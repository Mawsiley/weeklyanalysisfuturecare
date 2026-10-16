/**
 * 🤖 مساعد الذكاء الاصطناعي (DeepSeek) — يعمل داخل الـ popup.
 *
 * الخصوصية:
 *  - لا يُرسل شيء قبل موافقة صريحة ومفتاح API من المستخدم.
 *  - لا تُرسل أسماء المرضى ولا أرقام الهوية أبداً — فقط ملخصات (أعداد، أسباب الفشل، إعدادات التاسك، أسماء الأطباء).
 *  - أرقام الملفات تُقنَّع افتراضياً (P1، P2…) وتُعاد لأرقامها الحقيقية على الشاشة فقط.
 *
 * التحكم:
 *  - المساعد لا ينفذ شيئاً بنفسه. كل إجراء يقترحه يظهر زراً يضغطه المستخدم،
 *    والتشغيل يمر بكل نوافذ التأكيد والإذن المعتادة.
 */
(function () {
  const AI_DEFAULTS = { model: 'deepseek-chat', maskIds: true, consent: false };
  const MAX_HISTORY = 16;           // آخر الرسائل المرسلة للنموذج
  const SENSITIVE_HEADER = /name|اسم|national|هوية|iqama|إقامة|phone|جوال|mobile|birth|ميلاد|address|عنوان السكن|card|بطاقة/i;

  let aiSettings = { ...AI_DEFAULTS };
  let chat = [];                    // { role: 'user'|'assistant', content, actions?: [] }
  let busy = false;
  let idMask = null;                // { toToken: Map, toId: Map }

  const $ = id => document.getElementById(id);

  // ============================================================
  // ===== تقنيع أرقام الملفات =====
  // ============================================================
  function buildMask() {
    const ids = new Set();
    ((currentRun && currentRun.results) || []).forEach(r => ids.add(String(r.id)));
    (typeof importItems === 'function' && importState ? (importItems() || []) : []).forEach(it => ids.add(String(it.ptid)));
    const toToken = new Map();
    const toId = new Map();
    [...ids].forEach((id, i) => { toToken.set(id, 'P' + (i + 1)); toId.set('P' + (i + 1), id); });
    idMask = { toToken, toId };
  }

  function maskText(text) {
    let s = String(text ?? '');
    if (!aiSettings.maskIds || !idMask) return s;
    // الأطول أولاً حتى لا يُستبدل 4091 داخل 40915
    [...idMask.toToken.keys()].sort((a, b) => b.length - a.length).forEach(id => {
      s = s.replace(new RegExp('(^|[^\\d])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)', 'g'), '$1' + idMask.toToken.get(id));
    });
    return s;
  }

  function unmaskText(text) {
    let s = String(text ?? '');
    if (!aiSettings.maskIds || !idMask) return s;
    return s.replace(/\bP(\d+)\b/g, (m) => idMask.toId.get(m) || m);
  }

  function maskId(id) {
    return aiSettings.maskIds && idMask ? (idMask.toToken.get(String(id)) || String(id)) : String(id);
  }

  // ============================================================
  // ===== السياق المرسل (ملخص فقط — بلا أسماء مرضى أو هويات) =====
  // ============================================================
  function buildContext() {
    buildMask();
    const ctx = {
      today: today(),
      task_fields: {
        employee: $('qtEmployee').value.trim(),
        title: $('qtTitle').value.trim(),
        message: $('qtMessage').value.trim(),
        type: $('qtType').value.trim(),
        priority: $('qtPriority').value.trim(),
        category: $('qtCategory').value.trim(),
        subcategory: $('qtSubcategory').value.trim()
      },
      options_in_icare: {
        type: ['Medical', 'Administrative', 'REJECTED', 'Maintenance'],
        priority: ['Normal', 'Important'],
        category: ['Request', 'AMA', 'Pharamcy', 'Appointments'],
        subcategory: ['DR', 'PT', 'Nurse', 'Lab', 'Specialist', 'Other'],
        title_max_chars: 35
      },
      settings: {
        human_mode: $('qtHuman').checked,
        background_tab: $('qtBackground').checked,
        delay_seconds: Number($('qtDelay').value) || 3,
        on_fail: $('qtOnFail').value
      },
      import: null,
      last_run: null
    };

    if (importState) {
      const res = importResult();
      const map = importState.mapping || {};
      const header = i => (i >= 0 ? importState.headers[i] : null);
      const filter = importState.filter || { col: -1, exclude: [] };
      let filterInfo = null;
      if (filter.col >= 0 && !SENSITIVE_HEADER.test(header(filter.col) || '')) {
        const values = TaskImport.distinctValues({ rows: importState.rows }, filter.col);
        if (values.length <= 20) {
          filterInfo = {
            column: header(filter.col),
            values: values.map(v => ({ value: v.value, count: v.count, excluded: (filter.exclude || []).includes(v.value) }))
          };
        }
      }
      const items = res.items || [];
      const countBy = key => {
        const c = {};
        items.forEach(it => { const v = it.vars[key] || '(من التبويب)'; c[v] = (c[v] || 0) + 1; });
        return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value: maskText(value), count }));
      };
      ctx.import = {
        file_name: importState.fileName,
        imported_at: importState.importedAt,
        rows_in_file: importState.rows.length,
        tasks_after_filters: items.length,
        hidden_rows_skipped: res.hiddenSkipped || 0,
        filtered_out: res.filtered || 0,
        mapping: { ptid: header(map.ptid), employee: header(map.employee), title: header(map.title), message: header(map.message) },
        // أسماء الأعمدة فقط — القيم الحساسة (الأسماء/الهويات) لا تُرسل
        columns: importState.headers.map(h => SENSITIVE_HEADER.test(h) ? h + ' (لا يُرسل)' : h),
        filter: filterInfo,
        default_employee_if_no_doctor: importState.defaultEmployee ?? '',
        employees: countBy('TASK_EMPLOYEE'),
        titles: countBy('TASK_TITLE'),
        messages: countBy('TASK_MESSAGE')
      };
    }

    if (currentRun) {
      const results = currentRun.results || [];
      const count = st => results.filter(r => r.status === st).length;
      const groups = {};
      results.filter(r => r.status === 'fail' || r.warning).forEach(r => {
        const failedStep = (r.trace || []).find(t => t.status === 'fail');
        const key = (r.error || r.warning || '') + ' | ' + (failedStep ? failedStep.number + '. ' + failedStep.type + ' ' + (failedStep.target || '') : '');
        (groups[key] = groups[key] || []).push(r.id);
      });
      ctx.last_run = {
        loop: currentRun.loopName,
        running: currentRun.running,
        source_file: currentRun.source && currentRun.source.fileName || null,
        total: results.length,
        done_confirmed: results.filter(r => r.status === 'done' && !r.warning).length,
        done_unconfirmed: results.filter(r => r.status === 'done' && r.warning).length,
        failed: count('fail'),
        not_run: count('skipped') + count('pending'),
        problems: Object.entries(groups).slice(0, 12).map(([key, ids]) => ({
          reason: maskText(key), count: ids.length, examples: ids.slice(0, 5).map(maskId)
        }))
      };
    }
    return ctx;
  }

  // ============================================================
  // ===== الأدوات (إجراءات مقترحة — لا تُنفذ إلا بضغط المستخدم) =====
  // ============================================================
  const TOOLS = [
    { name: 'set_task_fields', label: 'تعديل حقول التاسك',
      description: 'اقتراح تعديل حقول التاسك في تبويب تاسك (تُطبق عند ضغط المستخدم). اترك الحقل غير المطلوب بدون قيمة.',
      parameters: { type: 'object', properties: {
        employee: { type: 'string', description: 'رقم أو اسم الموظف كما يُبحث في iCare' },
        title: { type: 'string', description: 'عنوان التاسك، 35 حرفاً كحد أقصى' },
        message: { type: 'string', description: 'رسالة/وصف التاسك' },
        type: { type: 'string' }, priority: { type: 'string' }, category: { type: 'string' }, subcategory: { type: 'string' }
      } } },
    { name: 'set_import_filter', label: 'تغيير تصفية الملف المستورد',
      description: 'اقتراح الإبقاء فقط على صفوف ذات قيم معينة في عمود التصفية الحالي (مثل Status = Would schedule).',
      parameters: { type: 'object', properties: {
        keep_values: { type: 'array', items: { type: 'string' }, description: 'القيم التي تبقى؛ باقي القيم تُستبعد' }
      }, required: ['keep_values'] } },
    { name: 'start_test_run', label: '🧪 تجربة على أول ملف',
      description: 'اقتراح تجربة التاسك على أول ملف فقط.', parameters: { type: 'object', properties: {} } },
    { name: 'start_full_run', label: '⚡ تشغيل على كل الملفات',
      description: 'اقتراح التشغيل على كل الملفات (يمر بنوافذ التأكيد والإذن المعتادة).', parameters: { type: 'object', properties: {} } },
    { name: 'stop_run', label: '⏹ إيقاف التشغيل',
      description: 'اقتراح إيقاف التشغيل الجاري.', parameters: { type: 'object', properties: {} } },
    { name: 'rerun_incomplete', label: '🔁 أكمل غير المكتملة',
      description: 'اقتراح إعادة الملفات غير المكتملة من آخر تشغيل بنفس قيمها.', parameters: { type: 'object', properties: {} } },
    { name: 'export_excel', label: '📗 حفظ Excel',
      description: 'اقتراح حفظ نتائج آخر تشغيل في Excel.',
      parameters: { type: 'object', properties: {
        which: { type: 'string', enum: ['unverified', 'failed', 'all'], description: 'غير المؤكدة / الفاشلة / الكل' }
      }, required: ['which'] } }
  ];

  const SYSTEM_PROMPT = [
    'أنت مساعد داخل إضافة Chrome اسمها "iCare Loop Recorder" تفتح تاسكات (Quick Task) لملفات مرضى في نظام iCare بشكل آلي.',
    'خطوات التاسك لكل ملف: فتح ملف المريض ← Quick Task ← تعيين إلى (بحث عن الموظف) ← النوع ← الأولوية ← الفئة ← الفئة الفرعية ← العنوان ← الوصف ← إنشاء المهمة ← تحقق.',
    'يمكن استيراد ملف Excel: كل صف = تاسك (PTID = رقم الملف، Case/Report Doctor = الموظف، Status = العنوان، Reason = الرسالة)، مع تصفية حسب عمود، واستبعاد الصفوف المخفية في Excel.',
    'مطابقة الموظف صارمة: الاسم الذي يطابق أكثر من موظف يُفشل الملف (الحل: استخدام رقم الموظف). الصفوف بلا طبيب تذهب للموظف البديل (افتراضياً 632).',
    'ستصلك حالة الإضافة الحالية كـ JSON في رسالة نظام. أرقام الملفات فيها مقنَّعة بصيغة P1، P2… — استخدمها كما هي ولا تطلب الأرقام الحقيقية.',
    'لا تطلب أبداً أسماء المرضى أو هوياتهم أو أي بيانات صحية تعريفية.',
    'أنت لا تنفذ شيئاً بنفسك. لاقتراح إجراء استخدم الأدوات المتاحة؛ سيظهر للمستخدم زر يضغطه إن وافق. لا تقل إن الإجراء تم.',
    'اقترح التجربة على أول ملف (start_test_run) قبل التشغيل الكامل عندما يكون الإعداد جديداً.',
    'أجب بالعربية، باختصار ووضوح، وبخطوات عملية. إذا كانت المعلومة غير موجودة في الحالة فقل ذلك.'
  ].join('\n');

  // ============================================================
  // ===== المحادثة =====
  // ============================================================
  async function sendToAi(userText) {
    if (busy) return;
    if (!aiSettings.consent) { openAiSettings(true); return; }
    if (!aiSettings.apiKeySet) { openAiSettings(true); alert('أدخل مفتاح DeepSeek API في الإعدادات أولاً'); return; }
    const text = String(userText || '').trim();
    if (!text) return;

    busy = true;
    renderAiBusy(true);
    chat.push({ role: 'user', content: text });
    renderChat();

    try {
      const context = buildContext();
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: 'حالة الإضافة الآن:\n' + JSON.stringify(context) },
        ...chat.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.role === 'user' ? maskText(m.content) : maskText(m.content) }))
      ];
      const tools = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

      let reply = await requestAi(messages, tools);
      const actions = [];
      // جولة ثانية إن طلب النموذج أدوات: نعيد له أن الإجراء "عُرض كزر" ليكتب الشرح النهائي
      if (reply.tool_calls && reply.tool_calls.length) {
        reply.tool_calls.forEach(call => {
          const tool = TOOLS.find(t => t.name === call.function.name);
          if (!tool) return;
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
          actions.push({ name: tool.name, label: tool.label, args: unmaskArgs(args), done: false });
        });
        if (!reply.content) {
          const followUp = await requestAi(messages.concat([
            { role: 'assistant', content: reply.content || '', tool_calls: reply.tool_calls },
            ...reply.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id,
              content: 'عُرض على المستخدم كزر — لم يُنفذ بعد. اشرح باختصار ماذا سيفعل ولماذا.' }))
          ]), null);
          reply = { content: followUp.content };
        }
      }
      chat.push({ role: 'assistant', content: unmaskText(reply.content || ''), actions });
      saveChat();
    } catch (e) {
      chat.push({ role: 'assistant', content: '⚠ ' + e.message, error: true });
    } finally {
      busy = false;
      renderAiBusy(false);
      renderChat();
    }
  }

  function unmaskArgs(args) {
    const out = {};
    Object.entries(args || {}).forEach(([k, v]) => {
      out[k] = Array.isArray(v) ? v.map(x => unmaskText(x)) : (typeof v === 'string' ? unmaskText(v) : v);
    });
    return out;
  }

  async function requestAi(messages, tools) {
    const res = await chrome.runtime.sendMessage({ action: 'BG_AI_REQUEST', model: aiSettings.model, messages, tools });
    if (!res || !res.ok) throw new Error((res && res.error) || 'لا يوجد رد من المساعد');
    return res.message || {};
  }

  // ============================================================
  // ===== تنفيذ الإجراءات (بضغط المستخدم فقط) =====
  // ============================================================
  async function runAction(action) {
    const a = action.args || {};
    switch (action.name) {
      case 'set_task_fields': {
        if (a.employee) { $('qtEmployee').value = a.employee; chrome.storage.local.set({ qtSavedEmployee: a.employee }); }
        if (a.message) { $('qtMessage').value = a.message; chrome.storage.local.set({ qtSavedMessage: a.message }); }
        const vars = getTaskVars();
        if (a.title) vars.TASK_TITLE = String(a.title).slice(0, 35);
        ['type', 'priority', 'category', 'subcategory'].forEach(k => {
          if (typeof a[k] === 'string') vars['TASK_' + k.toUpperCase()] = a[k];
        });
        setTaskVars(vars);
        saveTaskVars();
        if (importState) renderImport();
        switchToTab('quicktask');
        return 'تم تعديل حقول التاسك';
      }
      case 'set_import_filter': {
        if (!importState || !importState.filter || importState.filter.col < 0) throw new Error('لا يوجد ملف مستورد بعمود تصفية');
        const keep = new Set((a.keep_values || []).map(String));
        const values = TaskImport.distinctValues({ rows: importState.rows }, importState.filter.col).map(v => v.value);
        if (!values.some(v => keep.has(v))) throw new Error('القيم المقترحة غير موجودة في العمود');
        importState.filter.exclude = values.filter(v => !keep.has(v));
        delete importState.retryItems;
        saveImport();
        renderImport();
        switchToTab('quicktask');
        return 'التصفية: ' + [...keep].join('، ') + ' — ' + importItems().length + ' تاسك';
      }
      case 'start_test_run': switchToTab('quicktask'); await startRun('task', true); return 'بدأت التجربة (إن وافقت على التأكيدات)';
      case 'start_full_run': switchToTab('quicktask'); await startRun('task', false); return 'بدأ التشغيل (إن وافقت على التأكيدات)';
      case 'stop_run': await stopRun(); return 'طُلب الإيقاف';
      case 'rerun_incomplete':
        await refreshResumeQueue();
        if (!resumeQueue) throw new Error('لا توجد ملفات متبقية للإكمال');
        await rerunIncomplete(resumeQueue.kind || 'task'); return 'طُلب إكمال المتبقي';
      case 'export_excel': {
        if (!currentRun) throw new Error('لا يوجد تشغيل سابق');
        const kind = currentRun.kind || 'task';
        const p = PANELS[kind].prefix;
        $(p + 'XlsWhich').value = ['unverified', 'failed', 'all'].includes(a.which) ? a.which : 'all';
        $(p + 'XlsWhich').dataset.userSet = '1';
        updateXlsRow(kind);
        exportExcel(kind);
        return 'تم الحفظ';
      }
      default: throw new Error('إجراء غير معروف');
    }
  }

  // ============================================================
  // ===== الواجهة =====
  // ============================================================
  function describeArgs(action) {
    const a = action.args || {};
    const labels = { employee: 'الموظف', title: 'العنوان', message: 'الرسالة', type: 'النوع', priority: 'الأولوية',
      category: 'الفئة', subcategory: 'الفرعية', keep_values: 'إبقاء', which: 'النوع' };
    return Object.entries(a).filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => (labels[k] || k) + ': ' + (Array.isArray(v) ? v.join('، ') : v)).join(' · ');
  }

  function renderChat() {
    const el = $('aiChat');
    if (!chat.length) {
      el.innerHTML = '<div class="ai-empty">اسأل عن التاسكات، أسباب الفشل، أو اطلب اقتراح رسالة أو إعدادات.<br>' +
        'المساعد يقترح، وأنت تضغط للتنفيذ.</div>';
      return;
    }
    el.innerHTML = chat.map((m, i) => {
      const actions = (m.actions || []).map((a, j) =>
        '<div class="ai-action' + (a.done ? ' done' : '') + '">' +
          '<div class="ai-action-text"><b>' + esc(a.label) + '</b>' + (describeArgs(a) ? '<span>' + esc(describeArgs(a)) + '</span>' : '') +
          (a.result ? '<span class="ai-action-result">' + esc(a.result) + '</span>' : '') + '</div>' +
          (a.done ? '<span class="ai-done">✓</span>' : '<button class="btn-sm ai-run" data-msg="' + i + '" data-act="' + j + '">تنفيذ</button>') +
        '</div>').join('');
      return '<div class="ai-msg ' + m.role + (m.error ? ' error' : '') + '">' +
        '<div class="ai-bubble">' + esc(m.content || (m.actions && m.actions.length ? 'اقتراح:' : '')).replace(/\n/g, '<br>') + '</div>' +
        actions + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  function renderAiBusy(on) {
    $('aiSendBtn').disabled = on;
    $('aiSendBtn').textContent = on ? '…' : 'إرسال';
    $('aiThinking').style.display = on ? '' : 'none';
  }

  function renderAiSettings() {
    $('aiModel').value = aiSettings.model || AI_DEFAULTS.model;
    $('aiMask').checked = aiSettings.maskIds !== false;
    $('aiConsent').checked = Boolean(aiSettings.consent);
    $('aiKeyState').textContent = aiSettings.apiKeySet ? '✓ محفوظ' : 'غير محفوظ';
    $('aiKeyState').className = 'ai-key-state ' + (aiSettings.apiKeySet ? 'ok' : 'missing');
    const ready = aiSettings.consent && aiSettings.apiKeySet;
    $('aiStatus').textContent = ready ? 'جاهز — ' + (aiSettings.model || AI_DEFAULTS.model) : 'غير مفعّل — افتح الإعدادات';
    $('aiStatus').className = 'ai-status ' + (ready ? 'ok' : 'off');
  }

  function openAiSettings(open) {
    $('aiSettings').style.display = open ? '' : 'none';
    switchToTab('ai');
  }

  async function loadAi() {
    const s = await chrome.storage.local.get(['aiSettings', 'aiChat', 'aiApiKey']);
    aiSettings = { ...AI_DEFAULTS, ...(s.aiSettings || {}), apiKeySet: Boolean(s.aiApiKey) };
    chat = Array.isArray(s.aiChat) ? s.aiChat.slice(-40) : [];
    renderAiSettings();
    renderChat();
  }

  function saveSettings() {
    const { apiKeySet, ...persist } = aiSettings;
    chrome.storage.local.set({ aiSettings: persist });
    renderAiSettings();
  }

  function saveChat() {
    chrome.storage.local.set({ aiChat: chat.slice(-40) });
  }

  function setupAi() {
    $('aiSettingsToggle').addEventListener('click', () => {
      $('aiSettings').style.display = $('aiSettings').style.display === 'none' ? '' : 'none';
    });
    $('aiSaveKeyBtn').addEventListener('click', async () => {
      const key = $('aiApiKey').value.trim();
      if (!key) { alert('أدخل المفتاح'); return; }
      await chrome.storage.local.set({ aiApiKey: key });
      $('aiApiKey').value = '';
      aiSettings.apiKeySet = true;
      renderAiSettings();
      addLog('🤖 تم حفظ مفتاح DeepSeek (محلياً في المتصفح فقط)', 'ok');
    });
    $('aiClearKeyBtn').addEventListener('click', async () => {
      await chrome.storage.local.remove('aiApiKey');
      aiSettings.apiKeySet = false;
      renderAiSettings();
    });
    $('aiModel').addEventListener('change', () => { aiSettings.model = $('aiModel').value.trim() || AI_DEFAULTS.model; saveSettings(); });
    $('aiMask').addEventListener('change', () => {
      if (!$('aiMask').checked && !confirm('إلغاء التقنيع يرسل أرقام الملفات الحقيقية إلى DeepSeek. متابعة؟')) {
        $('aiMask').checked = true;
        return;
      }
      aiSettings.maskIds = $('aiMask').checked;
      saveSettings();
    });
    $('aiConsent').addEventListener('change', () => { aiSettings.consent = $('aiConsent').checked; saveSettings(); });

    $('aiSendBtn').addEventListener('click', () => { const t = $('aiInput').value; $('aiInput').value = ''; sendToAi(t); });
    $('aiInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('aiSendBtn').click(); }
    });
    $('aiQuick').addEventListener('click', e => {
      const chip = e.target.closest('[data-q]');
      if (chip) sendToAi(chip.dataset.q);
    });
    $('aiClearBtn').addEventListener('click', () => {
      if (!chat.length || !confirm('مسح المحادثة؟')) return;
      chat = [];
      saveChat();
      renderChat();
    });
    $('aiChat').addEventListener('click', async e => {
      const btn = e.target.closest('.ai-run');
      if (!btn) return;
      const action = chat[Number(btn.dataset.msg)].actions[Number(btn.dataset.act)];
      btn.disabled = true;
      try {
        action.result = await runAction(action);
        action.done = true;
        addLog('🤖 ' + action.label + ' — ' + action.result, 'ok');
      } catch (err) {
        action.result = '⚠ ' + err.message;
        btn.disabled = false;
      }
      saveChat();
      renderChat();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupAi();
    loadAi();
  });

  // للاختبار
  window.__ai = { buildContext, maskText, unmaskText, TOOLS, runAction, sendToAi, getChat: () => chat };
})();
