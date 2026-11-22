#!/usr/bin/env node
/**
 * mech-ocr OCR pipeline (独立 repo, 不 require KB 任何模块)
 *   node pipeline.js [--max-pages N]
 *
 * 由 KB 的 ocr_start 操作拉起(detached), 通过 HTTP API 调 KB:
 *   - ocr_report:  报告进度(meta 写 state, live 更新瞬态任务)
 *   - llm_complete: 调 author 模型(质量 agent / 常识 agent)
 *   - task_add:    排录入任务
 *
 * 环境变量(由 KB ocr_start 注入):
 *   MECH_KB_ROOT  KB 根目录(访问 .state/ocr.json 凭证)
 *   MECH_KB_RAW   raw 目录(访问 original/ pages/ toc.json)
 *   MECH_KB_URL   KB Studio HTTP API (http://127.0.0.1:7350)
 *
 * 四步管线:
 *   1. 初步 OCR: PDF → tesseract(WASM, chi_sim) 本地识别, 零 token, 按页断点续跑
 *   2. 一审(质量 agent): 前言不搭后语/顺序错乱/表格缺失/乱码 → 不合格页进入下一遍
 *   3. 精确提取: GLM-OCR(Ollama) → Doc2X → TextIn → tesseract-hires (三级降级)
 *   4. 三审(常识 agent): 单位错/因果颠倒/术语混用 → 通过才写 pages/ 并排录入任务
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pdf: pdfRender } = require('pdf-to-img');
const kb = require('./kb-client');
const engines = require('./engines');

const KB_ROOT = process.env.MECH_KB_ROOT || path.resolve(__dirname, '..');
const RAW = process.env.MECH_KB_RAW || path.join(KB_ROOT, '..', 'mech-kb-raw');

const opt = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const MAX_PAGES = opt('--max-pages', 80);
const now = () => new Date().toLocaleString('sv-SE');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const jsonOf = (text) => { const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text); return JSON.parse(m ? m[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); };

// ---------------------------------------------------------------- 进度 + 瞬态任务(通过 KB HTTP API)
let _meta = {};
let _lastReport = 0;
function liveTouch(status, title) {
  kb.ocrReport({ live: { status, title: String(title || '').slice(0, 80) } }).catch(() => {});
}
function progress(patch, line) {
  _meta = Object.assign({}, _meta, patch, { updated: now() });
  if (line) _meta.log = [].concat(_meta.log || [], [now().slice(11) + ' ' + line]).slice(-80);
  const t = Date.now();
  if (t - _lastReport > 400) { _lastReport = t; kb.ocrReport({ meta: _meta }).catch(() => {}); }
  if (line) { console.log(line); if (_meta.running !== false) liveTouch('doing', line); }
}
function progressFlush() { kb.ocrReport({ meta: _meta }).catch(() => {}); }
const die = (msg) => { progress({ running: false, error: String(msg).slice(0, 500) }); liveTouch('blocked', 'OCR interrupted: ' + String(msg).slice(0, 60)); progressFlush(); console.error(msg); process.exitCode = 1; };

// ---------------------------------------------------------------- 模型(质量 agent) — 通过 KB HTTP API
async function modelChat(system, user, what) {
  for (let attempt = 0; ; attempt++) {
    progress({}, what + ' (via KB LLM)…');
    try {
      const r = await Promise.race([
        kb.llmComplete(system, user),
        sleep(180000).then(() => { throw Object.assign(new Error(what + ' timeout(180s)'), { retry: true }); }),
      ]);
      return r.text;
    } catch (e) {
      if (!e.retry || attempt >= 2) throw e;
      progress({}, what + ' failed(' + e.message.slice(0, 90) + '), retry in 15s');
      await sleep(15000);
    }
  }
}

// ---------------------------------------------------------------- 队列发现: toc 里标记"扫描版"且原件在 original/ 的 PDF
function findQueue() {
  const out = [];
  if (!fs.existsSync(RAW)) return out;
  for (const sid of fs.readdirSync(RAW)) {
    const dir = path.join(RAW, sid);
    const tocFile = path.join(dir, 'toc.json');
    const origDir = path.join(dir, 'original');
    if (!fs.existsSync(tocFile) || !fs.existsSync(origDir)) continue;
    let toc;
    try { toc = JSON.parse(fs.readFileSync(tocFile, 'utf8')); } catch (_) { continue; }
    for (const t of toc) {
      if (t.pages) continue;
      if (!t.note || !/扫描版|未能自动获取/.test(t.note)) continue;
      const kbName = t.kb || sid;
      const cand = [kbName + '-' + t.title, kbName + '-' + t.title.replace(/\.pdf$/i, '')].map((x) => x.replace(/[\\/:*?"<>|]/g, '_'));
      const f = cand.flatMap((c) => [c, c + '.pdf']).map((c) => path.join(origDir, c)).find((p) => fs.existsSync(p));
      if (f) out.push({ sid, dir, tocFile, toc: t, file: f });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 单本处理
async function processPdf(item, budget) {
  const { sid, dir, tocFile, toc: te, file } = item;
  const name = path.basename(file).replace(/\.pdf$/i, '');
  const work = path.join(dir, 'ocr', name.replace(/[\\/:*?"<>|]/g, '_'));
  fs.mkdirSync(work, { recursive: true });
  const stFile = path.join(work, 'state.json');
  const st = fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, 'utf8')) : { stage: 'ocr', pageDone: 0, texts: [] };

  // 1) 初步 OCR(按页断点) — tesseract 本地 WASM
  progress({ source: sid, file: name, stage: 'initial OCR', page: st.pageDone, pages: st.texts.length || '?' }, 'OCR: ' + name);
  const doc = await pdfRender(fs.readFileSync(file), { scale: 2 });
  let rendered = 0;
  for await (const img of doc) {
    rendered++;
    if (rendered <= st.pageDone) continue;
    const { md } = await engines.recognize(img, { engine: 'tesseract' });
    st.texts[rendered - 1] = md;
    st.pageDone = rendered;
    if (rendered % 5 === 0 || rendered === 1) { fs.writeFileSync(stFile, JSON.stringify(st)); progress({ page: rendered, pages: '?' }, '  OCR ' + rendered + ' pages'); }
    if (budget.left <= 0) break;
    budget.left--;
  }
  st.pagesTotal = rendered;
  if (budget.left <= 0 && st.pageDone < rendered) { fs.writeFileSync(stFile, JSON.stringify(st)); progress({}, 'page budget exhausted(' + MAX_PAGES + '), ' + name + ' done ' + st.pageDone + '/' + rendered + ', continue next time'); return { queued: 0, done: false }; }
  fs.writeFileSync(stFile, JSON.stringify(st));

  // 2) 一审(质量 agent): 按批次审
  if (st.stage === 'ocr') { st.stage = 'review1'; fs.writeFileSync(stFile, JSON.stringify(st)); }
  if (!st.review1) {
    progress({ stage: 'review1 (quality)' }, 'review1: ' + name + '(' + rendered + ' pages)');
    const flagged = new Set(); const issues = [];
    for (let b = 0; b * 12 < st.texts.length; b++) {
      const pages = st.texts.slice(b * 12, b * 12 + 12).map((t, i) => '[page ' + (b * 12 + i + 1) + ']\n' + String(t || '(blank)').slice(0, 2200)).join('\n\n');
      const cls = jsonOf(await modelChat('You are a quality reviewer, output JSON only.',
        ['Below is OCR text from a scanned mechanical book, pages ' + (b * 12 + 1) + '-' + Math.min(st.texts.length, b * 12 + 12) + '.',
         'Check: incoherent text, wrong order, missing table/figure data, high garble rate.',
         'Output ```json: {"verdict":"pass or fail","issues":["..."],"pages":[problem page numbers]}', '', pages].join('\n'), 'review1 batch ' + (b + 1)));
      for (const p of cls.pages || []) if (p >= b * 12 + 1 && p <= b * 12 + 12) flagged.add(p);
      if (cls.verdict === 'fail') issues.push(...(cls.issues || []).slice(0, 5));
    }
    st.review1 = { verdict: issues.length || flagged.size ? 'fail' : 'pass', issues: issues.slice(0, 10), pages: [...flagged].sort((a, b2) => a - b2) };
    fs.writeFileSync(stFile, JSON.stringify(st));
    progress({}, 'review1 result: ' + st.review1.verdict + (flagged.size ? ', ' + flagged.size + ' pages need precise extraction' : '') + (issues.length ? '; ' + issues[0].slice(0, 80) : ''));
  }

  // 3) 精确提取: 引擎按优先级降级(glm-ocr → doc2x → textin → tesseract)
  if (st.review1.verdict === 'fail' && !st.precise && st.review1.pages.length) {
    st.stage = 'precise'; fs.writeFileSync(stFile, JSON.stringify(st));
    const avail = await engines.available();
    progress({}, 'precise: engines [' + avail.join(', ') + '], ' + st.review1.pages.length + ' pages');
    const doc2 = await pdfRender(fs.readFileSync(file), { scale: 2 });
    let idx = 0; const pageImgs = {};
    for await (const img of doc2) { idx++; if (st.review1.pages.includes(idx)) pageImgs[idx] = img; }
    let replaced = 0, usedEngine = null;
    for (const eng of avail) {
      if (replaced >= st.review1.pages.length) break;
      for (const p of st.review1.pages) {
        if (st.texts[p - 1] && st.texts[p - 1].replace(/\s/g, '').length > 100 && eng !== avail[0]) continue;
        if (!pageImgs[p]) continue;
        try {
          progress({}, '  ' + eng + ' page ' + p + '…');
          const { md } = await engines.recognize(pageImgs[p], { engine: eng });
          if (md.replace(/\s/g, '').length > 20) { st.texts[p - 1] = md; replaced++; usedEngine = eng; }
        } catch (e) { progress({}, '  ' + eng + ' page ' + p + ' failed: ' + e.message.slice(0, 80)); }
      }
      if (replaced > 0) { st.precise = usedEngine; break; }
    }
    if (!st.precise) st.precise = 'none(all engines failed)';
    fs.writeFileSync(stFile, JSON.stringify(st));
    progress({}, 'precise: ' + st.precise + ' replaced ' + replaced + '/' + st.review1.pages.length + ' pages');
  }

  // 4) 三审(常识 agent)
  if (!st.review2) {
    progress({ stage: 'review2 (common sense)' }, 'review2: ' + name);
    const ok = [];
    for (let b = 0; b * 12 < st.texts.length; b++) {
      const pages = st.texts.slice(b * 12, b * 12 + 12).map((t, i) => '[page ' + (b * 12 + i + 1) + ']\n' + String(t || '').slice(0, 2000)).join('\n\n');
      const cls = jsonOf(await modelChat('You are a common-sense reviewer, output JSON only.',
        ['Below is extracted text from mechanical book "' + name + '", pages ' + (b * 12 + 1) + '-' + Math.min(st.texts.length, b * 12 + 12) + '.',
         'Check: physics/engineering common sense, unit errors, formula inversions, terminology misuse, causal contradictions.',
         'Output ```json: {"verdict":"pass or fail","issues":["..."]}', '', pages].join('\n'), 'review2 batch ' + (b + 1)));
      if (cls.verdict === 'fail') ok.push(...(cls.issues || []).slice(0, 3));
    }
    st.review2 = { verdict: ok.length ? 'fail' : 'pass', issues: ok.slice(0, 8) };
    fs.writeFileSync(stFile, JSON.stringify(st));
    progress({}, 'review2 result: ' + st.review2.verdict + (ok.length ? '; ' + ok[0].slice(0, 80) : ''));
  }
  if (st.review2.verdict !== 'pass') {
    const docToc = JSON.parse(fs.readFileSync(tocFile, 'utf8'));
    const te2 = docToc.find((x) => x.title === te.title);
    if (te2) te2.note = 'OCR review2 failed(' + (st.review2.issues || []).join('; ').slice(0, 120) + '), keep original for manual review';
    fs.writeFileSync(tocFile, JSON.stringify(docToc, null, 1) + '\n');
    progress({}, name + ' review2 failed, no task queued (reason in toc)');
    return { queued: 0, done: true, used: 0 };
  }

  // 通过 → 写 pages/ + 排录入任务(via KB HTTP API)
  const pagesDir = path.join(dir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  let n = 0;
  while (fs.existsSync(path.join(pagesDir, String(n + 1).padStart(4, '0') + '.md'))) n++;
  const text = st.texts.map((t, i) => '(page ' + (i + 1) + ')\n' + t).join('\n\n').replace(/\n{3,}/g, '\n\n');
  n++;
  fs.writeFileSync(path.join(pagesDir, String(n).padStart(4, '0') + '.md'), '# Source: OCR · ' + name + '\n\n' + text.slice(0, 24000));
  const taskId = sid + '-scan-' + String(n).padStart(3, '0');
  await kb.taskAdd({ id: taskId, kind: 'ingest', source: sid, pages: [n, n], section: sid + ' segment ' + n, title: name.slice(0, 60), domain: te.domain || '未分类', priority: 'P1', status: 'todo', from: 'ocr' });
  const docToc = JSON.parse(fs.readFileSync(tocFile, 'utf8'));
  const te2 = docToc.find((x) => x.title === te.title);
  if (te2) { te2.pages = [n, n]; te2.section = sid + ' segment ' + n; delete te2.note; te2.ocr = st.precise || 'tesseract'; }
  fs.writeFileSync(tocFile, JSON.stringify(docToc, null, 1) + '\n');
  progress({}, name + ' passed review2 → task ' + taskId + ' queued (engine: ' + (st.precise || 'tesseract') + ')');
  return { queued: 1, done: true, used: 0 };
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const queue = findQueue();
  progress({ running: true, stage: 'prepare', log: [], started: now(), error: null, result: null, queue: queue.length },
    'OCR pipeline start: ' + queue.length + ' scanned PDFs' + (queue.length ? ': ' + queue.slice(0, 3).map((q) => path.basename(q.file).replace(/\.pdf$/i, '')).join(', ') + (queue.length > 3 ? ' etc' : '') : ''));
  if (!queue.length) { progress({ running: false }); liveTouch('done', 'no scanned PDFs to OCR'); progressFlush(); return; }
  const budget = { left: MAX_PAGES };
  let queued = 0;
  for (const item of queue) {
    if (budget.left <= 0) break;
    try {
      const r = await processPdf(item, budget);
      queued += r.queued;
      if (!r.done) break;
    } catch (e) {
      progress({}, '× ' + path.basename(item.file) + ': ' + e.message.slice(0, 120) + ' → skip, continue');
      try {
        const docToc = JSON.parse(fs.readFileSync(item.tocFile, 'utf8'));
        const te2 = docToc.find((x) => x.title === item.toc.title);
        if (te2) te2.note = 'OCR failed(' + e.message.slice(0, 100) + '), manual review';
        fs.writeFileSync(item.tocFile, JSON.stringify(docToc, null, 1) + '\n');
      } catch (_) {}
    }
  }
  progress({ running: false, stage: 'done', result: { pending: queue.length, queued: queued } }, 'OCR pipeline done: queued ' + queued + ' tasks');
  liveTouch('done', 'OCR done: queued ' + queued + ' tasks');
  progressFlush();
}
main().catch((e) => die(e.message));
