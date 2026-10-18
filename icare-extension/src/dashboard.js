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
  const S = { report: null, rows: [], cfg: {}, cfgAt: 0, reason: '', doctor: '', city: '', q: '', off: new Set(), busy: false, msg: '', sent: {}, showSent: false, daily: {}, autoFetch: true, hasToken: null, resume: null, run: null };
  // Custom rules ("filter + message"): checked before the default GP Note rules; first match wins.
  const STATUS = {
    notdone: ['Not Done (DR P > 0 و DR D = 0)', x => x.p > 0 && x.d === 0],
    partial: ['زيارة إضافية / جزئي (DR P > DR D ≥ 1)', x => x.d >= 1 && x.p - x.d >= 1],
    planned: ['له خطة طبيب (DR P > 0)', x => x.p > 0],
    all: ['كل الحالات', () => true],
  };
  const NOTE_MODES = { any: 'أي GP Note', empty: 'بدون GP Note', contains: 'GP Note يحتوي' };
  const customs = () => (Array.isArray(S.cfg.custom) ? S.cfg.custom : []);
  function customTest(c, x) {
    if (!(STATUS[c.status] || STATUS.notdone)[1](x)) return false;
    if (c.doctor && x.doctor !== c.doctor) return false;
    if (c.city && x.city !== c.city) return false;
    const n = (x.note || '').toLowerCase();
    if (c.noteMode === 'empty') return !n;
    if (c.noteMode === 'contains') { const parts = String(c.note || '').toLowerCase().split('|').map(s => s.trim()).filter(Boolean); return !parts.length || parts.some(p => n.includes(p)); }
    return true;
  }
  // One task per case: a PTID with a task recorded (sent / unconfirmed / maybe created) since the report month is not offered again.
  const reportMonth = () => (S.report && (S.report.month || (String(S.report.name || '').match(/(\d{4}-\d{2})/) || [])[1])) || new Date().toISOString().slice(0, 7);
  function sentEntry(ptid) {
    const m = reportMonth();
    const list = (S.sent[ptid] || []).filter(e => (!e.loop || e.loop === 'تاسك') && String(e.at || '').slice(0, 7) >= m);
    return list.length ? list[list.length - 1] : null;
  }

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
      const fillC = s => String(s || '').replace(/{DR_P}/g, x.p).replace(/{DR_D}/g, x.d).replace(/{NOTE}/g, x.note || '—')
        .replace(/{DOCTOR}/g, x.doctor || '—').replace(/{PTID}/g, x.ptid);
      const cr = customs().find(c => c.on !== false && customTest(c, x));
      if (cr) { out.push({ x, rule: { id: 'c:' + cr.id, label: '★ ' + (cr.name || 'قاعدة مخصصة') }, employee: txt(cr.employee) || x.doctor || fallback(), title: fillC(cr.title).slice(0, 35), message: fillC(cr.message), sent: sentEntry(x.ptid) }); return; }
      for (const base of RULES) {
        const r = rule(base.id);
        if (!r.on || !base.test(x)) continue;
        const fill = s => String(s || '').replace(/\{DR_P\}/g, x.p).replace(/\{DR_D\}/g, x.d).replace(/\{NOTE\}/g, x.note || '—')
          .replace(/\{DOCTOR\}/g, x.doctor || '—').replace(/\{PTID\}/g, x.ptid);
        out.push({ x, rule: base, employee: txt(r.employee) || x.doctor || fallback(), title: fill(r.title).slice(0, 35), message: fill(r.message), sent: sentEntry(x.ptid) });
        break;
      }
    });
    return out;
  }
  const visible = all => all.filter(c => (S.showSent || !c.sent) && (!S.reason || c.rule.id === S.reason) &&
    (!S.q || `${c.x.ptid} ${c.x.doctor} ${c.x.note}`.toLowerCase().includes(S.q.toLowerCase())));
  const selected = () => visible(cases()).filter(c => !c.sent && !S.off.has(c.x.ptid));

  function summary() {
    const a = scoped(), plan = a.reduce((s, x) => s + (x.d > 0 && x.p > x.d ? x.d : x.p), 0), done = a.reduce((s, x) => s + x.d, 0);
    const byDoc = new Map();
    a.forEach(x => { const k = x.doctor || '—'; const o = byDoc.get(k) || { doctor: k, n: 0, plan: 0, done: 0, nd: 0 };
      o.n++; o.plan += x.d > 0 && x.p > x.d ? x.d : x.p; o.done += x.d; if (x.p > 0 && x.d === 0) o.nd++; byDoc.set(k, o); });
    return { a, plan, done, nd: a.filter(x => x.p > 0 && x.d === 0).length, deact: S.rows.length - active().length,
      docs: [...byDoc.values()].sort((x, y) => y.n - x.n) };
  }

  const localDate = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const localDateOf = ms => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const timeOf = ms => new Date(ms).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
  const ERR_TXT = { NO_TOKEN: 'لا توجد جلسة iCare', TOKEN_EXPIRED: 'انتهت جلسة iCare', CITY_NOT_FOUND: 'لم توجد المدن في iCare', EMPTY: 'لا توجد حالات في التقرير', NETWORK: 'تعذّر الاتصال بـ iCare' };
  // Important alerts for the dashboard: freshness of the local copy, session, Not Done changes, pending work.
  function alerts() {
    const A = [], today = localDate(), rep = S.report, dl = S.daily || {}, how = rep && (rep.how === 'auto' ? 'جلب تلقائي' : rep.how === 'manual' ? 'جلب يدوي' : rep.source === 'site' ? 'من موقع التحليل' : 'من ملف');
    if (dl.lastError) A.push({ lv: 'err', t: '⛔ فشل آخر جلب: ' + (ERR_TXT[dl.lastError] || dl.lastError), act: 'fetch', actL: '📥 إعادة المحاولة' });
    if (!rep) A.push({ lv: 'warn', t: '⚠ لا يوجد تقرير محفوظ — اجلبه الآن.', act: 'fetch', actL: '📥 جلب الآن' });
    else if (localDateOf(rep.at) === today) A.push({ lv: 'ok', t: '✅ التقرير محدّث اليوم ' + timeOf(rep.at) + ' (' + how + ') — نسخة محلية محفوظة' });
    else A.push({ lv: 'warn', t: '⚠ آخر تقرير بتاريخ ' + localDateOf(rep.at) + ' (' + how + ') — لم يُجلب اليوم', act: 'fetch', actL: '📥 جلب الآن' });
    if (S.hasToken === false) A.push({ lv: 'warn', t: '🔐 لا توجد جلسة iCare — افتح iCare وسجّل الدخول لتفعيل الجلب (اليومي واليدوي).', act: 'icare', actL: 'فتح iCare' });
    if (!S.autoFetch) A.push({ lv: 'info', t: 'ℹ الجلب التلقائي اليومي متوقف (فعّله من الخانة أعلاه).' });
    if (S.run) A.push({ lv: 'info', t: '▶ تشغيل تاسكات جارٍ: ' + (S.run.currentIdx || 0) + ' / ' + ((S.run.ptids || []).length) + (S.run.paused ? ' (متوقف مؤقتاً)' : ''), act: 'queue', actL: 'متابعة' });
    if (S.resume && S.resume.items && S.resume.items.length) A.push({ lv: 'warn', t: '🔁 يوجد ' + S.resume.items.length + ' ملف متبقٍ لم يكتمل من آخر تشغيل (' + (S.resume.loopName || 'تاسك') + ')', act: 'queue', actL: 'إكمال المتبقي' });
    if (S.rows.length) {
      const sm = summary(), noNote = scoped().filter(x => x.p > 0 && x.d === 0 && !x.note).length, snaps = (S.daily && S.daily.snapshots) || [];
      let diff = '';
      if (snaps.length >= 2) {
        const cur = snaps[snaps.length - 1], prev = snaps[snaps.length - 2], ps = new Set(prev.ndPtids || []), cs = new Set(cur.ndPtids || []);
        const add = [...cs].filter(x => !ps.has(x)).length, gone = [...ps].filter(x => !cs.has(x)).length;
        diff = ' — منذ ' + prev.date + ': ' + (add ? '+' + add + ' جديدة' : 'لا جديد') + (gone ? '، ' + gone + ' انتهت' : '');
      }
      A.push({ lv: sm.nd ? 'warn' : 'ok', t: (sm.nd ? '📌 ' : '✅ ') + 'Not Done: ' + sm.nd + ' حالة' + diff });
      if (noNote) A.push({ lv: 'warn', t: '📝 ' + noNote + ' حالة Not Done بدون GP Note' });
      const low = sm.docs.filter(o => o.plan >= 10 && o.done / o.plan < 0.5).sort((a, b) => a.done / a.plan - b.done / b.plan).slice(0, 4);
      if (low.length) A.push({ lv: 'warn', t: '📉 إنجاز أقل من 50%: ' + low.map(o => o.doctor + ' (' + pct(o.done, o.plan) + ')').join('، ') });
      const all = cases(), ready = all.filter(c => !c.sent).length, sentN = all.length - ready;
      if (all.length) A.push({ lv: 'info', t: '📨 جاهز لفتح تاسك: ' + ready + ' حالة' + (sentN ? ' (أُرسل لـ ' + sentN + ' سابقاً)' : ''), act: ready ? 'cases' : '', actL: 'عرض' });
    }
    const order = { err: 0, warn: 1, info: 2, ok: 3 };
    return A.sort((a, b) => order[a.lv] - order[b.lv]);
  }
  const alertsHtml = () => { const A = alerts(); return A.length ? '<div class="dash-alerts">' + A.map(a => '<div class="dash-alert ' + a.lv + '"><span>' + esc(a.t) + '</span>' + (a.act ? '<button class="btn-sm" data-act="' + a.act + '">' + esc(a.actL) + '</button>' : '') + '</div>').join('') + '</div>' : ''; };
  // Key tables: by city, doctors with the most Not Done, last days trend (from the local daily copies).
  function tablesHtml(sm) {
    const byCity = new Map();
    sm.a.forEach(x => { const k = x.city || '—'; const o = byCity.get(k) || { c: k, n: 0, plan: 0, done: 0, nd: 0 }; o.n++; o.plan += x.d > 0 && x.p > x.d ? x.d : x.p; o.done += x.d; if (x.p > 0 && x.d === 0) o.nd++; byCity.set(k, o); });
    const top = sm.docs.filter(o => o.nd > 0).sort((a, b) => b.nd - a.nd).slice(0, 5), snaps = ((S.daily && S.daily.snapshots) || []).slice(-7).reverse();
    return '<details class="dash-box" open><summary>المدن</summary><div class="dash-table"><table><thead><tr><th>المدينة</th><th>مرضى</th><th>Plan</th><th>Done</th><th>إنجاز</th><th>Not Done</th></tr></thead><tbody>' +
      [...byCity.values()].sort((a, b) => b.n - a.n).map(o => '<tr><td>' + esc(o.c) + '</td><td>' + o.n + '</td><td>' + o.plan + '</td><td>' + o.done + '</td><td>' + pct(o.done, o.plan) + '</td><td>' + o.nd + '</td></tr>').join('') + '</tbody></table></div></details>' +
      (top.length ? '<details class="dash-box" open><summary>أعلى الأطباء في Not Done</summary><div class="dash-table"><table><thead><tr><th>الطبيب</th><th>Not Done</th><th>مرضى</th><th>إنجاز</th></tr></thead><tbody>' +
        top.map(o => '<tr><td>' + esc(o.doctor) + '</td><td><b>' + o.nd + '</b></td><td>' + o.n + '</td><td>' + pct(o.done, o.plan) + '</td></tr>').join('') + '</tbody></table></div></details>' : '') +
      (snaps.length ? '<details class="dash-box"><summary>الاتجاه اليومي (نسخ محلية: ' + snaps.length + ' يوم)</summary><div class="dash-table"><table><thead><tr><th>اليوم</th><th>نشط</th><th>Plan</th><th>Done</th><th>إنجاز</th><th>Not Done</th><th>بلا Note</th></tr></thead><tbody>' +
        snaps.map(o => '<tr><td>' + esc(o.date) + '</td><td>' + o.n + '</td><td>' + o.plan + '</td><td>' + o.done + '</td><td>' + pct(o.done, o.plan) + '</td><td>' + o.nd + '</td><td>' + o.noNote + '</td></tr>').join('') + '</tbody></table></div></details>' : '');
  }
  const sentDay = e => { try { return new Date(e.at).toLocaleDateString('ar-SA', { day: 'numeric', month: 'numeric' }); } catch (_) { return ''; } };
  function render() {
    const el = $d('tab-dash'); if (!el) return;
    const rep = S.report, thisMonth = new Date().toISOString().slice(0, 7);
    const head = `<div class="dash-src">
      <div class="dash-src-line">${rep ? `📗 <b>${esc(rep.name)}</b> <span class="dash-muted">— ${rep.source === 'icare' ? 'جُلب من iCare' : 'من موقع التحليل'} ${new Date(rep.at).toLocaleString('ar-SA')}</span>` : '<span class="dash-muted">لا يوجد تقرير بعد — اجلبه من iCare هنا، أو حمّله في موقع التحليل الأسبوعي فيصل تلقائياً.</span>'}</div>
      <div class="dash-fetch"><input type="month" id="dashMonth" value="${esc(S.month || thisMonth)}">
        ${Object.entries(CITIES).map(([k, v]) => `<label><input type="checkbox" class="dashCity" value="${k}" ${(S.cities || Object.keys(CITIES)).includes(k) ? 'checked' : ''}>${v}</label>`).join('')}
        <button class="btn-sm" id="dashFetch" ${S.busy ? 'disabled' : ''}>📥 جلب من iCare</button>
        <button class="btn-sm" id="dashPick">📂 ملف</button><input type="file" id="dashFile" accept=".xls,.xlsx,.html" hidden>
        ${document.body.classList.contains('full-page') ? '' : '<button class="btn-sm" id="dashFull" title="فتح هذه النافذة بصفحة كاملة">⤢ صفحة كاملة</button>'}
        <button class="btn-sm" id="dashSite" title="موقع التحليل الأسبوعي بكل التبويبات والتقارير">🌐 الداشبورد الكامل</button></div>
      <label class="dash-auto"><input type="checkbox" id="dashAuto" ${S.autoFetch ? 'checked' : ''}> 🔄 جلب تلقائي مرة يومياً (ونسخة محلية)</label>
      ${S.msg ? `<div class="dash-msg">${esc(S.msg)}</div>` : ''}</div>`;
    if (!S.rows.length) { el.innerHTML = head + alertsHtml(); return; }
    const sm = summary(), all = cases(), vis = visible(all), sel = vis.filter(c => !c.sent && !S.off.has(c.x.ptid)), sentN = all.filter(c => c.sent).length;
    const counts = {}; all.forEach(c => { counts[c.rule.id] = (counts[c.rule.id] || 0) + 1; });
    const cities = [...new Set(active().map(x => x.city).filter(Boolean))].sort(), docs = [...new Set(active().map(x => x.doctor).filter(Boolean))].sort();
    el.innerHTML = head + alertsHtml() + `
      <div class="dash-filters"><select id="dashCityF"><option value="">كل المدن</option>${cities.map(c => `<option ${S.city === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="dashDoctorF"><option value="">كل الأطباء</option>${docs.map(d => `<option ${S.doctor === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></div>
      <div class="dash-kpis">
        <div><b>${sm.a.length}</b><span>مريض نشط</span></div><div><b>${sm.plan}</b><span>DR Plan</span></div>
        <div><b>${sm.done}</b><span>DR Done</span></div><div><b>${pct(sm.done, sm.plan)}</b><span>الإنجاز</span></div>
        <div><b>${sm.nd}</b><span>Not Done</span></div><div><b>${sm.deact}</b><span>Deactive مستبعد</span></div></div>
      ${tablesHtml(sm)}
      <details class="dash-box"><summary>الأطباء (${sm.docs.length})</summary><div class="dash-table"><table><thead><tr><th>الطبيب</th><th>مرضى</th><th>Plan</th><th>Done</th><th>إنجاز</th><th>Not Done</th></tr></thead><tbody>
        ${sm.docs.map(o => `<tr><td>${esc(o.doctor)}</td><td>${o.n}</td><td>${o.plan}</td><td>${o.done}</td><td>${pct(o.done, o.plan)}</td><td>${o.nd}</td></tr>`).join('')}</tbody></table></div></details>
      <details class="dash-box" ${S.rulesOpen ? 'open' : ''} id="dashRulesBox"><summary>قواعد التاسكات (سبب الإرسال) — تتزامن مع موقع التحليل</summary>
        <div class="dash-sub">★ قواعد مخصصة — فلتر + رسالة خاصة (تُطبق قبل القواعد الافتراضية)</div>
        ${customs().map(c => `<div class="dash-rule dash-custom ${c.on === false ? 'off' : ''}" data-custom="${esc(c.id)}">
          <label class="dash-rule-top"><input type="checkbox" data-c="on" ${c.on === false ? '' : 'checked'}><input data-c="name" value="${esc(c.name || '')}" placeholder="اسم القاعدة"><span class="dash-count">${counts['c:' + c.id] || 0}</span><button class="btn-sm" data-del-custom="${esc(c.id)}" title="حذف">🗑</button></label>
          <div class="dash-grid2"><label>الحالة<select data-c="status">${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${(c.status || 'notdone') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>الطبيب<select data-c="doctor"><option value="">كل الأطباء</option>${docs.map(o => `<option ${c.doctor === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
          <label>المدينة<select data-c="city"><option value="">كل المدن</option>${cities.map(o => `<option ${c.city === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
          <label>GP Note<select data-c="noteMode">${Object.entries(NOTE_MODES).map(([k, l]) => `<option value="${k}" ${(c.noteMode || 'any') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
          ${c.noteMode === 'contains' ? `<label>النص (أكثر من كلمة: افصل بـ |)<input data-c="note" value="${esc(c.note || '')}" placeholder="مثال: refused|رفض"></label>` : ''}
          <label>يُرسل إلى <input data-c="employee" value="${esc(c.employee || '')}" placeholder="فارغ = طبيب الحالة"></label>
          <label>العنوان <input data-c="title" maxlength="35" value="${esc(c.title || '')}"></label>
          <label>الرسالة <textarea data-c="message" rows="3">${esc(c.message || '')}</textarea></label></div>`).join('')}
        <div class="btn-row"><button class="btn-sm" id="dashAddCustom">➕ قاعدة مخصصة</button><button class="btn-sm" id="dashAddFromFilter" title="تأخذ المدينة والطبيب من الفلتر الحالي">➕ من الفلتر الحالي</button></div>
        <div class="dash-sub">القواعد الافتراضية (GP Note)</div>
        ${RULES.map(b => { const r = rule(b.id); return `<div class="dash-rule ${r.on ? '' : 'off'}" data-rule="${b.id}">
          <label class="dash-rule-top"><input type="checkbox" data-k="on" ${r.on ? 'checked' : ''}><b>${esc(b.label)}</b><span class="dash-count">${counts[b.id] || 0}</span></label>
          <label>يُرسل إلى <input data-k="employee" value="${esc(r.employee)}" placeholder="فارغ = طبيب الحالة"><small>${esc(b.to)}</small></label>
          <label>العنوان <input data-k="title" maxlength="35" value="${esc(r.title)}"></label>
          <label>الرسالة <textarea data-k="message" rows="3">${esc(r.message)}</textarea></label></div>`; }).join('')}
        <div class="dash-hint">متغيرات: {DR_P} {DR_D} {NOTE} {DOCTOR} {PTID} · بلا طبيب ← <input id="dashFallback" value="${esc(fallback())}" size="5"> · <button class="btn-sm" id="dashReset">↩ افتراضي</button></div>
        <div class="dash-fields">${FIELDS.map(([k, l]) => `<label>${l}<input data-f="${k}" value="${esc((S.cfg.fields || {})[k] || '')}" placeholder="افتراضي iCare"></label>`).join('')}</div></details>
      <div class="dash-filters"><select id="dashReason"><option value="">كل الأسباب (${all.length})</option>${customs().filter(c => c.on !== false).map(c => `<option value="c:${esc(c.id)}" ${S.reason === 'c:' + c.id ? 'selected' : ''}>★ ${esc(c.name || 'قاعدة مخصصة')} (${counts['c:' + c.id] || 0})</option>`).join('')}${RULES.filter(b => rule(b.id).on).map(b => `<option value="${b.id}" ${S.reason === b.id ? 'selected' : ''}>${esc(b.label)} (${counts[b.id] || 0})</option>`).join('')}</select>
        <input id="dashQ" placeholder="بحث PTID / طبيب / ملاحظة" value="${esc(S.q)}">
        <button class="btn-sm" id="dashAll">الكل</button><button class="btn-sm" id="dashNone">لا شيء</button></div>
      <div class="dash-sent">✓ أُرسل لها تاسك منذ ${esc(reportMonth())}: <b>${sentN}</b> حالة — لا تُرسل مرة أخرى · <label><input type="checkbox" id="dashShowSent" ${S.showSent ? 'checked' : ''}> إظهارها</label></div>
      <div class="dash-table dash-cases"><table><thead><tr><th></th><th>PTID</th><th>الطبيب</th><th>P/D</th><th>GP Note</th><th>يُرسل إلى</th><th>العنوان</th></tr></thead><tbody>
        ${vis.slice(0, 1000).map(c => `<tr class="${c.sent ? 'sent' : S.off.has(c.x.ptid) ? 'off' : ''}" title="${esc(c.message)}"><td>${c.sent ? `<span class="dash-sent-mark" title="${esc((c.sent.title || '') + ' → ' + (c.sent.employee || ''))}">✓ ${sentDay(c.sent)}</span>` : `<input type="checkbox" data-p="${esc(c.x.ptid)}" ${S.off.has(c.x.ptid) ? '' : 'checked'}>`}</td><td>${esc(c.x.ptid)}</td><td>${esc(c.x.doctor || '—')}</td><td>${c.x.p}/${c.x.d}</td><td>${esc(c.x.note || '—')}</td><td><b>${esc(c.employee)}</b></td><td>${esc(c.title)}</td></tr>`).join('') || '<tr><td colspan="7">لا توجد حالات تنطبق عليها القواعد المفعّلة.</td></tr>'}
      </tbody></table></div>
      <button class="btn-primary dash-go" id="dashPrepare" ${sel.length ? '' : 'disabled'}>⚡ تجهيز ${sel.length} تاسك في تبويب التاسك</button>
      <div class="dash-hint">تُنقل القائمة إلى تبويب ⚡ تاسك (أسطر الرسالة تُدمج في سطر واحد)؛ هناك اضغط "تجربة" أو "تشغيل". كل حالة يُفتح لها تاسك مرة واحدة: بعد التشغيل تُسجل في سجل الإرسال وتظهر هنا «✓ أُرسل» ولا تُعرض للإرسال مرة أخرى (لإعادة الإرسال احذفها من السجل في تبويب 📋 سجل).</div>`;
  }

  async function load() {
    const { weeklyReport, weeklyTaskRules, sentHistory, weeklyDaily, weeklyAutoFetch, resumeQueue } = await chrome.storage.local.get(['weeklyReport', 'weeklyTaskRules', 'sentHistory', 'weeklyDaily', 'weeklyAutoFetch', 'resumeQueue']);
    S.sent = sentHistory || {}; S.daily = weeklyDaily || {}; S.autoFetch = weeklyAutoFetch !== false; S.resume = resumeQueue || null;
    const [stt, rs] = await Promise.all([chrome.runtime.sendMessage({ type: 'FCW_STATUS' }).catch(() => null), chrome.runtime.sendMessage({ action: 'BG_GET_RUN_STATE' }).catch(() => null)]);
    S.hasToken = stt && typeof stt.hasToken === 'boolean' ? stt.hasToken : null; S.run = rs && rs.state && rs.state.running ? rs.state : null;
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
      const cid = t.closest('[data-custom]')?.dataset.custom;
      if (cid && t.dataset.c) { const c = customs().find(x => x.id === cid); if (c) { c[t.dataset.c] = t.type === 'checkbox' ? t.checked : t.value; S.rulesOpen = true; await saveCfg(); } return rr(); }
      if (t.id === 'dashAuto') { S.autoFetch = t.checked; await chrome.storage.local.set({ weeklyAutoFetch: t.checked }); return rr(); }
      if (t.id === 'dashShowSent') { S.showSent = t.checked; return rr(); }
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
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'fetch') return $d('dashFetch')?.click();
      if (act === 'icare') return chrome.tabs.create({ url: 'https://icare.com.sa/performance-follow-up/report' });
      if (act === 'queue') return switchToTab('quicktask');
      if (act === 'cases') return $d('dashPrepare')?.scrollIntoView({ block: 'center' });
      if (id === 'dashPick') return $d('dashFile').click();
      if (id === 'dashFull') return chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1&tab=dash') });
      if (id === 'dashSite') return chrome.tabs.create({ url: 'https://weeklyanalysisfuturecare.netlify.app/' });
      if (id === 'dashAll') { visible(cases()).forEach(c => S.off.delete(c.x.ptid)); return rr(); }
      if (id === 'dashNone') { visible(cases()).forEach(c => S.off.add(c.x.ptid)); return rr(); }
      if (id === 'dashReset') { if (confirm('إرجاع القواعد والحقول إلى القيم الافتراضية؟')) { S.cfg = {}; await saveCfg(); rr(); } return; }
      if (id === 'dashPrepare') return prepare();
      if (id === 'dashAddCustom' || id === 'dashAddFromFilter') {
        const fromF = id === 'dashAddFromFilter';
        S.cfg.custom = [...customs(), { id: Date.now().toString(36), on: true, name: fromF ? [S.doctor, S.city].filter(Boolean).join(' / ') || 'قاعدة مخصصة' : 'قاعدة مخصصة',
          status: 'notdone', doctor: fromF ? S.doctor : '', city: fromF ? S.city : '', noteMode: 'any', note: '', employee: '', title: 'متابعة زيارة الطبيب',
          message: 'زيارة الطبيب مخططة ({DR_P}) والمنفذ ({DR_D}). GP Note: {NOTE}. الرجاء المتابعة واتخاذ اللازم.' }];
        S.rulesOpen = true; await saveCfg(); return rr();
      }
      const del = e.target.closest('[data-del-custom]');
      if (del) { if (confirm('حذف هذه القاعدة المخصصة؟')) { S.cfg.custom = customs().filter(c => c.id !== del.dataset.delCustom); await saveCfg(); rr(); } return; }
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
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.weeklyReport || ch.weeklyTaskRules || ch.sentHistory || ch.weeklyDaily || ch.weeklyAutoFetch || ch.resumeQueue)) { if ($d('tab-dash').classList.contains('active')) load(); } });
    const ver = ('extVersion'); if (ver) ver.textContent = 'v' + ((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '');
    load(); // always ready: it is the window's home tab
  }
  // loaded at the end of <body>: set up now, before popup.js picks the opening tab
  document.querySelector('.tabs') ? setup() : document.addEventListener('DOMContentLoaded', setup);
})();
