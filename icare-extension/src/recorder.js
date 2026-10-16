/**
 * iCare Loop Recorder — Content Script  v1.3
 * يعمل داخل صفحات icare.com.sa
 *  - التسجيل: يرسل كل خطوة للـ background الذي يحتفظ بالقائمة المركزية
 *  - التنفيذ: ينفذ خطوة واحدة عند طلب الـ background (الإطار الرئيسي فقط)
 */

(function () {
  const VERSION = '1.5.0';
  const IS_TOP = window.top === window;

  // ── منع الحقن المزدوج: نسخة حيّة واحدة فقط لكل إطار ──
  // بعد إعادة تحميل الإضافة تبقى النسخة القديمة "يتيمة" (chrome.runtime غير صالح)،
  // فنزيلها ونركّب نسخة جديدة بدلاً من تجاهل الحقن.
  const previous = window.__icareLoopRecorder;
  if (previous) {
    let alive = false;
    try { alive = previous.alive(); } catch { alive = false; }
    if (alive) return;
    try { previous.dispose(); } catch { /* نسخة قديمة */ }
  }

  let isRecording = false;
  let navigationTimer = null;
  let lastRecordedUrl = '';

  const instance = {
    version: VERSION,
    alive: () => { try { return Boolean(chrome.runtime && chrome.runtime.id); } catch { return false; } },
    dispose: () => {
      stopRecording();
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* runtime منتهي */ }
    }
  };
  window.__icareLoopRecorder = instance;

  function send(msg) {
    try { return chrome.runtime.sendMessage(msg).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  // ============================================================
  // ===== التسجيل =====
  // ============================================================

  const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [role="tab"], ' +
    '[role="checkbox"], [role="radio"], [role="option"], [role="menuitem"], [role="combobox"], [role="switch"], ' +
    '[contenteditable="true"]';

  const OPTION_SELECTORS = [
    '[role="option"]', '[role="menuitem"]', '[cmdk-item]', 'mat-option', '.p-dropdown-item',
    '.mat-option', '.dropdown-item', '.select-option', 'li[data-value]', '.ng-option'
  ].join(',');

  function recordStep(step, mode) {
    if (!isRecording) return;
    send({ action: 'REC_STEP', mode: mode || 'add', step: { ...step, timestamp: Date.now() } });
  }

  function onMouseClick(e) {
    if (!isRecording || !e.isTrusted) return;
    const rawEl = e.target && e.target.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
    if (!rawEl || !rawEl.closest) return;
    const el = rawEl.closest(INTERACTIVE) || rawEl;
    if (el.closest('[data-icare-recorder-ignore]')) return;

    // النقر على حقل كتابة لا يحتاج خطوة؛ الكتابة نفسها تُسجَّل كخطوة input.
    if (el.matches('input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea')) return;

    const optionEl = el.closest(OPTION_SELECTORS);
    if (optionEl) {
      const text = cleanText(optionEl.innerText).slice(0, 80);
      recordStep({
        type: 'customSelect',
        selector: getSelector(optionEl),
        text,
        value: optionEl.dataset.value || optionEl.getAttribute('value') || text
      });
      flashElement(optionEl);
      return;
    }

    recordStep({
      type: 'click',
      selector: getSelector(el),
      text: cleanText(el.innerText || el.value || '').slice(0, 60),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      label: fieldLabel(el)
    });
    flashElement(el);
  }

  function onInput(e) {
    if (!isRecording || !e.isTrusted) return;
    const el = e.target;
    if (!el || !el.tagName) return;

    // لا تحفظ كلمات المرور أو مسارات الملفات داخل اللوب.
    if (el.tagName === 'INPUT' && ['password', 'file'].includes(el.type)) return;

    if (el.isContentEditable) {
      recordStep({
        type: 'contentInput',
        selector: getSelector(el),
        value: el.innerText.trim(),
        label: fieldLabel(el)
      }, 'upsert');
      return;
    }

    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    const isCheckable = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type);
    recordStep({
      type: isCheckable ? 'checkbox' : (el.tagName === 'SELECT' ? 'select' : 'input'),
      selector: getSelector(el),
      value: isCheckable ? el.checked : el.value,
      placeholder: el.placeholder || el.name || '',
      label: fieldLabel(el)
    }, isCheckable ? 'add' : 'upsert');
  }

  function onKeyDown(e) {
    if (!isRecording || !e.isTrusted || !['Enter', 'Escape'].includes(e.key)) return;
    const el = e.target;
    if (!el || !el.matches || !el.matches('input, [role="combobox"], [contenteditable="true"]')) return;
    recordStep({ type: 'key', selector: getSelector(el), key: e.key, code: e.code || e.key });
  }

  function recordNavigation() {
    if (!isRecording || !IS_TOP) return;
    const url = normalizeUrl(window.location.href);
    if (url === lastRecordedUrl) return;
    lastRecordedUrl = url;
    // الـ background يتجاهل التكرار إذا كانت آخر خطوة نفس الرابط.
    recordStep({ type: 'navigate', url, title: document.title });
  }

  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    document.addEventListener('click', onMouseClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    if (IS_TOP) {
      lastRecordedUrl = '';
      recordNavigation();
      navigationTimer = setInterval(recordNavigation, 400);
    }
  }

  function stopRecording() {
    isRecording = false;
    document.removeEventListener('click', onMouseClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onInput, true);
    document.removeEventListener('keydown', onKeyDown, true);
    clearInterval(navigationTimer);
    navigationTimer = null;
  }

  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);
      ['ptid', 'PTID', 'patientId', 'patientid'].forEach(key => {
        if (url.searchParams.has(key)) url.searchParams.set(key, '{PTID}');
      });
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  // ============================================================
  // ===== المحددات (Selectors) =====
  // ============================================================

  // IDs التي تولدها مكتبات الواجهة (Radix/Headless UI/React) تتغير بين التحميلات.
  function isStableId(id) {
    return id && !/[:«»]|^radix-|^_r_|^headlessui-|^mui-|^react-|^rc-|\d{4,}/.test(id);
  }

  function attrSelector(tag, attr, value) {
    return tag + '[' + attr + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
  }

  function getSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (isStableId(el.id)) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) return attrSelector('', attr, v);
    }
    if (el.getAttribute('name')) return attrSelector(tag, 'name', el.getAttribute('name'));
    if (el.getAttribute('aria-label')) return attrSelector(tag, 'aria-label', el.getAttribute('aria-label'));
    if (['input', 'textarea'].includes(tag) && el.getAttribute('placeholder')) {
      return attrSelector(tag, 'placeholder', el.getAttribute('placeholder'));
    }
    if (tag === 'button' && el.getAttribute('type') === 'submit') return 'button[type="submit"]';

    // مسار CSS مختصر كحل أخير
    const path = [];
    let node = el;
    while (node && node !== el.ownerDocument.body && path.length < 4) {
      let sel = node.tagName.toLowerCase();
      const classes = [...node.classList]
        .filter(c => !/[:[\]/]/.test(c)) // تجاهل كلاسات Tailwind المعقدة
        .slice(0, 2).map(c => CSS.escape(c)).join('.');
      if (classes) sel += '.' + classes;
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
        : [];
      if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      path.unshift(sel);
      node = node.parentElement;
    }
    return path.join(' > ');
  }

  // نص العنوان (label) الأقرب للحقل — أثبت بكثير من مسار CSS.
  function fieldLabel(el) {
    try {
      if (el.id) {
        const lbl = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl) return cleanText(lbl.innerText).slice(0, 60);
      }
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const lbl = el.ownerDocument.getElementById(labelledBy.split(/\s+/)[0]);
        if (lbl) return cleanText(lbl.innerText).slice(0, 60);
      }
      let node = el.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        const lbl = [...node.querySelectorAll('label')].find(l => !l.contains(el) && cleanText(l.innerText));
        if (lbl) return cleanText(lbl.innerText).slice(0, 60);
      }
    } catch { /* تجاهل */ }
    return '';
  }

  // ============================================================
  // ===== التنفيذ =====
  // ============================================================

  // ── الوضع البشري: كتابة حرفاً بحرف، نقرات بتوقيت طبيعي، وتوقفات متفاوتة ──
  // speed: 1.5 بطيء، 1 عادي، 0.6 سريع
  let human = { enabled: false, speed: 1 };

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  async function humanPause(min, max) {
    if (human.enabled) await sleep(rand(min, max) * human.speed);
  }

  async function executeStep(step) {
    // لحظة "نظر" قبل كل إجراء، كما يفعل المستخدم
    if (step.type !== 'verify' && step.type !== 'escape') await humanPause(150, 450);
    switch (step.type) {
      case 'navigate':
        // التنقل ينفذه الـ background (يحتاج انتظار تحميل الصفحة).
        return { note: 'navigate handled by background' };

      case 'click': {
        const el = await findTarget(step, step.timeout || 8000);
        await waitEnabled(el, 4000);
        await realClick(el);
        return { target: describe(el) };
      }

      case 'input': {
        const el = await findTarget(step, step.timeout || 8000, 'input, textarea');
        // حقل سطر واحد لا يقبل الأسطر الجديدة ← تُستبدل بفاصل حتى لا تلتصق الجمل
        let value = String(step.value ?? '');
        if (el.tagName !== 'TEXTAREA') value = value.replace(/\s*\n\s*/g, ' - ');
        if (human.enabled) await humanType(el, value);
        else setNativeValue(el, value);
        return { target: describe(el) };
      }

      case 'select': {
        const el = await findTarget(step, step.timeout || 8000, 'select');
        const option = [...el.options].find(o => o.value === step.value || cleanText(o.text) === step.value);
        el.value = option ? option.value : step.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { target: describe(el) };
      }

      case 'checkbox': {
        const el = await findTarget(step, step.timeout || 8000);
        const checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
        if (Boolean(checked) !== Boolean(step.value)) await realClick(el);
        return { target: describe(el) };
      }

      case 'customSelect': {
        const wanted = step.text || step.value;
        const options = stepTexts(step).length ? stepTexts(step) : [normText(step.value)].filter(Boolean);
        let el = options.length
          ? await waitFor(() => options.map(findOptionByText).find(Boolean), step.timeout || 6000) : null;
        if (!el && step.selector) el = await waitFor(() => firstVisible(step.selector), 1500);
        if (!el) throw new Error('الخيار غير موجود في القائمة: ' + (wanted || step.selector));
        await realClick(el);
        return { target: describe(el) };
      }

      case 'selectFirstOption': {
        const el = await pickSearchResult(step);
        const picked = cleanText(el.innerText).slice(0, 120); // لتعلّم الرقم الوظيفي (مثل "1253 - Awad")
        await realClick(el);
        return { target: describe(el), picked };
      }

      case 'contentInput': {
        const el = await findTarget(step, step.timeout || 8000);
        el.focus();
        const doc = el.ownerDocument;
        doc.execCommand('selectAll', false, null);
        if (!doc.execCommand('insertText', false, step.value)) {
          el.innerText = step.value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: step.value }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { target: describe(el) };
      }

      case 'key': {
        const el = await findTarget(step, step.timeout || 8000);
        el.focus();
        await sleep(400);
        const init = { key: step.key, code: step.code || step.key, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keypress', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        return { target: describe(el) };
      }

      case 'clickText': {
        const wanted = step.text || '';
        if (!wanted) throw new Error('clickText: لم يُحدد نص');
        const el = await waitFor(() => stepTexts(step).map(t => findClickableByText(t, true)).find(Boolean),
          step.timeout || 10000);
        if (!el) throw new Error('لم يتم العثور على زر "' + wanted + '"');
        await waitEnabled(el, 4000);
        await realClick(el);
        return { target: describe(el) };
      }

      case 'wait': {
        const el = await waitFor(() => step.selector ? firstVisible(step.selector) : findClickableByText(step.text, false),
          step.timeout || 10000);
        if (!el) throw new Error('انتهى الانتظار: ' + (step.selector || step.text));
        return {};
      }

      case 'verify':
        return verifySuccess(step);

      case 'escape': {
        // إغلاق قائمة منسدلة مفتوحة
        const target = document.activeElement || document.body;
        const init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
        await sleep(300);
        return {};
      }

      default:
        throw new Error('نوع خطوة غير معروف: ' + step.type);
    }
  }

  // ── البحث عن العنصر: selector ← label ← نص ──
  async function findTarget(step, timeout, restrictTo) {
    const el = await waitFor(() => locate(step, restrictTo), timeout);
    if (!el) {
      throw new Error('العنصر غير موجود: ' + (step.label ? '[' + step.label + '] ' : '') +
        (step.text || step.placeholder || step.selector || ''));
    }
    return el;
  }

  function locate(step, restrictTo) {
    const controls = restrictTo || 'input, textarea, select, button, [role="combobox"], [contenteditable="true"]';
    const texts = stepTexts(step);

    // 1) المحدد المسجّل
    if (step.selector) {
      let matches = queryAllDocuments(step.selector).filter(isVisible)
        .filter(el => !restrictTo || el.matches(restrictTo));
      // أكثر من عنصر ومعنا نص: نأخذ المطابق للنص فقط — لا نختار عنصراً عشوائياً
      if (matches.length > 1 && texts.length) {
        matches = matches.filter(el => texts.includes(normText(el.innerText || el.value)));
      }
      // التحقق أن العنصر في الحقل الصحيح (العنوان) إن كان معروفاً
      if (matches.length && step.label) {
        const inField = matches.filter(el => labelMatches(fieldLabel(el), step.label));
        if (inField.length) return inField[0];
        // العنوان لم يُطابق: جرّب البحث بالعنوان، وإلا اعتمد المحدد (كما في اللوب الأصلي)
        const byLabel = findByLabel(step.label, controls);
        if (byLabel) return byLabel;
        const looseField = matches.find(el => labelMatches(fieldLabel(el), step.label, true));
        return looseField || matches[0];
      } else if (matches.length) {
        return matches[0];
      }
    }
    // 2) عنوان الحقل (label) — يدعم بدائل عربي/إنجليزي: "الفئة|Category"
    if (step.label) {
      const byLabel = findByLabel(step.label, controls);
      if (byLabel) return byLabel;
    }
    // 3) خانة وصف: إن كانت هناك textarea واحدة ظاهرة (في النموذج المفتوح) فهي المقصودة
    if (step.type === 'input' && /textarea/i.test(step.selector || '')) {
      const scope = queryAllDocuments('[role="dialog"], form').filter(isVisible).pop() || document;
      const areas = [...scope.querySelectorAll('textarea')].filter(isVisible);
      if (areas.length === 1) return areas[0];
    }
    // 4) placeholder
    if (step.placeholder && (!restrictTo || /input|textarea/.test(restrictTo))) {
      const byPh = queryAllDocuments('input, textarea').filter(isVisible)
        .find(el => el.getAttribute('placeholder') === step.placeholder || el.getAttribute('name') === step.placeholder);
      if (byPh) return byPh;
    }
    // 4) خانة بحث داخل قائمة منبثقة مفتوحة (placeholder يختلف حسب لغة iCare)
    if (step.type === 'input' && (step.search || /search|بحث/i.test((step.placeholder || '') + (step.selector || '')))) {
      const popupInput = queryAllDocuments(
        '[data-radix-popper-content-wrapper] input, [cmdk-input], [role="dialog"] input[type="text"], [role="listbox"] input'
      ).find(isVisible);
      if (popupInput) return popupInput;
    }
    // 5) النص — فقط لنص مميز (ليس "--" أو رمز)، وعلى العناصر التفاعلية فقط
    if (step.type === 'click') {
      for (const t of texts.filter(isDistinctText)) {
        const el = findClickableByText(t, false);
        if (el) return el;
      }
    }
    return null;
  }

  // النص المطلوب وبدائله (step.alt أو "نص1|نص2") بصيغة موحدة
  function stepTexts(step) {
    return [step.text, ...(step.alt || [])]
      .flatMap(t => String(t || '').split('|'))
      .map(normText).filter(Boolean);
  }

  function normText(text) {
    return cleanText(text).toLowerCase();
  }

  // "العنوان * (max 35)" ← "العنوان"
  function normLabel(text) {
    return cleanText(String(text || '').replace(/\(.*?\)/g, '').replace(/[*:：]/g, '')).toLowerCase();
  }

  // loose: "Task Type" أو "نوع المهمة" تطابق "Type" — كلمة كاملة وليس جزءاً من كلمة
  function labelMatches(actual, wanted, loose) {
    const a = normLabel(actual);
    if (!a) return false;
    return String(wanted || '').split('|').map(normLabel).filter(Boolean).some(w => {
      if (a === w) return true;
      if (!loose) return false;
      const words = a.split(' ');
      const wWords = w.split(' ');
      return words.length <= wWords.length + 2 &&
        words.some((_, i) => wWords.every((ww, j) => words[i + j] === ww || words[i + j] === 'ال' + ww));
    });
  }

  function isDistinctText(text) {
    const t = cleanText(text || '');
    return t.length >= 3 && /[\p{L}\p{N}]{2,}/u.test(t);
  }

  // عنصر العنوان ليس دائماً <label> — في نموذج Quick Task قد يكون span/div/p
  const LABEL_LIKE = 'label, legend, span, p, div, h4, h5, h6, dt';

  function labelCandidates(labelText) {
    const own = el => cleanText(el.innerText || '');
    const isLeafish = el => el.children.length <= 2 && own(el).length <= 40;
    // 1) <label> مطابق تماماً  2) <label> يحتوي الكلمة  3) عنصر نصي قصير مطابق تماماً
    const labels = queryAllDocuments('label').filter(isVisible);
    const exact = labels.filter(l => labelMatches(l.innerText, labelText));
    if (exact.length) return exact;
    const loose = labels.filter(l => labelMatches(l.innerText, labelText, true));
    if (loose.length) return loose;
    return queryAllDocuments(LABEL_LIKE).filter(el => isLeafish(el) && isVisible(el) &&
      !el.matches('button, [role="option"], [role="combobox"]') && !el.closest('button, nav, aside, [role="listbox"]') &&
      labelMatches(el.innerText, labelText));
  }

  function findByLabel(labelText, controlSelector) {
    const labels = labelCandidates(labelText);
    for (const lbl of labels) {
      if (lbl.htmlFor) {
        const target = lbl.ownerDocument.getElementById(lbl.htmlFor);
        if (target && isVisible(target)) return target;
      }
      let node = lbl.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        const control = [...node.querySelectorAll(controlSelector)].find(isVisible);
        if (control) return control;
      }
    }
    return null;
  }

  const CLICKABLE = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [cmdk-item], input[type="submit"], input[type="button"]';

  function findClickableByText(text, exactOnly) {
    const wanted = cleanText(text).toLowerCase();
    if (!wanted) return null;
    const candidates = queryAllDocuments(CLICKABLE).filter(isVisible);
    const textOf = el => cleanText(el.innerText || el.value || '').toLowerCase();
    const exact = candidates.find(el => textOf(el) === wanted);
    if (exact || exactOnly) return exact || null;
    return candidates.find(el => textOf(el).startsWith(wanted)) || null;
  }

  const OPTION_QUERY = '[role="option"], [role="menuitem"], [cmdk-item], [data-radix-collection-item], .p-dropdown-item, mat-option';

  function findOptionByText(text) {
    const wanted = cleanText(text).toLowerCase();
    const options = queryAllDocuments(OPTION_QUERY).filter(isVisible);
    const textOf = el => cleanText(el.innerText).toLowerCase();
    return options.find(el => textOf(el) === wanted) ||
      options.find(el => textOf(el).startsWith(wanted + ' ')) ||
      options.find(el => textOf(el).startsWith(wanted)) || null;
  }

  // اختيار نتيجة البحث: يفضّل النتيجة التي تحتوي النص المطلوب،
  // وإلا ينتظر استقرار القائمة (لا يختار نتيجة قديمة قبل انتهاء الفلترة).
  async function pickSearchResult(step) {
    const selector = step.selector || '[role="option"]';
    const isUsable = el => isVisible(el) && el.getAttribute('aria-disabled') !== 'true' &&
      !/^(no results?|no data|loading|لا توجد نتائج|جارٍ التحميل)/i.test(cleanText(el.innerText));
    const visibleOptions = () => queryAllDocuments(selector).filter(isUsable);

    const match = cleanText(step.match || '').toLowerCase();
    if (match) {
      // الاسم المطلوب يجب أن يطابق خياراً واحداً فقط — لا تعيين لموظف خاطئ
      const words = match.split(' ').filter(Boolean);
      const optText = el => cleanText(el.innerText).toLowerCase();
      const hasAllWords = el => { const t = ' ' + optText(el).replace(/[^\p{L}\p{N}]+/gu, ' ') + ' '; return words.every(w => t.includes(' ' + w + ' ')); };
      const candidates = () => {
        const opts = visibleOptions();
        const contains = opts.filter(el => optText(el).includes(match));
        return contains.length ? contains : opts.filter(hasAllWords);
      };
      const found = await waitFor(() => { const c = candidates(); return c.length ? c : null; }, step.timeout || 6000);
      if (found) {
        // انتظر لحظة لاكتمال نتائج البحث ثم أعد الفحص
        await sleep(500);
        const final = candidates();
        if (final.length === 1) return final[0];
        const exact = final.filter(el => optText(el).replace(/^[\d\s—–-]+/, '').replace(/\s+(dr|د)\.?$/i, '').trim() === match);
        if (exact.length === 1) return exact[0];
        // "1225" لا تطابق "12250": فضّل الخيار الذي يحتوي الاسم/الرقم ككلمات كاملة
        const whole = final.filter(hasAllWords);
        if (whole.length === 1) return whole[0];
        if (final.length > 1 && !step.allowFirst) {
          throw new Error('"' + step.match + '" يطابق أكثر من موظف (' + final.length + '): ' +
            final.slice(0, 3).map(el => cleanText(el.innerText).slice(0, 40)).join(' / '));
        }
        if (final.length) return final[0];
      }
      if (!step.allowFirst) throw new Error('لم يُعثر على الموظف "' + step.match + '" في نتائج البحث');
    }

    // انتظر حتى تستقر القائمة 700ms
    const deadline = Date.now() + (step.timeout || 8000);
    let lastSignature = null;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const options = visibleOptions();
      const signature = options.length + '|' + (options[0] ? cleanText(options[0].innerText) : '');
      if (signature !== lastSignature) { lastSignature = signature; stableSince = Date.now(); }
      if (options.length && Date.now() - stableSince >= 700) return options[0];
      await sleep(120);
    }
    throw new Error('لا توجد نتيجة ظاهرة للاختيار' + (match ? ' (بحث: ' + step.match + ')' : ''));
  }

  // ── التحقق من نجاح العملية بعد الحفظ ──
  async function verifySuccess(step) {
    const timeout = step.timeout || 8000;
    const successRe = new RegExp(step.successText ||
      'success|created|saved|assigned|added|sent|done|تم|تمت|بنجاح|أضيف|إضافة|أُنشئ|انشاء', 'i');
    const errorRe = new RegExp(step.errorText || 'error|failed|required|invalid|خطأ|فشل|مطلوب', 'i');
    const toastQuery = '[role="status"], [role="alert"], [data-sonner-toast], [data-radix-toast-root], .toast, .Toastify__toast, [class*="toast"]';
    const goneTexts = String(step.goneText || '').split('|').map(normText).filter(Boolean);
    const goneEl = () => goneTexts.map(t => findClickableByText(t, true)).find(Boolean) || null;
    const hadGoneEl = Boolean(goneEl());
    // الحقول المعبأة قبل الحفظ (الوصف/العنوان): إن اختفت أو أُفرغت فالنموذج أُرسل
    const filled = queryAllDocuments('textarea, input[type="text"], input:not([type])')
      .filter(el => isVisible(el) && String(el.value || '').trim().length > 2 &&
        !el.closest('header, nav, aside') && !/search|بحث/i.test(el.getAttribute('placeholder') || ''));
    const formCleared = () => filled.length > 0 &&
      filled.every(el => !el.isConnected || !isVisible(el) || !String(el.value || '').trim());
    const seenToasts = new Set();

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const toasts = queryAllDocuments(toastQuery).filter(isVisible).map(t => cleanText(t.innerText)).filter(Boolean);
      toasts.forEach(t => seenToasts.add(t.slice(0, 80)));
      const errorToast = toasts.find(t => errorRe.test(t) && !successRe.test(t));
      if (errorToast) throw new Error('رسالة خطأ من iCare: ' + errorToast.slice(0, 120));
      const okToast = toasts.find(t => successRe.test(t));
      if (okToast) return { verified: true, target: okToast.slice(0, 80) };
      if (hadGoneEl && !goneEl()) return { verified: true, target: 'أُغلق النموذج' };
      if (formCleared()) return { verified: true, target: 'أُرسل النموذج (أُغلق/أُفرغ)' };
      await sleep(200);
    }
    if (step.required) throw new Error('لم يتم التأكد من نجاح الحفظ خلال ' + Math.round(timeout / 1000) + ' ث');
    // نذكر الرسائل التي ظهرت فعلاً حتى نضيف صيغة iCare إن لم تكن معروفة
    const seen = [...seenToasts].join(' | ');
    return { verified: false, target: 'لم تظهر رسالة تأكيد' + (seen ? ' — ظهر: ' + seen : '') };
  }

  // ── فحص حالة الملف (غير نشط) — يبحث في الشارات والعناوين القصيرة فقط ──
  function detectDeactive() {
    const re = /^(deactive|deactivated|inactive|not active|file closed|closed file|الملف مغلق|غير نشط|موقوف|ملف مغلق)$/i;
    const nodes = document.querySelectorAll('span, div, p, strong, b, small, td, [class*="badge"], [class*="status"]');
    for (const node of nodes) {
      if (node.children.length > 1) continue;
      const text = cleanText(node.innerText || '');
      if (text && text.length <= 20 && re.test(text) && isVisible(node)) return text;
    }
    return '';
  }

  // ============================================================
  // ===== مساعدات DOM =====
  // ============================================================

  // سلسلة أحداث نقرة حقيقية — مكونات Radix/shadcn تفتح على pointerdown وليس click.
  async function realClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: human.enabled && !document.hidden ? 'smooth' : 'auto' });
    await sleep(human.enabled ? rand(250, 450) : 150);
    const rect = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView;
    // الوضع البشري: نقطة عشوائية داخل الجزء الأوسط من العنصر بدل المركز بالضبط
    const fx = human.enabled ? rand(0.3, 0.7) : 0.5;
    const fy = human.enabled ? rand(0.3, 0.7) : 0.5;
    const base = {
      bubbles: true, cancelable: true, composed: true, view,
      clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy,
      button: 0
    };
    const PointerEvt = view.PointerEvent || view.MouseEvent;
    const ptr = { pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvt('pointerover', { ...base, ...ptr }));
    if (human.enabled) {
      el.dispatchEvent(new PointerEvt('pointerenter', { ...base, ...ptr, bubbles: false }));
      el.dispatchEvent(new view.MouseEvent('mouseover', base));
      el.dispatchEvent(new PointerEvt('pointermove', { ...base, ...ptr }));
      el.dispatchEvent(new view.MouseEvent('mousemove', base));
      await humanPause(80, 220); // تحريك المؤشر ثم التوقف قبل الضغط
    }
    el.dispatchEvent(new PointerEvt('pointerdown', { ...base, ...ptr, buttons: 1 }));
    el.dispatchEvent(new view.MouseEvent('mousedown', { ...base, buttons: 1 }));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    await humanPause(50, 120); // مدة ضغطة الزر
    el.dispatchEvent(new PointerEvt('pointerup', { ...base, ...ptr }));
    el.dispatchEvent(new view.MouseEvent('mouseup', base));
    el.click();
  }

  // كتابة حرفاً بحرف مع أحداث لوحة المفاتيح — خانات البحث التي تنتظر توقف الكتابة تعمل كما مع المستخدم
  async function humanType(el, value) {
    el.focus();
    const view = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const setValue = v => { if (setter) setter.call(el, v); else el.value = v; };

    if (el.value) {
      setValue('');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await humanPause(120, 260);
    }
    const chars = [...value];
    // النصوص الطويلة (الرسالة) تُكتب أسرع حتى لا يتجاوز الحقل الواحد ~5 ثوانٍ
    const maxPerChar = chars.length ? (5000 * human.speed) / chars.length : 0;
    let typed = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      // سطر جديد: بدون أحداث Enter حتى لا يُرسل النموذج قبل اكتمال الرسالة
      const newline = ch === '\n';
      const key = { key: ch, bubbles: true, cancelable: true };
      if (!newline) {
        el.dispatchEvent(new KeyboardEvent('keydown', key));
        el.dispatchEvent(new KeyboardEvent('keypress', key));
      }
      typed += ch;
      setValue(typed);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: newline ? null : ch, inputType: newline ? 'insertLineBreak' : 'insertText' }));
      if (!newline) el.dispatchEvent(new KeyboardEvent('keyup', key));
      let delay = Math.min(rand(45, 130) * human.speed, maxPerChar);
      if (ch === ' ' || (i > 0 && i % Math.round(rand(8, 14)) === 0)) delay += rand(60, 200) * human.speed;
      await sleep(delay);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(el, value) {
    el.focus();
    const view = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitEnabled(el, timeout) {
    const deadline = Date.now() + timeout;
    while ((el.disabled || el.getAttribute('aria-disabled') === 'true') && Date.now() < deadline) {
      await sleep(150);
    }
  }

  async function waitFor(fn, timeout) {
    const deadline = Date.now() + timeout;
    while (true) {
      let result = null;
      try { result = fn(); } catch { result = null; }
      if (result) return result;
      if (Date.now() >= deadline) return null;
      await sleep(150);
    }
  }

  function firstVisible(selector) {
    return queryAllDocuments(selector).find(isVisible) || null;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function describe(el) {
    return cleanText(el.innerText || el.value || el.getAttribute('placeholder') || el.tagName).slice(0, 60);
  }

  function getReachableDocuments(rootDocument = document, collected = []) {
    if (collected.includes(rootDocument)) return collected;
    collected.push(rootDocument);
    rootDocument.querySelectorAll('iframe, frame').forEach(frame => {
      try { if (frame.contentDocument) getReachableDocuments(frame.contentDocument, collected); }
      catch { /* إطار من نطاق مختلف */ }
    });
    return collected;
  }

  function queryAllDocuments(selector) {
    const results = [];
    getReachableDocuments().forEach(doc => {
      try { results.push(...doc.querySelectorAll(selector)); } catch { /* محدد غير صالح */ }
    });
    return results;
  }

  function collectFailureDiagnostic(step, error) {
    // حقول النموذج المفتوح (نافذة/نموذج) أولاً — أهم من أزرار القائمة الجانبية
    const scope = queryAllDocuments('[role="dialog"], form').filter(isVisible).pop();
    const formFields = scope ? [...scope.querySelectorAll('input, textarea, select, button, [role="combobox"]')]
      .filter(isVisible).slice(0, 40).map((el, i) => ({
        index: i + 1,
        tag: el.tagName.toLowerCase() + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : ''),
        label: fieldLabel(el),
        text: cleanText(el.innerText || el.value || el.getAttribute('placeholder') || '').slice(0, 40)
      })) : [];
    const labels = (scope ? [...scope.querySelectorAll('label')] : queryAllDocuments('label'))
      .filter(isVisible).map(l => cleanText(l.innerText)).filter(Boolean).slice(0, 30);
    const controls = queryAllDocuments('input, textarea, select, button, [role="button"], [role="option"], [role="combobox"], label')
      .filter(el => isVisible(el) && !el.closest('nav, aside')).slice(0, 60).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        text: cleanText(el.innerText).slice(0, 80),
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        role: el.getAttribute('role') || ''
      })).filter(item => item.type !== 'password');
    return {
      capturedAt: new Date().toISOString(),
      step,
      error: error.message,
      page: { url: window.location.href, title: document.title },
      formScope: scope ? (scope.getAttribute('role') || scope.tagName.toLowerCase()) : 'none',
      formLabels: labels,
      formFields,
      visibleControls: controls
    };
  }

  // في التبويب المخفي يُبطئ Chrome المؤقتات (حتى مرة في الدقيقة بعد 5 دقائق)،
  // فنطلب الانتظار من الـ background: الرد يصل كرسالة لا كمؤقت فلا يُبطأ.
  function sleep(ms) {
    if (document.hidden && ms > 0) {
      try {
        return chrome.runtime.sendMessage({ action: 'BG_SLEEP', ms })
          .catch(() => new Promise(r => setTimeout(r, ms)));
      } catch { /* runtime غير متاح */ }
    }
    return new Promise(r => setTimeout(r, ms));
  }

  function flashElement(el) {
    const { outline, outlineOffset } = el.style;
    el.style.outline = '2px solid #C9A227';
    el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = outline; el.style.outlineOffset = outlineOffset; }, 600);
  }

  // ============================================================
  // ===== الرسائل =====
  // ============================================================

  function onMessage(msg, sender, sendResponse) {
    switch (msg.action) {
      case 'PING':
        sendResponse({ ok: true, version: VERSION, top: IS_TOP, url: window.location.href, ready: document.readyState });
        return;

      case 'START_RECORDING':
        startRecording();
        sendResponse({ ok: true });
        return;

      case 'STOP_RECORDING':
        stopRecording();
        sendResponse({ ok: true });
        return;

      case 'EXECUTE_STEP':
        if (!IS_TOP) return; // الإطار الرئيسي فقط ينفذ (ويبحث داخل الإطارات الفرعية)
        human = {
          enabled: Boolean(msg.human && msg.human.enabled),
          speed: Math.min(2, Math.max(0.3, Number(msg.human && msg.human.speed) || 1))
        };
        executeStep(msg.step)
          .then(info => sendResponse({ ok: true, ...(info || {}) }))
          .catch(err => sendResponse({
            ok: false,
            error: err.message,
            diagnostic: collectFailureDiagnostic(msg.step, err)
          }));
        return true; // async

      case 'DETECT_STATUS':
        if (!IS_TOP) return;
        sendResponse({ ok: true, deactive: detectDeactive(), title: document.title, url: window.location.href });
        return;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);

  // صفحة جديدة أثناء جلسة تسجيل ← أكمل التسجيل تلقائياً.
  send({ action: 'BG_GET_RECORDING_CONTEXT' }).then(context => {
    if (context && context.recording) startRecording();
  });
})();
