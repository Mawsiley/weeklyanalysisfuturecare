/* 📊 التحليل — dashboard inside the extension window (FutureCare Weekly).
   • Report: the latest performance report, fetched here from iCare or synced from the weekly site (weeklyReport).
   • Summary: active patients, DR plan / done (partial cases zeroed like the site), Not Done, per doctor.
   • Tasks: GP Note rules (synced with the site's 📨 tab — weeklyTaskRules, newer copy wins), case selection and
     preview; "تجهيز" loads the list into the ⚡ تاسك tab, where the run is started with the usual safeguards. */
(() => {
  const RULES = [
    { id: 'acute', label: 'Acute', to: 'التأمين (45)', employee: '45', on: true, title: 'Acute - سحب الخطة السابقة',
      message: 'حالة Acute: زيارة الطبيب مخططة ({DR_P}) ولم تُنفذ.\n1- قسم التأمين: سحب الخطة السابقة في الشهر السابق.\n2- ثم التحويل إلى نور للتأكد من اكتمال الملف.\n3- ثم إلى فاطمة العبدلي لإغلاق الملف.',
      test: r => r.p > 0 && r.d === 0 && /^acute$/i.test(r.note) },
    { id: 'refused', label: 'Patient refused service', to: 'تجربة المريض (632)', employee: '632', on: true, title: 'رفض المريض للخدمة',
      message: 'المريض رفض الخدمة (GP Note: {NOTE}).\nالرجاء معرفة سبب رفض المريض وتوثيقه، ومحاولة إقناعه، واستكمال الخطة العلاجية حسب البروتوكول المتفق عليه.',
      test: r => r.p > 0 && r.d === 0 && /refused/i.test(r.note) },
    { id: 'rescheduled', label: 'Service rescheduled by patient', to: 'طبيب الحالة', employee: '', on: true, title: 'إعادة جدولة زيارة الطبيب',
      message: 'المريض طلب إعادة جدولة الزيارة (GP Note: {NOTE}).\nالرجاء إدخال الموعد المتفق عليه مع المريض وجدولة الزيارة.',
      test: r => r.p > 0 && r.d === 0 && /rescheduled/i.test(r.note) },
    { id: 'not-available', label: 'Patient was not available', to: 'الاستقبال (709)', employee: '709', on: true, title: 'المريض غير متوفر وقت الزيارة',
      message: 'المريض لم يكن متوفراً وقت زيارة الطبيب (GP Note: {NOTE}).\nالرجاء التأكد من رقم الجوال ومعرفة سبب عدم توفر المريض، وتغيير رقم الهاتف أو ما يلزم.',
      test: r => r.p > 0 && r.d === 0 && /not\s*available/i.test(r.note) },
    { id: 'extra-visit', label: 'زيارة إضافية (DR P > DR D ≥ 1)', to: 'التأمين (45)', employee: '45', on: true, title: 'زيارة إضافية لتصفير الخطة',
      message: 'زيارات الطبيب: المخطط {DR_P} والمنفذ {DR_D}.\nالحالة تعتبر زيارة إضافية — الرجاء تصفير الخطة.',
      test: r => r.d >= 1 && r.p - r.d >= 1 },
    { id: 'missing-note', label: 'Not Done بدون GP Note', to: 'طبيب الحالة', employee: '', on: false, title: 'توثيق سبب عدم الزيارة',
      message: 'زيارة الطبيب مخططة ({DR_P}) ولم تُنفذ ولا يوجد GP Note.\nالرجاء توثيق سبب عدم تنفيذ الزيارة في GP Note أو جدولة الزيارة.',
      test: r => r.p > 0 && r.d === 0 && !r.note },
  ];
  const FIELDS = [['type', 'النوع'], ['priority', 'الأولوية'], ['category', 'الفئة'], ['subcategory', 'الفئة الفرعية']];
  const CITIES = { Jeddah: 'جدة', Makkah: 'مكة', Yanbu: 'ينبع' };
  const $d = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
  const txt = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
  const S = { report: null, rows: [], cfg: {}, cfgAt: 0, reason: '', doctor: '', city: '', q: '', off: new Set(), busy: false, msg: '' };

  const rule = id => ({ ...RULES.find(r => r.id === id), ...((S.cfg.rules || {})[id] || {}) });
  const fallback = () => txt(S.cfg.fallback) || '632';
  async function saveCfg() { S.cfgAt = Date.now(); await chrome.storage.local.set({ weeklyTaskRules: { cfg: S.cfg, at: S.cfgAt } }); }

  function parseReport(rep) {
    const bin = atob(rep.b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const wb = TaskImport.readWorkbookRows(bytes, XLSX), t = TaskImport.buildTable(wb.rows, wb.hidden, wb.misaligned);
    const H = t.headers.map(h => txt(h).toLowerCase()), col = (...names) => H.findIndex(h => names.includes(h));
    const c = { ptid: col('ptid', 'mrn', 'patient id'), doctor: col('doctor name', 'doctor', 'case doctor'), city: col('city'), status: col('status', 'patient status'),
      p: col('dr p', 'dr plan'), d: col('dr d', 'dr done'), note: col('gp note') };
    if (c.ptid < 0 || c.p < 0 || c.d < 0) throw new Error('الملف ليس تقرير أداء (يلزم PTID و DR P و DR D)');
    return t.rows.filter((_, i) => !t.hidden[i]).map(r => ({
      ptid: txt(r[c.ptid]), doctor: txt(r[c.doctor]).replace(/^#?n\/?a$/i, ''), city: txt(r[c.city]), status: txt(r[c.status]),
      p: num(r[c.p]), d: num(r[c.d]), note: txt(r[c.note]),
    })).filter(x => x.ptid);
  }
  const active = () => S.rows.filter(x => !/de-?active|inactive/i.test(x.status));
  const scoped = () => active().filter(x => (!S.city || x.city === S.city) && (!S.doctor || x.doctor === S.doctor));

  function cases() {
    const out = [];
    scoped().forEach(x => {
      for (const base of RULES) {
        const r = rule(base.id);
        if (!r.on || !base.test(x)) continue;
        const fill = s => String(s || '').replace(/\{DR_P\}/g, x.p).replace(/\{DR_D\}/g, x.d).replace(/\{NOTE\}/g, x.note || '—')
          .replace(/\{DOCTOR\}/g, x.doctor || '—').replace(/\{PTID\}/g, x.ptid);
        out.push({ x, rule: base, employee: txt(r.employee) || x.doctor || fallback(), title: fill(r.title).slice(0, 35), message: fill(r.message) });
        break;
      }
    });
    return out;
  }
  const visible = all => all.filter(c => (!S.reason || c.rule.id === S.reason) &&
    (!S.q || `${c.x.ptid} ${c.x.doctor} ${c.x.note}`.toLowerCase().includes(S.q.toLowerCase())));
  const selected = () => visible(cases()).filter(c => !S.off.has(c.x.ptid));

  function summary() {
    const a = scoped(), plan = a.reduce((s, x) => s + (x.d > 0 && x.p > x.d ? x.d : x.p), 0), done = a.reduce((s, x) => s + x.d, 0);
    const byDoc = new Map();
    a.forEach(x => { const k = x.doctor || '—'; const o = byDoc.get(k) || { doctor: k, n: 0, plan: 0, done: 0, nd: 0 };
      o.n++; o.plan += x.d > 0 && x.p > x.d ? x.d : x.p; o.done += x.d; if (x.p > 0 && x.d === 0) o.nd++; byDoc.set(k, o); });
    return { a, plan, done, nd: a.filter(x => x.p > 0 && x.d === 0).length, deact: S.rows.length - active().length,
      docs: [...byDoc.values()].sort((x, y) => y.n - x.n) };
  }

  function render() {
    const el = $d('tab-dash'); if (!el) return;
    const rep = S.report, thisMonth = new Date().toISOString().slice(0, 7);
    const head = `<div class="dash-src">
      <div class="dash-src-line">${rep ? `📗 <b>${esc(rep.name)}</b> <span class="dash-muted">— ${rep.source === 'icare' ? 'جُلب من iCare' : 'من موقع التحليل'} ${new Date(rep.at).toLocaleString('ar-SA')}</span>` : '<span class="dash-muted">لا يوجد تقرير بعد — اجلبه من iCare هنا، أو حمّله في موقع التحليل الأسبوعي فيصل تلقائياً.</span>'}</div>
      <div class="dash-fetch"><input type="month" id="dashMonth" value="${esc(S.month || thisMonth)}">
        ${Object.entries(CITIES).map(([k, v]) => `<label><input type="checkbox" class="dashCity" value="${k}" ${(S.cities || Object.keys(CITIES)).includes(k) ? 'checked' : ''}>${v}</label>`).join('')}
        <button class="btn-sm" id="dashFetch" ${S.busy ? 'disabled' : ''}>📥 جلب من iCare</button>
        <button class="btn-sm" id="dashPick">📂 ملف</button><input type="file" id="dashFile" accept=".xls,.xlsx,.html" hidden>
        ${document.body.classList.contains('full-page') ? '' : '<button class="btn-sm" id="dashFull" title="فتح في صفحة كاملة">⤢</button>'}</div>
      ${S.msg ? `<div class="dash-msg">${esc(S.msg)}</div>` : ''}</div>`;
    if (!S.rows.length) { el.innerHTML = head; return; }
    const sm = summary(), all = cases(), vis = visible(all), sel = vis.filter(c => !S.off.has(c.x.ptid));
    const counts = {}; all.forEach(c => { counts[c.rule.id] = (counts[c.rule.id] || 0) + 1; });
    const cities = [...new Set(active().map(x => x.city).filter(Boolean))].sort(), docs = [...new Set(active().map(x => x.doctor).filter(Boolean))].sort();
    el.innerHTML = head + `
      <div class="dash-filters"><select id="dashCityF"><option value="">كل المدن</option>${cities.map(c => `<option ${S.city === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="dashDoctorF"><option value="">كل الأطباء</option>${docs.map(d => `<option ${S.doctor === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></div>
      <div class="dash-kpis">
        <div><b>${sm.a.length}</b><span>مريض نشط</span></div><div><b>${sm.plan}</b><span>DR Plan</span></div>
        <div><b>${sm.done}</b><span>DR Done</span></div><div><b>${pct(sm.done, sm.plan)}</b><span>الإنجاز</span></div>
        <div><b>${sm.nd}</b><span>Not Done</span></div><div><b>${sm.deact}</b><span>Deactive مستبعد</span></div></div>
      <details class="dash-box"><summary>الأطباء (${sm.docs.length})</summary><div class="dash-table"><table><thead><tr><th>الطبيب</th><th>مرضى</th><th>Plan</th><th>Done</th><th>إنجاز</th><th>Not Done</th></tr></thead><tbody>
        ${sm.docs.map(o => `<tr><td>${esc(o.doctor)}</td><td>${o.n}</td><td>${o.plan}</td><td>${o.done}</td><td>${pct(o.done, o.plan)}</td><td>${o.nd}</td></tr>`).join('')}</tbody></table></div></details>
      <details class="dash-box" ${S.rulesOpen ? 'open' : ''} id="dashRulesBox"><summary>قواعد التاسكات (سبب الإرسال) — تتزامن مع موقع التحليل</summary>
        ${RULES.map(b => { const r = rule(b.id); return `<div class="dash-rule ${r.on ? '' : 'off'}" data-rule="${b.id}">
          <label class="dash-rule-top"><input type="checkbox" data-k="on" ${r.on ? 'checked' : ''}><b>${esc(b.label)}</b><span class="dash-count">${counts[b.id] || 0}</span></label>
          <label>يُرسل إلى <input data-k="employee" value="${esc(r.employee)}" placeholder="فارغ = طبيب الحالة"><small>${esc(b.to)}</small></label>
          <label>العنوان <input data-k="title" maxlength="35" value="${esc(r.title)}"></label>
          <label>الرسالة <textarea data-k="message" rows="3">${esc(r.message)}</textarea></label></div>`; }).join('')}
        <div class="dash-hint">متغيرات: {DR_P} {DR_D} {NOTE} {DOCTOR} {PTID} · بلا طبيب ← <input id="dashFallback" value="${esc(fallback())}" size="5"> · <button class="btn-sm" id="dashReset">↩ افتراضي</button></div>
        <div class="dash-fields">${FIELDS.map(([k, l]) => `<label>${l}<input data-f="${k}" value="${esc((S.cfg.fields || {})[k] || '')}" placeholder="افتراضي iCare"></label>`).join('')}</div></details>
      <div class="dash-filters"><select id="dashReason"><option value="">كل الأسباب (${all.length})</option>${RULES.filter(b => rule(b.id).on).map(b => `<option value="${b.id}" ${S.reason === b.id ? 'selected' : ''}>${esc(b.label)} (${counts[b.id] || 0})</option>`).join('')}</select>
        <input id="dashQ" placeholder="بحث PTID / طبيب / ملاحظة" value="${esc(S.q)}">
        <button class="btn-sm" id="dashAll">الكل</button><button class="btn-sm" id="dashNone">لا شيء</button></div>
      <div class="dash-table dash-cases"><table><thead><tr><th></th><th>PTID</th><th>الطبيب</th><th>P/D</th><th>GP Note</th><th>يُرسل إلى</th><th>العنوان</th></tr></thead><tbody>
        ${vis.slice(0, 1000).map(c => `<tr class="${S.off.has(c.x.ptid) ? 'off' : ''}" title="${esc(c.message)}"><td><input type="checkbox" data-p="${esc(c.x.ptid)}" ${S.off.has(c.x.ptid) ? '' : 'checked'}></td><td>${esc(c.x.ptid)}</td><td>${esc(c.x.doctor || '—')}</td><td>${c.x.p}/${c.x.d}</td><td>${esc(c.x.note || '—')}</td><td><b>${esc(c.employee)}</b></td><td>${esc(c.title)}</td></tr>`).join('') || '<tr><td colspan="7">لا توجد حالات تنطبق عليها القواعد المفعّلة.</td></tr>'}
      </tbody></table></div>
      <button class="btn-primary dash-go" id="dashPrepare" ${sel.length ? '' : 'disabled'}>⚡ تجهيز ${sel.length} تاسك في تبويب التاسك</button>
      <div class="dash-hint">تُنقل القائمة إلى تبويب ⚡ تاسك (أسطر الرسالة تُدمج في سطر واحد)؛ هناك اضغط "تجربة" أو "تشغيل". الإضافة تطلب إذنك قبل إعادة الإرسال لملف أُرسل له سابقاً.</div>`;
  }

  async function load() {
    const { weeklyReport, weeklyTaskRules } = await chrome.storage.local.get(['weeklyReport', 'weeklyTaskRules']);
    S.cfg = (weeklyTaskRules && weeklyTaskRules.cfg) || {}; S.cfgAt = (weeklyTaskRules && weeklyTaskRules.at) || 0;
    if (weeklyReport && (!S.report || weeklyReport.at !== S.report.at)) {
      S.report = weeklyReport;
      try { S.rows = parseReport(weeklyReport); S.off.clear(); } catch (e) { S.rows = []; S.msg = e.message; }
    }
    render();
  }

  async function prepare() {
    const list = selected(); if (!list.length) return;
    const f = k => txt((S.cfg.fields || {})[k]);
    const aoa = [['PTID', 'Case Doctor', 'Status', 'Reason', 'Task Type', 'Task Priority', 'Task Category', 'Task Subcategory', 'Rule', 'Doctor', 'City', 'DR P (report)', 'DR D (report)', 'GP Note (report)'],
      ...list.map(c => [c.x.ptid, c.employee, c.title, c.message, f('type'), f('priority'), f('category'), f('subcategory'), c.rule.id, c.x.doctor, c.x.city, c.x.p, c.x.d, c.x.note])];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Tasks');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const name = `تاسكات التحليل الأسبوعي - ${new Date().toISOString().slice(0, 10)}.xlsx`;
    await loadImportFile(new File([buf], name, { lastModified: Date.now() }));
    switchToTab('quicktask');
    addLog('📊 جُهّز ' + list.length + ' تاسك من التحليل الأسبوعي — راجعها ثم اضغط تجربة أو تشغيل', 'info');
  }

  function setup() {
    const tabs = document.querySelector('.tabs'), panelAfter = $d('tab-quicktask');
    if (!tabs || !panelAfter || $d('tab-dash')) return;
    const b = document.createElement('button'); b.className = 'tab'; b.dataset.tab = 'dash'; b.innerHTML = '<i class="icon">📊</i> التحليل';
    tabs.insertBefore(b, tabs.firstChild);
    b.addEventListener('click', () => { switchToTab('dash'); chrome.storage.local.set({ popupLastTab: 'dash' }); load(); });
    const p = document.createElement('div'); p.className = 'tab-content active'; p.id = 'tab-dash'; b.classList.add('active'); panelAfter.before(p);
    const rr = () => { const y = p.scrollTop; render(); p.scrollTop = y; };
    p.addEventListener('change', async e => {
      const t = e.target, rid = t.closest('[data-rule]')?.dataset.rule;
      if (rid && t.dataset.k) { S.cfg.rules = S.cfg.rules || {}; S.cfg.rules[rid] = { ...(S.cfg.rules[rid] || {}), [t.dataset.k]: t.type === 'checkbox' ? t.checked : t.value }; S.rulesOpen = true; await saveCfg(); return rr(); }
      if (t.dataset.f) { S.cfg.fields = { ...(S.cfg.fields || {}), [t.dataset.f]: t.value.trim() }; return saveCfg(); }
      if (t.id === 'dashFallback') { S.cfg.fallback = t.value.trim(); await saveCfg(); return rr(); }
      if (t.dataset.p != null) { t.checked ? S.off.delete(t.dataset.p) : S.off.add(t.dataset.p); t.closest('tr').classList.toggle('off', !t.checked); const g = $d('dashPrepare'); g.textContent = `⚡ تجهيز ${selected().length} تاسك في تبويب التاسك`; g.disabled = !selected().length; return; }
      if (t.id === 'dashReason') { S.reason = t.value; return rr(); }
      if (t.id === 'dashCityF') { S.city = t.value; return rr(); }
      if (t.id === 'dashDoctorF') { S.doctor = t.value; return rr(); }
      if (t.id === 'dashMonth') S.month = t.value;
      if (t.classList.contains('dashCity')) S.cities = [...p.querySelectorAll('.dashCity:checked')].map(x => x.value);
      if (t.id === 'dashFile' && t.files[0]) {
        const file = t.files[0], bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const rep = { name: file.name, b64: btoa(bin), source: 'file', at: Date.now() };
        try { parseReport(rep); await chrome.storage.local.set({ weeklyReport: rep }); S.msg = ''; } catch (x) { S.msg = x.message; render(); }
      }
    });
    p.addEventListener('input', e => { if (e.target.id === 'dashQ') { clearTimeout(p._q); p._q = setTimeout(() => { S.q = e.target.value; rr(); const q = $d('dashQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 300); } });
    p.addEventListener('toggle', e => { if (e.target.id === 'dashRulesBox') S.rulesOpen = e.target.open; }, true);
    p.addEventListener('click', async e => {
      const id = e.target.id;
      if (id === 'dashPick') return $d('dashFile').click();
      if (id === 'dashFull') return chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1&tab=dash') });
      if (id === 'dashAll') { visible(cases()).forEach(c => S.off.delete(c.x.ptid)); return rr(); }
      if (id === 'dashNone') { visible(cases()).forEach(c => S.off.add(c.x.ptid)); return rr(); }
      if (id === 'dashReset') { if (confirm('إرجاع القواعد والحقول إلى القيم الافتراضية؟')) { S.cfg = {}; await saveCfg(); rr(); } return; }
      if (id === 'dashPrepare') return prepare();
      if (id === 'dashFetch') {
        const month = $d('dashMonth').value, cities = [...p.querySelectorAll('.dashCity:checked')].map(x => x.value);
        if (!cities.length) { S.msg = 'اختر مدينة واحدة على الأقل.'; return render(); }
        S.busy = true; S.msg = `⏳ جارٍ جلب تقرير ${month} من iCare… قد يستغرق دقيقة.`; render();
        const r = await chrome.runtime.sendMessage({ type: 'FCW_FETCH_PERFORMANCE', month, cities }).catch(() => ({ ok: false, code: 'EXTENSION_ERROR' }));
        S.busy = false;
        S.msg = r.ok ? `✅ ${r.rows.length} مريض (${Object.entries(r.counts).map(([c, n]) => `${CITIES[c] || c}: ${n}`).join(' | ')})` :
          ({ NO_TOKEN: 'لا توجد جلسة iCare — افتح iCare وسجّل الدخول.', TOKEN_EXPIRED: 'انتهت جلسة iCare — سجّل الدخول من جديد.', CITY_NOT_FOUND: 'لم توجد المدن في iCare.' }[r.code] || 'تعذّر الجلب: ' + r.code);
        return load();
      }
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.weeklyReport || ch.weeklyTaskRules)) { if ($d('tab-dash').classList.contains('active')) load(); } });
    const ver = ('extVersion'); if (ver) ver.textContent = 'v' + ((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '');
    load(); // always ready: it is the window's home tab
  }
  // loaded at the end of <body>: set up now, before popup.js picks the opening tab
  document.querySelector('.tabs') ? setup() : document.addEventListener('DOMContentLoaded', setup);
})();
