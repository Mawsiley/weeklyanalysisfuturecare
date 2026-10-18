// Builds icare-extension-tests/dash-preview.html: the extension window with chrome-stub + a fake iCare fetch
// (synthetic patients) to check the 📊 التحليل tab in a normal browser. Run: node icare-extension-tests/make-dash-preview.js
// then serve the repo root (node icare-extension-tests/serve.js) and open /icare-extension-tests/dash-preview.html?full=1&tab=dash
const fs = require('fs'), path = require('path');
const EXT = path.resolve(__dirname, '../icare-extension');
const w = fs.readFileSync(path.join(EXT, 'src/weekly.js'), 'utf8');
const body = w.slice(w.indexOf('const PERF_CITY_ALIASES'), w.indexOf('async function fetchPerformance'));
const rb = w.slice(w.indexOf('function reportB64'), w.indexOf('// Task rules: the newer copy wins'));
const btoa = s => Buffer.from(s, 'latin1').toString('base64');
const { PERF_HEADERS, perfRow, reportB64 } = new Function('btoa', body + rb + 'return { PERF_HEADERS, perfRow, reportB64 };')(btoa);
const mk = (id, doctor, city, p, d, gp, st) => ({ patient_id: id, patient_name: 'Test ' + id, doctor_name: doctor, city, patient_status: st || 'Active',
  plan: { dr: p }, done: { Dr: d }, notes: { gp }, last_visit: '2026-10-05' });
const raw = [
  mk(91001, 'Dr Test Alpha', 'JED', 2, 0, 'Acute'), mk(91002, 'Dr Test Alpha', 'JED', 2, 0, 'Patient refused service'),
  mk(91003, 'Dr Test Beta', 'MKK', 2, 0, 'Service rescheduled by patient'), mk(91004, 'Dr Test Beta', 'MKK', 1, 0, 'Patient was not available'),
  mk(91005, 'Dr Test Gamma', 'YNB', 3, 1, ''), mk(91006, 'Dr Test Gamma', 'YNB', 2, 2, ''), mk(91007, 'Dr Test Alpha', 'JED', 2, 0, ''),
  mk(91008, 'Dr Test Beta', 'MKK', 2, 0, 'Acute', 'De-Active'),
];
const rep = { ok: true, month: '2026-10', counts: { Jeddah: 3, Makkah: 3, Yanbu: 2 }, headers: PERF_HEADERS, rows: raw.map((r, i) => perfRow(r, i + 1)) };
const b64 = reportB64(rep);
let html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8')
  .replace('href="popup.css"', 'href="/icare-extension/popup.css"')
  .replace(/src="(lib|src|icons)\//g, 'src="/icare-extension/$1/')
  .replace('<script src="popup.js"></script>', `<script src="/icare-extension-tests/chrome-stub.js"></script>
<script>(() => { // test additions: storage change events + fake iCare fetch for the 📊 tab
  const L = [], local = {}; const orig = chrome.storage.local;
  chrome.storage.onChanged = { addListener: f => L.push(f) };
  chrome.storage.local = { ...orig, set: async v => { await orig.set(v); const ch = {}; Object.keys(v).forEach(k => ch[k] = { newValue: v[k] }); L.forEach(f => f(ch, 'local')); } };
  chrome.tabs.create = async o => { window.__opened = o.url; return { id: 5 }; };
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async m => {
    if (m.type === 'FCW_FETCH_PERFORMANCE') { window.__fetched = m; await chrome.storage.local.set({ weeklyReport: { name: 'performance-report_2026-10_Jeddah-Makkah-Yanbu.xls', b64: ${JSON.stringify(b64)}, source: 'icare', how: 'manual', at: Date.now() } });
      return { ok: true, month: m.month, counts: ${JSON.stringify(rep.counts)}, rows: new Array(${raw.length}) }; }
    if (m.type === 'FCW_STATUS') return { ok: true, hasToken: true, version: 'test' };
    return send(m);
  };
})();</script>
<script src="/icare-extension/popup.js"></script>`);
fs.writeFileSync(path.join(__dirname, 'dash-preview.html'), html);
console.log('dash-preview.html written');
