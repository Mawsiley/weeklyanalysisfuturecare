// واجهة chrome وهمية لمعاينة popup.html في متصفح عادي (http://localhost:5178/tests/popup-preview.html)
(function () {
  const loops = [
    { id: 1, name: 'تاسك', steps: [{ type: 'input', value: '{TASK_TITLE}' }, { type: 'customSelect', text: '{TASK_TYPE}' }, { type: 'customSelect', text: '{TASK_PRIORITY}' }, { type: 'customSelect', text: '{TASK_CATEGORY}' }, { type: 'customSelect', text: '{TASK_SUBCATEGORY}' }, { type: 'input', value: '{TASK_EMPLOYEE}' }, { type: 'input', value: '{TASK_MESSAGE}' }], stepDelay: 800, builtinVersion: 11, created: '2026-08-30T00:00:00Z' },
    { id: 2, name: 'حوالة', steps: new Array(7).fill({ type: 'click' }), stepDelay: 1200, userUpdated: true, created: '2026-08-30T00:00:00Z' }
  ];
  const local = { popupLastTab: 'quicktask', loops, pendingSteps: [
    { type: 'navigate', url: 'https://icare.com.sa/patient-info?ptid=%7BPTID%7D' },
    { type: 'click', text: '-- staff --', label: 'Assign To', selector: '#staffBtn' },
    { type: 'input', value: '{TASK_EMPLOYEE}', placeholder: 'Search name or dept…' },
    { type: 'selectFirstOption', match: '{TASK_EMPLOYEE}' }
  ], deactiveList: [{ ptid: '5521', loopName: 'تاسك', status: 'complete', detectedAt: new Date().toISOString(), processedAt: new Date().toISOString() }] };
  const runState = {
    running: false, runId: 1, kind: 'task', loopName: 'تاسك', stepCount: 17, finishedAt: new Date().toISOString(), variables: { TASK_EMPLOYEE: '1225', TASK_TITLE: 'waitting visit' }, startedAt: new Date().toISOString(),
    results: [
      { id: '10021', status: 'done' }, { id: '10022', status: 'done', warning: 'لم تظهر رسالة تأكيد' },
      { id: '10023', status: 'fail', error: 'العنصر غير موجود: [Assign To] -- staff --', trace: [] },
      { id: '10024', status: 'running', attempt: 1 }, { id: '10025', status: 'pending' }
    ]
  };
  // المتبقي من آخر تشغيل (كما يحفظه الـ background)
  local.resumeQueue = { runId: 1, kind: 'task', loopName: 'تاسك', variables: runState.variables, source: { type: 'import', fileName: 'TAKAFUL.xlsx' },
    total: 5, done: 2, running: false, savedAt: new Date().toISOString(),
    items: [{ id: '10023', status: 'fail', error: 'العنصر غير موجود', vars: {} }, { id: '10024', status: 'skipped', vars: {} }, { id: '10025', status: 'skipped', vars: {} }] };
  local.staffDirectory = {
    'doctor alpha': { name: 'Doctor Alpha', id: '1253', source: 'learned', at: new Date().toISOString() },
    'pex department': { name: 'PEx Department', id: '632', source: 'manual', at: new Date().toISOString() }
  };
  window.__simRunning = () => { runState.running = true; delete runState.finishedAt; };
  const area = obj => ({
    get: async keys => { const o = {}; [].concat(keys || Object.keys(obj)).forEach(k => { if (k in obj) o[k] = obj[k]; }); return o; },
    set: async v => Object.assign(obj, v),
    remove: async k => [].concat(k).forEach(x => delete obj[x])
  });
  const handlers = {
    BG_GET_HISTORY: () => ({ ok: true, patients: 2, list: [
      { ptid: "80001", at: new Date(Date.now() - 7200000).toISOString(), loop: "تاسك", employee: "TEST DOCTOR ONE", title: "Would schedule", message: "Eligible for scheduling. Preparation starts after confirmation.", state: "verified", source: "TAKAFUL.xlsx" },
      { ptid: "80002", at: new Date(Date.now() - 7200000).toISOString(), loop: "تاسك", employee: "x", title: "y", message: "sent manually", state: "verified", source: "" },
      { ptid: "10021", at: new Date(Date.now() - 86400000).toISOString(), loop: "تاسك", employee: "1225", title: "waitting visit", message: "there is plan but no visit", state: "unverified" },
      { ptid: "10022", at: new Date(Date.now() - 3 * 86400000).toISOString(), loop: "تاسك", employee: "pex", title: "تواصل", message: "الرجاء معرفة إذا كان المريض يرغب", state: "verified" }] }),
    BG_CHECK_SENT: m => { const h = handlers.BG_GET_HISTORY().list; const sent = {}; m.ptids.forEach(p => { const e = h.filter(x => x.ptid === p); if (e.length) sent[p] = { last: e[0], count: e.length, entries: e }; }); return { ok: true, sent }; },
    BG_AI_REQUEST: m => { window.__aiRequests = (window.__aiRequests || []).concat([m]);
      const hasToolResult = m.messages.some(x => x.role === "tool");
      if (hasToolResult) return { ok: true, message: { content: "سأبقي صفوف Would schedule فقط ثم نجرب على أول ملف. P1 أول ملف.", tool_calls: [] } };
      return { ok: true, message: { content: "", tool_calls: [
        { id: "t1", type: "function", function: { name: "set_import_filter", arguments: JSON.stringify({ keep_values: ["Would schedule"] }) } },
        { id: "t2", type: "function", function: { name: "set_task_fields", arguments: JSON.stringify({ title: "متابعة جدولة", message: "يرجى التواصل مع المريض P1 لتأكيد الموعد" }) } }
      ] } }; },
    BG_GET_LOOPS: () => ({ ok: true, loops }),
    BG_GET_RUN_STATE: () => ({ ok: true, state: runState }),
    // لمعاينة الإيقاف المؤقت: window.__simRunning() يجعل التشغيل "جارياً"
    // ذاكرة أرقام الموظفين (أسماء وهمية)
    BG_GET_STAFF: () => ({ ok: true, directory: local.staffDirectory }),
    BG_SAVE_STAFF: m => { if (!/^\d+$/.test(m.id)) return { ok: false, error: 'الرقم الوظيفي يجب أن يكون أرقاماً فقط' };
      local.staffDirectory[m.name.toLowerCase().trim()] = { name: m.name, id: m.id, source: 'manual', at: new Date().toISOString() }; return { ok: true }; },
    BG_DELETE_STAFF: m => { delete local.staffDirectory[m.key]; return { ok: true }; },
    BG_LEARN_STAFF: m => { let added = 0; (m.values || []).forEach(v => { const x = v.match(/^(\d+)\s*-\s*(.+)$/); if (x) { local.staffDirectory[x[2].toLowerCase()] = { name: x[2], id: x[1], source: 'file', at: new Date().toISOString() }; added++; } }); return { ok: true, added }; },
    BG_CLEAR_RESUME: () => { delete local.resumeQueue; return { ok: true }; },
    BG_PAUSE_RUN: () => { runState.paused = true; return { ok: true }; },
    BG_RESUME_RUN: () => { runState.paused = false; return { ok: true }; },
    BG_GET_DEACTIVE: () => ({ ok: true, list: local.deactiveList }),
    BG_GET_PENDING_STEPS: () => ({ ok: true, steps: local.pendingSteps }),
    BG_SET_PENDING_STEPS: m => { local.pendingSteps = m.steps; return { ok: true }; }
  };
  window.chrome = {
    storage: { local: area(local), session: area({ runLog: [{ ts: Date.now(), ptid: '10024', msg: '✓ 3. input — pex' }] }) },
    runtime: {
      sendMessage: async m => (handlers[m.action] ? handlers[m.action](m) : { ok: true }),
      onMessage: { addListener: () => {} },
      reload: () => {}
    },
    tabs: { query: async () => [{ id: 1 }], reload: async () => {} }
  };
})();
