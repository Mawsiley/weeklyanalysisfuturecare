// Yesterday's DOCTOR visits per visiting doctor (src/weekly.js computeYesterdayVisits), with a fake iCare API.
// Last Visit of the performance report mixes services, so it only picks candidates; the date of the last GP visit and the
// visiting doctor come from the patient file (recent_visits.gp). Synthetic patients only.
// Run: node icare-extension-tests/yvisits.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '../icare-extension');
const listeners = [];
const store = { local: {}, session: {} };
const area = k => ({
  get: async keys => { const o = {}; (Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(store[k])).forEach(x => { if (x in store[k]) o[x] = JSON.parse(JSON.stringify(store[k][x])); }); return o; },
  set: async o => { Object.assign(store[k], JSON.parse(JSON.stringify(o))); }, remove: async ks => { [].concat(ks).forEach(x => delete store[k][x]); },
});
const ev = () => ({ addListener() {} });
const chrome = {
  runtime: { id: 'ext', onMessage: { addListener: f => listeners.push(f) }, onInstalled: ev(), onStartup: ev(),
    getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')), getURL: p => 'chrome-extension://ext/' + p, sendMessage: async () => {} },
  storage: { local: area('local'), session: area('session'), onChanged: ev() },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabs: { onRemoved: ev(), onUpdated: ev(), onActivated: ev(), onCreated: ev(), create: async () => ({}), query: async () => [], get: async () => ({}) }, tabGroups: {}, scripting: {}, windows: { onRemoved: ev() },
};
const ymd = ms => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const Y = ymd(Date.now() - 86400000), T = ymd(Date.now()), OLD = ymd(Date.now() - 5 * 86400000);
// 1: GP visit yesterday by Dr X | 2: only a NURSE visit yesterday (last_visit = yesterday, but GP was 5 days ago) | 3: GP yesterday by Dr Y
// 4: nurse visit today, GP visit yesterday by Dr X | 5: De-Active (ignored) | 6: last visit long ago (not a candidate)
const P = {
  1: { lv: Y, gp: { date: Y, staff_name: 'Dr X' }, st: 'Active' },
  2: { lv: Y, gp: { date: OLD, staff_name: 'Dr X' }, st: 'Active' },
  3: { lv: Y, gp: { date: Y, staff_name: 'Dr Y' }, st: 'Active' },
  4: { lv: T, gp: { date: Y, staff_name: 'Dr X' }, st: 'Active' },
  5: { lv: Y, gp: { date: Y, staff_name: 'Dr X' }, st: 'De-Active' },
  6: { lv: OLD, gp: { date: OLD, staff_name: 'Dr Y' }, st: 'Active' },
};
let infoCalls = [];
const fakeFetch = async url => {
  const u = new URL(url), p = u.pathname; let body;
  if (p.endsWith('/filter-options')) body = { options: { cities: ['JED'] } };
  else if (p.endsWith('/report-plan')) body = { ids: Object.keys(P).map(Number), chunk_max: 200 };
  else if (p.endsWith('/report')) body = { rows: (u.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number).map(id => ({ patient_id: id, patient_name: 'T' + id, doctor_name: 'Dr Z', city: 'JED', patient_status: P[id].st, plan: { dr: 2 }, done: { Dr: 1 }, last_visit: P[id].lv, notes: {} })) };
  else if (/\/patient-info\/\d+$/.test(p)) { const id = Number(p.split('/').pop()); infoCalls.push(id); body = { patient: { full_name: 'NEVER STORED', mobile: '0500000000' }, recent_visits: { gp: P[id].gp, nursing: { date: P[id].lv, staff_name: 'N' } } }; }
  else return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};
const ctx = { chrome, console, setTimeout: (f, ms) => (ms > 100000 ? 0 : setTimeout(f, ms)), clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextDecoder, TextEncoder, atob, btoa, fetch: fakeFetch, Date };
ctx.importScripts = f => vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), ctx, { filename: f });
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), ctx, { filename: 'background.js' });
const send = (msg, url) => new Promise(res => {
  let done = false;
  for (const l of listeners) { const r = l(msg, { url, id: 'ext' }, v => { if (!done) { done = true; res(v); } }); if (r === true) return; }
  setTimeout(() => { if (!done) res(null); }, 400);
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'https://weeklyanalysisfuturecare.netlify.app/';
(async () => {
  await send({ type: 'ICARE_TOKEN', token: 'T', build: '1' }, 'https://icare.com.sa/x');
  const r = await send({ type: 'FCW_FETCH_PERFORMANCE', month: ymd(Date.now()).slice(0, 7), cities: ['Jeddah'] }, SITE);
  assert.ok(r && r.ok && !('vcand' in r) && !('snap' in r), 'the response never exposes the candidate list or the snapshot');
  await wait(600);
  const yv = store.local.weeklyDaily && store.local.weeklyDaily.yvisits;
  assert.ok(yv, 'yesterday visits computed after the fetch');
  assert.strictEqual(yv.date, Y);
  assert.deepStrictEqual(yv.byDoc, { 'Dr X': 2, 'Dr Y': 1 }, 'only patients whose last DOCTOR visit was yesterday, by the visiting doctor: ' + JSON.stringify(yv.byDoc));
  assert.ok(!infoCalls.includes(5) && !infoCalls.includes(6), 'De-Active and old last-visit patients are not even checked: ' + infoCalls);
  assert.ok(infoCalls.includes(2) && infoCalls.includes(4), 'a nurse-only visit yesterday and a nurse visit today are checked (and 2 is not counted)');
  assert.ok(!JSON.stringify(store.local).includes('NEVER STORED') && !JSON.stringify(store.local).includes('0500000000'), 'no name / mobile from the patient file is stored');
  const g = await send({ type: 'FCW_GET_YVISITS' }, SITE);
  assert.ok(g && g.ok && g.yv.n === 3 && g.yv.byDoc['Dr X'] === 2 && !('ptids' in g.yv), 'the site gets counts only (no PTID list)');
  console.log('yesterday doctor visits: exact per visiting doctor, nurse-only visits excluded, no personal data stored OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
