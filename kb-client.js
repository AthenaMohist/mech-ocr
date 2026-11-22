'use strict';
/**
 * KB HTTP API 客户端 — mech-ocr 通过此模块调 KB, 不 require KB 任何代码。
 * KB 必须开着 Studio(:7350), 环境变量 MECH_KB_URL 指向它。
 *
 * 接口:
 *   taskAdd(task)              → 排录入任务(KB task_add op)
 *   taskSet(id, patch)         → 更新任务(KB task_set op)
 *   ocrReport({meta, live})    → 报告进度(KB ocr_report op: meta 写 state, live 更新瞬态任务)
 *   llmComplete(system, user)  → 调 author 模型(KB llm_complete op)
 *
 * 网络: 用 http 原生模块(绕过 undici fetch 在某些环境对本地连接的限制)。
 */
const http = require('http');

const KB_URL = process.env.MECH_KB_URL || 'http://127.0.0.1:7350';

function post(op, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(KB_URL + '/api/' + op);
    const payload = JSON.stringify(body || {});
    const req = http.request({
      method: 'POST', hostname: u.hostname,
      port: u.port || 80, path: u.pathname,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try {
          const j = JSON.parse(txt);
          if (j.ok) resolve(j.result);
          else reject(new Error(j.error || ('KB op ' + op + ' failed')));
        } catch (e) { reject(new Error('KB response parse error: ' + txt.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(200000, () => req.destroy(new Error('KB timeout (200s)')));
    req.write(payload);
    req.end();
  });
}

/** 排录入任务 */
async function taskAdd(task) { return post('task_add', { task }); }

/** 更新任务状态 */
async function taskSet(id, patch) { return post('task_set', Object.assign({ id }, patch)); }

/** 报告 OCR 进度: meta 写 .state, live 更新瞬态任务 ocr:live */
async function ocrReport(report) {
  const body = {};
  if (report.meta) body.meta = report.meta;
  if (report.live) body.live = report.live;
  return post('ocr_report', body);
}

/** 调 author 模型 system+user → text (质量 agent / 常识 agent) */
async function llmComplete(system, user) {
  const r = await post('llm_complete', { system: system || '', user });
  return { text: r.text, usage: r.usage };
}

module.exports = { taskAdd, taskSet, ocrReport, llmComplete, KB_URL };
