/**
 * استيراد ملفات Excel/CSV (مثل تقرير Rad. Reports) لتحويل كل صف إلى تاسك:
 *   PTID → رقم الملف، Report Doctor → الموظف، Status → العنوان، Error / Rejection Reason → الرسالة
 * يعتمد على SheetJS (lib/sheetjs/xlsx.full.min.js) للقراءة، وباقي الدوال نقية وقابلة للاختبار.
 */
(function (root) {
  // الحقول التي يمكن ربطها بأعمدة الملف
  const FIELDS = [
    { key: 'ptid',     label: 'رقم الملف',  required: true,
      patterns: [/^p\.?t\.?\s*id$/i, /^(patient\s*id|file\s*(no|number)|mrn|رقم\s*الملف)$/i, /ptid|رقم الملف/i] },
    { key: 'employee', label: 'الموظف',
      patterns: [/^report\s*doctor$/i, /^case\s*doctor$/i, /doctor|physician|الطبيب|الموظف|staff|assign/i] },
    // ملفات التصدير من الإضافة نفسها فيها "العنوان" و"رسالة التاسك" بجانب "الحالة" و"الملاحظة" (نتيجة التشغيل)
    // فالتطابق الدقيق يسبق العام حتى لا يُربط العنوان بـ "الحالة: فشل" أو الرسالة بنص الخطأ
    { key: 'title',    label: 'العنوان',
      patterns: [/^status$/i, /^(title|العنوان)$/i, /^الحالة$/i, /status|title/i] },
    { key: 'message',  label: 'الرسالة',
      patterns: [/rejection\s*reason/i, /^(reason|message|الرسالة|رسالة التاسك)$/i,
        /reason|error|notes?|message|الرسالة|سبب|ملاحظ/i] }
  ];

  // أعمدة اختيارية تكتبها الإضافة عند الحفظ — تُربط بالاسم الدقيق فقط حتى لا تلتقط
  // أعمدة مثل "Priority" في تقارير أخرى (قيمها Primary/Secondary وليست أولوية التاسك)
  const EXTRA_FIELDS = [
    { key: 'TASK_TYPE',        pattern: /^task\s*type$/i },
    { key: 'TASK_PRIORITY',    pattern: /^task\s*priority$/i },
    { key: 'TASK_CATEGORY',    pattern: /^task\s*category$/i },
    { key: 'TASK_SUBCATEGORY', pattern: /^task\s*sub\s*-?\s*category$/i }
  ];

  // قوالب لأنواع ملفات معروفة: تُعرف من أعمدتها، وتربط الأعمدة الصحيحة وتعطي عنواناً ورسالة ثابتين
  // (توضع في حقلي العنوان والرسالة بالتبويب فيمكن تعديلها قبل التشغيل)
  const PROFILES = [
    {
      id: 'exit-list',
      label: 'قائمة دخول المستشفى (Exit list)',
      match: headers => ['record type', 'harp score', 'doctor'].every(h => headers.some(x => cellText(x).toLowerCase() === h)),
      // الموظف = Doctor (طبيب الحالة) وليس Staff؛ العنوان والرسالة ثابتان وليسا Status/Reason
      columns: { ptid: /^ptid$/i, employee: /^doctor$/i },
      title: 'اكمال ملف الدخول للمستشفى',
      message: [
        'الرجاء اكمال ملف الدخول:',
        '- كل الأمراض المتعلقة بالمريض',
        '- السبب الأساسي لدخوله المستشفى',
        '- مراجعة الفحوصات المعملية والأدوية التي عليها المريض',
        '1- اتباع النصائح الأخيرة من الاجتماع للدخول المتكرر',
        '2- مراجعة تصنيف HARP',
        '3- اختيار تصنيف الحالة من الاختصاصي: مخطط أم لا، يمكن تجنب الدخول أم لا',
        '4- التأكد من رفع طلب زيارة الأخصائي وإكمال الزيارة'
      ].join('\n')
    },
    {
      // قائمة المرضى الجدد (new-files): المهمة لطبيب الحالة — الرسالة بالإنجليزية كما تُكتب في النظام
      id: 'new-files',
      label: 'قائمة المرضى الجدد (New files)',
      match: headers => ['patient id', 'doctor', 'file open time', 'csheet visits'].every(h => headers.some(x => cellText(x).toLowerCase() === h)),
      columns: { ptid: /^patient\s*id$/i, employee: /^doctor$/i },
      title: 'New Patient - Schedule Visit',
      message: 'The patient is on the new patients list.\n' +
        'Please contact the patient and take the necessary action, or schedule the visit with the patient.'
    },
    {
      // تقرير الأداء الشهري: تحليل GP Note لزيارات الطبيب (DR P = المخطط، DR D = المنفذ)
      id: 'gp-note',
      label: 'تحليل GP Note (تقرير الأداء)',
      match: headers => ['gp note', 'dr p', 'dr d'].every(h => headers.some(x => cellText(x).toLowerCase() === h)),
      columns: { ptid: /^ptid$/i, employee: /^doctor\s*name$/i, drP: /^dr\s*p$/i, drD: /^dr\s*d$/i, note: /^gp\s*note$/i },
      // كل صف يأخذ أول سبب ينطبق عليه؛ employee فارغ = طبيب الحالة من عمود Doctor Name
      // في الرسائل: {DR_P} {DR_D} {NOTE} تُستبدل بقيم الصف
      rules: [
        { id: 'acute', label: 'Acute → التأمين 45',
          test: r => r.p > 0 && r.d === 0 && /^acute$/i.test(r.note),
          employee: '45', title: 'Acute - سحب الخطة السابقة',
          message: 'حالة Acute: زيارة الطبيب مخططة ({DR_P}) ولم تُنفذ.\n' +
            '1- قسم التأمين: سحب الخطة السابقة في الشهر السابق.\n' +
            '2- ثم التحويل إلى نور للتأكد من اكتمال الملف.\n' +
            '3- ثم إلى فاطمة العبدلي لإغلاق الملف.' },
        { id: 'refused', label: 'Patient refused service → تجربة المريض 632',
          test: r => r.p > 0 && r.d === 0 && /refused/i.test(r.note),
          employee: '632', title: 'رفض المريض للخدمة',
          message: 'المريض رفض الخدمة (GP Note: {NOTE}).\n' +
            'الرجاء معرفة سبب رفض المريض وتوثيقه، ومحاولة إقناعه، واستكمال الخطة العلاجية حسب البروتوكول المتفق عليه.' },
        { id: 'rescheduled', label: 'Service rescheduled by patient → طبيب الحالة',
          test: r => r.p > 0 && r.d === 0 && /rescheduled/i.test(r.note),
          employee: '', title: 'إعادة جدولة زيارة الطبيب',
          message: 'المريض طلب إعادة جدولة الزيارة (GP Note: {NOTE}).\n' +
            'الرجاء إدخال الموعد المتفق عليه مع المريض وجدولة الزيارة.' },
        { id: 'not-available', label: 'Patient was not available → الاستقبال 709',
          test: r => r.p > 0 && r.d === 0 && /not\s*available/i.test(r.note),
          employee: '709', title: 'المريض غير متوفر وقت الزيارة',
          message: 'المريض لم يكن متوفراً وقت زيارة الطبيب (GP Note: {NOTE}).\n' +
            'الرجاء التأكد من رقم الجوال ومعرفة سبب عدم توفر المريض، وتغيير رقم الهاتف أو ما يلزم.' },
        { id: 'extra-visit', label: 'زيارة إضافية (DR P > DR D ≥ 1) → التأمين 45',
          test: r => r.d >= 1 && r.p - r.d >= 1,
          employee: '45', title: 'زيارة إضافية لتصفير الخطة',
          message: 'زيارات الطبيب: المخطط {DR_P} والمنفذ {DR_D}.\n' +
            'الحالة تعتبر زيارة إضافية — الرجاء تصفير الخطة.' }
      ]
    }
  ];

  function profileById(id) {
    return PROFILES.find(p => p.id === id) || null;
  }

  // السبب المنطبق على صف (لقوالب القواعد)
  function classifyRow(profile, mapping, row) {
    const num = col => (col >= 0 ? Number(cellText(row[col])) || 0 : 0);
    const ctx = { p: num(mapping.drP), d: num(mapping.drD), note: mapping.note >= 0 ? cellText(row[mapping.note]) : '' };
    const rule = profile.rules.find(r => r.test(ctx));
    return rule ? { rule, ctx } : null;
  }

  function fillRuleText(text, ctx) {
    return String(text).replace(/\{DR_P\}/g, ctx.p).replace(/\{DR_D\}/g, ctx.d).replace(/\{NOTE\}/g, ctx.note);
  }

  function detectProfile(headers) {
    return PROFILES.find(p => p.match(headers || [])) || null;
  }

  function cellText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
    return String(value).replace(/\s+/g, ' ').trim();
  }

  // قيم تعني "لا يوجد" تُعامل كخانة فارغة (تُؤخذ القيمة من إعدادات التبويب)
  const EMPTY_VALUE = /^(—|–|-+|n\/?a|null|none|nil|لا يوجد|غير محدد)$/i;
  function valueText(value) {
    const text = cellText(value);
    return EMPTY_VALUE.test(text) ? '' : text;
  }

  // رقم الملف: 41531.0 ← 41531، مع إزالة المسافات
  function normalizePtid(value) {
    if (typeof value === 'number' && isFinite(value)) return String(Math.round(value));
    return cellText(value).replace(/\.0+$/, '').replace(/\s+/g, '');
  }

  // "processNotes: PLZ ATTACH ... | disposition: rejected" ← "PLZ ATTACH ..."
  function cleanMessage(text) {
    return cellText(text)
      .replace(/^\s*process\s*notes?\s*:\s*/i, '')
      .replace(/\s*\|\s*disposition\s*:\s*[^|]*$/i, '')
      .replace(/^[-–:\s]+/, '')
      .trim();
  }

  // صف العناوين: أول صف (ضمن أول 20) يحتوي عمود رقم الملف، وإلا أول صف غير فارغ
  function findHeaderRow(rows) {
    const limit = Math.min(rows.length, 20);
    for (let i = 0; i < limit; i++) {
      if ((rows[i] || []).some(v => FIELDS[0].patterns.some(re => re.test(cellText(v))))) return i;
    }
    return rows.findIndex(r => (r || []).some(v => cellText(v)));
  }

  // الأعمدة بلا عنوان تأخذ اسماً وصفياً: "عمود E"
  function columnLetter(index) {
    let s = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // hidden (اختياري): مصفوفة بنفس طول rows — true للصف المخفي في Excel
  // misaligned (اختياري): true للصف المنزاح في ملف iCare (انظر htmlMisalignedRows)
  function buildTable(rows, hidden, misaligned) {
    const headerIdx = findHeaderRow(rows);
    if (headerIdx < 0) return { headers: [], rows: [], hidden: [], misaligned: [], headerRow: -1 };
    const width = Math.max(...rows.map(r => (r || []).length), 0);
    const rawHeaders = rows[headerIdx] || [];
    const headers = Array.from({ length: width }, (_, i) =>
      cellText(rawHeaders[i]) || ('عمود ' + columnLetter(i)));
    const dataRows = [];
    const dataHidden = [];
    const dataMisaligned = [];
    rows.forEach((r, i) => {
      if (i <= headerIdx || !(r || []).some(v => cellText(v))) return;
      dataRows.push(r);
      dataHidden.push(Boolean(hidden && hidden[i]));
      dataMisaligned.push(Boolean(misaligned && misaligned[i]));
    });
    return { headers, rows: dataRows, hidden: dataHidden, misaligned: dataMisaligned, headerRow: headerIdx };
  }

  function detectMapping(headers) {
    const profile = detectProfile(headers);
    if (profile) {
      const mapping = { extra: {}, profile: profile.id, title: -1, message: -1 };
      Object.entries(profile.columns).forEach(([key, re]) => {
        mapping[key] = headers.findIndex(h => re.test(cellText(h)));
      });
      return mapping;
    }
    const used = new Set();
    const mapping = { extra: {} };
    EXTRA_FIELDS.forEach(f => {
      const idx = headers.findIndex(h => f.pattern.test(cellText(h)));
      if (idx >= 0) { mapping.extra[f.key] = idx; used.add(idx); }
    });
    FIELDS.forEach(field => {
      mapping[field.key] = -1;
      for (const re of field.patterns) {
        const idx = headers.findIndex((h, i) => !used.has(i) && re.test(h));
        if (idx >= 0) { mapping[field.key] = idx; used.add(idx); break; }
      }
    });
    return mapping;
  }

  /**
   * يحول الصفوف إلى عناصر تشغيل. الحقل غير المربوط (-1) يأخذ القيمة من إعدادات تبويب تاسك.
   * @returns {{ items: {ptid, vars, row}[], skipped: number, duplicates: number }}
   */
  function buildItems(table, mapping, options = {}) {
    const clean = options.cleanMessage !== false;
    // filter: { col, exclude: [قيم] } — الصفوف بهذه القيم تُستبعد
    const filter = options.filter && options.filter.col >= 0 ? options.filter : null;
    const excluded = new Set(filter ? filter.exclude || [] : []);
    // الصفوف المخفية في Excel (مثل ما أخفاه فلتر Excel) تُستبعد
    const skipHidden = options.skipHidden && Array.isArray(table.hidden);
    let hiddenSkipped = 0;
    // قوالب القواعد: كل صف يُصنف بسبب، والصفوف بلا سبب لا تُرسل؛ options.rule = سبب واحد أو 'all'
    const profile = profileById(mapping.profile);
    const ruled = profile && profile.rules ? profile : null;
    const ruleCounts = {};
    let unmatched = 0;
    const misalignedPtids = [];
    const seen = new Set();
    const items = [];
    let skipped = 0;
    let duplicates = 0;
    let filtered = 0;
    table.rows.forEach((row, i) => {
      if (skipHidden && table.hidden[i]) { hiddenSkipped++; return; }
      if (filter && excluded.has(cellText(row[filter.col]) || '(فارغ)')) { filtered++; return; }
      const get = key => (mapping[key] >= 0 ? row[mapping[key]] : undefined);
      const ptid = normalizePtid(get('ptid'));
      if (!ptid || !/^[A-Za-z0-9-]+$/.test(ptid)) { skipped++; return; }
      const vars = {};
      // صف منزاح: قيم الأعمدة غير موثوقة (الطبيب قد يكون اسم شركة تأمين)
      const shifted = Array.isArray(table.misaligned) && table.misaligned[i];
      if (shifted) misalignedPtids.push(ptid);
      if (ruled && shifted) { unmatched++; return; } // السبب يعتمد على أرقام الأعمدة — لا نخمن
      if (ruled) {
        const hit = classifyRow(ruled, mapping, row);
        if (!hit) { unmatched++; return; }
        ruleCounts[hit.rule.id] = (ruleCounts[hit.rule.id] || 0) + 1;
        if (options.rule && options.rule !== 'all' && options.rule !== hit.rule.id) { filtered++; return; }
        vars.TASK_EMPLOYEE = hit.rule.employee || (mapping.employee >= 0 ? valueText(get('employee')) : '') ||
          String(options.defaultEmployee || '').trim();
        vars.TASK_TITLE = fillRuleText(hit.rule.title, hit.ctx).slice(0, 35);
        vars.TASK_MESSAGE = fillRuleText(hit.rule.message, hit.ctx);
        const key = ptid + '|' + JSON.stringify(vars);
        if (seen.has(key)) { duplicates++; return; }
        seen.add(key);
        items.push({ ptid, vars, row: i + 1, rule: hit.rule.id });
        return;
      }
      if (mapping.employee >= 0) vars.TASK_EMPLOYEE = valueText(get('employee'));
      // صف بلا طبيب ← الموظف البديل (مثل 632)
      if (!vars.TASK_EMPLOYEE && options.defaultEmployee) vars.TASK_EMPLOYEE = String(options.defaultEmployee).trim();
      if (mapping.title >= 0) vars.TASK_TITLE = valueText(get('title')).slice(0, 35);
      if (mapping.message >= 0) {
        const raw = valueText(get('message'));
        vars.TASK_MESSAGE = clean ? cleanMessage(raw) : raw;
      }
      Object.entries(mapping.extra || {}).forEach(([key, col]) => {
        const v = valueText(row[col]);
        if (v) vars[key] = v;
      });
      if (shifted) {
        // نرسل للموظف البديل (مثل 632) بالعنوان والرسالة من التبويب بدل قيم منزاحة
        Object.keys(vars).forEach(k => delete vars[k]);
        if (options.defaultEmployee) vars.TASK_EMPLOYEE = String(options.defaultEmployee).trim();
      }
      // حقول فارغة في الصف ← تُحذف لتستخدم قيمة التبويب
      Object.keys(vars).forEach(k => { if (!vars[k]) delete vars[k]; });
      const key = ptid + '|' + JSON.stringify(vars);
      if (seen.has(key)) { duplicates++; return; }
      seen.add(key);
      items.push(shifted ? { ptid, vars, row: i + 1, misaligned: true } : { ptid, vars, row: i + 1 });
    });
    return { items, skipped, duplicates, filtered, hiddenSkipped, ruleCounts, unmatched, misalignedPtids };
  }

  // قراءة ملف (File/ArrayBuffer) عبر SheetJS → مصفوفة صفوف من الورقة الأولى غير الفارغة
  // cellStyles: لقراءة الصفوف المخفية (!rows[i].hidden)؛ blankrows: للحفاظ على ترقيم الصفوف
  // ملفات .xls المصدّرة من iCare هي HTML بترميز UTF-16 — SheetJS يفسد النص العربي فيها
  // فتنزاح الأعمدة (اسم الطبيب يلتصق بعمود Reason). نفك الترميز بأنفسنا ونقرأها كنص.
  function decodeTextSheet(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let encoding = null;
    let offset = 0;
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) { encoding = 'utf-16le'; offset = 2; }
    else if (bytes[0] === 0xFE && bytes[1] === 0xFF) { encoding = 'utf-16be'; offset = 2; }
    if (!encoding || typeof TextDecoder === 'undefined') return null;
    const text = new TextDecoder(encoding).decode(bytes.subarray(offset));
    return /^\s*</.test(text) ? text : null;
  }

  // تصدير iCare أحياناً يضع خلايا زائدة في صف (مثلاً 38 بدل 36) فتنزاح قيمه: يظهر اسم شركة التأمين
  // في عمود Doctor. SheetJS يقص الصف لعرض الجدول فلا يظهر ذلك — نعد الخلايا في HTML الأصلي.
  function htmlMisalignedRows(html, count) {
    const body = html.replace(/<!--[\s\S]*?-->/g, '');
    const cells = body.split(/<tr[\s>]/i).slice(1).map(tr => {
      const row = tr.split(/<\/tr>/i)[0];
      return (row.match(/<t[dh][\s>]/gi) || []).length;
    });
    if (!cells.length) return [];
    const freq = new Map();
    cells.forEach(n => freq.set(n, (freq.get(n) || 0) + 1));
    const normal = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return Array.from({ length: count }, (_, i) => cells[i] !== undefined && cells[i] !== normal);
  }

  function readWorkbookRows(data, XLSX) {
    const text = decodeTextSheet(data);
    const wb = text !== null
      ? XLSX.read(text, { type: 'string', cellDates: false, cellStyles: true })
      : XLSX.read(data, { type: 'array', cellDates: false, cellStyles: true });
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws['!ref']) continue;
      const start = XLSX.utils.decode_range(ws['!ref']).s.r;
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true });
      if (!rows.some(r => r.some(v => cellText(v)))) continue;
      const rowProps = ws['!rows'] || [];
      const hidden = rows.map((_, i) => Boolean(rowProps[start + i] && rowProps[start + i].hidden));
      return { sheetName: name, rows, hidden, misaligned: text !== null ? htmlMisalignedRows(text, rows.length) : [] };
    }
    return { sheetName: wb.SheetNames[0] || '', rows: [], hidden: [] };
  }

  // القيم المختلفة في عمود مع عددها (لقائمة التصفية)
  function distinctValues(table, col) {
    const counts = new Map();
    table.rows.forEach(row => {
      const v = cellText(row[col]) || '(فارغ)';
      counts.set(v, (counts.get(v) || 0) + 1);
    });
    return [...counts.entries()].map(([value, count]) => ({ value, count }));
  }

  const api = { FIELDS, EXTRA_FIELDS, PROFILES, detectProfile, profileById, classifyRow, cellText, valueText, distinctValues, normalizePtid, cleanMessage, findHeaderRow, buildTable, detectMapping, buildItems, readWorkbookRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaskImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
