/**
 * OCR 引擎适配层 — KB 核心只依赖此模块的统一接口, 不依赖具体引擎实现。
 * 引擎可独立替换/增删/分享; 引擎本体(Ollama 2.7GB/tesseract WASM 等)不进此文件。
 *
 * 接口:
 *   engines.available()           → ['glm-ocr','doc2x','textin','tesseract'] 当前可用列表
 *   engines.recognize(imgBuf, {engine, prompt}) → {md, ms, engine} 或抛错
 *
 * 配置在 .state/ocr.json (不进 git):
 *   { ollama_url, ollama_model, doc2x_token, doc2x_image_url,
 *     textin_app_id, textin_secret_code, textin_url }
 *
 * 网络: 用 http/https 原生模块(绕过 undici fetch 在某些环境对本地连接的限制)。
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  const p = path.join(process.env.MECH_KB_ROOT || process.cwd(), '.state', 'ocr.json');
  _cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  return _cfg;
}

/** 通用 POST: 返回 {status, body}。body 是 Buffer 转 string。 */
function post(urlStr, headers, bodyBuf, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method: 'POST', hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({}, headers),
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout ' + timeoutMs + 'ms')));
    req.write(bodyBuf);
    req.end();
  });
}

function get(urlStr, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// ============================================================ 引擎: GLM-OCR (本地 Ollama, 免费)
async function glmOcrAvailable() {
  const c = cfg();
  const base = c.ollama_url || 'http://127.0.0.1:11434';
  const model = c.ollama_model || 'glm-ocr';
  try {
    const { status, body } = await get(base + '/api/tags', 4000);
    if (status !== 200) return false;
    const j = JSON.parse(body);
    return (j.models || []).some((m) => String(m.name || '').startsWith(model));
  } catch (_) { return false; }
}

async function glmOcrRecognize(imgBuf, opts = {}) {
  const c = cfg();
  const base = c.ollama_url || 'http://127.0.0.1:11434';
  const model = c.ollama_model || 'glm-ocr';
  const t = Date.now();
  const body = JSON.stringify({
    model, stream: false,
    prompt: opts.prompt || 'OCR this page to markdown. 保留标题层级, 表格输出 markdown 表格, 公式用 LaTeX。只输出页面内容, 不要解释。',
    images: [Buffer.from(imgBuf).toString('base64')],
  });
  const { status, body: txt } = await post(base + '/api/generate', { 'content-type': 'application/json' }, Buffer.from(body), 180000);
  if (status !== 200) throw new Error('glm-ocr HTTP ' + status + ': ' + txt.slice(0, 120));
  const j = JSON.parse(txt);
  return { md: String(j.response || '').trim(), ms: Date.now() - t, engine: 'glm-ocr' };
}

// ============================================================ 引擎: Doc2X (云端, 需充值)
async function doc2xAvailable() {
  const c = cfg();
  return Boolean(c.doc2x_token);
}

async function doc2xRecognize(imgBuf) {
  const c = cfg();
  const url = c.doc2x_image_url || 'https://v2.doc2x.noedgeai.com/api/v2/parse/img/layout';
  const t = Date.now();
  const { status, body: txt } = await post(url, { authorization: 'Bearer ' + c.doc2x_token, 'content-type': 'application/octet-stream' }, imgBuf, 180000);
  const j = JSON.parse(txt);
  if (j.code !== 'success') throw new Error('doc2x: ' + j.code + ' ' + String(j.msg || '').slice(0, 100));
  if (j.data && j.data.status && j.data.status !== 'success') throw new Error('doc2x status: ' + j.data.status);
  const pages = (j.data && j.data.result && j.data.result.pages) || [];
  return { md: pages.map((p) => p.md || '').join('\n\n'), ms: Date.now() - t, engine: 'doc2x' };
}

// ============================================================ 引擎: TextIn xParse (云端)
async function textinAvailable() {
  const c = cfg();
  return Boolean(c.textin_app_id && c.textin_secret_code);
}

async function textinRecognize(imgBuf) {
  const c = cfg();
  const url = c.textin_url || 'https://api.textin.com/ai/service/v1/pdf_to_markdown?markdown_details=1&parse_mode=auto';
  const t = Date.now();
  const { status, body: txt } = await post(url, { 'x-ti-app-id': c.textin_app_id, 'x-ti-secret-code': c.textin_secret_code, 'content-type': 'application/octet-stream' }, imgBuf, 180000);
  const j = JSON.parse(txt);
  if (j.code !== 200) throw new Error('textin code=' + j.code + ' ' + String(j.message || j.msg || '').slice(0, 100));
  const r = j.result || {};
  let md = r.markdown || '';
  if (!md && r.pages) md = r.pages.map((p) => (p.content || []).map((l) => l.text).join('\n')).join('\n\n');
  return { md, ms: Date.now() - t, engine: 'textin' };
}

// ============================================================ 引擎: tesseract (本地 WASM, 兜底)
let _tessWorker = null, _tessReady = false;
async function tesseractAvailable() {
  try { require('tesseract.js'); return true; } catch (_) { return false; }
}
async function tesseractRecognize(imgBuf) {
  const { createWorker } = require('tesseract.js');
  const KB = process.env.MECH_KB_ROOT || process.cwd();
  if (!_tessWorker) {
    _tessWorker = await createWorker('chi_sim', 1, { cachePath: path.join(KB, '.state', 'tessdata') });
    _tessReady = true;
  }
  const t = Date.now();
  const { data } = await _tessWorker.recognize(imgBuf);
  return { md: String(data.text || '').trim(), ms: Date.now() - t, engine: 'tesseract' };
}
async function tesseractTerminate() { if (_tessWorker) { await _tessWorker.terminate(); _tessWorker = null; _tessReady = false; } }

// ============================================================ 统一接口
const REGISTRY = {
  'glm-ocr':   { available: glmOcrAvailable,   recognize: glmOcrRecognize },
  'doc2x':     { available: doc2xAvailable,    recognize: doc2xRecognize },
  'textin':    { available: textinAvailable,   recognize: textinRecognize },
  'tesseract': { available: tesseractAvailable, recognize: tesseractRecognize },
};

/** 返回当前可用引擎列表(按优先级排序)。 */
async function available() {
  const order = ['glm-ocr', 'doc2x', 'textin', 'tesseract'];
  const out = [];
  for (const e of order) { try { if (await REGISTRY[e].available()) out.push(e); } catch (_) {} }
  return out;
}

/** 用指定引擎识别单张图片。engine 缺省取 available() 第一个。 */
async function recognize(imgBuf, opts = {}) {
  let engine = opts.engine;
  if (!engine) { const list = await available(); engine = list[0]; if (!engine) throw new Error('没有可用的 OCR 引擎'); }
  if (!REGISTRY[engine]) throw new Error('未知引擎: ' + engine);
  return REGISTRY[engine].recognize(imgBuf, opts);
}

module.exports = { available, recognize, REGISTRY, tesseractTerminate, _post: post, _get: get };
