/**
 * iCare Loop Recorder — popup.js  v1.3
 * الواجهة فقط: التشغيل الفعلي وحالته في الـ background (تبقى بعد إغلاق النافذة).
 */

const DEFAULT_TASK_MESSAGE = 'الرجاء معرفة إذا كان المريض يرغب في استمرار الخدمة لتوزيعه على طبيب، علمًا أن الملف قديم.';
const DEFAULT_TASK_EMPLOYEE = 'pex';
const DEFAULT_HANDOVER_STAFF = '12161';
// الموظف البديل لصفوف الاستيراد التي لا يوجد فيها طبيب (632 — PEx Department)
const DEFAULT_IMPORT_EMPLOYEE = '632';
// الوضع البشري مفعّل افتراضياً: أبطأ قليلاً لكنه أوثق مع خانات البحث في iCare
const DEFAULT_HUMAN_MODE = { enabled: true, speed: 1 };
// القيم الافتراضية لحقول التاسك (فارغ = يبقى اختيار iCare كما هو)
const DEFAULT_TASK_VARS = {
  TASK_TITLE: 'تواصل',
  TASK_TYPE: '',
  TASK_PRIORITY: '',
  TASK_CATEGORY: 'Request',
  TASK_SUBCATEGORY: 'DR'
};
const VAR_LABELS = {
  TASK_EMPLOYEE: 'الموظف', TASK_MESSAGE: 'الرسالة', TASK_TITLE: 'العنوان', TASK_TYPE: 'النوع',
  TASK_PRIORITY: 'الأولوية', TASK_CATEGORY: 'الفئة', TASK_SUBCATEGORY: 'الفئة الفرعية', HANDOVER_STAFF: 'موظف الحوالة'
};

// لوحات التشغيل: تاسك / حوالة / لوب مخصص — نفس المنطق بعناصر مختلفة
const PANELS = {
  task:     { prefix: 'qt', tab: 'quicktask', loopName: 'تاسك',  title: 'تاسك',  doneMsg: 'تم فتح التاسك' },
  handover: { prefix: 'hv', tab: 'handover',  loopName: 'حوالة', title: 'حوالة', doneMsg: 'تمت الحوالة' },
  custom:   { prefix: 'rn', tab: 'run',       loopName: null,    title: 'لوب',   doneMsg: 'تم' }
};

let loops = [];
let localSteps = [];
let isRecording = false;
let recTimer = null;
let recStartedAt = 0;
let stepsPoll = null;
let runPoll = null;
let currentRun = null;
let reportedRunId = null;
let logLines = [];
// الاستيراد: { fileName, sheetName, headers, rows, mapping, clean, retryItems? }
let importState = null;

const $ = id => document.getElementById(id);

// ============================================================
// ===== نقطة الدخول =====
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  setupListeners();
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  await restoreLog();
  await checkIcareStatus();
  await refreshLoops();
  await restoreInputs();
  await restoreImport();
  await takeAppImport();
  if (new URLSearchParams(location.search).has('full')) document.body.classList.add('full-page');
  await restoreRecording();
  await refreshDeactive();
  await refreshHistory();
  await refreshStaff();

  const st = await bg('BG_GET_RUN_STATE');
  if (st.state) {
    reportedRunId = st.state.running ? null : st.state.runId; // لا تعرض تقرير تشغيل قديم
    renderRunState(st.state);
    if (st.state.running) {
      switchToTab(PANELS[st.state.kind]?.tab || 'quicktask');
      startRunPoll();
    }
  }
  await refreshResumeQueue();
});

// ============================================================
// ===== التبويبات =====
// ============================================================
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      switchToTab(btn.dataset.tab);
      chrome.storage.local.set({ popupLastTab: btn.dataset.tab });
    });
  });
}

function switchToTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + tabName));
}

// ============================================================
// ===== المستمعون =====
// ============================================================
function setupListeners() {
  $('reloadBtn').addEventListener('click', reloadExtension);
  $('refreshStatusBtn').addEventListener('click', checkIcareStatus);

  // تاسك
  bindIdsInput('qt');
  $('qtMessage').addEventListener('input', () => chrome.storage.local.set({ qtSavedMessage: $('qtMessage').value }));
  $('qtEmployee').addEventListener('input', () => chrome.storage.local.set({ qtSavedEmployee: $('qtEmployee').value }));
  document.querySelectorAll('#tab-quicktask [data-var]').forEach(input => {
    input.addEventListener('input', () => { saveTaskVars(); updateTitleCount(); });
  });
  $('qtVarsResetBtn').addEventListener('click', () => { setTaskVars(DEFAULT_TASK_VARS); saveTaskVars(); });
  $('qtRerecordBtn').addEventListener('click', () => rerecordLoop('تاسك', 'آخر تسجيل للوب تاسك'));
  $('qtRestoreBtn').addEventListener('click', () => restoreBuiltin('تاسك'));
  setupImportListeners();
  $('fullPageBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1') }));

  // حوالة
  bindIdsInput('hv');
  $('hvStaff').addEventListener('input', () => chrome.storage.local.set({ hvSavedStaff: $('hvStaff').value }));
  $('hvRerecordBtn').addEventListener('click', () => rerecordLoop('حوالة', 'آخر تسجيل للوب حوالة'));
  $('hvRestoreBtn').addEventListener('click', () => restoreBuiltin('حوالة'));

  // أزرار التشغيل المشتركة
  Object.entries(PANELS).forEach(([kind, panel]) => {
    const p = panel.prefix;
    $(p + 'RunBtn').addEventListener('click', () => startRun(kind, false));
    $(p + 'TestBtn').addEventListener('click', () => startRun(kind, true));
    $(p + 'StopBtn').addEventListener('click', stopRun);
    $(p + 'PauseBtn').addEventListener('click', togglePause);
    $(p + 'ExportBtn').addEventListener('click', () => exportResults(kind));
    $(p + 'RetryFailedBtn').addEventListener('click', () => loadFailedIds(kind));
    $(p + 'RerunBtn').addEventListener('click', () => rerunIncomplete(kind));
    $(p + 'ResumeClearBtn').addEventListener('click', clearResumeQueue);
    $(p + 'XlsWhich').addEventListener('change', () => { $(p + 'XlsWhich').dataset.userSet = '1'; updateXlsRow(kind); });
    $(p + 'XlsName').addEventListener('input', () => { $(p + 'XlsName').dataset.touched = '1'; });
    $(p + 'XlsBtn').addEventListener('click', () => exportExcel(kind));
    // الوضع البشري: إعداد واحد مشترك بين كل التبويبات
    $(p + 'Background').addEventListener('change', () => setRunInBackground($(p + 'Background').checked));
    $(p + 'Human').addEventListener('change', () => setHumanMode({ enabled: $(p + 'Human').checked, speed: $(p + 'Speed').value }));
    $(p + 'Speed').addEventListener('change', () => setHumanMode({ enabled: $(p + 'Human').checked, speed: $(p + 'Speed').value }));
  });

  // تسجيل
  $('recBtn').addEventListener('click', toggleRecording);
  $('clearStepsBtn').addEventListener('click', clearSteps);
  $('saveLoopBtn').addEventListener('click', saveLoop);
  $('stepsList').addEventListener('click', onStepsListClick);

  // لوبات
  $('savedLoopsList').addEventListener('click', onSavedLoopsClick);

  // غير النشطة
  $('deactiveToggle').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const wrap = $('deactiveListWrap');
    const open = wrap.style.display === 'none';
    wrap.style.display = open ? '' : 'none';
    $('deactiveChevron').classList.toggle('open', open);
  });
  $('deactiveExportBtn').addEventListener('click', exportDeactive);
  $('deactiveClearBtn').addEventListener('click', async () => {
    if (!confirm('مسح قائمة الملفات غير النشطة؟')) return;
    await bg('BG_CLEAR_DEACTIVE');
    await refreshDeactive();
  });
  $('deactiveListEl').addEventListener('click', async e => {
    const del = e.target.closest('[data-del-ptid]');
    if (!del) return;
    await bg('BG_REMOVE_DEACTIVE', { ptid: del.dataset.delPtid });
    await refreshDeactive();
  });
  $('deactiveLoadBtn').addEventListener('click', async () => {
    const { list = [] } = await bg('BG_GET_DEACTIVE');
    const ids = list.filter(d => d.status !== 'complete').map(d => d.ptid);
    if (!ids.length) { addLog('لا توجد ملفات غير نشطة معلّقة', 'info'); return; }
    $('qtPtidInput').value = ids.join('\n');
    parseIds('qt');
    addLog('تم نقل ' + ids.length + ' ملف لقائمة التاسك', 'ok');
  });

  // سجل التاسكات المرسلة
  $('historyToggle').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const wrap = $('historyWrap');
    const open = wrap.style.display === 'none';
    wrap.style.display = open ? '' : 'none';
    $('historyChevron').classList.toggle('open', open);
    if (open) refreshHistory();
  });
  $('historySearch').addEventListener('input', () => renderHistory());

  // ذاكرة أرقام الموظفين
  $('staffToggle').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const open = $('staffWrap').style.display === 'none';
    $('staffWrap').style.display = open ? '' : 'none';
    $('staffChevron').classList.toggle('open', open);
    if (open) refreshStaff();
  });
  $('staffSearch').addEventListener('input', () => renderStaff());
  $('staffAddBtn').addEventListener('click', saveStaffEntry);
  $('staffId').addEventListener('keydown', e => { if (e.key === 'Enter') saveStaffEntry(); });
  $('staffExportBtn').addEventListener('click', exportStaff);
  $('staffList').addEventListener('click', async e => {
    const del = e.target.closest('[data-staff-del]');
    if (del) {
      const entry = staffDirectory[del.dataset.staffDel];
      if (!entry || !confirm('حذف "' + entry.name + '" (' + entry.id + ') من الذاكرة؟')) return;
      await bg('BG_DELETE_STAFF', { key: del.dataset.staffDel });
      await refreshStaff();
      return;
    }
    const row = e.target.closest('[data-staff-key]');
    const entry = row && staffDirectory[row.dataset.staffKey];
    if (entry) { $('staffName').value = entry.name; $('staffId').value = entry.id; $('staffId').focus(); } // للتعديل
  });
  $('historyExportBtn').addEventListener('click', exportHistory);
  $('historyClearBtn').addEventListener('click', async () => {
    if (!confirm('مسح سجل الملفات المرسل لها تاسك؟\nبعدها لن تُسأل عن التكرار لهذه الملفات.')) return;
    await bg('BG_CLEAR_HISTORY');
    await refreshHistory();
    addLog('تم مسح سجل التاسكات المرسلة', 'info');
  });
  $('historyList').addEventListener('click', async e => {
    const del = e.target.closest('[data-h-del]');
    if (!del) return;
    if (!confirm('إزالة ' + del.dataset.hDel + ' من السجل؟')) return;
    await bg('BG_REMOVE_HISTORY', { ptid: del.dataset.hDel });
    await refreshHistory();
  });

  // سجل
  $('clearLogBtn').addEventListener('click', async () => { logLines = []; renderLog(); await bg('BG_CLEAR_LOG'); });
  $('copyLogBtn').addEventListener('click', () => navigator.clipboard.writeText(logText()));
  $('exportLogBtn').addEventListener('click', () =>
    download('icare-loop-log-' + today() + '.txt', logText(), 'text/plain;charset=utf-8'));

  // التقرير
  $('devReportCloseBtn').addEventListener('click', closeReport);
  $('devReportCloseBottomBtn').addEventListener('click', closeReport);
  $('devReportCopyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('devReportText').value);
    $('devReportCopyBtn').textContent = '✓ تم النسخ';
    setTimeout(() => { $('devReportCopyBtn').textContent = '📋 نسخ النص'; }, 1200);
  });
}

function bindIdsInput(p) {
  $(p + 'PtidInput').addEventListener('input', () => {
    parseIds(p);
    chrome.storage.local.set({ [p + 'PtidDraft']: $(p + 'PtidInput').value });
  });
  $(p + 'PasteBtn').addEventListener('click', async () => {
    try {
      $(p + 'PtidInput').value = await navigator.clipboard.readText();
      parseIds(p);
      chrome.storage.local.set({ [p + 'PtidDraft']: $(p + 'PtidInput').value });
    } catch { addLog('تعذّر الوصول للحافظة', 'err'); }
  });
  $(p + 'ClearIdsBtn').addEventListener('click', () => {
    $(p + 'PtidInput').value = '';
    parseIds(p);
    chrome.storage.local.set({ [p + 'PtidDraft']: '' });
  });
}

// ============================================================
// ===== الاتصال و Reload =====
// ============================================================
async function checkIcareStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://icare.com.sa/*', 'https://*.icare.com.sa/*'] });
    if (tabs.length) setStatus('متصل بـ iCare ✓', '#1E7E4D');
    else setStatus('iCare غير مفتوح — افتحه وسجّل الدخول', '#e24b4a');
  } catch {
    setStatus('تحقق من الصلاحيات', '#e86116');
  }
}

function setStatus(text, color) {
  $('icarStatus').textContent = text;
  $('icarStatus').style.color = color || '#888';
}

async function reloadExtension() {
  if (currentRun && currentRun.running && !confirm('يوجد تشغيل جارٍ — إعادة التحميل ستوقفه. متابعة؟')) return;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://icare.com.sa/*', 'https://*.icare.com.sa/*'] });
    for (const t of tabs) await chrome.tabs.reload(t.id);
    chrome.runtime.reload();
  } catch (e) {
    addLog('خطأ: ' + e.message, 'err');
  }
}

// ============================================================
// ===== اللوبات =====
// ============================================================
async function refreshLoops() {
  const res = await bg('BG_GET_LOOPS');
  loops = res.loops || [];
  renderLoopBar('qt', 'تاسك');
  renderLoopBar('hv', 'حوالة');
  renderSavedLoops();
  const sel = $('runLoopSelect');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— اختر لوبًا —</option>' +
    loops.map(l => '<option value="' + l.id + '">' + esc(l.name) + ' (' + l.steps.length + ' خطوة)</option>').join('');
  if (loops.some(l => String(l.id) === prev)) sel.value = prev;
}

function loopByName(name) {
  return loops.find(l => l.name === name) || null;
}

function renderLoopBar(p, name) {
  const loop = loopByName(name);
  const bar = $(p + 'LoopBar');
  if (loop) {
    const who = loop.userUpdated ? 'تسجيلك' : 'افتراضي';
    $(p + 'LoopName').textContent = loop.name + ' — ' + loop.steps.length + ' خطوة (' + who + ')';
    bar.classList.remove('no-loop');
  } else {
    $(p + 'LoopName').textContent = 'لوب ' + name + ' غير موجود';
    bar.classList.add('no-loop');
  }
}

function renderSavedLoops() {
  const el = $('savedLoopsList');
  if (!loops.length) { el.innerHTML = '<div class="empty">لا توجد لوبات محفوظة</div>'; return; }
  el.innerHTML = loops.map(l => `
    <div class="loop-item">
      <div class="loop-header">
        <span class="loop-name">${esc(l.name)}</span>
        <div class="loop-btns">
          <button class="btn-sm" data-loop-act="edit" data-id="${l.id}" title="تحرير الخطوات">✏️</button>
          <button class="btn-sm" data-loop-act="export" data-id="${l.id}" title="تصدير JSON">⬇</button>
          <button class="btn-sm" data-loop-act="delete" data-id="${l.id}" title="حذف">🗑</button>
        </div>
      </div>
      <div class="loop-meta">${l.steps.length} خطوة · تأخير ${Number(l.stepDelay) || 800}ms · ${esc(fmtDate(l.updated || l.created))}</div>
      ${l.desc ? `<div class="loop-desc">${esc(l.desc)}</div>` : ''}
    </div>`).join('');
}

async function onSavedLoopsClick(e) {
  const btn = e.target.closest('[data-loop-act]');
  if (!btn) return;
  const loop = loops.find(l => String(l.id) === btn.dataset.id);
  if (!loop) return;
  if (btn.dataset.loopAct === 'delete') {
    if (!confirm('حذف اللوب "' + loop.name + '"؟')) return;
    await bg('BG_DELETE_LOOP', { id: loop.id });
    addLog('تم حذف اللوب: ' + loop.name, 'info');
    await refreshLoops();
  } else if (btn.dataset.loopAct === 'export') {
    download(safeFileName(loop.name) + '.json', JSON.stringify(loop, null, 2), 'application/json');
  } else if (btn.dataset.loopAct === 'edit') {
    if (isRecording) { alert('أوقف التسجيل أولاً'); return; }
    localSteps = loop.steps.map(s => ({ ...s }));
    await setEditContext({ id: loop.id, name: loop.name });
    $('loopName').value = loop.name;
    $('loopDesc').value = loop.desc || '';
    $('stepDelay').value = loop.stepDelay || 800;
    await syncSteps();
    renderSteps();
    switchToTab('record');
  }
}

async function restoreBuiltin(name) {
  if (!confirm('استرجاع لوب "' + name + '" الافتراضي؟ سيُستبدل تسجيلك الحالي.')) return;
  const res = await bg('BG_RESTORE_BUILTIN', { name });
  if (!res.ok) { addLog('خطأ: ' + res.error, 'err'); return; }
  addLog('↩ تم استرجاع لوب ' + name + ' الافتراضي', 'ok');
  await refreshLoops();
}

// ============================================================
// ===== التسجيل =====
// ============================================================
async function toggleRecording() {
  if (!isRecording) {
    const res = await bg('BG_START_RECORDING');
    if (!res.ok) { addLog('خطأ: ' + res.error, 'err'); alert(res.error); return; }
    localSteps = [];
    renderSteps();
    await chrome.storage.local.set({ recordingStartedAt: Date.now() });
    startRecordingUI(Date.now());
    addLog('⏺ بدأ التسجيل — نفّذ الخطوات في iCare', 'info');
  } else {
    const res = await bg('BG_STOP_RECORDING');
    stopRecordingUI();
    if (res.steps) { localSteps = res.steps; renderSteps(); }
    addLog('⏹ انتهى التسجيل — ' + localSteps.length + ' خطوة. راجعها ثم احفظ.', 'ok');
  }
}

function startRecordingUI(startedAt) {
  isRecording = true;
  recStartedAt = startedAt || Date.now();
  $('recDot').classList.add('recording');
  $('recBtn').textContent = '⏹ إيقاف';
  $('recBtn').classList.add('btn-stop');
  $('recLabel').textContent = 'جارٍ التسجيل...';
  const tick = () => {
    const secs = Math.floor((Date.now() - recStartedAt) / 1000);
    $('recTime').textContent = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
  };
  tick();
  clearInterval(recTimer);
  recTimer = setInterval(tick, 1000);
  clearInterval(stepsPoll);
  stepsPoll = setInterval(pollSteps, 700);
}

function stopRecordingUI() {
  isRecording = false;
  clearInterval(recTimer);
  clearInterval(stepsPoll);
  $('recDot').classList.remove('recording');
  $('recBtn').textContent = '⏺ ابدأ';
  $('recBtn').classList.remove('btn-stop');
  $('recLabel').textContent = 'جاهز للتسجيل';
}

async function pollSteps() {
  const res = await bg('BG_GET_PENDING_STEPS');
  if (res.steps && JSON.stringify(res.steps) !== JSON.stringify(localSteps)) {
    localSteps = res.steps;
    renderSteps();
  }
}

async function restoreRecording() {
  const s = await chrome.storage.local.get(['isRecording', 'recordingStartedAt', 'pendingSteps', 'editLoop']);
  localSteps = s.pendingSteps || [];
  if (s.editLoop && s.editLoop.name) {
    $('loopName').value = s.editLoop.name;
    $('loopName').readOnly = true;
  }
  renderSteps();
  if (s.isRecording) {
    startRecordingUI(s.recordingStartedAt);
    switchToTab('record');
  } else if (localSteps.length) {
    addLog('يوجد ' + localSteps.length + ' خطوة مسجلة غير محفوظة (تبويب تسجيل)', 'info');
  }
}

async function rerecordLoop(name, desc) {
  if (isRecording) { switchToTab('record'); return; }
  const loop = loopByName(name);
  await setEditContext({ id: loop ? loop.id : null, name });
  $('loopName').value = name;
  $('loopDesc').value = desc;
  switchToTab('record');
  const hint = name === 'تاسك'
    ? 'اكتب اسم الموظف "' + $('qtEmployee').value + '" ونص الرسالة كما في تبويب تاسك — تتحول تلقائياً لمتغيرات'
    : name === 'حوالة' ? 'اكتب رقم الموظف "' + $('hvStaff').value + '" كما في تبويب حوالة — يتحول تلقائياً لمتغير' : '';
  addLog('افتح ملف مريض في iCare ثم نفّذ خطوات "' + name + '" يدوياً. ' + hint, 'info');
  await toggleRecording();
}

async function setEditContext(ctx) {
  if (ctx) {
    await chrome.storage.local.set({ editLoop: ctx });
    $('loopName').readOnly = true;
  } else {
    await chrome.storage.local.remove('editLoop');
    $('loopName').readOnly = false;
  }
}

// ============================================================
// ===== الخطوات =====
// ============================================================
const TYPE_ICON = {
  click: '🖱️', clickText: '🖱️', input: '✏️', select: '📋', navigate: '🔗', wait: '⏳', checkbox: '☑️',
  customSelect: '🔽', selectFirstOption: '🔽', contentInput: '📝', key: '⌨️', verify: '✅'
};

function stepLabel(s) {
  const target = s.label ? '[' + s.label + '] ' : '';
  switch (s.type) {
    case 'click':             return 'نقر: ' + target + (s.text || s.ariaLabel || s.selector);
    case 'clickText':         return 'نقر على نص: ' + s.text;
    case 'input':             return 'كتابة في: ' + target + (s.placeholder || s.selector);
    case 'select':            return 'اختيار في: ' + target + (s.placeholder || s.selector);
    case 'checkbox':          return 'تحديد: ' + target + (s.placeholder || s.selector);
    case 'navigate':          return 'فتح صفحة: ' + shortUrl(s.url);
    case 'wait':              return 'انتظار: ' + (s.selector || s.text);
    case 'customSelect':      return 'اختيار من القائمة: ' + (s.text || s.value);
    case 'selectFirstOption': return 'اختيار نتيجة البحث' + (s.match ? ' (' + s.match + ')' : '');
    case 'contentInput':      return 'كتابة نص: ' + target;
    case 'key':               return 'مفتاح: ' + s.key;
    case 'verify':            return 'تحقق من نجاح الحفظ';
    default:                  return s.type;
  }
}

function stepDetail(s) {
  if (['input', 'select', 'contentInput'].includes(s.type)) return 'القيمة: ' + (String(s.value ?? '') || '—');
  if (s.type === 'checkbox') return s.value ? 'مُحدد' : 'غير مُحدد';
  if (s.type === 'navigate') return s.url || '';
  if (s.type === 'verify') return s.goneText ? 'اختفاء زر "' + s.goneText + '" أو رسالة نجاح' : 'رسالة نجاح';
  return s.selector || '';
}

function renderSteps() {
  $('stepsCount').textContent = localSteps.length;
  const list = $('stepsList');
  if (!localSteps.length) {
    list.innerHTML = '<div class="empty">ابدأ التسجيل وتفاعل مع iCare</div>';
    return;
  }
  list.innerHTML = localSteps.map((s, i) => `
    <div class="step-item">
      <div class="step-num">${i + 1}</div>
      <span class="step-type-icon">${TYPE_ICON[s.type] || '•'}</span>
      <div class="step-info">
        <div class="step-name" title="${esc(stepLabel(s))}">${esc(stepLabel(s))}</div>
        <div class="step-detail" title="${esc(stepDetail(s))}">${esc(stepDetail(s))}</div>
      </div>
      ${editableField(s) ? `<button class="step-del step-edit" data-step-act="edit" data-idx="${i}" title="تعديل">✎</button>` : ''}
      <button class="step-del" data-step-act="up" data-idx="${i}" title="تحريك لأعلى">▲</button>
      <button class="step-del" data-step-act="del" data-idx="${i}" title="حذف">✕</button>
    </div>`).join('');
  list.scrollTop = list.scrollHeight;
}

function editableField(s) {
  if (['input', 'select', 'contentInput'].includes(s.type)) return 'value';
  if (['customSelect', 'clickText'].includes(s.type)) return 'text';
  if (s.type === 'selectFirstOption') return 'match';
  if (s.type === 'navigate') return 'url';
  return null;
}

async function onStepsListClick(e) {
  const btn = e.target.closest('[data-step-act]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const step = localSteps[idx];
  if (!step) return;
  if (btn.dataset.stepAct === 'del') {
    localSteps.splice(idx, 1);
  } else if (btn.dataset.stepAct === 'up') {
    if (idx === 0) return;
    [localSteps[idx - 1], localSteps[idx]] = [localSteps[idx], localSteps[idx - 1]];
  } else if (btn.dataset.stepAct === 'edit') {
    const field = editableField(step);
    const hint = ['value', 'match', 'text'].includes(field)
      ? '\nمتغيرات متاحة: {PTID} {DATE} {TASK_EMPLOYEE} {TASK_MESSAGE} {TASK_TITLE} {TASK_TYPE}' +
        ' {TASK_PRIORITY} {TASK_CATEGORY} {TASK_SUBCATEGORY} {HANDOVER_STAFF}' : '';
    const next = prompt('القيمة الجديدة:' + hint, String(step[field] ?? ''));
    if (next === null) return;
    step[field] = next;
    if (step.type === 'customSelect') step.value = next;
  }
  await syncSteps();
  renderSteps();
}

async function syncSteps() {
  await bg('BG_SET_PENDING_STEPS', { steps: localSteps });
}

async function clearSteps() {
  if (localSteps.length && !confirm('مسح كل الخطوات المسجلة؟')) return;
  localSteps = [];
  await syncSteps();
  await setEditContext(null);
  renderSteps();
  addLog('تم مسح الخطوات', 'info');
}

async function saveLoop() {
  if (isRecording) { alert('أوقف التسجيل أولاً'); return; }
  const { editLoop } = await chrome.storage.local.get('editLoop');
  const name = ((editLoop && editLoop.name) || $('loopName').value).trim();
  if (!name) { alert('أدخل اسم اللوب'); return; }
  if (!localSteps.length) { alert('لا توجد خطوات مسجلة'); return; }
  const existing = loopByName(name);
  if (existing && !(editLoop && editLoop.name === name) && !confirm('يوجد لوب بنفس الاسم — استبداله؟')) return;

  const res = await bg('BG_SAVE_LOOP', {
    name,
    desc: $('loopDesc').value.trim(),
    steps: localSteps,
    stepDelay: parseInt($('stepDelay').value, 10) || 800,
    replaceId: editLoop ? editLoop.id : null,
    // القيم المطابقة لهذه الإعدادات تتحول لمتغيرات داخل اللوب
    vars: {
      ...getTaskVars(),
      TASK_EMPLOYEE: $('qtEmployee').value,
      TASK_MESSAGE: $('qtMessage').value,
      HANDOVER_STAFF: $('hvStaff').value
    }
  });
  if (!res.ok) { addLog('خطأ في الحفظ: ' + res.error, 'err'); return; }
  addLog('💾 تم حفظ اللوب: ' + name + ' (' + res.loop.steps.length + ' خطوة)', 'ok');
  await setEditContext(null);
  $('loopName').value = '';
  $('loopDesc').value = '';
  localSteps = [];
  renderSteps();
  await refreshLoops();
  const panel = Object.values(PANELS).find(pn => pn.loopName === name);
  if (panel) switchToTab(panel.tab);
}

// ============================================================
// ===== أرقام الملفات =====
// ============================================================
function parseIdList(raw) {
  return [...new Set(String(raw || '').split(/[\n,،;\s\t]+/).map(s => s.trim()).filter(Boolean))];
}

function parseIds(p) {
  const ids = parseIdList($(p + 'PtidInput').value);
  const count = $(p + 'Count');
  if (count) {
    count.textContent = ids.length + ' ملف';
    count.style.background = ids.length ? '#e8f4e8' : '#f4f4f1';
    count.style.color = ids.length ? '#1E4E4D' : '#888';
  }
  const preview = $(p + 'Preview');
  if (preview) {
    preview.style.display = ids.length ? 'block' : 'none';
    $(p + 'PreviewCount').textContent = ids.length;
    $(p + 'Chips').innerHTML = ids.slice(0, 200).map(id => '<span class="qt-chip">' + esc(id) + '</span>').join('') +
      (ids.length > 200 ? '<span class="qt-chip">+' + (ids.length - 200) + '</span>' : '');
  }
  return ids;
}

async function restoreInputs() {
  const s = await chrome.storage.local.get([
    'qtSavedMessage', 'qtSavedEmployee', 'hvSavedStaff', 'qtPtidDraft', 'hvPtidDraft', 'popupLastTab', 'qtVars', 'humanMode', 'runInBackground'
  ]);
  showHumanMode(s.humanMode || DEFAULT_HUMAN_MODE);
  showRunInBackground(s.runInBackground !== false);
  setTaskVars({ ...DEFAULT_TASK_VARS, ...(s.qtVars || {}) });
  $('qtMessage').value = s.qtSavedMessage || DEFAULT_TASK_MESSAGE;
  $('qtEmployee').value = s.qtSavedEmployee || DEFAULT_TASK_EMPLOYEE;
  $('hvStaff').value = s.hvSavedStaff || DEFAULT_HANDOVER_STAFF;
  $('qtPtidInput').value = s.qtPtidDraft || '';
  $('hvPtidInput').value = s.hvPtidDraft || '';
  parseIds('qt');
  parseIds('hv');
  if (s.popupLastTab && s.popupLastTab !== 'record') switchToTab(s.popupLastTab);
}

// ============================================================
// ===== حقول التاسك (متغيرات) =====
// ============================================================
function taskVarInputs() {
  return [...document.querySelectorAll('#tab-quicktask [data-var]')];
}

function getTaskVars() {
  const vars = {};
  taskVarInputs().forEach(input => { vars[input.dataset.var] = input.value.trim(); });
  return vars;
}

function setTaskVars(vars) {
  taskVarInputs().forEach(input => { input.value = vars[input.dataset.var] ?? ''; });
  updateTitleCount();
}

function saveTaskVars() {
  chrome.storage.local.set({ qtVars: getTaskVars() });
}

function updateTitleCount() {
  const len = $('qtTitle').value.length;
  $('qtTitleCount').textContent = len + '/35';
  $('qtTitleCount').classList.toggle('full', len >= 35);
}

// المتغيرات المعبأة التي لا يستخدمها اللوب
function unusedVars(loop, vars) {
  const text = JSON.stringify(loop.steps || []);
  return Object.entries(vars)
    .filter(([k, v]) => v && !text.includes('{' + k + '}') && !text.includes('%7B' + k + '%7D'))
    .map(([k]) => VAR_LABELS[k] || k);
}

// ============================================================
// ===== استيراد Excel =====
// ============================================================
function setupImportListeners() {
  $('impPickBtn').addEventListener('click', () => $('impFile').click());
  $('impReplaceBtn').addEventListener('click', () => $('impFile').click());
  $('impFile').addEventListener('change', () => {
    const file = $('impFile').files[0];
    if (file) loadImportFile(file);
    $('impFile').value = '';
  });
  $('impFullPageBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1') }));
  $('impClearBtn').addEventListener('click', () => {
    importState = null;
    saveImport();
    renderImport();
    addLog('أُلغي الاستيراد — عودة للإدخال اليدوي', 'info');
  });
  document.querySelectorAll('.imp-map select').forEach(sel => sel.addEventListener('change', () => {
    importState.mapping[sel.dataset.field] = Number(sel.value);
    delete importState.retryItems;
    saveImport();
    renderImport();
  }));
  $('impRule').addEventListener('change', () => {
    importState.rule = $('impRule').value;
    delete importState.retryItems;
    saveImport();
    renderImport();
  });
  $('impFilterCol').addEventListener('change', () => {
    importState.filter = { col: Number($('impFilterCol').value), exclude: [] };
    delete importState.retryItems;
    saveImport();
    renderImport();
  });
  $('impFilterValues').addEventListener('change', e => {
    const box = e.target.closest('input[data-value]');
    if (!box) return;
    const exclude = new Set(importState.filter.exclude || []);
    if (box.checked) exclude.delete(box.dataset.value); else exclude.add(box.dataset.value);
    importState.filter.exclude = [...exclude];
    delete importState.retryItems;
    saveImport();
    renderImport();
  });
  $('impDefaultEmployee').addEventListener('input', () => {
    importState.defaultEmployee = $('impDefaultEmployee').value.trim();
    chrome.storage.local.set({ impDefaultEmployee: importState.defaultEmployee });
    delete importState.retryItems;
    saveImport();
    renderImport();
  });
  $('impSkipHidden').addEventListener('change', () => {
    importState.skipHidden = $('impSkipHidden').checked;
    delete importState.retryItems;
    saveImport();
    renderImport();
  });
  $('impClean').addEventListener('change', () => {
    importState.clean = $('impClean').checked;
    saveImport();
    renderImport();
  });

  // السحب والإفلات على كامل الصفحة (يعمل بأفضل شكل في "الصفحة الكاملة")
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer && e.dataTransfer.types || [])].includes('Files');
  document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('drag-over'); });
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('drag-over'); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) { switchToTab('quicktask'); loadImportFile(file); }
  });
}

async function loadImportFile(file) {
  if (!/\.(xlsx?|csv)$/i.test(file.name)) { alert('الملف يجب أن يكون xls أو xlsx أو csv'); return; }
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const { rows, sheetName, hidden, misaligned } = TaskImport.readWorkbookRows(data, XLSX);
    const table = TaskImport.buildTable(rows, hidden, misaligned);
    if (!table.rows.length) { alert('لم يُعثر على بيانات في الملف'); return; }
    const { impDefaultEmployee } = await chrome.storage.local.get('impDefaultEmployee');
    importState = {
      importedAt: new Date().toISOString(),
      fileModified: file.lastModified || null,
      defaultEmployee: impDefaultEmployee ?? DEFAULT_IMPORT_EMPLOYEE,
      fileName: file.name,
      sheetName,
      headers: table.headers,
      rows: table.rows.map(r => table.headers.map((_, i) => r[i] ?? '')),
      hidden: table.hidden,
      misaligned: table.misaligned,
      skipHidden: true,
      mapping: TaskImport.detectMapping(table.headers),
      clean: true
    };
    const titleCol = importState.mapping.title;
    const visibleTable = { rows: table.rows.filter((_, i) => !table.hidden[i]) };
    const fewValues = titleCol >= 0 && TaskImport.distinctValues(visibleTable, titleCol).length <= 12;
    importState.filter = { col: fewValues ? titleCol : -1, exclude: [] };
    // نوع ملف معروف ← عنوانه ورسالته الثابتان في حقول التبويب (قابلة للتعديل)
    const profile = TaskImport.PROFILES.find(p => p.id === importState.mapping.profile);
    if (profile && profile.rules) {
      // قوالب القواعد: الموظف والعنوان والرسالة لكل صف حسب سببه؛ يبدأ بأول سبب (اختيار واعٍ قبل "الكل")
      importState.rule = profile.rules[0].id;
      addLog('📋 تم التعرف على "' + profile.label + '" — اختر سبب الإرسال من القائمة', 'ok');
    } else if (profile) {
      $('qtTitle').value = profile.title;
      $('qtMessage').value = profile.message;
      updateTitleCount();
      saveTaskVars();
      chrome.storage.local.set({ qtSavedMessage: profile.message });
      addLog('📋 تم التعرف على "' + profile.label + '" — الموظف = Doctor، والعنوان والرسالة من القالب (يمكن تعديلهما)', 'ok');
    }
    saveImport();
    renderImport();
    learnStaffFromImport(importState).then(renderImport).catch(() => {});
    const n = importItems().length;
    const hiddenN = table.hidden.filter(Boolean).length;
    addLog('📂 تم استيراد "' + file.name + '" — ' + n + ' تاسك' +
      (hiddenN ? ' (استُبعد ' + hiddenN + ' صف مخفي في Excel)' : ''), 'ok');
    if (importState.mapping.ptid < 0) alert('لم يُعثر على عمود رقم الملف تلقائياً — اختره من القائمة');
  } catch (e) {
    addLog('تعذر قراءة الملف: ' + e.message, 'err');
    alert('تعذر قراءة الملف: ' + e.message);
  }
}

function renderImportFilter() {
  const filter = importState.filter || { col: -1, exclude: [] };
  const onlyVisible = importState.skipHidden !== false && Array.isArray(importState.hidden);
  const table = { headers: importState.headers,
    rows: onlyVisible ? importState.rows.filter((_, i) => !importState.hidden[i]) : importState.rows };
  $('impFilterCol').innerHTML = '<option value="-1">— بدون تصفية —</option>' +
    importState.headers.map((hd, i) => '<option value="' + i + '">' + esc(hd) + '</option>').join('');
  $('impFilterCol').value = String(filter.col);
  $('impFilterCol').disabled = Boolean(importState.retryItems);
  if (filter.col < 0 || importState.retryItems) { $('impFilterValues').innerHTML = ''; return; }
  const values = TaskImport.distinctValues(table, filter.col);
  const exclude = new Set(filter.exclude || []);
  $('impFilterValues').innerHTML = values.length > 40
    ? '<span class="muted">القيم كثيرة (' + values.length + ') — اختر عموداً آخر للتصفية</span>'
    : values.map(v => '<label class="imp-chip' + (exclude.has(v.value) ? ' off' : '') + '" title="' + esc(v.value) + '">' +
        '<input type="checkbox" data-value="' + esc(v.value) + '"' + (exclude.has(v.value) ? '' : ' checked') + '>' +
        esc(v.value.length > 28 ? v.value.slice(0, 28) + '…' : v.value) + ' <b>' + v.count + '</b></label>').join('');
}

// قائمة "سبب الإرسال" لقوالب القواعد (مثل GP Note) مع عدد كل سبب ولمن يُرسل
function renderImportRule(profile, res) {
  const show = Boolean(profile && profile.rules && !importState.retryItems);
  $('impRuleRow').style.display = show ? '' : 'none';
  if (!show) return;
  const counts = res.ruleCounts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const current = importState.rule || 'all';
  $('impRule').innerHTML = profile.rules.map(r =>
    '<option value="' + r.id + '">' + esc(r.label) + ' (' + (counts[r.id] || 0) + ')</option>').join('') +
    '<option value="all">كل الأسباب (' + total + ')</option>';
  $('impRule').value = current;
  const rule = profile.rules.find(r => r.id === current);
  $('impRuleInfo').textContent = rule
    ? 'الموظف: ' + (rule.employee || 'طبيب الحالة (Doctor Name)') + '\nالعنوان: ' + rule.title + '\nالرسالة: ' +
      rule.message.replace(/\{NOTE\}/g, '‹GP Note›').replace(/\{DR_P\}/g, '‹DR P›').replace(/\{DR_D\}/g, '‹DR D›')
    : 'كل سبب يُرسل لموظفه ورسالته.';
  if (res.unmatched) $('impRuleInfo').textContent += '\n(' + res.unmatched + ' صف لا ينطبق عليه أي سبب — لا يُرسل)';
}

function importResult() {
  if (!importState) return null;
  if (importState.retryItems) return { items: importState.retryItems, skipped: 0, duplicates: 0 };
  return TaskImport.buildItems({ headers: importState.headers, rows: importState.rows, hidden: importState.hidden, misaligned: importState.misaligned, headerRow: 0 },
    importState.mapping, { cleanMessage: importState.clean, filter: importState.filter, rule: importState.rule || 'all',
      skipHidden: importState.skipHidden !== false,
      defaultEmployee: importState.defaultEmployee ?? DEFAULT_IMPORT_EMPLOYEE });
}

function importItems() {
  const res = importResult();
  return res ? res.items : null;
}

function saveImport() {
  chrome.storage.local.set({ qtImport: importState });
}

async function restoreImport() {
  const { qtImport } = await chrome.storage.local.get('qtImport');
  const valid = qtImport && Array.isArray(qtImport.headers) && Array.isArray(qtImport.rows) &&
    qtImport.mapping && typeof qtImport.mapping === 'object' &&
    Array.isArray(qtImport.hidden) && qtImport.hidden.length === qtImport.rows.length;
  importState = valid ? qtImport : null;
  if (qtImport && !valid) {
    chrome.storage.local.remove('qtImport');
    addLog('⚠ الملف المستورد سابقاً "' + (qtImport.fileName || '') + '" كان بنسخة قديمة لا تعرف الصفوف المخفية — أُلغي، استورده من جديد', 'err');
  }
  renderImport();
}

function renderImport() {
  try {
    renderImportUnsafe();
  } catch (e) {
    addLog('تعذر عرض الملف المستورد (' + e.message + ') — تم إلغاؤه، استورده من جديد', 'err');
    importState = null;
    chrome.storage.local.remove('qtImport');
    $('impDrop').style.display = '';
    $('impLoaded').style.display = 'none';
    ['qtIdsLabel', 'qtIdsToolbar', 'qtPtidInput', 'qtPreview'].forEach(id => $(id).classList.remove('ids-locked'));
  }
}

function renderImportUnsafe() {
  const loaded = Boolean(importState);
  $('impDrop').style.display = loaded ? 'none' : '';
  $('impLoaded').style.display = loaded ? '' : 'none';
  // الإدخال اليدوي للأرقام معطل أثناء الاستيراد
  ['qtIdsLabel', 'qtIdsToolbar', 'qtPtidInput', 'qtPreview'].forEach(id => $(id).classList.toggle('ids-locked', loaded));
  if (!loaded) return;

  const { headers, mapping } = importState;
  const res = importResult();
  const profile = TaskImport.PROFILES.find(p => p.id === mapping.profile);
  $('impFileName').textContent = '📗 ' + importState.fileName + (importState.retryItems ? ' — إعادة الفاشلة' : '') +
    (profile && !importState.retryItems ? ' · 📋 ' + profile.label : '');
  $('impFileName').title = importState.fileName + ' / ' + importState.sheetName +
    '\nاستُورد: ' + fmtDate(importState.importedAt) +
    (importState.fileModified ? '\nآخر حفظ للملف: ' + fmtDate(new Date(importState.fileModified).toISOString()) : '') +
    '\nإذا عدّلت الملف أو فلترته في Excel بعد ذلك: احفظه ثم "📂 ملف آخر" لإعادة الاستيراد';
  $('impCount').textContent = res.items.length + ' تاسك';
  $('impClean').checked = importState.clean !== false;
  const hiddenTotal = (importState.hidden || []).filter(Boolean).length;
  $('impSkipHiddenRow').style.display = hiddenTotal && !importState.retryItems ? '' : 'none';
  $('impHiddenCount').textContent = hiddenTotal;
  $('impSkipHidden').checked = importState.skipHidden !== false;
  if (document.activeElement !== $('impDefaultEmployee')) {
    $('impDefaultEmployee').value = importState.defaultEmployee ?? DEFAULT_IMPORT_EMPLOYEE;
  }
  renderImportFilter();
  renderImportRule(profile, res);

  document.querySelectorAll('.imp-map select').forEach(sel => {
    const field = sel.dataset.field;
    const none = field === 'ptid' ? '— اختر —' : '— من إعدادات التبويب —';
    sel.innerHTML = '<option value="-1">' + none + '</option>' +
      headers.map((hd, i) => '<option value="' + i + '">' + esc(hd) + '</option>').join('');
    sel.value = String(mapping[field] ?? -1);
    sel.disabled = Boolean(importState.retryItems);
  });

  const notes = [];
  const fallback = { TASK_EMPLOYEE: $('qtEmployee').value.trim(), TASK_TITLE: $('qtTitle').value.trim(), TASK_MESSAGE: $('qtMessage').value.trim() };
  const empty = key => res.items.filter(it => !it.vars[key]).length;
  if (mapping.ptid < 0) notes.push('<div class="err">اختر عمود رقم الملف</div>');
  const def = (importState.defaultEmployee ?? DEFAULT_IMPORT_EMPLOYEE).trim();
  if (def && !importState.retryItems && mapping.employee >= 0) {
    const col = mapping.employee;
    const noDoctor = res.items.filter(it => !it.misaligned && it.vars.TASK_EMPLOYEE === def &&
      !TaskImport.valueText(importState.rows[it.row - 1] && importState.rows[it.row - 1][col])).length;
    if (noDoctor) notes.push('<div class="warn">' + noDoctor + ' صف بدون طبيب ← سيُرسل إلى "' + esc(def) + '"</div>');
  }
  // الأطباء المحفوظة أرقامهم في الذاكرة ← يُبحث عنهم بالرقم الوظيفي
  const byId = new Set(res.items.map(it => it.vars.TASK_EMPLOYEE).filter(v => v && !/^\d+$/.test(v) && staffDirectory[staffKey(v)]));
  if (byId.size) notes.push('<div class="muted">👥 ' + byId.size + ' موظف محفوظ رقمه في الذاكرة — سيُبحث عنه بالرقم الوظيفي</div>');
  // رقم ملف قصير جداً (مثل 1) غالباً خطأ في التقرير — قد يفتح تاسك لمريض آخر
  const suspicious = res.items.filter(it => /^\d{1,2}$/.test(it.ptid)).map(it => it.ptid);
  if (suspicious.length) {
    notes.push('<div class="err">⚠ رقم ملف مشبوه: ' + esc(suspicious.join('، ')) +
      ' — تأكد منه في الملف قبل التشغيل (قد يكون لمريض آخر)</div>');
  }
  // صفوف منزاحة في تصدير iCare (خلايا زائدة): الطبيب غير موثوق ← الموظف البديل
  if (res.misalignedPtids && res.misalignedPtids.length) {
    notes.push('<div class="err">⚠ ' + res.misalignedPtids.length + ' صف منزاح في ملف iCare (أعمدته غير مرتبة): ' +
      esc(res.misalignedPtids.join('، ')) + ' — ' +
      (profile && profile.rules ? 'لن يُرسل؛ راجعه يدوياً' : 'سيُرسل إلى "' + esc(importState.defaultEmployee ?? DEFAULT_IMPORT_EMPLOYEE) +
        '" بعنوان ورسالة التبويب بدل الطبيب المكتوب') + '</div>');
  }
  notes.push('<div class="muted">الصورة المستوردة: ' + esc(fmtDate(importState.importedAt)) +
    ' — أي تعديل أو فلترة في Excel بعدها يحتاج حفظ الملف ثم "📂 ملف آخر"</div>');
  if (!(importState.hidden || []).some(Boolean) && !importState.retryItems) {
    notes.push('<div class="muted">لا توجد صفوف مخفية في الملف المستورد — كل الصفوف تُحتسب</div>');
  }
  if (res.hiddenSkipped) notes.push('<div class="warn">تم استبعاد ' + res.hiddenSkipped + ' صف مخفي في Excel — الظاهرة فقط</div>');
  if (res.filtered) notes.push('<div class="warn">تم استبعاد ' + res.filtered + ' صف بالتصفية</div>');
  if (res.skipped) notes.push('<div class="warn">تم تجاهل ' + res.skipped + ' صف بدون رقم ملف صالح</div>');
  if (res.duplicates) notes.push('<div class="warn">تم حذف ' + res.duplicates + ' صف مكرر بالكامل</div>');
  const repeated = res.items.length - new Set(res.items.map(it => it.ptid)).size;
  if (repeated) notes.push('<div class="warn">' + repeated + ' مريض له أكثر من صف — سيُفتح تاسك لكل صف</div>');
  [['TASK_EMPLOYEE', 'الموظف'], ['TASK_TITLE', 'العنوان'], ['TASK_MESSAGE', 'الرسالة']].forEach(([k, label]) => {
    const n = empty(k);
    if (n) notes.push('<div class="' + (fallback[k] ? 'warn' : 'err') + '">' + n + ' صف بدون ' + label +
      (fallback[k] ? ' — سيُستخدم "' + esc(fallback[k].slice(0, 30)) + '" من التبويب' : ' — أدخله في التبويب أو اربط العمود') + '</div>');
  });
  $('impNotes').innerHTML = notes.join('');

  const cell = (v, fb) => v ? esc(v) : (fb ? '<span class="missing">' + esc(fb.slice(0, 25)) + '</span>' : '<span class="missing">—</span>');
  $('impPreview').innerHTML = '<table><thead><tr><th>رقم الملف</th><th>الموظف</th><th>العنوان</th><th>الرسالة</th></tr></thead><tbody>' +
    res.items.slice(0, 50).map(it => '<tr>' +
      '<td class="ptid">' + esc(it.ptid) + '</td>' +
      '<td>' + cell(it.vars.TASK_EMPLOYEE, fallback.TASK_EMPLOYEE) + '</td>' +
      '<td>' + cell(it.vars.TASK_TITLE, fallback.TASK_TITLE) + '</td>' +
      '<td class="msg">' + cell(it.vars.TASK_MESSAGE, fallback.TASK_MESSAGE) + '</td></tr>').join('') +
    (res.items.length > 50 ? '<tr><td colspan="4">… و ' + (res.items.length - 50) + ' صف آخر</td></tr>' : '') +
    '</tbody></table>';
}

// ============================================================
// ===== سجل التاسكات المرسلة =====
// ============================================================
const H_STATE = { verified: 'مؤكد', unverified: 'غير مؤكد', uncertain: 'ربما أُنشئ' };
let historyList = [];

async function refreshHistory() {
  const res = await bg('BG_GET_HISTORY');
  historyList = res.list || [];
  $('historyBadge').textContent = res.patients || 0;
  $('historyPanel').style.display = historyList.length ? '' : 'none';
  renderHistory();
}

function renderHistory() {
  const q = $('historySearch').value.trim().toLowerCase();
  const rows = historyList.filter(e => !q || [e.ptid, e.employee, e.title, e.loop].join(' ').toLowerCase().includes(q));
  $('historyList').innerHTML = rows.slice(0, 300).map(e => `
    <div class="history-row" title="${esc(e.message || '')}">
      <span class="h-ptid">${esc(e.ptid)}</span>
      <span class="h-info">${esc(fmtDate(e.at))} · ${esc(e.loop)} · ${esc(e.employee)}${e.title ? ' · ' + esc(e.title) : ''}</span>
      <span class="h-state ${esc(e.state)}">${esc(H_STATE[e.state] || e.state)}</span>
      <span class="h-del" data-h-del="${esc(e.ptid)}" title="إزالة من السجل">✕</span>
    </div>`).join('') || '<div class="empty">لا توجد نتائج</div>';
}

function exportHistory() {
  if (!historyList.length) { alert('السجل فارغ'); return; }
  // ما يظهر حالياً (بعد البحث) هو ما يُحفظ
  const q = $('historySearch').value.trim().toLowerCase();
  const list = historyList.filter(e => !q || [e.ptid, e.employee, e.title, e.loop].join(' ').toLowerCase().includes(q));
  const headers = REUSABLE_HEADERS.concat(['تاريخ الإرسال', 'اللوب', 'حالة الإرسال', 'ملف المصدر']);
  const rows = list.map(e => reusableCells(e.ptid, { TASK_EMPLOYEE: e.employee, TASK_TITLE: e.title, TASK_MESSAGE: e.message })
    .concat([fmtDate(e.at), e.loop, H_STATE[e.state] || e.state, e.source || '']));
  const saved = saveXlsx(titleDateName(list.map(e => e.title), 'التاسكات المرسلة'), 'التاسكات المرسلة', headers, rows);
  addLog('⬇ تم حفظ السجل في ' + saved, 'ok');
}

// ===== ذاكرة أرقام الموظفين =====
let staffDirectory = {};
const STAFF_SRC = { manual: 'يدوي', learned: 'من iCare', file: 'من ملف' };
// نفس مفتاح الـ background: أحرف صغيرة بدون "Dr." وعلامات الترقيم
const staffKey = name => String(name || '').toLowerCase().replace(/^\s*(dr|د)\.?\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function refreshStaff() {
  const res = await bg('BG_GET_STAFF');
  staffDirectory = (res && res.directory) || {};
  $('staffBadge').textContent = Object.keys(staffDirectory).length;
  renderStaff();
}

function renderStaff() {
  const q = $('staffSearch').value.trim().toLowerCase();
  const list = Object.entries(staffDirectory)
    .filter(([, e]) => !q || (e.name + ' ' + e.id).toLowerCase().includes(q))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('staffList').innerHTML = list.slice(0, 300).map(([key, e]) =>
    '<div class="staff-row" data-staff-key="' + esc(key) + '" title="اضغط للتعديل — ' + esc(fmtDate(e.at)) + '">' +
    '<span class="s-name">' + esc(e.name) + '</span><span class="s-id">' + esc(e.id) + '</span>' +
    '<span class="s-src ' + esc(e.source) + '">' + esc(STAFF_SRC[e.source] || e.source) + '</span>' +
    '<span class="h-del" data-staff-del="' + esc(key) + '" title="حذف">✕</span></div>').join('') ||
    '<div class="empty">' + (q ? 'لا توجد نتائج' : 'لا توجد أرقام محفوظة بعد') + '</div>';
}

async function saveStaffEntry() {
  const name = $('staffName').value.trim();
  const id = $('staffId').value.trim();
  const res = await bg('BG_SAVE_STAFF', { name, id });
  if (!res.ok) { alert(res.error); return; }
  addLog('👥 حُفظ "' + name + '" ← ' + id, 'ok');
  $('staffName').value = '';
  $('staffId').value = '';
  await refreshStaff();
  if (importState) renderImport();
}

function exportStaff() {
  const list = Object.values(staffDirectory);
  if (!list.length) { alert('لا توجد أرقام محفوظة'); return; }
  const rows = list.sort((a, b) => a.name.localeCompare(b.name))
    .map(e => [e.name, /^\d+$/.test(e.id) ? Number(e.id) : e.id, STAFF_SRC[e.source] || e.source, fmtDate(e.at)]);
  const saved = saveXlsx('أرقام الموظفين - ' + today(), 'أرقام الموظفين', ['Staff', 'Staff ID', 'المصدر', 'آخر تحديث'], rows);
  addLog('⬇ تم حفظ أرقام الموظفين في ' + saved, 'ok');
}

// قيم "1253 - الاسم" في أي عمود (مثل Staff) ← تُحفظ في الذاكرة. لا تُرسل أسماء المرضى: نتجاهل الأعمدة الحساسة.
async function learnStaffFromImport(state) {
  const values = new Set();
  state.headers.forEach((h, col) => {
    if (/name|اسم|patient|مريض|mobile|phone|جوال|national|هوية/i.test(h) && !/doctor|staff|طبيب|موظف/i.test(h)) return;
    state.rows.forEach(r => {
      const v = String(r[col] ?? '').replace(/\s+/g, ' ').trim();
      if (/^\d{1,7}\s*-\s*\p{L}[\p{L} .'-]{2,60}$/u.test(v)) values.add(v);
    });
  });
  if (!values.size) return;
  const res = await bg('BG_LEARN_STAFF', { values: [...values].slice(0, 2000) });
  if (res && res.added) addLog('👥 حُفظ ' + res.added + ' رقم وظيفي من الملف في الذاكرة', 'ok');
  await refreshStaff();
}

// هل أُرسل هذا الصف من نفس ملف Excel؟ (نفس اسم الملف + نفس الرسالة بعد تعويض {PTID})
function sentFromSameFile(item, sentInfo, fileName, fallbackMessage) {
  if (!sentInfo || !fileName) return false;
  const message = String(item.vars.TASK_MESSAGE || fallbackMessage || '').replace(/\{PTID\}/g, item.ptid).slice(0, 200);
  return (sentInfo.entries || [sentInfo.last]).some(e => e && e.source === fileName && e.message === message);
}

// التاسك الذي سيُرسل لكل ملف (العنوان والرسالة بعد تعويض {PTID}) — للمقارنة مع السجل
function outgoingTaskFor(items, fallbackVars) {
  const byPtid = new Map();
  (items || []).forEach(it => { if (!byPtid.has(it.ptid)) byPtid.set(it.ptid, it.vars || {}); });
  return ptid => {
    const v = { ...(fallbackVars || {}), ...(byPtid.get(ptid) || {}) };
    const fill = s => String(s || '').replace(/\{PTID\}/g, ptid).trim();
    return { title: fill(v.TASK_TITLE).slice(0, 35), message: fill(v.TASK_MESSAGE).slice(0, 200) };
  };
}

// سجل سابق لنفس التاسك (نفس الرسالة، أو نفس العنوان إذا لم توجد رسالة) — مثل "New Patient" مرة أخرى
function sameTaskEntry(info, out) {
  if (!out) return null;
  const entries = (info.entries || [info.last]).filter(Boolean).slice().reverse(); // الأحدث أولاً
  return entries.find(e => out.message ? e.message === out.message : (out.title && e.title === out.title)) || null;
}

// نافذة الإذن: تعيد مجموعة الملفات المسموح بإعادة الإرسال لها، أو null عند الإلغاء
// outFor(ptid) ← { title, message } للتاسك الجديد: نميز "نفس التاسك" عن "تاسك آخر" ونطلب تأكيداً ثانياً لنفس التاسك
function askResend(already, total, loopName, outFor) {
  return new Promise(resolve => {
    const dialog = $('resendDialog');
    const rows = already.map(([ptid, info]) => ({ ptid, info, same: sameTaskEntry(info, outFor && outFor(ptid)) }))
      .sort((a, b) => Boolean(b.same) - Boolean(a.same));
    const sameSet = new Set(rows.filter(r => r.same).map(r => r.ptid));
    $('resendTitle').textContent = 'أُرسل "' + loopName + '" سابقاً لـ ' + already.length + ' ملف';
    const fresh = total - already.length;
    $('resendInfo').innerHTML = (sameSet.size
      ? '<div class="resend-same-note">🔁 <b>' + sameSet.size + '</b> ملف أُرسل له <b>نفس التاسك</b> من قبل — لن يُعاد إلا إذا حددته وأكدت.</div>' : '') +
      'حدّد الملفات التي تريد إرسال تاسك لها <b>مرة أخرى</b>. غير المحددة ستُتخطى.' +
      (fresh ? '<br>الملفات الجديدة (' + fresh + ') ستُرسل كالمعتاد.' : '<br>لا توجد ملفات جديدة في هذه القائمة.');
    $('resendList').innerHTML = rows.map(({ ptid, info, same }) => {
      const e = same || info.last;
      const tag = same ? '<span class="r-tag same">🔁 نفس التاسك</span>'
        : (outFor ? '<span class="r-tag other">تاسك آخر</span>' : '');
      return '<label class="resend-row' + (same ? ' same' : '') + '"><input type="checkbox" data-ptid="' + esc(ptid) + '">' +
        '<span class="r-ptid">' + esc(ptid) + '</span>' +
        '<span class="r-meta">' + tag + esc(fmtDate(e.at)) + ' — ' + esc(e.employee || '') +
        (e.title ? ' — ' + esc(e.title) : '') + ' <span class="h-state ' + esc(e.state) + '">' + esc(H_STATE[e.state] || e.state) + '</span>' +
        (info.count > 1 ? ' (أُرسل ' + info.count + ' مرات)' : '') +
        (e.message ? '<br>' + esc(e.message.slice(0, 90)) : '') + '</span></label>';
    }).join('');
    $('resendAll').checked = false;
    $('resendSkipBtn').style.display = fresh ? '' : 'none';

    const boxes = () => [...$('resendList').querySelectorAll('input[type=checkbox]')];
    const selected = () => new Set(boxes().filter(b => b.checked).map(b => b.dataset.ptid));
    const updateOk = () => {
      const n = selected().size;
      $('resendOkBtn').textContent = n ? 'متابعة — إعادة ' + n + (fresh ? ' + ' + fresh + ' جديد' : '') : (fresh ? 'متابعة — الجديد فقط' : 'متابعة');
      $('resendOkBtn').disabled = !n && !fresh;
    };
    const finish = value => {
      cleanup();
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onAll = () => { boxes().forEach(b => { b.checked = $('resendAll').checked; }); updateOk(); };
    const onList = () => updateOk();
    const onOk = () => {
      const chosen = selected();
      const again = [...chosen].filter(ptid => sameSet.has(ptid));
      // تأكيد ثانٍ: نفس التاسك سيصل للمريض/الطبيب مرة أخرى
      if (again.length && !confirm('تأكيد: سيُرسل نفس التاسك مرة أخرى لـ ' + again.length + ' ملف أُرسل لهم سابقاً:\n' +
          again.slice(0, 15).join('، ') + (again.length > 15 ? '…' : '') + '\n\nمتأكد من إعادة الإرسال؟')) return;
      finish(chosen);
    };
    const onSkip = () => finish(new Set());
    const onCancel = () => finish(null);
    const onDialogCancel = e => { e.preventDefault(); finish(null); };
    function cleanup() {
      $('resendAll').removeEventListener('change', onAll);
      $('resendList').removeEventListener('change', onList);
      $('resendOkBtn').removeEventListener('click', onOk);
      $('resendSkipBtn').removeEventListener('click', onSkip);
      $('resendCancelBtn').removeEventListener('click', onCancel);
      $('resendCloseBtn').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onDialogCancel);
    }
    $('resendAll').addEventListener('change', onAll);
    $('resendList').addEventListener('change', onList);
    $('resendOkBtn').addEventListener('click', onOk);
    $('resendSkipBtn').addEventListener('click', onSkip);
    $('resendCancelBtn').addEventListener('click', onCancel);
    $('resendCloseBtn').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onDialogCancel);
    updateOk();
    dialog.showModal();
  });
}

// ============================================================
// ===== الوضع البشري =====
// ============================================================
// التشغيل في الخلفية: إعداد واحد مشترك (افتراضياً مفعّل)
function showRunInBackground(enabled) {
  Object.values(PANELS).forEach(pn => { $(pn.prefix + 'Background').checked = enabled; });
}

function setRunInBackground(enabled) {
  showRunInBackground(enabled);
  chrome.storage.local.set({ runInBackground: enabled });
}

function showHumanMode(mode) {
  Object.values(PANELS).forEach(pn => {
    $(pn.prefix + 'Human').checked = Boolean(mode.enabled);
    $(pn.prefix + 'Speed').value = String(mode.speed || 1);
    $(pn.prefix + 'Speed').disabled = !mode.enabled;
  });
}

function setHumanMode(mode) {
  const normalized = { enabled: Boolean(mode.enabled), speed: Number(mode.speed) || 1 };
  showHumanMode(normalized);
  chrome.storage.local.set({ humanMode: normalized });
}

// ============================================================
// ===== التشغيل =====
// ============================================================
async function startRun(kind, testOnly) {
  if (currentRun && currentRun.running) { alert('يوجد تشغيل جارٍ بالفعل'); return; }
  if (isRecording) { alert('أوقف التسجيل أولاً'); return; }
  const panel = PANELS[kind];
  const p = panel.prefix;

  const loop = panel.loopName ? loopByName(panel.loopName) : loops.find(l => String(l.id) === $('runLoopSelect').value);
  if (!loop) { alert(panel.loopName ? 'لوب ' + panel.loopName + ' غير موجود — اضغط "افتراضي"' : 'اختر لوبًا'); return; }

  // تبويب تاسك مع ملف مستورد: كل صف = تاسك بقيمه الخاصة
  let items = kind === 'task' ? importItems() : null;
  if (items && !Array.isArray(importState.hidden)) {
    alert('الملف المستورد بنسخة قديمة — أعد استيراده بزر "📂 ملف آخر" قبل التشغيل.');
    return;
  }
  if (items && !items.length) { alert('لا توجد صفوف صالحة في الملف المستورد'); return; }
  let ids = items ? items.map(it => it.ptid) : parseIds(p);
  if (!ids.length) { alert('أدخل أرقام الملفات أولاً'); return; }
  if (testOnly) { ids = ids.slice(0, 1); if (items) items = items.slice(0, 1); }

  // تشغيل جديد يستبدل قائمة "المتبقي" — ننبه حتى لا تضيع ملفات لم تكتمل
  await refreshResumeQueue();
  if (resumeQueue && !confirm('يوجد ' + resumeQueue.items.length + ' ملف متبقٍ لم يكتمل من تشغيل "' + resumeQueue.loopName + '".' +
      '\nالتشغيل الجديد سيستبدل قائمة المتبقي (لإكمالها اضغط إلغاء ثم "🔁 أكمل المتبقي").\nمتابعة التشغيل الجديد؟')) return;

  const payload = {
    kind,
    loopId: loop.id,
    ptids: ids,
    delay: (parseFloat($(p + 'Delay').value) || 3) * 1000,
    onFail: $(p + 'OnFail').value,
    human: { enabled: $(p + 'Human').checked, speed: Number($(p + 'Speed').value) || 1 },
    runIn: $(p + 'Background').checked ? 'background' : 'current',
    items: items || undefined,
    source: items ? { type: 'import', fileName: importState.fileName } : undefined
  };

  if (kind === 'task') {
    payload.taskEmployee = $('qtEmployee').value.trim();
    payload.taskMessage = $('qtMessage').value.trim();
    payload.vars = getTaskVars();
    const missing = (key, fallback) => items ? items.some(it => !it.vars[key] && !fallback) : !fallback;
    if (missing('TASK_EMPLOYEE', payload.taskEmployee)) { alert('أدخل اسم الموظف أو القسم (أو اربط عمود الموظف)'); return; }
    if (missing('TASK_MESSAGE', payload.taskMessage)) { alert('أدخل رسالة التاسك (أو اربط عمود الرسالة)'); return; }
    if (missing('TASK_TITLE', payload.vars.TASK_TITLE)) { alert('أدخل عنوان التاسك (أو اربط عمود العنوان)'); return; }
    // تنبيه إذا كان اللوب (تسجيل قديم) لا يستخدم حقلاً معبّأ
    const unused = unusedVars(loop, { ...payload.vars, TASK_EMPLOYEE: payload.taskEmployee, TASK_MESSAGE: payload.taskMessage });
    if (unused.length && !confirm('اللوب الحالي لا يستخدم: ' + unused.join('، ') +
        '\nهذه القيم لن تُطبق. اضغط "↩ افتراضي" لاستخدام اللوب الجديد، أو أعد التسجيل.\n\nمتابعة رغم ذلك؟')) return;
  } else if (kind === 'handover') {
    payload.handoverStaff = $('hvStaff').value.trim();
    if (!payload.handoverStaff) { alert('أدخل رقم الموظف'); return; }
  } else {
    payload.taskEmployee = $('qtEmployee').value.trim();
    payload.taskMessage = $('qtMessage').value.trim();
    payload.handoverStaff = $('hvStaff').value.trim();
    payload.vars = getTaskVars();
  }

  // ملفات أُرسل لها بنفس اللوب سابقاً
  const check = await bg('BG_CHECK_SENT', { ptids: ids, loopName: loop.name });

  // 1) من نفس ملف Excel ونفس الرسالة ← تخطٍّ تلقائي بدون سؤال
  if (items && importState && $('impSkipSameFile').checked) {
    const sameFile = items.filter(it => sentFromSameFile(it, (check.sent || {})[it.ptid], importState.fileName, payload.taskMessage));
    if (sameFile.length) {
      const skippedKeys = new Set(sameFile);
      items = items.filter(it => !skippedKeys.has(it));
      ids = items.map(it => it.ptid);
      payload.items = items;
      payload.ptids = ids;
      addLog('⏭ تم تخطي ' + sameFile.length + ' صف أُرسل سابقاً من نفس الملف "' + importState.fileName + '": ' +
        sameFile.slice(0, 10).map(it => it.ptid).join('، ') + (sameFile.length > 10 ? '…' : ''), 'info');
      if (!items.length) {
        alert('كل الصفوف (' + sameFile.length + ') أُرسل لها تاسك سابقاً من نفس الملف — لا يوجد جديد.\n' +
          'لإعادة الإرسال: أزل علامة "تخطَّ تلقائياً ما أُرسل سابقاً من نفس الملف".');
        return;
      }
    }
  }

  // 2) أُرسل سابقاً من مكان آخر (يدوياً أو ملف مختلف) ← اطلب الإذن لكل ملف
  const already = Object.entries((check && check.sent) || {}).filter(([ptid]) => ids.includes(ptid));
  if (already.length) {
    const resend = await askResend(already, new Set(ids).size, loop.name,
      outgoingTaskFor(items, { ...(payload.vars || {}), TASK_MESSAGE: payload.taskMessage }));
    if (!resend) { addLog('أُلغي التشغيل', 'info'); return; }
    const keep = ptid => !check.sent[ptid] || resend.has(ptid);
    ids = ids.filter(keep);
    if (items) items = items.filter(it => keep(it.ptid));
    if (!ids.length) { addLog('لا توجد ملفات جديدة للإرسال — تم تخطي كل الملفات المرسلة سابقاً', 'info'); return; }
    payload.ptids = ids;
    if (items) payload.items = items;
    const skipped = already.length - resend.size;
    if (skipped) addLog('⏭ تم تخطي ' + skipped + ' ملف أُرسل له تاسك سابقاً', 'info');
    if (resend.size) addLog('↻ إعادة إرسال لـ ' + resend.size + ' ملف بإذنك', 'info');
  }

  const hiddenSkippedNow = items && !importState.retryItems ? (importResult().hiddenSkipped || 0) : 0;
  const what = items ? 'فتح تاسك من "' + importState.fileName + '"' +
    (hiddenSkippedNow ? ' (الظاهرة فقط — استُبعد ' + hiddenSkippedNow + ' صف مخفي)' : '') : kind === 'task' ? 'فتح تاسك' : kind === 'handover' ? 'حوالة' : 'تشغيل "' + loop.name + '"';
  if (!testOnly && ids.length > 1 &&
      !confirm(what + ' لـ ' + ids.length + ' ملف؟\n' + (payload.runIn === 'background'
        ? 'سيعمل في تبويب منفصل "iCare Loop" بالخلفية — تصفّح ما تريد، فقط لا تغلق ذلك التبويب.'
        : 'لا تستخدم تبويب iCare أثناء التشغيل.'))) return;

  const res = await bg('BG_START_RUN', payload);
  if (!res.ok) { addLog('خطأ: ' + res.error, 'err'); alert(res.error); return; }
  reportedRunId = null;
  delete $(p + 'XlsName').dataset.touched;
  delete $(p + 'XlsWhich').dataset.userSet;
  addLog((testOnly ? '🧪 تجربة ' : '▶ ') + what + ' — ' + ids.length + ' ملف' +
    (payload.human.enabled ? ' (وضع بشري)' : '') +
    (payload.runIn === 'background' ? ' — في تبويب "iCare Loop" بالخلفية، يمكنك تصفّح صفحات أخرى' : ''), 'info');
  const st = await bg('BG_GET_RUN_STATE');
  renderRunState(st.state);
  startRunPoll();
}

async function stopRun() {
  await bg('BG_STOP_RUN');
  addLog('⏹ طلب إيقاف — ينتهي بعد الخطوة الحالية', 'info');
}

async function togglePause() {
  const resume = Boolean(currentRun && currentRun.paused);
  const res = await bg(resume ? 'BG_RESUME_RUN' : 'BG_PAUSE_RUN');
  if (!res || !res.ok) { addLog((res && res.error) || 'تعذر تنفيذ الطلب', 'err'); return; }
  addLog(resume ? '▶ استئناف — يكمل من حيث توقف' : '⏸ إيقاف مؤقت — يتوقف بعد اكتمال الملف الحالي', 'info');
  const st = await bg('BG_GET_RUN_STATE');
  renderRunState(st.state);
}

function startRunPoll() {
  clearInterval(runPoll);
  runPoll = setInterval(async () => {
    const st = await bg('BG_GET_RUN_STATE');
    if (st.state) renderRunState(st.state);
    if (!st.state || !st.state.running) clearInterval(runPoll);
  }, 1000);
}

function renderRunState(state) {
  if (!state) return;
  currentRun = state;
  const panel = PANELS[state.kind] || PANELS.custom;
  const p = panel.prefix;
  const results = state.results || [];
  const count = st => results.filter(r => r.status === st).length;
  const done = count('done');
  const fail = count('fail');
  const left = count('pending') + count('running');
  const total = results.length;

  $(p + 'ProgressSection').style.display = 'block';
  $(p + 'ProgressFill').style.width = (total ? Math.round((total - left) / total * 100) : 0) + '%';
  $(p + 'StatDone').textContent = done;
  $(p + 'StatFail').textContent = fail;
  $(p + 'StatLeft').textContent = left;

  const cur = results.find(r => r.status === 'running');
  let label;
  if (state.running && state.paused) {
    label = cur ? '⏸ سيتوقف مؤقتاً بعد اكتمال ' + cur.id + '...'
      : '⏸ متوقف مؤقتاً — ' + (total - left) + '/' + total + ' — اضغط "استئناف" للإكمال';
  } else if (state.running) {
    label = cur ? 'جارٍ: ' + cur.id + '  (' + (results.indexOf(cur) + 1) + '/' + total + ')' +
      (cur.attempt > 1 ? ' — محاولة ' + cur.attempt : '') : 'جارٍ التشغيل...';
  } else if (state.interrupted) {
    label = '⚠️ انقطع التشغيل — راجع النتائج';
  } else if (state.stopRequested) {
    label = '⏹ أُوقف التشغيل';
  } else {
    label = '✅ اكتمل — ' + done + ' ناجح، ' + fail + ' فشل';
  }
  $(p + 'ProgressLabel').textContent = label;
  $(p + 'ProgressLabel').classList.toggle('qt-progress-paused', Boolean(state.running && state.paused));

  $(p + 'Results').innerHTML = results.filter(r => r.status !== 'pending').slice(-12).reverse().map(r => {
    const cls = r.status === 'done' && r.warning ? 'warn' : r.status;
    const icon = { done: r.warning ? '⚠' : '✓', fail: '✗', running: '…', skipped: '–' }[r.status] || '';
    const msg = r.status === 'fail' ? r.error : r.status === 'done' ? (r.warning || panel.doneMsg) :
      r.status === 'running' ? 'قيد التنفيذ' : 'لم يُنفذ';
    return '<div class="qt-result-row ' + cls + '"><span class="qt-result-id">' + icon + ' ' + esc(r.id) +
      '</span><span class="qt-result-msg" title="' + esc(msg) + '">' + esc(msg) + '</span></div>';
  }).join('');

  // الأزرار: أثناء التشغيل كل أزرار البدء معطلة
  Object.values(PANELS).forEach(pn => {
    $(pn.prefix + 'RunBtn').disabled = state.running;
    $(pn.prefix + 'TestBtn').disabled = state.running;
    $(pn.prefix + 'StopBtn').style.display = state.running && pn.prefix === p ? '' : 'none';
    const pause = $(pn.prefix + 'PauseBtn');
    pause.style.display = state.running && pn.prefix === p ? '' : 'none';
    pause.classList.toggle('resume', Boolean(state.paused));
    pause.textContent = state.paused ? '▶ استئناف' : '⏸ إيقاف مؤقت';
  });
  $(p + 'ExportBtn').style.display = !state.running && total ? '' : 'none';
  $(p + 'RetryFailedBtn').style.display = !state.running && fail ? '' : 'none';
  if (state.running) renderResumeButtons(); else refreshResumeQueue();
  $(p + 'XlsRow').style.display = !state.running && total ? '' : 'none';
  if (!state.running && total) updateXlsRow(state.kind || 'custom');

  if (!state.running && reportedRunId !== state.runId) {
    reportedRunId = state.runId;
    addLog('النتائج: ' + done + ' ناجح، ' + fail + ' فشل' + (count('skipped') ? '، ' + count('skipped') + ' لم يُنفذ' : ''),
      fail ? 'err' : 'ok');
    refreshHistory();
    const warned = results.filter(r => r.warning).length;
    if (fail || warned) showReport(state);
  }
}

// ============================================================
// ===== تصدير Excel =====
// ============================================================
const XLS_FILTERS = {
  unverified: { label: 'غير مؤكدة', test: r => r.status === 'done' && Boolean(r.warning) },
  failed:     { label: 'فاشلة',     test: r => r.status === 'fail' || r.status === 'skipped' },
  all:        { label: 'كل الملفات', test: () => true }
};

// ── ملفات Excel قابلة لإعادة الاستيراد ──
// أول الأعمدة بالأسماء التي تربطها الإضافة تلقائياً عند الاستيراد؛ بعدها أعمدة معلومات لا تؤثر على الربط.
const REUSABLE_HEADERS = ['PTID', 'Case Doctor', 'Status', 'Reason',
  'Task Type', 'Task Priority', 'Task Category', 'Task Subcategory'];

function reusableCells(ptid, v) {
  return [ptid, v.TASK_EMPLOYEE || v.HANDOVER_STAFF || '', v.TASK_TITLE || '', v.TASK_MESSAGE || '',
    v.TASK_TYPE || '', v.TASK_PRIORITY || '', v.TASK_CATEGORY || '', v.TASK_SUBCATEGORY || ''];
}

// اسم الملف: عنوان التاسك الأكثر تكراراً + التاريخ (مثل "Skipped - 2026-09-29")
function titleDateName(titles, fallback) {
  const counts = {};
  titles.map(t => String(t || '').trim()).filter(Boolean).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return safeFileName(((top && top[0]) || fallback || 'تاسك') + ' - ' + today());
}

function saveXlsx(name, sheetName, headers, rows) {
  let fileName = safeFileName(name);
  if (!/\.xlsx$/i.test(fileName)) fileName += '.xlsx';
  const blob = buildXlsx({ sheetName, headers, rows, rtl: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
}

function runRowVars(r) {
  return { ...((currentRun && currentRun.variables) || {}), ...(r.vars || {}) };
}

function xlsRows(kind) {
  if (!currentRun || (currentRun.kind || 'custom') !== kind) return [];
  const which = $(PANELS[kind].prefix + 'XlsWhich').value;
  return (currentRun.results || []).filter(XLS_FILTERS[which].test);
}

function defaultXlsName(kind) {
  const rows = xlsRows(kind);
  return titleDateName(rows.map(r => runRowVars(r).TASK_TITLE), currentRun.loopName || PANELS[kind].title);
}

// يختار تلقائياً "غير المؤكدة" إن وُجدت، ويقترح اسماً ما لم يكتب المستخدم اسمه
function updateXlsRow(kind) {
  const p = PANELS[kind].prefix;
  const results = (currentRun && currentRun.results) || [];
  const which = $(p + 'XlsWhich');
  if (!which.dataset.userSet) {
    which.value = results.some(XLS_FILTERS.unverified.test) ? 'unverified'
      : results.some(XLS_FILTERS.failed.test) ? 'failed' : 'all';
  }
  const count = xlsRows(kind).length;
  $(p + 'XlsCount').textContent = count;
  $(p + 'XlsBtn').disabled = !count;
  const nameInput = $(p + 'XlsName');
  if (!nameInput.dataset.touched) nameInput.value = defaultXlsName(kind);
}

function exportExcel(kind) {
  const p = PANELS[kind].prefix;
  const rows = xlsRows(kind);
  if (!rows.length) { alert('لا توجد ملفات في هذا الاختيار'); return; }
  const name = $(p + 'XlsName').value.trim() || defaultXlsName(kind);
  const saved = saveRunResultsXlsx(rows, name, XLS_FILTERS[$(p + 'XlsWhich').value].label);
  addLog('📗 تم حفظ ' + rows.length + ' ملف في ' + saved + ' — يمكن استيراده في الإضافة مباشرة', 'ok');
}

const RUN_STATUS_AR = { done: 'تم', fail: 'فشل', skipped: 'لم يُنفذ', pending: 'لم يُنفذ', running: 'منقطع' };

function saveRunResultsXlsx(rows, name, sheetName) {
  const lastStep = r => {
    const failed = (r.trace || []).find(t => t.status === 'fail');
    return failed ? failed.number + '. ' + failed.type + ' — ' + (failed.target || '') : '';
  };
  const headers = REUSABLE_HEADERS.concat(['نتيجة التشغيل', 'تفاصيل', 'الخطوة المتوقفة', 'وقت الانتهاء', 'اللوب']);
  const data = rows.map(r => reusableCells(r.id, runRowVars(r)).concat([
    r.status === 'done' && r.warning ? 'تم — غير مؤكد' : (RUN_STATUS_AR[r.status] || r.status),
    r.error || r.warning || '',
    lastStep(r),
    r.finishedAt ? fmtDate(r.finishedAt) : '',
    currentRun.loopName || ''
  ]));
  return saveXlsx(name, sheetName, headers, data);
}

// غير المكتملة: فشل، لم يُنفذ (بعد إيقاف)، أو بقي معلقاً/منقطعاً — الناجح (حتى غير المؤكد) لا يُعاد
const INCOMPLETE = ['fail', 'skipped', 'pending', 'running'];
function incompleteResults(state) {
  return ((state && state.results) || []).filter(r => INCOMPLETE.includes(r.status));
}

// ===== المتبقي للإكمال =====
// يحفظه الـ background في storage.local مع كل تقدم (يبقى بعد الإيقاف أو إغلاق المتصفح)
let resumeQueue = null;

async function refreshResumeQueue() {
  const { resumeQueue: q } = await chrome.storage.local.get('resumeQueue');
  resumeQueue = q && Array.isArray(q.items) && q.items.length ? q : null;
  renderResumeButtons();
}

function renderResumeButtons() {
  const running = Boolean(currentRun && currentRun.running);
  Object.values(PANELS).forEach(pn => {
    $(pn.prefix + 'RerunBtn').style.display = 'none';
    $(pn.prefix + 'ResumeClearBtn').style.display = 'none';
  });
  if (running || !resumeQueue) return;
  const p = (PANELS[resumeQueue.kind] || PANELS.custom).prefix;
  const q = resumeQueue;
  const btn = $(p + 'RerunBtn');
  btn.style.display = '';
  $(p + 'ResumeClearBtn').style.display = '';
  btn.textContent = '🔁 أكمل المتبقي (' + q.items.length + ')';
  btn.title = 'إكمال ' + q.items.length + ' ملف من تشغيل "' + q.loopName + '" (' + (q.done || 0) + '/' + (q.total || 0) + ' اكتمل)' +
    (q.source && q.source.fileName ? ' — ' + q.source.fileName : '') + '\nآخر تحديث: ' + fmtDate(q.savedAt) +
    '\nبنفس القيم الأصلية لكل ملف';
}

async function clearResumeQueue() {
  if (!resumeQueue) return;
  if (!confirm('تجاهل ' + resumeQueue.items.length + ' ملف متبقٍ من تشغيل "' + resumeQueue.loopName + '"؟\nلن يظهر زر الإكمال لها بعد ذلك.')) return;
  const res = await bg('BG_CLEAR_RESUME');
  if (!res.ok) { alert(res.error); return; }
  addLog('✕ تم تجاهل الملفات المتبقية', 'info');
  await refreshResumeQueue();
}

async function rerunIncomplete(kind) {
  if (currentRun && currentRun.running) { alert('يوجد تشغيل جارٍ بالفعل'); return; }
  if (isRecording) { alert('أوقف التسجيل أولاً'); return; }
  await refreshResumeQueue();
  const q = resumeQueue;
  if (!q || (q.kind || 'custom') !== kind) { alert('لا توجد ملفات متبقية للإكمال'); return; }
  const panel = PANELS[kind];
  const p = panel.prefix;
  const loop = loopByName(q.loopName);
  if (!loop) { alert('اللوب "' + q.loopName + '" لم يعد موجوداً'); return; }

  const rest = q.items;
  let items = rest.map(r => ({ ptid: r.id, vars: r.vars || {}, row: r.row }));

  // أُرسل سابقاً (مثل "ربما أُنشئ": فشل بعد الضغط على الحفظ) ← نافذة الإذن
  const check = await bg('BG_CHECK_SENT', { ptids: items.map(it => it.ptid), loopName: loop.name });
  const already = Object.entries((check && check.sent) || {});
  if (already.length) {
    const resend = await askResend(already, new Set(items.map(it => it.ptid)).size, loop.name, outgoingTaskFor(items, q.variables));
    if (!resend) { addLog('أُلغي إكمال غير المكتملة', 'info'); return; }
    items = items.filter(it => !check.sent[it.ptid] || resend.has(it.ptid));
    if (!items.length) { addLog('لا يوجد ما يُعاد بعد استبعاد المرسل سابقاً', 'info'); return; }
  }

  const byStatus = st => rest.filter(r => r.status === st).length;
  const summary = [byStatus('fail') && byStatus('fail') + ' فشل', byStatus('skipped') && byStatus('skipped') + ' لم يُنفذ',
    (byStatus('pending') + byStatus('running')) && (byStatus('pending') + byStatus('running')) + ' منقطع'].filter(Boolean).join('، ');
  const runIn = $(p + 'Background').checked ? 'background' : 'current';
  // ملف انقطع أثناءه التشغيل أو فشل بعد الحفظ: ربما أُنشئ تاسكه — ننبه قبل الإعادة
  const unsure = rest.filter(r => r.committed || /انقطع/.test(r.error || '')).map(r => r.id)
    .filter(id => items.some(it => it.ptid === id));
  if (!confirm('إكمال ' + items.length + ' ملف من آخر تشغيل "' + q.loopName + '" (' + summary + ')' +
      '\nبنفس القيم (الموظف/العنوان/الرسالة لكل ملف)؟' +
      (unsure.length ? '\n⚠ ربما أُنشئ تاسك لـ: ' + unsure.join('، ') + ' — تحقق منها في iCare أو احذفها من القائمة' : '') +
      (runIn === 'background' ? '\nسيعمل في تبويب "iCare Loop" بالخلفية.' : ''))) return;

  // نفس قيم التشغيل الأصلي (وليس حقول التبويب الحالية)
  const vars = q.variables || {};
  const payload = {
    kind,
    loopId: loop.id,
    ptids: items.map(it => it.ptid),
    items,
    source: q.source || undefined,
    delay: (parseFloat($(p + 'Delay').value) || 3) * 1000,
    onFail: $(p + 'OnFail').value,
    human: { enabled: $(p + 'Human').checked, speed: Number($(p + 'Speed').value) || 1 },
    runIn,
    taskEmployee: vars.TASK_EMPLOYEE,
    taskMessage: vars.TASK_MESSAGE,
    handoverStaff: vars.HANDOVER_STAFF,
    vars
  };
  const res = await bg('BG_START_RUN', payload);
  if (!res.ok) { addLog('خطأ: ' + res.error, 'err'); alert(res.error); return; }
  reportedRunId = null;
  addLog('🔁 إكمال المتبقي — ' + items.length + ' ملف: ' + items.slice(0, 10).map(it => it.ptid).join('، ') +
    (items.length > 10 ? '…' : ''), 'info');
  const st = await bg('BG_GET_RUN_STATE');
  renderRunState(st.state);
  startRunPoll();
}

function loadFailedIds(kind) {
  if (!currentRun || currentRun.kind !== kind) return;
  const failedResults = currentRun.results.filter(r => r.status === 'fail' || r.status === 'skipped');
  if (kind === 'task' && currentRun.source && currentRun.source.type === 'import' && importState) {
    importState.retryItems = failedResults.map(r => ({ ptid: r.id, vars: r.vars || {}, row: r.row }));
    saveImport();
    renderImport();
    addLog('تم تحميل ' + failedResults.length + ' صف فاشل من الملف — راجعها قبل التشغيل', 'info');
    return;
  }
  const failed = failedResults.map(r => r.id);
  const p = PANELS[kind].prefix;
  $(p + 'PtidInput').value = failed.join('\n');
  parseIds(p);
  chrome.storage.local.set({ [p + 'PtidDraft']: $(p + 'PtidInput').value });
  addLog('تم تحميل ' + failed.length + ' ملف (فاشل/لم يُنفذ) — راجعها قبل التشغيل', 'info');
}

function exportResults(kind) {
  if (!currentRun || currentRun.kind !== kind) return;
  const rows = currentRun.results || [];
  const name = titleDateName(rows.map(r => runRowVars(r).TASK_TITLE), currentRun.loopName);
  const saved = saveRunResultsXlsx(rows, name, 'كل الملفات');
  addLog('⬇ تم حفظ النتائج في ' + saved, 'ok');
}

// ============================================================
// ===== رسائل من background =====
// ============================================================
function handleBackgroundMessage(msg) {
  if (msg.action === 'RUN_PROGRESS' || msg.action === 'RUN_COMPLETE') {
    if (msg.state) renderRunState(msg.state);
  } else if (msg.action === 'LOG_UPDATE') {
    pushLog({ ts: msg.ts || Date.now(), text: '[' + msg.ptid + '] ' + msg.msg, type: /✗|فشل|خطأ/.test(msg.msg) ? 'err' : /✓/.test(msg.msg) ? 'ok' : 'info' });
  } else if (msg.action === 'DEACTIVE_UPDATED') {
    refreshDeactive();
  }
}

// ============================================================
// ===== الملفات غير النشطة =====
// ============================================================
async function refreshDeactive() {
  const { list = [] } = await bg('BG_GET_DEACTIVE');
  $('deactiveBadge').textContent = list.length;
  $('deactivePanel').style.display = list.length ? '' : 'none';
  const statusAr = { complete: 'تم', pending: 'معلّق', fail: 'فشل' };
  $('deactiveListEl').innerHTML = list.map(d => `
    <div class="deactive-row">
      <span class="dr-ptid">${esc(d.ptid)}</span>
      <span class="dr-status ${esc(d.status)}">${esc(statusAr[d.status] || d.status)}</span>
      <span class="dr-date" title="${esc(d.error || '')}">${esc(d.loopName || '')} · ${esc(fmtDate(d.processedAt || d.detectedAt))}</span>
      <span class="dr-del" data-del-ptid="${esc(d.ptid)}" title="إزالة">✕</span>
    </div>`).join('');
}

async function exportDeactive() {
  const { list = [] } = await bg('BG_GET_DEACTIVE');
  if (!list.length) { alert('القائمة فارغة'); return; }
  const headers = ['PTID', 'اللوب', 'حالة المعالجة', 'تاريخ الاكتشاف', 'آخر معالجة', 'تفاصيل'];
  const rows = list.map(d => [d.ptid, d.loopName, d.status, fmtDate(d.detectedAt), fmtDate(d.processedAt), d.error || '']);
  const saved = saveXlsx('الملفات غير النشطة - ' + today(), 'غير نشطة', headers, rows);
  addLog('⬇ تم حفظ ' + saved, 'ok');
}

// ============================================================
// ===== التقرير =====
// ============================================================
function buildReport(state) {
  const results = state.results || [];
  const lines = [
    'iCare Loop Report',
    '=================',
    'Loop: ' + state.loopName + '  (' + state.stepCount + ' steps)',
    'Started: ' + state.startedAt,
    'Finished: ' + (state.finishedAt || '-'),
    'Total: ' + results.length +
      ' | Success: ' + results.filter(r => r.status === 'done').length +
      ' | Failed: ' + results.filter(r => r.status === 'fail').length,
    ''
  ];
  results.filter(r => r.status !== 'done' || r.warning).forEach(r => {
    lines.push('PTID: ' + r.id + ' [' + String(r.status).toUpperCase() + ']');
    if (r.error) lines.push('Error: ' + r.error);
    if (r.warning) lines.push('Warning: ' + r.warning);
    (r.trace || []).forEach(t => {
      lines.push('  ' + t.number + '. [' + String(t.status).toUpperCase() + '] ' + t.type + ' — ' + (t.target || '-') +
        (t.durationMs ? ' (' + t.durationMs + 'ms)' : ''));
      if (t.selector) lines.push('     Selector: ' + t.selector);
      if (t.error) lines.push('     Error: ' + t.error);
    });
    if (r.diagnostic && r.diagnostic.page) {
      lines.push('  Page: ' + r.diagnostic.page.url);
      const d = r.diagnostic;
      if (d.formScope && d.formScope !== 'none') lines.push('  Form (' + d.formScope + ') labels: ' + (d.formLabels || []).join(' | '));
      (d.formFields || []).forEach(f => lines.push('    #' + f.index + ' ' + f.tag + ' [' + (f.label || '-') + '] "' + f.text + '"'));
      const controls = (r.diagnostic.visibleControls || []).slice(0, 25)
        .map(c => c.tag + (c.role ? '[' + c.role + ']' : '') + ' "' + (c.text || c.placeholder || c.ariaLabel) + '"');
      if (controls.length) lines.push('  Visible: ' + controls.join(' | '));
    }
    lines.push('');
  });
  return lines.join('\n');
}

function showReport(state) {
  $('devReportTitle').textContent = 'تقرير: ' + state.loopName;
  $('devReportText').value = buildReport(state);
  if (!$('devReportDialog').open) $('devReportDialog').showModal();
}

function closeReport() {
  if ($('devReportDialog').open) $('devReportDialog').close();
}

// ============================================================
// ===== السجل =====
// ============================================================
async function restoreLog() {
  try {
    const { runLog = [] } = await chrome.storage.session.get('runLog');
    logLines = runLog.map(l => ({ ts: l.ts, text: '[' + l.ptid + '] ' + l.msg, type: /✗|فشل/.test(l.msg) ? 'err' : 'info' }));
  } catch { logLines = []; }
  renderLog();
}

function addLog(text, type) {
  pushLog({ ts: Date.now(), text, type: type || '' });
}

function pushLog(line) {
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  renderLog();
}

function renderLog() {
  const el = $('logArea');
  el.innerHTML = logLines.map(l =>
    '<span class="log-' + esc(l.type) + '">[' + fmtTime(l.ts) + '] ' + esc(l.text) + '</span>\n').join('');
  el.scrollTop = el.scrollHeight;
}

function logText() {
  return logLines.map(l => '[' + fmtTime(l.ts) + '] ' + l.text).join('\n');
}

// ============================================================
// ===== مساعدات =====
// ============================================================
async function bg(action, extra) {
  try {
    return (await chrome.runtime.sendMessage({ action, ...(extra || {}) })) || { ok: false, error: 'لا يوجد رد' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toCsv(rows) {
  return rows.map(row => row.map(cell => {
    const s = String(cell ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileName(name) {
  return String(name || 'loop').replace(/[\\/:*?"<>|]+/g, '_');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? decodeURIComponent(u.search) : '');
  } catch {
    return url || '';
  }
}

// ============================================================
// ===== تقرير مُرسل من التحليل الأسبوعي (FutureCare Weekly) =====
// ============================================================
// الصفحة ترسل تقريرها الحالي فيُفتح هنا للاستيراد والمراجعة فقط — لا يبدأ أي تشغيل تلقائياً.
async function takeAppImport() {
  const { pendingAppImport: p } = await chrome.storage.local.get('pendingAppImport');
  if (!p) return;
  await chrome.storage.local.remove('pendingAppImport');
  if (!p.b64 || Date.now() - (p.at || 0) > 10 * 60 * 1000) return;
  const bin = atob(p.b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  switchToTab('quicktask');
  await loadImportFile(new File([bytes], p.name || 'report.xls', { lastModified: p.at }));
  addLog('📥 استُلم تقرير من التحليل الأسبوعي: ' + (p.name || '') + ' — راجع القاعدة والحالات ثم ابدأ التشغيل يدوياً', 'info');
}
