// The report the weekly site builds from iCare rows (UTF-16 HTML .xls, iCare export columns) must be
// recognised by the task importer as the "gp-note" profile. Synthetic data only.
const assert = require('assert');
const fs = require('fs');
const XLSX = require('../icare-extension/lib/sheetjs/xlsx.full.min.js');
const I = require('../icare-extension/lib/import.js');

const src = fs.readFileSync(__dirname + '/../icare-extension/src/weekly.js', 'utf8');
const body = src.slice(src.indexOf('const PERF_CITY_ALIASES'), src.indexOf('async function fetchPerformance'));
const { PERF_HEADERS, perfRow } = new Function(body + 'return { PERF_HEADERS, perfRow };')();

const mk = (id, doctor, p, d, gp) => ({ patient_id: id, patient_name: 'Test ' + id, doctor_name: doctor, city: 'JED', patient_status: 'Active',
  plan: { dr: p }, done: { Dr: d }, notes: { gp }, last_visit: '2026-10-05' });
const rows = [
  mk(90001, 'Doctor Alpha', 1, 0, 'Acute||older'), mk(90002, 'Doctor Alpha', 1, 0, 'Patient refused service'),
  mk(90003, 'Doctor Beta', 2, 0, 'Service rescheduled by patient'), mk(90004, 'Doctor Beta', 1, 0, 'Patient was not available'),
  mk(90005, 'Doctor Beta', 2, 1, ''), mk(90006, 'Doctor Beta', 1, 1, 'Acute'),
].map((r, i) => perfRow(r, i + 1));

// same serialisation as icare-connect.js asIcareFile()
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const html = '<html><head><meta charset="utf-8"></head><body><table><tr>' + PERF_HEADERS.map(h => `<th>${esc(h)}</th>`).join('') + '</tr>' +
  rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</table></body></html>';
const u16 = new Uint16Array(html.length + 1); u16[0] = 0xFEFF; for (let i = 0; i < html.length; i++) u16[i + 1] = html.charCodeAt(i);

const wb = I.readWorkbookRows(new Uint8Array(u16.buffer), XLSX);
const t = I.buildTable(wb.rows, wb.hidden, wb.misaligned);
const m = I.detectMapping(t.headers);
assert.strictEqual(m.profile, 'gp-note');
const all = I.buildItems(t, m, { rule: 'all', defaultEmployee: '632' });
assert.deepStrictEqual(all.items.map(i => [i.ptid, i.rule, i.vars.TASK_EMPLOYEE]), [
  ['90001', 'acute', '45'], ['90002', 'refused', '632'], ['90003', 'rescheduled', 'Doctor Beta'],
  ['90004', 'not-available', '709'], ['90005', 'extra-visit', '45']]);
assert.ok(all.items.every(i => i.vars.TASK_TITLE.length <= 35));
console.log('weekly hand-off: iCare-format report → gp-note task items OK');
