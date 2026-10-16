// FutureCare Weekly: iCare performance report fetch for the weekly analysis site (separate scope).
if (typeof importScripts === 'function') importScripts('weekly.js');

/**
 * iCare Loop Recorder — Background Service Worker  v1.3
 * يدير: جلسة التسجيل (قائمة خطوات مركزية)، تشغيل اللوب على قائمة مرضى، التخزين
 */

const ICARE_URLS = ['https://icare.com.sa/*', 'https://*.icare.com.sa/*'];
const ICARE_ORIGIN = 'https://icare.com.sa';
// المساعد: DeepSeek (واجهة متوافقة مع OpenAI)
const AI_ENDPOINT = 'https://api.deepseek.com/chat/completions';
// المتغيرات المتاحة داخل خطوات اللوب بصيغة {NAME}
const VAR_NAMES = [
  'PTID', 'DATE',
  'TASK_EMPLOYEE', 'TASK_MESSAGE', 'TASK_TITLE',
  'TASK_TYPE', 'TASK_PRIORITY', 'TASK_CATEGORY', 'TASK_SUBCATEGORY',
  'HANDOVER_STAFF'
];
// متغيرات قيمها تُختار من قائمة (تتحول لمتغير عند إعادة التسجيل إذا طابق الاختيار قيمتها)
const SELECT_VARS = ['TASK_TYPE', 'TASK_PRIORITY', 'TASK_CATEGORY', 'TASK_SUBCATEGORY'];
const BUILTIN_LOOPS = [
  { file: 'loops/task-loop.json', name: 'تاسك' },
  { file: 'loops/handover-loop.json', name: 'حوالة' }
];
// خطوات تفتح نافذة/تبويب أو تغيّر الصفحة — ننتظر بعدها لاكتشاف تبويب جديد.
const CLICK_LIKE = ['click', 'clickText', 'customSelect', 'selectFirstOption', 'key'];

let runState = null;
let keepAliveTimer = null;
let runOpenedTabs = new Set(); // تبويبات فتحها iCare أثناء التشغيل الحالي
let recQueue = Promise.resolve();
let historyQueue = Promise.resolve(); // كتابة السجل بالتسلسل
const HISTORY_PER_PTID = 10;

// ============================================================
// ===== استعادة حالة التشغيل بعد إعادة تشغيل الـ Service Worker =====
// ============================================================
const restoredState = chrome.storage.session.get('runState').then(async ({ runState: saved }) => {
  if (!saved) {
    // أُعيد تشغيل المتصفح أثناء تشغيل: الحالة المؤقتة مُسحت، لكن قائمة الإكمال محفوظة
    const { resumeQueue } = await chrome.storage.local.get('resumeQueue');
    if (resumeQueue && resumeQueue.running) {
      resumeQueue.running = false;
      resumeQueue.interrupted = true;
      resumeQueue.items.forEach(it => {
        if (it.status === 'running') { it.status = 'fail'; it.error = 'انقطع التشغيل (أُغلق المتصفح) أثناء هذا الملف — تحقق منه'; }
      });
      await chrome.storage.local.set({ resumeQueue });
    }
    return;
  }
  runState = saved;
  if (!saved.historyRecorded) {
    saved.results.forEach(r => { if (shouldRecord(r)) recordSent(r, saved); });
    saved.historyRecorded = true;
  }
  if (saved.running) {
    // التشغيل انقطع (أُغلق المتصفح أو توقف الـ worker) — لا نستأنف تلقائياً لتجنب التكرار.
    runState.running = false;
    runState.paused = false;
    runState.interrupted = true;
    runState.results.forEach(r => {
      if (r.status === 'running') { r.status = 'fail'; r.error = 'انقطع التشغيل قبل اكتمال هذا الملف — تحقق منه يدوياً'; }
    });
    persistRunState();
  }
}).catch(() => {});

// ============================================================
// ===== الرسائل =====
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg.action];
  if (!handler) return false; // رسائل موجهة للـ popup (LOG_UPDATE ...)
  (async () => {
    try {
      await restoredState;
      sendResponse(await handler(msg, sender));
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

const HANDLERS = {
  // ---------- التسجيل ----------
  async BG_START_RECORDING() {
    const tab = await getIcareTab({ preferActive: true });
    if (!tab) return { ok: false, error: 'افتح iCare في تبويب أولاً' };
    await chrome.storage.local.set({
      isRecording: true,
      recordingTabId: tab.id,
      recordingWindowId: tab.windowId,
      recordingSessionTabs: [tab.id],
      pendingSteps: []
    });
    await ensureContentScript(tab.id, true);
    await chrome.tabs.sendMessage(tab.id, { action: 'START_RECORDING' }).catch(() => {});
    return { ok: true, tabId: tab.id };
  },

  async BG_GET_RECORDING_CONTEXT(msg, sender) {
    const state = await chrome.storage.local.get(['isRecording', 'recordingSessionTabs', 'recordingTabId']);
    const tab = sender.tab;
    if (!state.isRecording || !tab) return { ok: true, recording: false };
    const sessionTabs = state.recordingSessionTabs || [];
    const belongs = sessionTabs.includes(tab.id) || sessionTabs.includes(tab.openerTabId);
    if (belongs && !sessionTabs.includes(tab.id)) {
      await chrome.storage.local.set({ recordingSessionTabs: [...sessionTabs, tab.id] });
    }
    return { ok: true, recording: belongs };
  },

  async REC_STEP(msg, sender) {
    // طابور تسلسلي: الخطوات من عدة إطارات/تبويبات لا تكتب فوق بعضها.
    recQueue = recQueue.then(() => appendRecordedStep(msg, sender)).catch(() => {});
    await recQueue;
    return { ok: true };
  },

  async BG_STOP_RECORDING() {
    const { recordingSessionTabs = [] } = await chrome.storage.local.get('recordingSessionTabs');
    await chrome.storage.local.set({ isRecording: false });
    await Promise.all(recordingSessionTabs.map(id =>
      chrome.tabs.sendMessage(id, { action: 'STOP_RECORDING' }).catch(() => {})));
    await recQueue;
    const { pendingSteps = [] } = await chrome.storage.local.get('pendingSteps');
    return { ok: true, steps: pendingSteps };
  },

  async BG_GET_PENDING_STEPS() {
    const { pendingSteps = [] } = await chrome.storage.local.get('pendingSteps');
    return { ok: true, steps: pendingSteps };
  },

  async BG_SET_PENDING_STEPS(msg) {
    await recQueue;
    await chrome.storage.local.set({ pendingSteps: Array.isArray(msg.steps) ? msg.steps : [] });
    return { ok: true };
  },

  // ---------- اللوبات ----------
  async BG_GET_LOOPS() {
    return { ok: true, loops: await ensureBundledLoops() };
  },

  async BG_SAVE_LOOP(msg) {
    const { loops = [] } = await chrome.storage.local.get('loops');
    const name = String(msg.name || '').trim();
    if (!name) return { ok: false, error: 'اسم اللوب مطلوب' };
    if (!Array.isArray(msg.steps) || !msg.steps.length) return { ok: false, error: 'لا توجد خطوات' };

    let idx = msg.replaceId ? loops.findIndex(l => l.id === msg.replaceId) : -1;
    if (idx < 0) idx = loops.findIndex(l => l.name === name);
    const previous = idx >= 0 ? loops[idx] : null;
    const isBuiltin = BUILTIN_LOOPS.some(b => b.name === name);

    const loop = {
      id: previous ? previous.id : Date.now(),
      name,
      desc: msg.desc || '',
      steps: prepareSteps(msg.steps, msg.vars),
      stepDelay: Number(msg.stepDelay) || 800,
      created: previous ? previous.created : new Date().toISOString(),
      updated: new Date().toISOString(),
      userUpdated: isBuiltin || undefined,
      builtinVersion: previous ? previous.builtinVersion : undefined
    };
    if (idx >= 0) loops[idx] = loop; else loops.push(loop);
    await chrome.storage.local.set({ loops, pendingSteps: [] });
    return { ok: true, loop };
  },

  async BG_DELETE_LOOP(msg) {
    const { loops = [] } = await chrome.storage.local.get('loops');
    await chrome.storage.local.set({ loops: loops.filter(l => l.id !== msg.id) });
    return { ok: true };
  },

  async BG_RESTORE_BUILTIN(msg) {
    const def = BUILTIN_LOOPS.find(b => b.name === msg.name);
    if (!def) return { ok: false, error: 'ليس لوبًا مدمجًا' };
    const bundled = await loadBundled(def.file);
    const { loops = [] } = await chrome.storage.local.get('loops');
    const idx = loops.findIndex(l => l.name === def.name);
    if (idx >= 0) loops[idx] = bundled; else loops.push(bundled);
    await chrome.storage.local.set({ loops });
    return { ok: true, loop: bundled };
  },

  // ---------- التشغيل ----------
  async BG_START_RUN(msg) {
    if (runState && runState.running) return { ok: false, error: 'يوجد تشغيل جارٍ بالفعل' };
    const loops = await ensureBundledLoops();
    const loop = loops.find(l => l.id === msg.loopId);
    if (!loop) return { ok: false, error: 'اللوب غير موجود' };
    // items: [{ ptid, vars, row }] من ملف مستورد — نفس المريض قد يتكرر بتاسكات مختلفة
    const items = Array.isArray(msg.items) && msg.items.length
      ? msg.items
        .map(it => ({ ptid: String(it.ptid || '').trim(), vars: sanitizeRowVars(it.vars), row: it.row }))
        .filter(it => it.ptid)
      : [...new Set((msg.ptids || []).map(p => String(p).trim()).filter(Boolean))].map(ptid => ({ ptid, vars: {} }));
    const ptids = items.map(it => it.ptid);
    if (!ptids.length) return { ok: false, error: 'لا توجد أرقام ملفات' };

    runState = {
      running: true,
      runId: Date.now(),
      kind: msg.kind || 'custom',
      loop,
      loopName: loop.name,
      ptids,
      currentIdx: 0,
      delay: Math.max(500, Number(msg.delay) || 3000),
      onFail: msg.onFail || 'skip',
      // background: تبويب مخصص في الخلفية (افتراضي) — current: تبويب iCare المفتوح
      runIn: msg.runIn === 'current' ? 'current' : 'background',
      human: {
        enabled: Boolean(msg.human && msg.human.enabled),
        speed: Math.min(2, Math.max(0.3, Number(msg.human && msg.human.speed) || 1))
      },
      variables: sanitizeVars({
        TASK_MESSAGE: msg.taskMessage,
        TASK_EMPLOYEE: msg.taskEmployee,
        HANDOVER_STAFF: msg.handoverStaff,
        ...(msg.vars || {})
      }),
      tabId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      source: msg.source || null,
      historyRecorded: true,
      results: items.map(it => ({ id: it.ptid, status: 'pending', vars: it.vars, row: it.row }))
    };
    await persistRunState();
    runLoop(); // بدون await — يعمل في الخلفية
    return { ok: true, runId: runState.runId };
  },

  async BG_STOP_RUN() {
    if (runState && runState.running) {
      runState.running = false;
      runState.paused = false;
      runState.stopRequested = true;
      await persistRunState();
    }
    return { ok: true };
  },

  // إيقاف مؤقت: الملف الجاري يكتمل أولاً (لا نترك نموذج تاسك نصف معبأ)، ثم ينتظر حتى الاستئناف
  async BG_PAUSE_RUN() {
    if (!runState || !runState.running) return { ok: false, error: 'لا يوجد تشغيل جارٍ' };
    if (!runState.paused) {
      runState.paused = true;
      runState.pausedAt = new Date().toISOString();
      await persistRunState();
      log('—', '⏸ طلب إيقاف مؤقت — يتوقف بعد اكتمال الملف الحالي');
      notifyPopup('RUN_PROGRESS');
    }
    return { ok: true };
  },

  async BG_RESUME_RUN() {
    if (!runState || !runState.running) return { ok: false, error: 'لا يوجد تشغيل جارٍ' };
    if (runState.paused) {
      runState.paused = false;
      delete runState.pausedAt;
      await persistRunState();
      notifyPopup('RUN_PROGRESS');
    }
    return { ok: true };
  },

  // ---------- ذاكرة أرقام الموظفين ----------
  async BG_GET_STAFF() {
    await staffQueue;
    return { ok: true, directory: await getStaffDirectory() };
  },

  async BG_SAVE_STAFF(msg) {
    const id = String(msg.id || '').trim();
    const name = String(msg.name || '').trim();
    if (!STAFF_ID.test(id)) return { ok: false, error: 'الرقم الوظيفي يجب أن يكون أرقاماً فقط' };
    if (!/\p{L}{2}/u.test(name)) return { ok: false, error: 'أدخل اسم الموظف' };
    await learnStaff([{ name, id }], 'manual');
    return { ok: true };
  },

  async BG_DELETE_STAFF(msg) {
    await staffQueue;
    const dir = await getStaffDirectory();
    delete dir[msg.key];
    await chrome.storage.local.set({ staffDirectory: dir });
    return { ok: true };
  },

  // أزواج من ملف Excel (مثل عمود Staff: "1253 - Awad Osman")
  async BG_LEARN_STAFF(msg) {
    const pairs = (msg.values || []).map(parseStaffOption).filter(Boolean);
    return { ok: true, added: await learnStaff(pairs, 'file') };
  },

  async BG_CLEAR_RESUME() {
    if (runState && runState.running) return { ok: false, error: 'يوجد تشغيل جارٍ' };
    await chrome.storage.local.remove('resumeQueue');
    return { ok: true };
  },

  async BG_GET_RUN_STATE() {
    return { ok: true, state: publicRunState() };
  },

  // ---------- سجل التاسكات المرسلة ----------
  // يعيد الملفات التي أُرسل لها بنفس اللوب سابقاً: { ptid: { last, count } }
  async BG_CHECK_SENT(msg) {
    await historyQueue;
    const { sentHistory = {} } = await chrome.storage.local.get('sentHistory');
    const sent = {};
    [...new Set((msg.ptids || []).map(String))].forEach(ptid => {
      const entries = (sentHistory[ptid] || []).filter(e => !msg.loopName || e.loop === msg.loopName);
      if (entries.length) sent[ptid] = { last: entries[entries.length - 1], count: entries.length, entries };
    });
    return { ok: true, sent };
  },

  async BG_GET_HISTORY() {
    await historyQueue;
    const { sentHistory = {} } = await chrome.storage.local.get('sentHistory');
    const list = [];
    Object.entries(sentHistory).forEach(([ptid, entries]) => entries.forEach(e => list.push({ ptid, ...e })));
    list.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return { ok: true, list, patients: Object.keys(sentHistory).length };
  },

  async BG_REMOVE_HISTORY(msg) {
    historyQueue = historyQueue.then(async () => {
      const { sentHistory = {} } = await chrome.storage.local.get('sentHistory');
      delete sentHistory[String(msg.ptid)];
      await chrome.storage.local.set({ sentHistory });
    });
    await historyQueue;
    return { ok: true };
  },

  async BG_CLEAR_HISTORY() {
    historyQueue = historyQueue.then(() => chrome.storage.local.set({ sentHistory: {} }));
    await historyQueue;
    return { ok: true };
  },

  // ---------- 🤖 المساعد (DeepSeek — واجهة متوافقة مع OpenAI) ----------
  // المفتاح يُقرأ هنا من التخزين المحلي ولا يُرسل للـ popup؛ الـ popup يرسل ملخصاً مقنّعاً فقط.
  async BG_AI_REQUEST(msg) {
    const { aiApiKey, aiSettings = {} } = await chrome.storage.local.get(['aiApiKey', 'aiSettings']);
    if (!aiSettings.consent) return { ok: false, error: 'فعّل الموافقة على إرسال الملخصات إلى DeepSeek من إعدادات المساعد' };
    if (!aiApiKey) return { ok: false, error: 'أدخل مفتاح DeepSeek API في إعدادات المساعد' };
    const body = {
      model: String(msg.model || aiSettings.model || 'deepseek-chat'),
      messages: Array.isArray(msg.messages) ? msg.messages : [],
      temperature: 0.3,
      max_tokens: 1200,
      stream: false
    };
    if (Array.isArray(msg.tools) && msg.tools.length) { body.tools = msg.tools; body.tool_choice = 'auto'; }
    let res;
    try {
      res = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiApiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
    } catch (e) {
      return { ok: false, error: /timeout|abort/i.test(e.name + e.message) ? 'انتهت مهلة الرد من DeepSeek (60 ث)' : 'تعذر الاتصال بـ DeepSeek: ' + e.message };
    }
    if (!res.ok) {
      const known = { 401: 'مفتاح DeepSeek غير صحيح', 402: 'رصيد حساب DeepSeek غير كافٍ', 429: 'طلبات كثيرة — انتظر قليلاً ثم أعد',
        400: 'طلب غير صالح (تحقق من اسم النموذج)', 500: 'خطأ في خادم DeepSeek', 503: 'خادم DeepSeek مشغول' };
      const detail = await res.text().catch(() => '');
      return { ok: false, error: (known[res.status] || 'خطأ من DeepSeek (' + res.status + ')') +
        (detail && !known[res.status] ? ': ' + detail.slice(0, 160) : '') };
    }
    const data = await res.json().catch(() => null);
    const message = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!message) return { ok: false, error: 'رد غير متوقع من DeepSeek' };
    return { ok: true, message: { content: message.content || '', tool_calls: message.tool_calls || [] }, usage: data.usage || null };
  },

  async BG_SLEEP(msg) {
    await sleep(Math.min(30000, Math.max(0, Number(msg.ms) || 0)));
    return { ok: true };
  },

  async BG_CLEAR_LOG() {
    logBuffer = [];
    await chrome.storage.session.set({ runLog: [] }).catch(() => {});
    return { ok: true };
  },

  // ---------- الملفات غير النشطة ----------
  async BG_GET_DEACTIVE() {
    const { deactiveList = [] } = await chrome.storage.local.get('deactiveList');
    return { ok: true, list: deactiveList };
  },
  async BG_CLEAR_DEACTIVE() {
    await chrome.storage.local.set({ deactiveList: [] });
    return { ok: true };
  },
  async BG_REMOVE_DEACTIVE(msg) {
    const { deactiveList = [] } = await chrome.storage.local.get('deactiveList');
    await chrome.storage.local.set({ deactiveList: deactiveList.filter(d => d.ptid !== msg.ptid) });
    return { ok: true };
  }
};

// ============================================================
// ===== التسجيل: إضافة الخطوات للقائمة المركزية =====
// ============================================================
async function appendRecordedStep(msg, sender) {
  const state = await chrome.storage.local.get(['isRecording', 'recordingSessionTabs', 'pendingSteps']);
  if (!state.isRecording) return;
  const tab = sender.tab;
  const sessionTabs = state.recordingSessionTabs || [];
  if (!tab || !(sessionTabs.includes(tab.id) || sessionTabs.includes(tab.openerTabId))) return;
  if (!sessionTabs.includes(tab.id)) {
    await chrome.storage.local.set({ recordingSessionTabs: [...sessionTabs, tab.id] });
  }

  const steps = state.pendingSteps || [];
  const step = msg.step || {};
  const last = steps[steps.length - 1];

  if (step.type === 'navigate') {
    // تجاهل تكرار نفس الرابط (إعادة حقن / تحديث)
    const lastNav = [...steps].reverse().find(s => s.type === 'navigate');
    if (last && last.type === 'navigate' && last.url === step.url) return;
    if (lastNav && lastNav.url === step.url && steps.indexOf(lastNav) === steps.length - 1) return;
  }

  if (msg.mode === 'upsert' && last && last.type === step.type && last.selector === step.selector) {
    steps[steps.length - 1] = { ...last, ...step };
  } else {
    steps.push(step);
  }
  await chrome.storage.local.set({ pendingSteps: steps });
}

// تنظيف الخطوات قبل الحفظ: إزالة البيانات غير اللازمة وتحويل القيم لمتغيرات.
function prepareSteps(steps, vars) {
  const cleaned = steps.map(s => {
    const step = { ...s };
    delete step.timestamp;
    return step;
  }).filter((s, i, arr) => {
    // إزالة خطوات التنقل المتتالية (يبقى الأخير فقط)
    return !(s.type === 'navigate' && arr[i + 1] && arr[i + 1].type === 'navigate');
  });

  // القيم التي كتبها المستخدم أثناء التسجيل وتطابق إعدادات الواجهة تتحول لمتغيرات،
  // فيعمل اللوب مع أي موظف/رسالة لاحقاً.
  const varEntries = Object.entries(vars || {})
    .map(([k, v]) => [k, String(v || '').trim()])
    .filter(([k, v]) => VAR_NAMES.includes(k) && v);
  cleaned.forEach(step => {
    if (!['input', 'contentInput'].includes(step.type) || typeof step.value !== 'string') return;
    const hit = varEntries.find(([, v]) => v.toLowerCase() === step.value.trim().toLowerCase());
    if (hit) step.value = '{' + hit[0] + '}';
  });

  // اختيار من قائمة يطابق قيمة متغير (النوع/الأولوية/الفئة/الفرعية) ← يصبح متغيراً
  cleaned.forEach(step => {
    if (step.type !== 'customSelect') return;
    const text = String(step.text || '').trim().toLowerCase();
    const hit = varEntries.find(([k, v]) => SELECT_VARS.includes(k) && v.toLowerCase() === text);
    if (hit) { step.text = '{' + hit[0] + '}'; step.value = step.text; }
  });

  // كتابة في خانة بحث ثم اختيار نتيجة ← "اختر النتيجة المطابقة" بدل نص ثابت
  for (let i = 0; i < cleaned.length - 1; i++) {
    const step = cleaned[i];
    const next = cleaned[i + 1];
    const isSearch = step.type === 'input' &&
      /search|بحث|find/i.test((step.placeholder || '') + ' ' + (step.selector || ''));
    if (isSearch && next.type === 'customSelect' && /^\{[A-Z_]+\}$/.test(step.value)) {
      cleaned[i + 1] = { type: 'selectFirstOption', selector: '[role="option"]', match: step.value };
    }
  }
  // خطوة تحقق تلقائية بعد آخر نقرة حفظ (لا تُفشل التشغيل، تنبّه فقط)
  const last = cleaned[cleaned.length - 1];
  if (last && ['click', 'clickText'].includes(last.type) && !cleaned.some(s => s.type === 'verify')) {
    last.commit = true;
    cleaned.push({ type: 'verify', goneText: last.text || '', timeout: 8000 });
  }
  return cleaned;
}

// ============================================================
// ===== تشغيل اللوب =====
// ============================================================
async function runLoop() {
  startKeepAlive();
  const myRunId = runState.runId;
  try {
    while (runState && runState.runId === myRunId && runState.running && runState.currentIdx < runState.ptids.length) {
      await waitWhilePaused(myRunId);
      if (!runState || runState.runId !== myRunId || !runState.running) break;
      const idx = runState.currentIdx;
      const result = runState.results[idx];
      const maxAttempts = runState.onFail === 'retry' ? 2 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        result.status = 'running';
        result.attempt = attempt;
        await persistRunState();
        notifyPopup('RUN_PROGRESS');

        const outcome = await runPatient(result.id, attempt, result.vars);
        Object.assign(result, outcome);
        // لا نعيد المحاولة إذا تم الضغط على زر الحفظ — قد يُنشئ تاسك مكرر.
        if (outcome.status === 'done' || !runState.running || outcome.committed) break;
        if (attempt < maxAttempts) {
          log(result.id, '↻ إعادة المحاولة...');
          await sleep(1500); // المحاولة الثانية جزء من نفس الملف — لا يقطعها الإيقاف المؤقت
        }
      }

      if (shouldRecord(result)) await recordSent(result, runState);
      await persistRunState();
      notifyPopup('RUN_PROGRESS');

      if (result.status === 'fail' && runState.onFail === 'stop') {
        runState.running = false;
        break;
      }
      runState.currentIdx++;
      if (runState.running && runState.currentIdx < runState.ptids.length) {
        await sleepWhileRunning(humanize(runState.delay, 0.75, 1.35));
      }
    }
  } catch (e) {
    log('—', 'خطأ غير متوقع: ' + e.message);
  } finally {
    if (runState && runState.runId === myRunId) {
      if (!runState.running && runState.stopRequested) {
        runState.results.forEach(r => { if (r.status === 'pending') r.status = 'skipped'; });
      }
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
      await persistRunState();
      await closeRunTabs();
      await finishRunTab();
      notifyPopup('RUN_COMPLETE');
    }
    stopKeepAlive();
  }
}

async function runPatient(ptid, attempt, rowVars) {
  const loop = runState.loop;
  // قيم الصف (الطبيب/العنوان/الرسالة) تتقدم على إعدادات التبويب
  const vars = resolveVars({ ...runState.variables, ...(rowVars || {}) }, ptid);
  // اسم الموظف ← رقمه الوظيفي من الذاكرة (إن وُجد)
  const staffDir = await getStaffDirectory();
  const staffNames = {};
  ['TASK_EMPLOYEE', 'HANDOVER_STAFF'].forEach(k => {
    const v = String(vars[k] || '').trim();
    if (!v || STAFF_ID.test(v)) return;
    const hit = staffDir[staffKey(v)];
    if (hit) { staffNames[k] = v; vars[k] = hit.id; return; }
    // القيمة نفسها فيها الرقم ("544 - AYAT BRIMA" من عمود Staff) ← ابحث بالرقم
    const own = parseStaffOption(v);
    if (own) { staffNames[k] = v; vars[k] = own.id; }
  });
  const trace = [];
  let committed = false;
  let isDeactive = false;
  let warning = '';
  const skippedGroups = new Set();

  try {
    let tabId = await getRunTab();
    const mainTabId = tabId;
    log(ptid, 'بدأ تنفيذ "' + loop.name + '" — ' + loop.steps.length + ' خطوة' + (attempt > 1 ? ' (محاولة ' + attempt + ')' : ''));
    Object.entries(staffNames).forEach(([k, name]) => log(ptid, '👥 "' + name + '" ← الرقم الوظيفي ' + vars[k] + ' (من الذاكرة)'));

    // إذا لم تبدأ اللوب بخطوة تنقل، افتح ملف المريض أولاً.
    if (!loop.steps.length || loop.steps[0].type !== 'navigate') {
      await navigateTab(tabId, ICARE_ORIGIN + '/patient-info?ptid=' + encodeURIComponent(ptid), true);
    }

    for (let i = 0; i < loop.steps.length; i++) {
      if (!runState.running) throw new Error('أوقف المستخدم التشغيل');
      const step = replaceVars(loop.steps[i], vars);
      const t0 = Date.now();
      const entry = { number: i + 1, type: step.type, status: 'done', selector: step.selector || '', target: stepTarget(step), error: '', durationMs: 0 };

      // خطوة مرتبطة بمتغير فارغ (مثل الفئة الفرعية) ← تُتخطى ويبقى اختيار iCare الافتراضي
      if (step.skipIf !== undefined && !String(step.skipIf).trim()) {
        entry.status = 'skipped';
        trace.push(entry);
        continue;
      }
      // حقل اختياري لم يُعثر عليه سابقاً ← تخطَّ بقية خطوات مجموعته (مثل اختيار القيمة)
      if (step.group && skippedGroups.has(step.group)) {
        entry.status = 'skipped';
        trace.push(entry);
        continue;
      }

      try {
        if (step.type === 'navigate') {
          // خطوة تنقل = الصفحة الرئيسية للمريض؛ ارجع للتبويب الأساسي
          tabId = mainTabId;
          await navigateTab(tabId, step.url, attempt > 1 || i === 0);
          if (i === 0 || !isDeactive) {
            const status = await detectStatus(tabId);
            if (status && !isDeactive) {
              isDeactive = true;
              log(ptid, '⚠️ الملف غير نشط (' + status + ') — سيتم التنفيذ مع ذلك');
              await upsertDeactive(ptid, loop.name, 'pending', null);
              notifyPopup('DEACTIVE_UPDATED');
            }
          }
        } else {
          const openedBefore = new Set(runOpenedTabs);
          const isCommit = isCommitStep(step, i, loop.steps);
          if (isCommit) committed = true;

          const res = await sendStep(tabId, step, i + 1);
          if (res.target) entry.target = res.target;
          // تعلّم الرقم الوظيفي من الخيار المختار في iCare (مثل "1253 - Awad Osman")
          if (step.type === 'selectFirstOption' && step.match && !step.allowFirst && res.picked) {
            const opt = parseStaffOption(res.picked);
            if (opt) {
              const pairs = [opt];
              const key = ['TASK_EMPLOYEE', 'HANDOVER_STAFF'].find(k => vars[k] === step.match || staffNames[k]);
              const asked = key && (staffNames[key] || vars[key]);
              if (asked && !STAFF_ID.test(asked) && !staffNames[key]) pairs.push({ name: asked, id: opt.id });
              learnStaff(pairs, 'learned');
            }
          }
          if (step.type === 'verify' && res.verified === false) {
            warning = res.target || 'لم يتم التأكد من النجاح';
            entry.status = 'warn';
          }

          if (CLICK_LIKE.includes(step.type)) {
            const newTabId = await waitForNewTab(openedBefore, 1200);
            if (newTabId) {
              log(ptid, 'فُتح تبويب جديد (' + newTabId + ') — المتابعة فيه');
              await waitForTabLoad(newTabId);
              await ensureContentScript(newTabId);
              await sleep(600);
              tabId = newTabId;
            }
          }
        }
        entry.durationMs = Date.now() - t0;
        trace.push(entry);
        log(ptid, '✓ ' + (i + 1) + '. ' + step.type + (entry.target ? ' — ' + entry.target : ''));
        await sleepWhileRunning(humanize(loop.stepDelay || 800, 0.7, 1.4));
      } catch (stepErr) {
        entry.durationMs = Date.now() - t0;
        // خطوة اختيارية (مثل فتح قائمة النوع): لا تُفشل الملف، سجّل تنبيهاً وأكمل
        if (step.optional && !committed) {
          entry.status = 'warn';
          entry.error = stepErr.message;
          trace.push(entry);
          if (step.group) skippedGroups.add(step.group);
          // إن كانت قائمة مفتوحة (فُتحت ولم يوجد الخيار) أغلقها قبل المتابعة
          if (step.type === 'customSelect') await sendStep(tabId, { type: 'escape' }, i + 1).catch(() => {});
          const what = step.type === 'customSelect'
            ? 'الخيار "' + (step.text || step.value) + '"'
            : 'حقل "' + (step.label || step.text || step.type).split('|')[0] + '"';
          warning = (warning ? warning + '؛ ' : '') + 'لم يُعثر على ' + what + ' — تُرك افتراضياً';
          log(ptid, '⚠ ' + (i + 1) + '. ' + what + ': غير موجود — تم التخطي');
          continue;
        }
        entry.status = 'fail';
        entry.error = stepErr.message;
        trace.push(entry);
        stepErr.diagnostic = stepErr.diagnostic || null;
        throw stepErr;
      }
    }

    // تنظيف التبويبات المؤقتة لهذا المريض
    await closeRunTabs();

    if (isDeactive) {
      await upsertDeactive(ptid, loop.name, 'complete', null);
      notifyPopup('DEACTIVE_UPDATED');
    }
    log(ptid, warning ? '✓ اكتمل (تنبيه: ' + warning + ')' : '✓ اكتمل بنجاح');
    return { status: 'done', error: '', warning, trace, committed, finishedAt: new Date().toISOString() };

  } catch (err) {
    log(ptid, '✗ فشل: ' + err.message);
    await closeRunTabs();
    if (isDeactive) {
      await upsertDeactive(ptid, loop.name, 'fail', err.message);
      notifyPopup('DEACTIVE_UPDATED');
    }
    return {
      status: 'fail',
      error: err.message + (committed ? ' (بعد الضغط على الحفظ — تحقق يدوياً قبل إعادة التشغيل)' : ''),
      trace,
      committed,
      diagnostic: err.diagnostic || null,
      finishedAt: new Date().toISOString()
    };
  }
}

// زر الحفظ النهائي: بعده لا نعيد المحاولة تلقائياً.
function isCommitStep(step, index, steps) {
  if (step.commit) return true;
  if (!['click', 'clickText'].includes(step.type)) return false;
  const text = (step.text || '').toLowerCase();
  if (/create task|save|submit|confirm|assign|حفظ|إنشاء|تأكيد|إرسال/.test(text)) return true;
  if ((step.selector || '').includes('type="submit"')) return true;
  // آخر نقرة في اللوب تعتبر حفظاً
  const lastClick = [...steps].map((s, i) => ({ s, i })).reverse().find(x => ['click', 'clickText'].includes(x.s.type));
  return lastClick && lastClick.i === index;
}

function stepTarget(step) {
  return step.label || step.text || step.value || step.placeholder || step.url || '';
}

async function sendStep(tabId, step, num) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ensureContentScript(tabId);
    let res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { action: 'EXECUTE_STEP', step, num, human: runState && runState.human }, { frameId: 0 });
    } catch (e) {
      const msg = String(e.message || e);
      // الصفحة تغيّرت أثناء الخطوة (نقرة أدت لتنقل) — للنقرات والتحقق نعتبرها منفذة.
      if (/message port closed|back\/forward cache|frame was removed/i.test(msg) && (CLICK_LIKE.includes(step.type) || step.type === 'verify')) {
        await waitForTabLoad(tabId);
        return { ok: true, target: 'تنقلت الصفحة بعد الخطوة', verified: step.type === 'verify' ? true : undefined };
      }
      // لا يوجد مستقبل (الصفحة ما زالت تُحمَّل) — انتظر وأعد
      if (attempt < 3) { await waitForTabLoad(tabId); await sleep(700); continue; }
      throw new Error('تعذر الاتصال بصفحة iCare: ' + msg);
    }
    if (!res) {
      if (attempt < 3) { await sleep(700); continue; }
      throw new Error('لا يوجد رد من الصفحة في الخطوة ' + num);
    }
    if (!res.ok) {
      const err = new Error(res.error || 'فشلت الخطوة ' + num);
      err.diagnostic = res.diagnostic || null;
      throw err;
    }
    return res;
  }
  throw new Error('فشلت الخطوة ' + num);
}

// ============================================================
// ===== إدارة التبويبات =====
// ============================================================
chrome.tabs.onCreated.addListener(async tab => {
  // أثناء التشغيل: تتبع التبويبات التي يفتحها iCare
  if (runState && runState.running && tab.openerTabId != null) {
    const known = new Set([runState.tabId, ...runOpenedTabs]);
    if (known.has(tab.openerTabId)) runOpenedTabs.add(tab.id);
  }
  // أثناء التسجيل: ضم التبويبات الجديدة للجلسة
  const { isRecording, recordingSessionTabs = [] } = await chrome.storage.local.get(['isRecording', 'recordingSessionTabs']);
  if (isRecording && tab.openerTabId != null && recordingSessionTabs.includes(tab.openerTabId)) {
    await chrome.storage.local.set({ recordingSessionTabs: [...new Set([...recordingSessionTabs, tab.id])] });
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  runOpenedTabs.delete(tabId);
  if (runState && runState.tabId === tabId) runState.tabId = null;
});

async function waitForNewTab(before, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const fresh = [...runOpenedTabs].find(id => !before.has(id));
    if (fresh) return fresh;
    await sleep(150);
  }
  return null;
}

async function closeRunTabs() {
  const ids = [...runOpenedTabs];
  runOpenedTabs.clear();
  await Promise.all(ids.map(id => chrome.tabs.remove(id).catch(() => {})));
}

// تبويب التشغيل: نفس التبويب طوال التشغيل، ويُنشأ إذا أُغلق.
async function getRunTab() {
  if (runState.tabId) {
    const tab = await chrome.tabs.get(runState.tabId).catch(() => null);
    if (tab) return tab.id;
  }
  let tab = null;
  if (runState.runIn === 'current') {
    tab = await getIcareTab({ preferActive: true });
  }
  if (!tab) {
    // تبويب مخصص للتشغيل لا يُفتح أمامك — تصفّح ما تريد وهو يعمل
    tab = await chrome.tabs.create({ url: ICARE_ORIGIN + '/', active: false });
    runState.ownsTab = true;
    await labelRunTab(tab, '▶ iCare Loop — يعمل');
  }
  // لا تسمح لـ Chrome بتفريغ التبويب من الذاكرة أثناء التشغيل
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  runState.tabId = tab.id;
  await persistRunState();
  return tab.id;
}

// تجميع تبويب التشغيل باسم واضح (يتطلب صلاحية tabGroups)
async function labelRunTab(tab, title, color) {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  try {
    const groupId = tab.groupId >= 0 && runState.groupId === tab.groupId
      ? tab.groupId
      : await chrome.tabs.group({ tabIds: tab.id });
    runState.groupId = groupId;
    await chrome.tabGroups.update(groupId, { title, color: color || 'green', collapsed: false });
  } catch { /* التجميع اختياري */ }
}

async function finishRunTab() {
  if (!runState.tabId) return;
  const tab = await chrome.tabs.get(runState.tabId).catch(() => null);
  if (!tab) return;
  await chrome.tabs.update(tab.id, { autoDiscardable: true }).catch(() => {});
  if (runState.ownsTab) {
    const done = runState.results.filter(r => r.status === 'done').length;
    const fail = runState.results.filter(r => r.status === 'fail').length;
    await labelRunTab(tab, '✓ iCare Loop — ' + done + ' ✓ / ' + fail + ' ✗', fail ? 'orange' : 'green');
  }
}

async function getIcareTab({ preferActive } = {}) {
  const tabs = await chrome.tabs.query({ url: ICARE_URLS });
  if (!tabs.length) return null;
  if (preferActive) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: ICARE_URLS });
    if (active) return active;
    const activeAny = tabs.find(t => t.active);
    if (activeAny) return activeAny;
  }
  return tabs[0];
}

// التنقل: يتخطى إذا كانت الصفحة الحالية تطابق المسار وكل معاملات الرابط المطلوبة.
async function navigateTab(tabId, url, force) {
  const tab = await chrome.tabs.get(tabId);
  if (!force && urlSatisfies(tab.url, url)) return;
  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId, true);
  await ensureContentScript(tabId);
  await sleep(900); // وقت لتحميل بيانات تطبيق iCare
}

function urlSatisfies(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    if (current.origin !== target.origin || current.pathname !== target.pathname) return false;
    for (const [key, value] of target.searchParams) {
      if (current.searchParams.get(key) !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function waitForTabLoad(tabId, expectNavigation) {
  return new Promise(resolve => {
    let done = false;
    let sawLoading = !expectNavigation;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, 20000);
    chrome.tabs.get(tabId).then(tab => {
      if (!expectNavigation && tab.status === 'complete') finish();
    }).catch(finish);
  });
}

// يتأكد أن السكربت موجود وحيّ في الصفحة؛ يحقنه فقط إذا لم يرد (لا حقن مزدوج).
async function ensureContentScript(tabId, allFrames) {
  const alive = await chrome.tabs.sendMessage(tabId, { action: 'PING' }, { frameId: 0 })
    .then(r => Boolean(r && r.ok)).catch(() => false);
  if (alive && !allFrames) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: Boolean(allFrames) },
    files: ['src/recorder.js']
  }).catch(() => {});
  if (!alive) await sleep(250);
}

async function detectStatus(tabId) {
  const res = await chrome.tabs.sendMessage(tabId, { action: 'DETECT_STATUS' }, { frameId: 0 }).catch(() => null);
  return res && res.deactive ? res.deactive : '';
}

// ============================================================
// ===== مساعدات =====
// ============================================================
// قيم المتغيرات: نصوص فقط، وبالأسماء المعروفة فقط
function sanitizeVars(input) {
  const out = {};
  VAR_NAMES.forEach(k => { if (k !== 'PTID' && k !== 'DATE') out[k] = String(input[k] ?? '').trim(); });
  return out;
}

// ============================================================
// ===== سجل التاسكات المرسلة =====
// ============================================================
// نسجل: الناجح (مؤكد أو غير مؤكد) + الفاشل بعد الضغط على الحفظ (ربما أُنشئ)
function shouldRecord(result) {
  return result.status === 'done' || (result.status === 'fail' && result.committed);
}

function recordSent(result, state) {
  const vars = resolveVars({ ...(state.variables || {}), ...(result.vars || {}) }, result.id);
  const entry = {
    at: result.finishedAt || new Date().toISOString(),
    loop: state.loopName || '',
    kind: state.kind || '',
    runId: state.runId,
    employee: vars.TASK_EMPLOYEE || vars.HANDOVER_STAFF || '',
    title: vars.TASK_TITLE || '',
    message: (vars.TASK_MESSAGE || '').slice(0, 200),
    state: result.status === 'done' ? (result.warning ? 'unverified' : 'verified') : 'uncertain',
    source: state.source && state.source.fileName ? state.source.fileName : ''
  };
  historyQueue = historyQueue.then(async () => {
    const { sentHistory = {} } = await chrome.storage.local.get('sentHistory');
    const list = sentHistory[result.id] || [];
    // نفس التشغيل ونفس الرسالة (إعادة المحاولة) لا تُسجل مرتين
    if (list.some(e => e.runId === entry.runId && e.message === entry.message)) return;
    list.push(entry);
    sentHistory[result.id] = list.slice(-HISTORY_PER_PTID);
    await chrome.storage.local.set({ sentHistory });
  }).catch(() => {});
  return historyQueue;
}

// ============================================================
// ===== ذاكرة أرقام الموظفين (الاسم ← الرقم الوظيفي) =====
// ============================================================
// تُحفظ في storage.local: { مفتاح الاسم: { name, id, source: manual|learned|file, at } }
// عند التشغيل يُستبدل اسم الطبيب برقمه (بحث أدق في "تعيين إلى"، ولا التباس بين الأسماء المتشابهة).
// الإدخال اليدوي له الأولوية ولا يُكتب فوقه ما يُتعلّم تلقائياً.
const STAFF_ID = /^\d{1,7}$/;
let staffQueue = Promise.resolve();

function staffKey(name) {
  return String(name || '').toLowerCase()
    .replace(/^\s*(dr|د)\.?\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// "1253 - Awad Osman" أو "Awad Osman - 1253" أو "Awad Osman (1253)" ← { id, name }
function parseStaffOption(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  let m = t.match(/^(\d{1,7})\s*[-–—:|]\s*(.+)$/);
  if (m) return { id: m[1], name: m[2].trim() };
  m = t.match(/^(.+?)\s*[-–—(|]\s*(\d{1,7})\)?$/);
  if (m) return { id: m[2], name: m[1].trim() };
  return null;
}

async function getStaffDirectory() {
  const { staffDirectory = {} } = await chrome.storage.local.get('staffDirectory');
  return staffDirectory;
}

function learnStaff(pairs, source) {
  let changed = 0;
  staffQueue = staffQueue.then(async () => {
    const dir = await getStaffDirectory();
    (pairs || []).forEach(p => {
      const id = String(p && p.id || '').trim();
      const name = String(p && p.name || '').replace(/\s+/g, ' ').trim();
      const key = staffKey(name);
      if (!STAFF_ID.test(id) || !/\p{L}{2}/u.test(key) || STAFF_ID.test(name)) return;
      const old = dir[key];
      if (old && old.source === 'manual' && source !== 'manual') return; // اليدوي لا يُستبدل تلقائياً
      if (old && old.id === id && old.source === source) return;
      dir[key] = { name, id, source, at: new Date().toISOString() };
      changed++;
    });
    if (changed) await chrome.storage.local.set({ staffDirectory: dir });
  }).catch(() => {});
  return staffQueue.then(() => changed);
}

// قيم صف مستورد: متغيرات معروفة فقط وبقيم غير فارغة
function sanitizeRowVars(input) {
  const out = {};
  Object.entries(input || {}).forEach(([k, v]) => {
    const value = String(v ?? '').trim();
    if (VAR_NAMES.includes(k) && k !== 'PTID' && k !== 'DATE' && value) out[k] = value;
  });
  return out;
}

// قيم المتغيرات لمريض محدد — يمكن كتابة {PTID} و {DATE} داخل العنوان أو الرسالة
function resolveVars(variables, ptid) {
  const base = { ...variables, PTID: String(ptid), DATE: new Date().toISOString().slice(0, 10) };
  const resolved = {};
  Object.entries(base).forEach(([k, v]) => {
    resolved[k] = String(v ?? '').replace(/\{(PTID|DATE)\}/g, (m, name) => base[name]);
  });
  // حقل العنوان في iCare حده 35 حرفاً
  resolved.TASK_TITLE = (resolved.TASK_TITLE || '').slice(0, 35);
  return resolved;
}

function replaceVars(value, vars) {
  if (typeof value === 'string') {
    return value
      .replace(/%7B([A-Z_]+)%7D/gi, (m, k) => VAR_NAMES.includes(k.toUpperCase()) ? encodeURIComponent(vars[k.toUpperCase()] ?? '') : m)
      .replace(/\{([A-Z_]+)\}/g, (m, k) => VAR_NAMES.includes(k) ? (vars[k] ?? '') : m);
  }
  if (Array.isArray(value)) return value.map(v => replaceVars(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceVars(v, vars)]));
  }
  return value;
}

async function upsertDeactive(ptid, loopName, status, error) {
  const { deactiveList = [] } = await chrome.storage.local.get('deactiveList');
  const idx = deactiveList.findIndex(d => d.ptid === ptid);
  const now = new Date().toISOString();
  const entry = idx >= 0
    ? { ...deactiveList[idx], loopName, status, processedAt: now, error: error || null }
    : { ptid, loopName, detectedAt: now, status, processedAt: now, error: error || null };
  if (idx >= 0) deactiveList[idx] = entry; else deactiveList.push(entry);
  await chrome.storage.local.set({ deactiveList });
}

async function loadBundled(file) {
  const r = await fetch(chrome.runtime.getURL(file));
  if (!r.ok) throw new Error('تعذر تحميل ' + file);
  return r.json();
}

// اللوبات المدمجة: تُضاف إن لم توجد، وتُحدَّث لنسخة أحدث ما لم يسجّلها المستخدم بنفسه.
async function ensureBundledLoops() {
  const { loops = [] } = await chrome.storage.local.get('loops');
  let changed = false;
  for (const def of BUILTIN_LOOPS) {
    try {
      const bundled = await loadBundled(def.file);
      const idx = loops.findIndex(l => l.name === def.name);
      if (idx < 0) { loops.push(bundled); changed = true; continue; }
      const existing = loops[idx];
      if (!existing.userUpdated && (existing.builtinVersion || 0) < bundled.builtinVersion) {
        loops[idx] = bundled;
        changed = true;
      }
    } catch (e) {
      console.warn('[bundled-loop]', def.file, e.message);
    }
  }
  if (changed) await chrome.storage.local.set({ loops });
  return loops;
}

function publicRunState() {
  if (!runState) return null;
  const { loop, ...rest } = runState;
  return { ...rest, stepCount: loop ? loop.steps.length : 0 };
}

async function persistRunState() {
  if (!runState) return;
  await chrome.storage.session.set({ runState }).catch(() => {});
  await saveResumeQueue();
}

// ملفات يجب إكمالها (لم تنجح بعد) — في storage.local حتى تبقى بعد إغلاق المتصفح
// (storage.session يُمسح عند إعادة تشغيل المتصفح). تُحدّث مع كل تقدم، وتُحذف عند اكتمال الكل.
const RESUME_STATUSES = ['fail', 'skipped', 'pending', 'running'];
async function saveResumeQueue() {
  const rest = runState.results.filter(r => RESUME_STATUSES.includes(r.status));
  if (!rest.length) { await chrome.storage.local.remove('resumeQueue').catch(() => {}); return; }
  const queue = {
    runId: runState.runId,
    kind: runState.kind,
    loopName: runState.loopName,
    variables: runState.variables,
    source: runState.source,
    total: runState.results.length,
    done: runState.results.filter(r => r.status === 'done').length,
    running: Boolean(runState.running),
    savedAt: new Date().toISOString(),
    items: rest.map(r => ({ id: r.id, vars: r.vars || {}, row: r.row, status: r.status,
      error: r.error || '', committed: Boolean(r.committed) }))
  };
  await chrome.storage.local.set({ resumeQueue: queue }).catch(() => {});
}

// السجل يُحفظ في storage.session حتى يظهر عند إعادة فتح الـ popup أثناء التشغيل.
let logBuffer = [];
let logSaveTimer = null;
chrome.storage.session.get('runLog').then(({ runLog }) => {
  if (Array.isArray(runLog)) logBuffer = runLog.concat(logBuffer).slice(-400);
}).catch(() => {});

function log(ptid, msg) {
  const line = { ts: Date.now(), ptid, msg };
  logBuffer.push(line);
  if (logBuffer.length > 400) logBuffer.shift();
  clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => chrome.storage.session.set({ runLog: logBuffer }).catch(() => {}), 300);
  chrome.runtime.sendMessage({ action: 'LOG_UPDATE', ...line }).catch(() => {});
}

function notifyPopup(action) {
  chrome.runtime.sendMessage({ action, state: publicRunState() }).catch(() => {});
}

// الوضع البشري: انتظار متفاوت بدل مدة ثابتة (مضروباً في سرعة الوضع)
function humanize(ms, minFactor, maxFactor) {
  const h = runState && runState.human;
  if (!h || !h.enabled) return ms;
  return Math.round(ms * h.speed * (minFactor + Math.random() * (maxFactor - minFactor)));
}

// انتظار يمكن قطعه عند الإيقاف أو الإيقاف المؤقت
async function sleepWhileRunning(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && runState && runState.running && !runState.paused) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

// الإيقاف المؤقت بين الملفات: ينتظر حتى الاستئناف أو الإيقاف النهائي
async function waitWhilePaused(myRunId) {
  const active = () => runState && runState.runId === myRunId && runState.running;
  if (!active() || !runState.paused) return;
  log('—', '⏸ متوقف مؤقتاً — اضغط "استئناف" للإكمال');
  notifyPopup('RUN_PROGRESS');
  await labelOwnedRunTab('⏸ iCare Loop — متوقف مؤقتاً', 'yellow');
  while (active() && runState.paused) await sleep(500);
  if (!active()) return;
  log('—', '▶ استئناف التشغيل');
  await labelOwnedRunTab('▶ iCare Loop — يعمل');
  notifyPopup('RUN_PROGRESS');
  await sleep(humanize(1000, 0.8, 1.5));
}

async function labelOwnedRunTab(title, color) {
  if (!runState.ownsTab || !runState.tabId) return;
  const tab = await chrome.tabs.get(runState.tabId).catch(() => null);
  if (tab) await labelRunTab(tab, title, color);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

// إبقاء الـ Service Worker حيًا أثناء التشغيل الطويل
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
}
function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ============================================================
// ===== تهيئة عند التثبيت/التحديث =====
// ============================================================
chrome.runtime.onInstalled.addListener(async () => {
  await ensureBundledLoops();
  await chrome.storage.local.set({ isRecording: false });
  // حقن السكربت في تبويبات iCare المفتوحة مسبقاً (بدون الحاجة لتحديثها)
  const tabs = await chrome.tabs.query({ url: ICARE_URLS });
  await Promise.all(tabs.map(t => chrome.scripting.executeScript({
    target: { tabId: t.id, allFrames: true }, files: ['src/recorder.js']
  }).catch(() => {})));
});
