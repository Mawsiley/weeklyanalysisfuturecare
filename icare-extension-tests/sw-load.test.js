// Loads src/background.js the way Chrome does (importScripts('weekly.js') included) and checks that both
// the task engine and the weekly-site messages answer. Run: node icare-extension-tests/sw-load.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '../icare-extension');
const listeners = [];
const store = { local: {}, session: { icareToken: 'T', tokenAt: Date.now() } };
const area = k => ({
  get: async keys => { const o = {}; (Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(store[k])).forEach(x => { if (x in store[k]) o[x] = store[k][x]; }); return o; },
  set: async o => { Object.assign(store[k], o); }, remove: async ks => { [].concat(ks).forEach(x => delete store[k][x]); },
});
const ev = () => ({ addListener() {} });
const chrome = {
  runtime: { id: 'ext', onMessage: { addListener: f => listeners.push(f) }, onInstalled: ev(), onStartup: ev(),
    getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')), getURL: p => 'chrome-extension://ext/' + p, sendMessage: async () => {} },
  storage: { local: area('local'), session: area('session'), onChanged: ev() },
  tabs: { onRemoved: ev(), onUpdated: ev(), onActivated: ev(), onCreated: ev(), create: async o => ({ id: 9, ...o }), query: async () => [], get: async () => ({}) },
  tabGroups: {}, alarms: { create() {}, clear() {}, onAlarm: ev() }, scripting: {}, windows: { onRemoved: ev() },
};
const ctx = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextDecoder, TextEncoder, atob, btoa,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ options: { cities: ['JED'] } }) }) };
ctx.importScripts = f => vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), ctx, { filename: f });
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), ctx, { filename: 'background.js' });
const send = (msg, url) => new Promise(res => {
  let done = false;
  for (const l of listeners) { const r = l(msg, { url, id: 'ext' }, v => { if (!done) { done = true; res(v); } }); if (r === true) return; }
  setTimeout(() => { if (!done) res(null); }, 500);
});
(async () => {
  assert.ok(listeners.length >= 2, 'engine + weekly listeners registered');
  const st = await send({ type: 'FCW_STATUS' }, 'https://weeklyanalysisfuturecare.netlify.app/');
  assert.ok(st && st.ok && st.hasToken && st.tasks, 'weekly status answers: ' + JSON.stringify(st));
  const rs = await send({ action: 'BG_GET_RUN_STATE' }, 'chrome-extension://ext/popup.html');
  assert.ok(rs && rs.ok, 'engine answers');
  const bad = await send({ type: 'FCW_FETCH_PERFORMANCE', month: '2026-10' }, 'https://evil.example/');
  assert.ok(bad && bad.code === 'FORBIDDEN_ORIGIN', 'other sites cannot fetch the report');
  console.log('service worker loads: engine + weekly messages OK (version ' + st.version + ')');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
