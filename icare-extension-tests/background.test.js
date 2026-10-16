// اختبار منطق الـ background بدون متصفح: node tests/background.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../icare-extension');

function makeChrome(opts = {}) {
  const store = { local: {}, session: {} };
  const listeners = { message: [], created: [], removed: [], updated: [] };
  const sent = [];
  const groups = {};
  const tabs = new Map([[1, { id: 1, url: 'https://icare.com.sa/home', status: 'complete', active: true, windowId: 1 }]]);
  const area = name => ({
    get: async keys => {
      const out = {};
      const list = keys == null ? Object.keys(store[name]) : [].concat(keys);
      list.forEach(k => { if (k in store[name]) out[k] = JSON.parse(JSON.stringify(store[name][k])); });
      return out;
    },
    set: async obj => { Object.assign(store[name], JSON.parse(JSON.stringify(obj))); },
    remove: async k => { [].concat(k).forEach(x => delete store[name][x]); }
  });
  const chrome = {
    storage: { local: area('local'), session: area('session') },
    runtime: {
      onMessage: { addListener: f => listeners.message.push(f) },
      onInstalled: { addListener: () => {} },
      sendMessage: async m => { sent.push(m); },
      getURL: p => path.join(ROOT, p),
      getPlatformInfo: async () => ({})
    },
    tabs: {
      query: async () => [...tabs.values()],
      get: async id => { if (!tabs.has(id)) throw new Error('no tab'); return { ...tabs.get(id) }; },
      create: async o => { const t = { id: 99, url: o.url, status: 'complete', active: o.active !== false, groupId: -1 }; tabs.set(99, t); return { ...t }; },
      update: async (id, o) => {
        const t = tabs.get(id);
        if ('autoDiscardable' in o) t.autoDiscardable = o.autoDiscardable;
        if (o.url) {
          t.url = o.url;
          setTimeout(() => { listeners.updated.forEach(f => f(id, { status: 'loading' })); listeners.updated.forEach(f => f(id, { status: 'complete' })); }, 5);
        }
        return t;
      },
      group: async ({ tabIds }) => { tabs.get([].concat(tabIds)[0]).groupId = 7; return 7; },
      remove: async id => { tabs.delete(id); },
      sendMessage: async (id, m) => {
        if (m.action === 'PING') return { ok: true };
        if (m.action === 'DETECT_STATUS') return { ok: true, deactive: opts.deactive || '' };
        if (m.action === 'EXECUTE_STEP') return opts.execute(m.step, tabs.get(id));
        return { ok: true };
      },
      onCreated: { addListener: f => listeners.created.push(f) },
      onRemoved: { addListener: f => listeners.removed.push(f) },
      onUpdated: { addListener: f => listeners.updated.push(f), removeListener: f => { listeners.updated = listeners.updated.filter(x => x !== f); } }
    },
    scripting: { executeScript: async () => [] },
    tabGroups: { update: async (id, o) => { groups[id] = { ...(groups[id] || {}), ...o }; } }
  };
  return { chrome, store, sent, tabs, groups };
}

function loadBackground(env) {
  const code = fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  const fetch = async (p, o) => (/^https?:/.test(p) && env.fetchHook) ? env.fetchHook(p, o)
    : ({ ok: true, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) });
  // تسريع الانتظار داخل الاختبار
  const fastTimeout = (fn, ms, ...a) => setTimeout(fn, Math.min(ms || 0, 5), ...a);
  const ctx = vm.createContext({ chrome: env.chrome, fetch, console, URL, setTimeout: fastTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, AbortSignal });
  vm.runInContext(code + '\n;this.__api = { HANDLERS, prepareSteps, replaceVars, urlSatisfies, isCommitStep, getState: () => runState };', ctx);
  return ctx.__api;
}

const fastLoops = env => env.store.local.loops.forEach(l => { l.stepDelay = 5; });
const call = (api, action, extra) => api.HANDLERS[action]({ action, ...(extra || {}) }, {});
const waitDone = async api => { for (let i = 0; i < 6000; i++) { const s = api.getState(); if (s && !s.running && s.finishedAt) return s; await new Promise(r => setTimeout(r, 10)); } throw new Error('run did not finish'); };

(async () => {
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log('✓', name); };

  await test('replaceVars يعوض المتغيرات ويشفّر الروابط', async () => {
    const api = loadBackground(makeChrome({ execute: () => ({ ok: true }) }));
    const r = api.replaceVars({ url: 'https://icare.com.sa/p?ptid=%7BPTID%7D', value: '{TASK_EMPLOYEE}', other: '{UNKNOWN}' },
      { PTID: 'A 1', TASK_EMPLOYEE: 'pex' });
    assert.strictEqual(r.url, 'https://icare.com.sa/p?ptid=A%201');
    assert.strictEqual(r.value, 'pex');
    assert.strictEqual(r.other, '{UNKNOWN}');
  });

  await test('urlSatisfies يقارن المسار ومعاملات الرابط', async () => {
    const api = loadBackground(makeChrome({ execute: () => ({ ok: true }) }));
    assert.ok(api.urlSatisfies('https://icare.com.sa/patient-info?ptid=5&tab=x', 'https://icare.com.sa/patient-info?ptid=5'));
    assert.ok(!api.urlSatisfies('https://icare.com.sa/patient-info?ptid=4', 'https://icare.com.sa/patient-info?ptid=5'));
  });

  await test('prepareSteps يحول القيم لمتغيرات ويضيف خطوة تحقق', async () => {
    const api = loadBackground(makeChrome({ execute: () => ({ ok: true }) }));
    const steps = api.prepareSteps([
      { type: 'navigate', url: 'a' }, { type: 'navigate', url: 'b' },
      { type: 'input', placeholder: 'Search name or dept…', value: 'PEX', timestamp: 1 },
      { type: 'customSelect', text: 'PEX Department' },
      { type: 'input', selector: 'textarea', value: 'رسالة' },
      { type: 'click', text: 'Create Task' }
    ], { TASK_EMPLOYEE: 'pex', TASK_MESSAGE: 'رسالة' });
    assert.strictEqual(JSON.stringify(steps.map(s => s.type)), JSON.stringify(['navigate', 'input', 'selectFirstOption', 'input', 'click', 'verify']));
    assert.strictEqual(steps[0].url, 'b');
    assert.strictEqual(steps[1].value, '{TASK_EMPLOYEE}');
    assert.strictEqual(steps[2].match, '{TASK_EMPLOYEE}');
    assert.strictEqual(steps[3].value, '{TASK_MESSAGE}');
    assert.ok(steps[4].commit);
    assert.ok(!('timestamp' in steps[1]));
  });

  await test('تشغيل لوب تاسك المدمج على 3 ملفات — كل خطوة مرة واحدة', async () => {
    const executed = [];
    const env = makeChrome({ execute: step => { executed.push(step); return { ok: true, verified: step.type === 'verify' ? true : undefined }; } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    const res = await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, ptids: ['101', '102', '102', '103'], delay: 1, taskEmployee: 'pex', taskMessage: 'msg', vars: { TASK_TITLE: 't', TASK_TYPE: 'Medical', TASK_PRIORITY: 'Normal', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR' } });
    assert.ok(res.ok);
    const s = await waitDone(api);
    assert.strictEqual(JSON.stringify(s.results.map(r => r.status)), JSON.stringify(['done', 'done', 'done'])); // التكرار حُذف
    const perPatient = task.steps.filter(x => x.type !== 'navigate').length;
    assert.strictEqual(executed.length, perPatient * 3);
    assert.ok(executed.some(x => x.value === 'pex') && executed.some(x => x.value === 'msg'));
    assert.ok(!executed.some(x => JSON.stringify(x).includes('{TASK_')));
    assert.strictEqual(env.tabs.get(99).url, 'https://icare.com.sa/patient-info?ptid=103');
    assert.strictEqual(env.tabs.get(1).url, 'https://icare.com.sa/home');
  });

  await test('إعادة المحاولة: تعيد قبل الحفظ ولا تعيد بعد الضغط على Create Task', async () => {
    let failBeforeCommit = 1;
    let submits = 0;
    const env = makeChrome({ execute: (step, tab) => {
      if (tab.url.endsWith('=201') && step.type === 'input' && failBeforeCommit-- > 0) return { ok: false, error: 'timeout' };
      if (step.selector === 'button[type="submit"]') { submits++; if (tab.url.endsWith('=202')) return { ok: true }; }
      if (step.type === 'verify' && tab.url.endsWith('=202')) return { ok: false, error: 'رسالة خطأ من iCare' };
      return { ok: true };
    } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, ptids: ['201', '202'], delay: 1, onFail: 'retry', taskEmployee: 'pex', taskMessage: 'm' });
    const s = await waitDone(api);
    assert.strictEqual(s.results[0].status, 'done');
    assert.strictEqual(s.results[0].attempt, 2);
    assert.strictEqual(s.results[1].status, 'fail');
    assert.strictEqual(s.results[1].attempt, 1); // لم يُعد بعد الحفظ
    assert.ok(s.results[1].committed);
    assert.strictEqual(submits, 2); // ضغطة واحدة لكل ملف فقط
  });

  await test('عند الفشل = أوقف: يتوقف ويترك الباقي بدون تنفيذ', async () => {
    const env = makeChrome({ execute: (step, tab) => tab.url.endsWith('=301') ? { ok: false, error: 'x' } : { ok: true } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const hv = loops.find(l => l.name === 'حوالة');
    await call(api, 'BG_START_RUN', { kind: 'handover', loopId: hv.id, ptids: ['301', '302'], delay: 1, onFail: 'stop', handoverStaff: '12161' });
    const s = await waitDone(api);
    assert.strictEqual(JSON.stringify(s.results.map(r => r.status)), JSON.stringify(['fail', 'pending']));
  });

  await test('الملف غير النشط يُسجل في القائمة', async () => {
    const env = makeChrome({ deactive: 'Inactive', execute: () => ({ ok: true }) });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, ptids: ['401'], delay: 1, taskEmployee: 'p', taskMessage: 'm' });
    await waitDone(api);
    const { list } = await call(api, 'BG_GET_DEACTIVE');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].status, 'complete');
  });

  await test('متغيرات التاسك: العنوان مع {PTID}، وتخطي الحقول الفارغة', async () => {
    const executed = [];
    const env = makeChrome({ execute: step => { executed.push(step); return { ok: true }; } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', {
      kind: 'task', loopId: task.id, ptids: ['501'], delay: 1, taskEmployee: 'pex', taskMessage: 'رسالة {PTID}',
      vars: { TASK_TITLE: 'تواصل {PTID}', TASK_TYPE: '', TASK_PRIORITY: 'Important', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: '', EVIL: 'x' }
    });
    const s = await waitDone(api);
    assert.strictEqual(s.results[0].status, 'done');
    const values = executed.map(x => x.value || x.text).filter(Boolean);
    assert.ok(values.includes('تواصل 501'), 'title with PTID');
    assert.ok(values.includes('رسالة 501'), 'message with PTID');
    assert.ok(values.includes('Important') && values.includes('Request'));
    // النوع والفئة الفرعية فارغان ← خطوتا الفتح والاختيار لكل منهما تُتخطى
    const skipped = s.results[0].trace.filter(t => t.status === 'skipped');
    assert.strictEqual(skipped.length, 4);
    assert.ok(!('EVIL' in s.variables));
  });

  await test('إعادة التسجيل: اختيارات القوائم المطابقة تصبح متغيرات', async () => {
    const api = loadBackground(makeChrome({ execute: () => ({ ok: true }) }));
    const steps = api.prepareSteps([
      { type: 'customSelect', text: 'Request' }, { type: 'customSelect', text: 'DR' },
      { type: 'input', selector: 'input.title', value: 'تواصل' }, { type: 'click', text: 'إنشاء المهمة' }
    ], { TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR', TASK_TITLE: 'تواصل' });
    assert.strictEqual(steps[0].text, '{TASK_CATEGORY}');
    assert.strictEqual(steps[1].text, '{TASK_SUBCATEGORY}');
    assert.strictEqual(steps[2].value, '{TASK_TITLE}');
  });

  await test('حقل النوع غير موجود في نموذج Quick Task ← تنبيه ويكمل ويُنشئ التاسك', async () => {
    const executed = [];
    const env = makeChrome({ execute: step => {
      executed.push(step);
      if (step.group === 'type' && step.type === 'click') return { ok: false, error: 'العنصر غير موجود: [النوع|Type]' };
      if (step.group === 'priority' && step.type === 'customSelect') return { ok: false, error: 'الخيار غير موجود' };
      return { ok: true };
    } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, ptids: ['601'], delay: 1, taskEmployee: 'pex', taskMessage: 'm',
      vars: { TASK_TITLE: 't', TASK_TYPE: 'Medical', TASK_PRIORITY: 'Important', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR' } });
    const s = await waitDone(api);
    const r = s.results[0];
    assert.strictEqual(r.status, 'done', r.error);
    assert.ok(/النوع/.test(r.warning) && /Important/.test(r.warning), r.warning);
    // لم يُنفذ اختيار "Medical" بعد فشل فتح القائمة، وأُرسل Escape بعد فشل اختيار الأولوية
    assert.ok(!executed.some(x => x.type === 'customSelect' && x.text === 'Medical'));
    assert.ok(executed.some(x => x.type === 'escape'));
    assert.ok(executed.some(x => x.selector === 'button[type="submit"]'));
  });

  await test('استيراد Excel: تقرير Rad. Reports ← عناصر بطبيب وعنوان ورسالة لكل صف', async () => {
    const T = require(path.join(ROOT, 'lib/import.js'));
    const rows = [
      [], [],
      ['', 'Report Doctor', 'Priority', 'Status', '', 'Patient', 'PTID', 'Insurance Card No', 'City', 'Error / Rejection Reason'],
      ['', 'MOHAMED ALI', 'Secondary', 'Rejected', 'Lab', 'X', 41531, '1', 'RUH', 'processNotes: PLZ ATTACH PREVIOUS INVS | disposition: rejected'],
      ['', 'Ryan Omer', 'Primary', 'Rejected', 'Rad', 'Y', '36163.0', '2', 'JED', 'processNotes: - Please attach report | disposition: rejected'],
      ['', 'MOHAMED ALI', 'Secondary', 'Rejected', 'Lab', 'X', 41531, '1', 'RUH', 'processNotes: PLZ ATTACH PREVIOUS INVS | disposition: rejected'],
      ['', 'MOHAMED ALI', 'Primary', 'Rejected', 'Rad', 'X', 41531, '1', 'RUH', 'processNotes: another reason | disposition: rejected'],
      ['', 'no ptid', '', '', '', '', '', '', '', 'x']
    ];
    const table = T.buildTable(rows);
    assert.strictEqual(table.headerRow, 2);
    const m = T.detectMapping(table.headers);
    assert.strictEqual(table.headers[m.ptid], 'PTID');
    assert.strictEqual(table.headers[m.employee], 'Report Doctor');
    assert.strictEqual(table.headers[m.title], 'Status');
    assert.strictEqual(table.headers[m.message], 'Error / Rejection Reason');
    const r = T.buildItems(table, m);
    assert.strictEqual(r.items.length, 3);   // صف مكرر بالكامل حُذف
    assert.strictEqual(r.duplicates, 1);
    assert.strictEqual(r.skipped, 1);         // صف بلا رقم ملف
    assert.strictEqual(r.items[0].ptid, '41531');
    assert.strictEqual(r.items[1].ptid, '36163');
    assert.strictEqual(r.items[0].vars.TASK_MESSAGE, 'PLZ ATTACH PREVIOUS INVS');
    assert.strictEqual(r.items[1].vars.TASK_MESSAGE, 'Please attach report');
    assert.strictEqual(r.items[0].vars.TASK_TITLE, 'Rejected');
  });

  await test('تشغيل بعناصر مستوردة: قيم كل صف تُطبق، ونفس المريض بتاسكين', async () => {
    const executed = [];
    const env = makeChrome({ execute: (step, tab) => { executed.push({ step, url: tab.url }); return { ok: true }; } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', {
      kind: 'task', loopId: task.id, delay: 1, taskEmployee: 'pex', taskMessage: 'fallback msg',
      vars: { TASK_TITLE: 'fallback title', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR' },
      items: [
        { ptid: '41531', vars: { TASK_EMPLOYEE: 'MOHAMED ALI', TASK_TITLE: 'Rejected', TASK_MESSAGE: 'reason A', EVIL: 'x' } },
        { ptid: '41531', vars: { TASK_EMPLOYEE: 'MOHAMED ALI', TASK_TITLE: 'Rejected', TASK_MESSAGE: 'reason B' } },
        { ptid: '36163', vars: { TASK_EMPLOYEE: 'Ryan Omer' } }
      ],
      source: { type: 'import', fileName: 'Rad. Reports.xls' }
    });
    const s = await waitDone(api);
    assert.strictEqual(JSON.stringify(s.results.map(r => r.status)), JSON.stringify(['done', 'done', 'done']));
    const values = executed.map(x => x.step.value || x.step.text || x.step.match).filter(Boolean);
    assert.ok(values.includes('reason A') && values.includes('reason B'));
    assert.ok(values.includes('Ryan Omer'));
    assert.ok(values.includes('fallback title') && values.includes('fallback msg')); // صف 3 يأخذ من التبويب
    assert.ok(!('EVIL' in s.results[0].vars));
    assert.strictEqual(s.source.fileName, 'Rad. Reports.xls');
  });

  await test('سجل التاسكات المرسلة: يُحفظ الناجح وغير المؤكد وما بعد الحفظ، ويُكشف عند الطلب', async () => {
    const env = makeChrome({ execute: (step, tab) => {
      if (tab.url.endsWith('=702') && step.type === 'verify') return { ok: true, verified: false, target: 'لم تظهر رسالة تأكيد' };
      if (tab.url.endsWith('=703') && step.type === 'verify') return { ok: false, error: 'رسالة خطأ من iCare' };
      if (tab.url.endsWith('=704') && step.type === 'input') return { ok: false, error: 'timeout' };
      return { ok: true, verified: step.type === 'verify' ? true : undefined };
    } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, ptids: ['701', '702', '703', '704'], delay: 1,
      taskEmployee: 'pex', taskMessage: 'رسالة {PTID}', vars: { TASK_TITLE: 'تواصل' } });
    await waitDone(api);
    const h = await call(api, 'BG_GET_HISTORY');
    const states = Object.fromEntries(h.list.map(e => [e.ptid, e.state]));
    assert.strictEqual(states['701'], 'verified');
    assert.strictEqual(states['702'], 'unverified');
    assert.strictEqual(states['703'], 'uncertain');   // فشل بعد الضغط على الحفظ — ربما أُنشئ
    assert.ok(!('704' in states));                     // فشل قبل الحفظ — لم يُرسل
    assert.strictEqual(h.list.find(e => e.ptid === '701').message, 'رسالة 701');

    const check = await call(api, 'BG_CHECK_SENT', { ptids: ['701', '704', '999'], loopName: 'تاسك' });
    assert.strictEqual(JSON.stringify(Object.keys(check.sent)), JSON.stringify(['701']));
    const otherLoop = await call(api, 'BG_CHECK_SENT', { ptids: ['701'], loopName: 'حوالة' });
    assert.strictEqual(Object.keys(otherLoop.sent).length, 0);

    await call(api, 'BG_REMOVE_HISTORY', { ptid: '701' });
    const after = await call(api, 'BG_CHECK_SENT', { ptids: ['701'], loopName: 'تاسك' });
    assert.strictEqual(Object.keys(after.sent).length, 0);
  });

  await test('استيراد TAKAFUL schedule-plan: Case Doctor + تصفية Status + الطبيب "—"', async () => {
    const T = require(path.join(ROOT, 'lib/import.js'));
    const rows = [
      ['PTID', 'Patient Name', 'Medical Record No.', 'Insurance Company', 'City', 'Status', 'Reason', 'Case Doctor', 'National ID'],
      [29369, 'A', '349361', 'Takaful', 'RUH', 'Would schedule', 'Eligible for scheduling. Preparation starts after confirmation.', 'DOCTOR ONE', '1'],
      [39834, 'B', '353749', 'Takaful', 'RUH', 'Skipped', 'No Primary medical record (Pres_Type=1) exists for this patient.', 'DOCTOR TWO', '2'],
      [40001, 'C', '353750', 'Takaful', 'JED', 'Would schedule', 'Eligible for scheduling.', '—', '3']
    ];
    const table = T.buildTable(rows);
    const m = T.detectMapping(table.headers);
    assert.strictEqual(table.headers[m.ptid], 'PTID');            // وليس Medical Record No.
    assert.strictEqual(table.headers[m.employee], 'Case Doctor');
    assert.strictEqual(table.headers[m.title], 'Status');
    assert.strictEqual(table.headers[m.message], 'Reason');
    const all = T.buildItems(table, m);
    assert.strictEqual(all.items.length, 3);
    assert.ok(!('TASK_EMPLOYEE' in all.items[2].vars));          // "—" = فارغ ← من إعدادات التبويب
    const withDefault = T.buildItems(table, m, { defaultEmployee: '632' });
    assert.strictEqual(withDefault.items[2].vars.TASK_EMPLOYEE, '632');           // بلا طبيب ← 632
    assert.strictEqual(withDefault.items[0].vars.TASK_EMPLOYEE, 'DOCTOR ONE');    // الباقي كما هو
    const f = T.buildItems(table, m, { filter: { col: m.title, exclude: ['Skipped'] } });
    assert.strictEqual(JSON.stringify(f.items.map(i => i.ptid)), JSON.stringify(['29369', '40001']));
    assert.strictEqual(f.filtered, 1);
    assert.strictEqual(JSON.stringify(T.distinctValues(table, m.title)),
      JSON.stringify([{ value: 'Would schedule', count: 2 }, { value: 'Skipped', count: 1 }]));
  });

  await test('التشغيل في الخلفية: تبويب مخصص غير نشط، مجمّع، لا يُفرَّغ، وتبويب المستخدم لا يُلمس', async () => {
    let discardableDuringRun = null;
    const env = makeChrome({ execute: (step, tab) => {
      if (discardableDuringRun === null) discardableDuringRun = tab.autoDiscardable;
      return { ok: true, verified: step.type === 'verify' ? true : undefined };
    } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, ptids: ['801'], delay: 1, taskEmployee: 'pex', taskMessage: 'm', vars: { TASK_TITLE: 't' } });
    const s = await waitDone(api);
    const runTab = env.tabs.get(99);
    assert.ok(runTab, 'run tab created');
    assert.strictEqual(runTab.active, false);                       // لا يسرق التركيز
    assert.strictEqual(s.tabId, 99);
    assert.strictEqual(discardableDuringRun, false);                // محمي أثناء التشغيل
    assert.strictEqual(runTab.autoDiscardable, true);               // يعود طبيعياً بعد الانتهاء
    assert.strictEqual(env.tabs.get(1).url, 'https://icare.com.sa/home');
    assert.ok(/✓ iCare Loop/.test(env.groups[7].title), env.groups[7] && env.groups[7].title);

    // الخيار "التبويب الحالي" يستخدم تبويب iCare المفتوح
    const env2 = makeChrome({ execute: () => ({ ok: true }) });
    const api2 = loadBackground(env2);
    const r2 = await call(api2, 'BG_GET_LOOPS'); fastLoops(env2);
    await call(api2, 'BG_START_RUN', { kind: 'task', loopId: r2.loops.find(l => l.name === 'تاسك').id, ptids: ['802'], delay: 1,
      taskEmployee: 'pex', taskMessage: 'm', vars: { TASK_TITLE: 't' }, runIn: 'current' });
    const s2 = await waitDone(api2);
    assert.strictEqual(s2.tabId, 1);
    assert.ok(!env2.tabs.has(99));

    // BG_SLEEP: نوم يطلبه تبويب مخفي
    const t0 = Date.now();
    const sl = await call(api, 'BG_SLEEP', { ms: 20 });
    assert.ok(sl.ok && Date.now() - t0 >= 0);
  });

  await test('استيراد: الصفوف المخفية بفلتر Excel تُستبعد (الظاهرة فقط)', async () => {
    const XLSX = require(path.join(ROOT, 'lib/sheetjs/xlsx.full.min.js'));
    const T = require(path.join(ROOT, 'lib/import.js'));
    const aoa = [['PTID', 'Status', 'Reason', 'Case Doctor'],
      [1001, 'Would schedule', 'r1', 'D1'], [1002, 'Skipped', 'r2', 'D2'], [1003, 'Would schedule', 'r3', 'D3'], [1004, 'Skipped', 'r4', '—']];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!rows'] = [null, { hidden: true }, null, { hidden: true }, null]; // صفا Excel 2 و4 مخفيان
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
    const data = new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    const { rows, hidden } = T.readWorkbookRows(data, XLSX);
    const table = T.buildTable(rows, hidden);
    assert.strictEqual(JSON.stringify(table.hidden), JSON.stringify([true, false, true, false]));
    const m = T.detectMapping(table.headers);
    const vis = T.buildItems(table, m, { skipHidden: true, defaultEmployee: '632' });
    assert.strictEqual(JSON.stringify(vis.items.map(i => i.ptid)), JSON.stringify(['1002', '1004']));
    assert.strictEqual(vis.hiddenSkipped, 2);
    assert.strictEqual(vis.items[1].vars.TASK_EMPLOYEE, '632');
    const all = T.buildItems(table, m, { skipHidden: false });
    assert.strictEqual(all.items.length, 4);
    fs.writeFileSync(path.join(__dirname, 'fixtures/hidden-rows-sample.xlsx'), data);
  });

  await test('ملفات Excel التي تحفظها الإضافة تُستورد مرة أخرى بنفس القيم (round-trip)', async () => {
    const XLSX = require(path.join(ROOT, 'lib/sheetjs/xlsx.full.min.js'));
    const T = require(path.join(ROOT, 'lib/import.js'));
    // كاتب Excel الخاص بالإضافة (lib/xlsx.js) يعمل على window
    const sandbox = { window: {}, TextEncoder, Blob };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'lib/xlsx.js'), 'utf8'), sandbox);
    // نفس الأعمدة التي يكتبها popup.js عند الحفظ
    const headers = ['PTID', 'Case Doctor', 'Status', 'Reason', 'Task Type', 'Task Priority', 'Task Category', 'Task Subcategory',
      'نتيجة التشغيل', 'تفاصيل', 'الخطوة المتوقفة', 'وقت الانتهاء', 'اللوب'];
    const rows = [
      ['40915', '632', 'Skipped', 'No Primary medical record', '', 'Important', 'Request', 'DR', 'فشل', 'العنصر غير موجود: Quick Task', '2. click', '28/09/2026', 'تاسك'],
      ['40958', 'Awad Abdelmonim', 'Would schedule', 'Eligible', 'Medical', '', 'Request', 'PT', 'تم — غير مؤكد', 'لم تظهر رسالة تأكيد', '', '', 'تاسك']
    ];
    const blob = sandbox.window.buildXlsx({ sheetName: 'فاشلة', headers, rows, rtl: true });
    const data = new Uint8Array(await blob.arrayBuffer());
    const read = T.readWorkbookRows(data, XLSX);
    const table = T.buildTable(read.rows, read.hidden);
    const m = T.detectMapping(table.headers);
    assert.strictEqual(table.headers[m.ptid], 'PTID');
    assert.strictEqual(table.headers[m.employee], 'Case Doctor');
    assert.strictEqual(table.headers[m.title], 'Status');          // وليس "نتيجة التشغيل"
    assert.strictEqual(table.headers[m.message], 'Reason');        // وليس "تفاصيل" (نص الخطأ)
    const items = T.buildItems(table, m).items;
    assert.strictEqual(items.length, 2);
    assert.strictEqual(JSON.stringify(items[0].vars), JSON.stringify({
      TASK_EMPLOYEE: '632', TASK_TITLE: 'Skipped', TASK_MESSAGE: 'No Primary medical record',
      TASK_PRIORITY: 'Important', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR' }));
    assert.strictEqual(items[1].vars.TASK_TYPE, 'Medical');
    assert.strictEqual(items[1].vars.TASK_SUBCATEGORY, 'PT');
    // عمود "Priority" في تقارير خارجية (Primary/Secondary) لا يُربط بأولوية التاسك
    const ext = T.buildTable([['PTID', 'Priority', 'Status', 'Reason'], [1, 'Primary', 'Rejected', 'x']]);
    assert.ok(!('TASK_PRIORITY' in T.buildItems(ext, T.detectMapping(ext.headers)).items[0].vars));
  });

  await test('🤖 المساعد: لا إرسال بدون موافقة ومفتاح، وصيغة الطلب لـ DeepSeek صحيحة، والأخطاء واضحة', async () => {
    const env = makeChrome({ execute: () => ({ ok: true }) });
    let lastReq = null;
    let status = 200;
    env.fetchHook = async (url, opts) => {
      lastReq = { url, opts, body: JSON.parse(opts.body) };
      if (status !== 200) return { ok: false, status, text: async () => 'err' };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'مرحباً',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'start_test_run', arguments: '{}' } }] } }], usage: { total_tokens: 42 } }) };
    };
    const api = loadBackground(env);
    const req = { messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'start_test_run', parameters: {} } }] };

    let r = await call(api, 'BG_AI_REQUEST', req);
    assert.ok(!r.ok && /الموافقة/.test(r.error) && lastReq === null);           // بدون موافقة: لا طلب
    env.store.local.aiSettings = { consent: true, model: 'deepseek-chat' };
    r = await call(api, 'BG_AI_REQUEST', req);
    assert.ok(!r.ok && /مفتاح/.test(r.error) && lastReq === null);             // بدون مفتاح: لا طلب

    env.store.local.aiApiKey = 'sk-test-123';
    r = await call(api, 'BG_AI_REQUEST', req);
    assert.ok(r.ok, r.error);
    assert.strictEqual(lastReq.url, 'https://api.deepseek.com/chat/completions');
    assert.strictEqual(lastReq.opts.headers.Authorization, 'Bearer sk-test-123');
    assert.strictEqual(lastReq.body.model, 'deepseek-chat');
    assert.strictEqual(lastReq.body.tool_choice, 'auto');
    assert.strictEqual(r.message.content, 'مرحباً');
    assert.strictEqual(r.message.tool_calls[0].function.name, 'start_test_run');
    assert.ok(!JSON.stringify(r).includes('sk-test'));                          // المفتاح لا يعود للـ popup

    status = 401; r = await call(api, 'BG_AI_REQUEST', req);
    assert.ok(!r.ok && /غير صحيح/.test(r.error));
    status = 402; r = await call(api, 'BG_AI_REQUEST', req);
    assert.ok(!r.ok && /رصيد/.test(r.error));
  });

  await test('إيقاف مؤقت بعد اكتمال الملف الحالي ثم استئناف، والإيقاف أثناء التوقف المؤقت', async () => {
    const vars = { TASK_TITLE: 't', TASK_TYPE: 'Medical', TASK_PRIORITY: 'Normal', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR' };
    const sleepMs = ms => new Promise(r => setTimeout(r, ms));
    for (const mode of ['resume', 'stop']) {
      let api;
      let verifies = 0;
      const env = makeChrome({ execute: step => {
        // طلب الإيقاف المؤقت أثناء تنفيذ الملف الأول — يجب أن يكتمل الملف أولاً
        if (step.type === 'verify' && ++verifies === 1) call(api, 'BG_PAUSE_RUN');
        return { ok: true, verified: step.type === 'verify' ? true : undefined };
      } });
      api = loadBackground(env);
      const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
      const task = loops.find(l => l.name === 'تاسك');
      assert.ok((await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, ptids: ['201', '202', '203'], delay: 1, taskEmployee: 'pex', taskMessage: 'm', vars })).ok);
      for (let i = 0; i < 3000 && api.getState().results[0].status !== 'done'; i++) await sleepMs(10);
      await sleepMs(150);
      let s = api.getState();
      assert.ok(s.running && s.paused, JSON.stringify({ running: s.running, paused: s.paused, st: s.results.map(r => r.status + (r.error || "")), verifies }));
      assert.strictEqual(JSON.stringify(s.results.map(r => r.status)), JSON.stringify(['done', 'pending', 'pending'])); // لم يبدأ الملف التالي
      assert.strictEqual(verifies, 1);
      if (mode === 'resume') {
        assert.ok((await call(api, 'BG_RESUME_RUN')).ok);
        s = await waitDone(api);
        assert.strictEqual(JSON.stringify(s.results.map(r => r.status)), JSON.stringify(['done', 'done', 'done']));
      } else {
        await call(api, 'BG_STOP_RUN');
        s = await waitDone(api);
        assert.strictEqual(JSON.stringify(s.results.map(r => r.status)), JSON.stringify(['done', 'skipped', 'skipped']));
        assert.ok(!s.paused);
      }
    }
    // بدون تشغيل جارٍ
    const idle = loadBackground(makeChrome({ execute: () => ({ ok: true }) }));
    assert.ok(!(await call(idle, 'BG_PAUSE_RUN')).ok);
  });

  await test('قائمة المتبقي تُحفظ في storage.local عند الإيقاف وتُحذف عند الاكتمال وتبقى بعد إعادة تشغيل المتصفح', async () => {
    const vars = { TASK_TITLE: 't', TASK_TYPE: 'Medical', TASK_PRIORITY: 'Normal', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR' };
    let api;
    let verifies = 0;
    const env = makeChrome({ execute: step => {
      if (step.type === 'verify' && ++verifies === 1) call(api, 'BG_STOP_RUN');
      return { ok: true, verified: step.type === 'verify' ? true : undefined };
    } });
    api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, delay: 1, taskEmployee: 'pex', taskMessage: 'm', vars,
      items: [{ ptid: '301', vars: { TASK_EMPLOYEE: 'A' } }, { ptid: '302', vars: { TASK_EMPLOYEE: 'B' }, row: 5 }, { ptid: '303' }],
      source: { type: 'import', fileName: 'f.xlsx' } });
    await waitDone(api);
    let q = env.store.local.resumeQueue;
    assert.ok(q, 'المتبقي محفوظ');
    assert.strictEqual(JSON.stringify(q.items.map(i => [i.id, i.status])), JSON.stringify([['302', 'skipped'], ['303', 'skipped']]));
    assert.strictEqual(q.items[0].vars.TASK_EMPLOYEE, 'B');
    assert.strictEqual(q.items[0].row, 5);
    assert.strictEqual(q.loopName, 'تاسك');
    assert.strictEqual(q.source.fileName, 'f.xlsx');
    assert.ok(!q.running && q.done === 1 && q.total === 3);

    // الإكمال: تشغيل جديد ينجح كله ← تُحذف القائمة
    verifies = 10;
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, delay: 1, taskEmployee: 'pex', taskMessage: 'm', vars,
      items: q.items.map(i => ({ ptid: i.id, vars: i.vars, row: i.row })) });
    await waitDone(api);
    assert.ok(!('resumeQueue' in env.store.local), 'تُحذف بعد اكتمال الكل');

    // إعادة تشغيل المتصفح أثناء تشغيل: session فارغ، والقائمة تبقى ويُعلَّم الملف الجاري كمنقطع
    const env2 = makeChrome({ execute: () => ({ ok: true }) });
    env2.store.local.resumeQueue = { kind: 'task', loopName: 'تاسك', running: true, items: [{ id: '401', status: 'running' }, { id: '402', status: 'pending' }] };
    loadBackground(env2);
    for (let i = 0; i < 50 && env2.store.local.resumeQueue.running; i++) await new Promise(r => setTimeout(r, 10));
    q = env2.store.local.resumeQueue;
    assert.ok(!q.running && q.interrupted);
    assert.strictEqual(q.items[0].status, 'fail');
    assert.ok(/انقطع/.test(q.items[0].error));
    assert.strictEqual(q.items[1].status, 'pending');

    const cleared = await call(loadBackground(env2), 'BG_CLEAR_RESUME');
    assert.ok(cleared.ok && !('resumeQueue' in env2.store.local));
  });

  await test('ذاكرة أرقام الموظفين: استبدال الاسم بالرقم، التعلم من الخيار المختار، وأولوية الإدخال اليدوي', async () => {
    const vars = { TASK_TITLE: 't', TASK_TYPE: 'Medical', TASK_PRIORITY: 'Normal', TASK_CATEGORY: 'Request', TASK_SUBCATEGORY: 'DR' };
    const seen = [];
    const env = makeChrome({ execute: step => {
      if (step.type === 'selectFirstOption') {
        seen.push(step.match);
        const picked = step.match === '1253' ? '1253 - Awad Osman' : step.match === 'Doctor Beta' ? '777 - Doctor Beta' : step.match;
        return { ok: true, picked };
      }
      return { ok: true, verified: step.type === 'verify' ? true : undefined };
    } });
    const api = loadBackground(env);
    const { loops } = await call(api, 'BG_GET_LOOPS'); fastLoops(env);
    const task = loops.find(l => l.name === 'تاسك');

    assert.ok(!(await call(api, 'BG_SAVE_STAFF', { name: 'x', id: '12a' })).ok);
    assert.ok((await call(api, 'BG_SAVE_STAFF', { name: 'Dr. Awad  Osman', id: '1253' })).ok);
    await call(api, 'BG_START_RUN', { kind: 'task', loopId: task.id, delay: 1, taskMessage: 'm', vars,
      items: [{ ptid: '501', vars: { TASK_EMPLOYEE: 'awad osman' } }, { ptid: '502', vars: { TASK_EMPLOYEE: 'Doctor Beta' } }, { ptid: '503', vars: { TASK_EMPLOYEE: '632' } }, { ptid: '504', vars: { TASK_EMPLOYEE: '544 - AYAT BRIMA' } }] });
    const s = await waitDone(api);
    assert.strictEqual(JSON.stringify(s.results.map(r => r.status)), JSON.stringify(['done', 'done', 'done', 'done']));
    assert.strictEqual(JSON.stringify(seen), JSON.stringify(['1253', 'Doctor Beta', '632', '544'])); // الاسم المحفوظ بُحث برقمه

    const { directory } = await call(api, 'BG_GET_STAFF');
    assert.strictEqual(directory['awad osman'].id, '1253');
    assert.strictEqual(directory['awad osman'].source, 'manual');               // لم يُستبدل بالمتعلَّم
    assert.strictEqual(directory['doctor beta'].id, '777');                      // تعلّم من الخيار المختار
    assert.strictEqual(directory['doctor beta'].source, 'learned');
    assert.ok(!Object.values(directory).some(e => e.name === '632'));

    // من ملف Excel (عمود Staff)
    const r = await call(api, 'BG_LEARN_STAFF', { values: ['544 - AYAT BRIMA', 'no id here', '12161 - abdullah elnagar', '1253 - Other Name'] });
    assert.strictEqual(r.added, 3);
    const d2 = (await call(api, 'BG_GET_STAFF')).directory;
    assert.strictEqual(d2['ayat brima'].id, '544');
    assert.strictEqual(d2['awad osman'].id, '1253');

    await call(api, 'BG_DELETE_STAFF', { key: 'ayat brima' });
    assert.ok(!(await call(api, 'BG_GET_STAFF')).directory['ayat brima']);
  });

  console.log('\n' + passed + ' tests passed');
})().catch(e => { console.error('✗ FAILED:', e); process.exit(1); });
