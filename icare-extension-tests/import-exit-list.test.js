// اختبار قالب "قائمة دخول المستشفى" + قراءة ملفات iCare بصيغة HTML/UTF-16 (بيانات وهمية)
const assert = require('assert');
const path = require('path');
const XLSX = require('../icare-extension/lib/sheetjs/xlsx.full.min.js');
const I = require('../icare-extension/lib/import.js');

const headers = ['#', 'PTID', 'Name', 'Age', 'Status', 'Type', 'Record Type', 'Travel city', 'Staff', 'Date IN',
  'Date OUT', 'Reason', 'Doctor', 'HARP Score', 'GP Action', 'Specialist Action', 'Planned', 'Avoidable', 'Specialist comment', 'Comments'];
const rows = [
  [1, 90001, 'TEST ONE', 60, 'Active', 'insurance', 'Hospital Admission', '', '111 - Staff A', '', '', 'Admission - Others — المريض كان متعباً', 'Doctor Alpha', '10 - High Risk', '', '', '', '', '', 0],
  [2, 90002, 'TEST TWO', 70, 'Active', 'insurance', 'Hospital Admission', '', '222 - Staff B', '', '', 'Admission - Pneumonia', '-', '', '', '', '', '', '', 1],
  [3, 90001, 'TEST ONE', 60, 'Active', 'insurance', 'Hospital Admission', '', '111 - Staff A', '', '', 'Admission - Sepsis', 'Doctor Alpha', '', '', '', '', '', '', 0]
];
const td = v => '<td>' + String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td>';
const html = '<html><body><table><tr>' + headers.map(td).join('') + '</tr>' +
  rows.map(r => '<tr>' + r.map(td).join('') + '</tr>').join('') + '</table></body></html>';
const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(html, 'utf16le')]);

const wb = I.readWorkbookRows(new Uint8Array(utf16), XLSX);
const table = I.buildTable(wb.rows, wb.hidden);
assert.strictEqual(table.rows.length, 3);
assert.strictEqual(table.rows[0][11], 'Admission - Others — المريض كان متعباً', 'النص العربي يُقرأ سليماً');
assert.strictEqual(table.rows[0][12], 'Doctor Alpha', 'عمود Doctor لا ينزاح');

const mapping = I.detectMapping(table.headers);
assert.strictEqual(mapping.profile, 'exit-list');
assert.strictEqual(table.headers[mapping.employee], 'Doctor', 'الموظف = Doctor وليس Staff');
assert.strictEqual(mapping.title, -1);
assert.strictEqual(mapping.message, -1);

const res = I.buildItems(table, mapping, { defaultEmployee: '632', skipHidden: true });
assert.deepStrictEqual(res.items.map(i => [i.ptid, i.vars.TASK_EMPLOYEE]), [['90001', 'Doctor Alpha'], ['90002', '632']]);
assert.strictEqual(res.duplicates, 1, 'دخول متكرر لنفس المريض والطبيب = تاسك واحد');
assert.ok(res.items.every(i => !i.vars.TASK_TITLE && !i.vars.TASK_MESSAGE), 'العنوان والرسالة من التبويب');

const profile = I.PROFILES.find(p => p.id === 'exit-list');
assert.ok(profile.title.length <= 35);
assert.ok(/HARP/.test(profile.message));

// الملفات الأخرى لا تتأثر
const fs = require('fs');
const rad = I.readWorkbookRows(fs.readFileSync(path.join(__dirname, 'fixtures/rad-reports-sample.xls')), XLSX);
assert.ok(!I.detectMapping(I.buildTable(rad.rows, rad.hidden).headers).profile);

// ===== تحليل GP Note (تقرير الأداء) =====
{
  const H = ['S/N', 'Status', 'PTID', 'Patient Name', 'Doctor Name', 'DR P', 'DR D', 'RTP (DR)', 'GP Note'];
  const R = [
    [1, 'Active', 80001, 'X', 'Doctor Alpha', 1, 0, 0, 'Acute'],
    [2, 'Active', 80002, 'X', 'Doctor Alpha', 1, 0, 0, 'Patient refused service'],
    [3, 'Active', 80003, 'X', 'Doctor Beta', 2, 0, 0, 'Service rescheduled by patient'],
    [4, 'Active', 80004, 'X', 'Doctor Beta', 1, 0, 0, 'Patient was not available'],
    [5, 'Active', 80005, 'X', 'Doctor Beta', 2, 1, 0, ''],
    [6, 'Active', 80006, 'X', 'Doctor Beta', 1, 1, 0, 'Acute'],          // نفذت الزيارة ← لا شيء
    [7, 'Active', 80007, 'X', 'Doctor Beta', 1, 0, 0, 'Patient traveled'], // سبب غير مشمول
    [8, 'Active', 80008, 'X', '', 1, 0, 0, 'Service rescheduled by patient'] // بلا طبيب ← 632
  ];
  const t = I.buildTable([H, ...R], []);
  const m = I.detectMapping(t.headers);
  assert.strictEqual(m.profile, 'gp-note');
  const all = I.buildItems(t, m, { rule: 'all', defaultEmployee: '632' });
  assert.deepStrictEqual(all.items.map(i => [i.ptid, i.rule, i.vars.TASK_EMPLOYEE]), [
    ['80001', 'acute', '45'], ['80002', 'refused', '632'], ['80003', 'rescheduled', 'Doctor Beta'],
    ['80004', 'not-available', '709'], ['80005', 'extra-visit', '45'], ['80008', 'rescheduled', '632']]);
  assert.strictEqual(all.unmatched, 2);
  assert.deepStrictEqual(all.ruleCounts, { acute: 1, refused: 1, rescheduled: 2, 'not-available': 1, 'extra-visit': 1 });
  const one = I.buildItems(t, m, { rule: 'not-available', defaultEmployee: '632' });
  assert.deepStrictEqual(one.items.map(i => i.ptid), ['80004']);
  assert.strictEqual(one.filtered, 5);
  assert.ok(/المخطط 2 والمنفذ 1/.test(all.items[4].vars.TASK_MESSAGE));
  assert.ok(all.items.every(i => i.vars.TASK_TITLE.length <= 35));
}

// ===== قائمة المرضى الجدد + صف منزاح (خلايا زائدة في تصدير iCare) =====
{
  const H = ['ID', 'Patient ID', 'Name', 'Company', 'Insurance', 'Doctor', 'Status', 'File Open Time', 'CSheet Visits'];
  const ok1 = ['5001', '70001', 'X', 'Co A', 'Bupa', 'Doctor Alpha', 'Waiting Doctor', '1', '0'];
  const bad = ['5002', '70002', 'X', 'Co B', 'Acute', '', 'MEDGULF', 'MEDGULF', 'Doctor Alpha', '1', '0']; // خليتان زائدتان
  const ok2 = ['5003', '70003', 'X', 'Co C', 'Tawuniya', '', 'Waiting Doctor', '1', '0'];
  const tr = cells => '<tr>' + cells.map(c => '<td x:str>' + c + '</td>').join('') + '</tr>';
  const html = '<html><body><table><tr>' + H.map(h => '<th style="x">' + h + '</th>').join('') + '</tr>' +
    tr(ok1) + tr(bad) + tr(ok2) + '</table></body></html>';
  const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(html, 'utf16le')]);
  const w = I.readWorkbookRows(new Uint8Array(buf), XLSX);
  assert.strictEqual(JSON.stringify(w.misaligned), JSON.stringify([false, false, true, false]));
  const t = I.buildTable(w.rows, w.hidden, w.misaligned);
  const m = I.detectMapping(t.headers);
  assert.strictEqual(m.profile, 'new-files');
  assert.strictEqual(t.headers[m.ptid], 'Patient ID', 'رقم الملف = Patient ID وليس ID');
  assert.strictEqual(t.headers[m.employee], 'Doctor');
  const r = I.buildItems(t, m, { defaultEmployee: '632' });
  assert.strictEqual(JSON.stringify(r.items.map(i => [i.ptid, i.vars.TASK_EMPLOYEE, Boolean(i.misaligned)])),
    JSON.stringify([['70001', 'Doctor Alpha', false], ['70002', '632', true], ['70003', '632', false]]));
  assert.strictEqual(JSON.stringify(r.misalignedPtids), JSON.stringify(['70002']));
  const p = I.PROFILES.find(x => x.id === 'new-files');
  assert.ok(p.title.length <= 35 && /new patients list/i.test(p.message) && !/[؀-ۿ]/.test(p.title + p.message), 'رسالة إنجليزية');
}

console.log('import exit-list + gp-note + new-files tests passed');
