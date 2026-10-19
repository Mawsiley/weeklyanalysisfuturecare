// Daily fetch + local copy (src/weekly.js), with a fake iCare API (synthetic patients only).
// Run: node icare-extension-tests/daily-fetch.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '../icare-extension');
const listeners = [], alarmListeners = [];
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
  alarms: { created: [], create(n, o) { this.created.push([n, o]); }, onAlarm: { addListener: f => alarmListeners.push(f) } },
  tabs: { onRemoved: ev(), onUpdated: ev(), onActivated: ev(), onCreated: ev(), create: async () => ({}), query: async () => [], get: async () => ({}) }, tabGroups: {}, scripting: {}, windows: { onRemoved: ev() },
};
const cities = { JED: [1, 2, 3], MKK: [11, 12], YNB: [21], RUH: [31] };
let apiCalls = 0, failApi = false;
const row = id => { const k = id % 3, c = Object.keys(cities).find(x => cities[x].includes(id));
  return { patient_id: id, patient_name: 'T' + id, doctor_name: id % 2 ? 'Dr A' : 'Dr B', city: c, patient_status: id === 3 ? 'De-Active' : 'Active',
    plan: { dr: 2 }, done: { Dr: k === 0 ? 0 : k === 1 ? 1 : 2 }, notes: { gp: k === 0 && id > 10 ? 'refused' : '' } }; };
// synthetic new-file orders: this month, last month, and one from 3 months ago (must be dropped)
const ymdLocal = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const nowD = new Date(), curStart = ymdLocal(new Date(nowD.getFullYear(), nowD.getMonth(), 1)), prevStart = ymdLocal(new Date(nowD.getFullYear(), nowD.getMonth() - 1, 5)), oldStart = ymdLocal(new Date(nowD.getFullYear(), nowD.getMonth() - 3, 5));
const newItems = [
  { id: 1, patient_id: 501, patient_name: 'SECRET NAME', mobile: '0500000000', pid: '1000000000', city: 'Jeddah', doctor_name: 'Dr A', company_name: 'Co', status_label: 'Open', created_at: curStart + ' 09:00:00', register_date: curStart, csheet_count: 2 },
  { id: 2, patient_id: 502, patient_name: 'SECRET 2', mobile: '0500000001', city: 'Makkah', doctor_name: 'Dr B', status_label: 'New', created_at: prevStart + ' 10:00:00', csheet_count: 0, mobile_dup_count: 1 },
  { id: 3, patient_id: 503, patient_name: 'OLD', city: 'Jeddah', doctor_name: 'Dr A', status_label: 'Open', created_at: oldStart + ' 10:00:00' },
];
let newCalls = 0;
const fakeFetch = async url => {
  apiCalls++;
  if (failApi) return { ok: false, status: 500, json: async () => ({}) };
  const u = new URL(url), p = u.pathname, city = u.searchParams.get('city'); let body;
  if (p.endsWith('/new-file')) { newCalls++; const pg = Number(u.searchParams.get('page') || 1); assert.strictEqual(u.searchParams.get('cdm_siss'), 'non_cdm'); assert.strictEqual(u.searchParams.get('page_size'), '500'); assert.ok(/^\d{4}-\d{2}-01$/.test(u.searchParams.get('start')), 'starts at the 1st of last month'); return { ok: true, status: 200, json: async () => ({ items: pg === 1 ? newItems : [], total: newItems.length }) }; }
  if (p.endsWith('/filter-options')) body = { options: { cities: Object.keys(cities) } };
  else if (p.endsWith('/report-plan')) body = { ids: cities[city] || [], chunk_max: 200 };
  else body = { rows: (u.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number).map(row) };
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
const localDate = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

(async () => {
  assert.ok(chrome.alarms.created.some(([n, o]) => n === 'fcw-daily' && o.periodInMinutes === 60), 'hourly check alarm registered');
  assert.ok(chrome.runtime.getManifest().permissions.includes('alarms'), 'alarms permission');

  // no iCare session yet → nothing is fetched, nothing breaks
  await wait(4300);
  assert.strictEqual(apiCalls, 0, 'no fetch without an iCare session');

  // an iCare tab provides the token → pending daily fetch runs
  await send({ type: 'ICARE_TOKEN', token: 'T', build: '2316' }, 'https://icare.com.sa/x');
  await wait(3200);
  const d1 = store.local.weeklyDaily;
  assert.ok(d1 && d1.lastDate === localDate() && d1.lastHow === 'auto', 'daily copy recorded as auto: ' + JSON.stringify(d1 && { l: d1.lastDate, h: d1.lastHow, e: d1.lastError }));
  assert.strictEqual(d1.snapshots.length, 1);
  const s = d1.snapshots[0];
  assert.strictEqual(s.n, 5, 'Deactive excluded from the snapshot (6 patients in 3 cities, 1 Deactive)');
  assert.ok(s.nd >= 1 && s.byCity.JED && s.byDoc['Dr A'], 'snapshot has Not Done and city/doctor totals');
  assert.ok(!('RUH' in s.byCity), 'only Jeddah, Makkah, Yanbu');
  assert.strictEqual(store.local.weeklyReport.source, 'icare');
  assert.strictEqual(store.local.weeklyReport.how, 'auto');
  const nw = store.local.weeklyNew;
  assert.ok(nw && nw.how === 'auto' && nw.date === localDate(), 'new patients fetched with the daily run');
  assert.strictEqual(nw.rows.length, 2, 'only previous + current month kept (the 3-month-old order is dropped)');
  assert.ok(!JSON.stringify(nw.rows).match(/SECRET|0500000|1000000000/), 'no patient name, mobile or national ID is stored');
  assert.deepStrictEqual(nw.rows.map(x => x.ptid).sort(), ['501', '502']);
  assert.strictEqual(nw.rows.find(x => x.ptid === '502').dup, 1);
  const callsAfterAuto = apiCalls;

  // same day: no second automatic fetch
  await send({ type: 'ICARE_TOKEN', token: 'T' }, 'https://icare.com.sa/x');
  alarmListeners.forEach(f => f({ name: 'fcw-daily' }));
  await wait(3200);
  assert.strictEqual(apiCalls, callsAfterAuto, 'once a day: no second automatic fetch');

  // on demand: manual fetch works any time and updates the local copy
  const man = await send({ type: 'FCW_FETCH_PERFORMANCE', month: localDate().slice(0, 7), cities: ['Jeddah'] }, SITE);
  assert.ok(man && man.ok && man.rows.length === 3 && !('snap' in man), 'manual fetch answers (snapshot not leaked to the page)');
  assert.ok(apiCalls > callsAfterAuto);
  assert.strictEqual(store.local.weeklyDaily.lastHow, 'manual');
  assert.strictEqual(store.local.weeklyDaily.snapshots.length, 1, 'same day replaces the snapshot');

  // new patients on demand + local copy for the page
  const fn = await send({ type: 'FCW_FETCH_NEW' }, SITE);
  assert.ok(fn && fn.ok && fn.rows.length === 2 && fn.months.length === 2, 'manual new-patients fetch');
  assert.strictEqual(store.local.weeklyNew.how, 'manual');
  const gn = await send({ type: 'FCW_GET_NEW' }, SITE);
  assert.ok(gn && gn.ok && gn.rows.length === 2, 'site gets the local new-patients copy');
  assert.strictEqual((await send({ type: 'FCW_GET_NEW' }, 'https://evil.example/')).code, 'FORBIDDEN_ORIGIN');
  assert.strictEqual((await send({ type: 'FCW_FETCH_NEW' }, 'https://evil.example/')).code, 'FORBIDDEN_ORIGIN');
  // the site can load the local copy; other origins cannot
  const loc = await send({ type: 'FCW_GET_REPORT' }, SITE);
  assert.ok(loc && loc.ok && loc.b64 && loc.how === 'manual', 'site gets the local copy');
  // a file loaded by hand on the site replaces the working report but never the saved iCare copy
  await send({ type: 'FCW_SYNC_REPORT', name: 'hand.xls', b64: Buffer.from('x').toString('base64') }, SITE);
  assert.strictEqual(store.local.weeklyReport.source, 'site');
  assert.strictEqual(store.local.weeklyLocal.source, 'icare', 'local iCare copy kept');
  const loc2 = await send({ type: 'FCW_GET_REPORT' }, SITE);
  assert.ok(loc2.ok && loc2.name.startsWith('performance-report_'), 'site still gets the iCare copy');
  const bad = await send({ type: 'FCW_GET_REPORT' }, 'https://evil.example/');
  assert.ok(bad && bad.code === 'FORBIDDEN_ORIGIN');

  // switched off: no automatic fetch on a new day
  store.local.weeklyAutoFetch = false;
  store.local.weeklyDaily.lastDate = '2000-01-01';
  const before = apiCalls;
  await send({ type: 'ICARE_TOKEN', token: 'T' }, 'https://icare.com.sa/x');
  await wait(3200);
  assert.strictEqual(apiCalls, before, 'auto fetch off → nothing fetched');

  // on: new day fetches once; a failure is remembered and not retried right away
  store.local.weeklyAutoFetch = true; failApi = true;
  await send({ type: 'ICARE_TOKEN', token: 'T' }, 'https://icare.com.sa/x');
  await wait(3200);
  assert.ok(store.local.weeklyDaily.lastError, 'failure recorded: ' + store.local.weeklyDaily.lastError);
  const afterFail = apiCalls;
  await send({ type: 'ICARE_TOKEN', token: 'T' }, 'https://icare.com.sa/x');
  await wait(3200);
  assert.strictEqual(apiCalls, afterFail, 'no retry storm after a failure');

  console.log('daily fetch: auto once a day + local copy + manual on demand + off switch + failure throttle OK');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.stack || e.message); process.exit(1); });
