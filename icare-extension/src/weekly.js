// FutureCare Weekly — performance report fetch + hand-over to the task window (loaded by src/background.js).
(() => {
// FutureCare Weekly — iCare Reports (service worker).
// Holds the iCare session token (memory only) and fetches the Performance Follow-up report for the
// weekly analysis site. Only the origins in PAGE_ORIGINS may ask for data.

const API_BASE = 'https://api.fc.med.sa/api';
const ICARE_HEADERS = { 'x-icare-client': 'web/2316', 'x-icare-frontend-host': 'icare.com.sa', Accept: 'application/json' };
const PAGE_ORIGINS = ['https://weeklyanalysisfuturecare.netlify.app', 'http://localhost:5177'];
const ICARE_ORIGIN = 'https://icare.com.sa';

const originOf = url => { try{ return new URL(url).origin; }catch(e){ return ''; } };

async function getToken(){
  const s = await chrome.storage.session.get(['icareToken', 'tokenAt', 'icareBuild']);
  return { token: s.icareToken || '', at: s.tokenAt || 0, build: s.icareBuild || '' };
}

// iCare sends its current build number with every request; use the one read from the open iCare page.
async function headersWith(token){
  const { build } = await getToken();
  return { ...ICARE_HEADERS, ...(build ? { 'x-icare-client': 'web/' + build } : {}), Authorization: 'Bearer ' + token };
}

async function icareGet(path){
  const { token } = await getToken();
  if(!token) throw Object.assign(new Error(), { code: 'NO_TOKEN' });
  const r = await fetch(API_BASE + path, { headers: await headersWith(token), credentials: 'omit' });
  if(r.status === 401 || r.status === 403){ await chrome.storage.session.remove(['icareToken', 'tokenAt']); throw Object.assign(new Error(), { code: 'TOKEN_EXPIRED' }); }
  if(!r.ok) throw Object.assign(new Error(), { code: 'HTTP_' + r.status });
  return r.json();
}

// ── Performance Follow-up report (icare.com.sa/performance-follow-up/report) ──────────────────────
// Same API calls and the same columns as iCare's own "performance-report_<month>_all" export, limited
// to the requested cities. Rows go only to the requesting FutureCare page (kept in memory there).
const PERF_CITY_ALIASES = {
  Jeddah: /^jed$|jedd?ah|jidd?ah|جد[ةه]/i,   // iCare uses city codes (JED, MKK, YNB)
  Makkah: /^mkk$|makk?ah|mecc?a|مك[ةه]/i,
  Yanbu: /^ynb$|yanbu|ينبع/i,
};
const PERF_HEADERS = 'S/N,Status,App.N#,Approval Status,Monthly Approvals,PTID,Patient Name,Doctor Name,Ins.,Company,Group,City,NU P,NU D,RTP (NU),Short (NU),PT P,PT D,RTP (PT),Short (PT),DR P,DR D,RTP (DR),Short (DR),LAB P,LAB D,Short (LAB),IV P,IV D,Short (IV),SPE P,SPE D,Short (SPE),Dialysis P,Dialysis D,Speech P,Speech D,ABA P,ABA D,RT P,RT D,OT P,OT D,Dressing W.IV,VAC P,VAC D,VAC Rent,Vaccination P,Vaccination D,V. Call P,V. Call D,PT_Before,NU_Before,Last HARP Score,Hospital Admissions (Month),Mobility,Last Visit,NU Note,PT Note,GP Note,IV Note,Dressing Note,Dialysis Note'.split(',');
const firstNote = v => v ? (String(v).split('||')[0] || '') : '';
function perfRow(e, sn){
  const p = e.plan || {}, d = e.done || {}, n = v => v ?? 0, s = k => (e.short && e.short[k]) ?? '';
  const abe = e.approval_below_executed || {}, notes = e.notes || {};
  const status = e.patient_status === 'De-Active' ? 'De-Active' : e.in_out === 'Hospital' ? 'Hospital' : e.in_out === 'Traveler' ? 'Traveler' : 'Active';
  const w = String(e.waseel_status ?? '').toLowerCase();
  const appr = w.includes('approv') ? 'Approved' : w === 'partial' ? 'Partial' : w === 'rejected' ? 'Rejected' : (w === '0' || w === 'pended') ? 'Pending' : (w || 'No Primary');
  return [sn, status, e.approval_number || '', appr, e.monthly_approvals === undefined ? '' : e.monthly_approvals.length,
    e.patient_id, `${e.patient_name || ''}${e.cit_iqama_no ? ' - ' + e.cit_iqama_no : ''}`, e.doctor_name || '#N/A', e.insurance_name || '#N/A',
    e.company_name || '#N/A', e.gen_manager || '', e.city || '#N/A',
    `${n(p.nu)}${abe.nu ? ' ⚠' : ''}`, n(d.Nur), n(e.nu_for_next), s('Nur'),
    `${n(p.pt)}${abe.pt ? ' ⚠' : ''}`, n(d.PT), n(e.pt_for_next), s('PT'),
    n(p.dr), n(d.Dr), n(e.dr_for_next), s('Dr'),
    n(p.lab), n(d.LAB), s('LAB'),
    `${n(p.IV)}${abe.iv ? ' ⚠' : ''}`, n(d.IV), s('IV'),
    n(p.SPE), n(d.SPE), s('SPE'), n(p.Dialysis), n(d.Dialysis), n(p.Speech), n(d.Speech), n(p.ABA), n(d.ABA),
    n(p.RT), n(d.RT), n(p.OT), n(d.OT), n(d.DressingWithIV), n(p.VAC), n(d.VAC), n(e.vac_rent),
    n(p.Vaccination), n(d.Vaccination), n(p.VCall), n(d.VCall), n(e.pt_store), n(e.nu_store),
    e.harp_score === '' || e.harp_score == null ? '#' : e.harp_score, n(e.hospital_admissions), e.mobility_status || '', e.last_visit || '#NA',
    firstNote(notes.nu), firstNote(notes.pt), firstNote(notes.gp), firstNote(notes.iv), firstNote(notes.dressing), firstNote(notes.dialysis)];
}

async function fetchPerformance({ month, cities }){
  if(!/^\d{4}-\d{2}$/.test(month || '')) return { ok: false, code: 'BAD_MONTH' };
  const wanted = (Array.isArray(cities) && cities.length ? cities : Object.keys(PERF_CITY_ALIASES)).filter(c => PERF_CITY_ALIASES[c]);
  try{
    const fo = await icareGet('/performance-follow-up/filter-options');
    const available = ((fo.options && fo.options.cities) || []).map(String);
    const matched = {}, missing = [];
    for(const c of wanted){
      const names = available.filter(a => PERF_CITY_ALIASES[c].test(a));
      if(names.length) matched[c] = names; else missing.push(c);
    }
    if(!Object.keys(matched).length) return { ok: false, code: 'CITY_NOT_FOUND', available };
    const seen = new Set(), all = [], counts = {};
    for(const [c, names] of Object.entries(matched)){
      counts[c] = 0;
      for(const city of names){
        const q = new URLSearchParams({ month, city }).toString();
        const plan = await icareGet(`/performance-follow-up/report-plan?${q}`);
        const ids = Array.isArray(plan.ids) ? plan.ids : [];
        const chunks = [];
        if(!ids.length) chunks.push(await icareGet(`/performance-follow-up/report?${q}`));
        const size = Math.max(50, Math.min(Number(plan.chunk_max) || 200, 200));
        for(let i = 0; i < ids.length; i += size) chunks.push(await icareGet(`/performance-follow-up/report?${q}&ids=${ids.slice(i, i + size).join(',')}`));
        for(const j of chunks) for(const r of (j.rows || [])){
          const id = String(r.patient_id ?? '');
          if(!id || seen.has(id)) continue;
          seen.add(id); all.push(r); counts[c]++;
        }
      }
    }
    return { ok: true, month, matched, missing, counts, headers: PERF_HEADERS, rows: all.map((r, i) => perfRow(r, i + 1)), snap: snapshotOf(all, month), fetchedAt: new Date().toISOString() };
  } catch(e){
    return { ok: false, code: e.code || 'NETWORK' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const from = originOf(sender.url || (sender.tab && sender.tab.url) || '');
  if(msg && msg.type === 'ICARE_TOKEN'){
    if(from !== ICARE_ORIGIN) return;  // only iCare pages may set the token
    const build = /^\d{1,6}$/.test(String(msg.build || '')) ? String(msg.build) : '';
    (msg.token
      ? chrome.storage.session.set({ icareToken: msg.token, tokenAt: Date.now(), ...(build ? { icareBuild: build } : {}) })
      : chrome.storage.session.remove(['icareToken', 'tokenAt'])).then(() => { sendResponse({ ok: true }); if(msg.token) setTimeout(dailyCheck, 2500); });
    return true;
  }
  if(msg && msg.type === 'FCW_STATUS'){
    if(!PAGE_ORIGINS.includes(from) && sender.id !== chrome.runtime.id) return;
    Promise.all([getToken(), chrome.storage.local.get(['weeklyLocal', 'weeklyDaily', 'weeklyNew'])]).then(([t, { weeklyLocal: w, weeklyDaily: d, weeklyNew: nw }]) => sendResponse({ ok: true, hasToken: !!t.token, tokenAt: t.at, version: chrome.runtime.getManifest().version, tasks: true, sentApi: 1,
      localAt: w ? w.at : 0, newAt: nw ? nw.at : 0, newApi: 1, localHow: (d && d.lastHow) || (w && w.how) || '' }));
    return true;
  }
  // The weekly site hands over its current report: the task window opens with it imported, for review.
  // Nothing is sent to iCare until the user starts the run there.
  if(msg && msg.type === 'FCW_OPEN_TASKS'){
    if(!PAGE_ORIGINS.includes(from)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    const name = String(msg.name || 'report.xls').replace(/\.html?$/i, '.xls').slice(0, 120);
    const b64 = String(msg.b64 || '');
    if(!b64 || b64.length > 40e6) { sendResponse({ ok: false, code: 'BAD_FILE' }); return; }
    chrome.storage.local.set({ pendingAppImport: { name, b64, at: Date.now() } })
      .then(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?full=1&fromApp=1') }))
      .then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, code: 'EXTENSION_ERROR', error: e.message }));
    return true;
  }
  if(msg && msg.type === 'FCW_FETCH_PERFORMANCE'){
    if(!PAGE_ORIGINS.includes(from) && !fromExtensionPage(sender)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    fetchPerformance(msg).then(async r => {
      if(r.ok && r.rows.length) await recordFetch(r, 'manual');
      const { snap, ...rest } = r; // the snapshot stays inside the extension
      sendResponse(rest);
    });
    return true;
  }
  // Sync with the weekly site: the report loaded there (fetched or uploaded) and the task rules.
  // Read-only: which of these PTIDs already got a task (from the extension's send log). Used by the site to
  // show "✓ sent" and keep one task per case. The site cannot create or change anything here.
  if(msg && msg.type === 'FCW_SENT'){
    if(!PAGE_ORIGINS.includes(from)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    const ptids = (Array.isArray(msg.ptids) ? msg.ptids : []).slice(0, 5000).map(x => String(x).slice(0, 20));
    const month = /^\d{4}-\d{2}$/.test(String(msg.month || '')) ? String(msg.month) : '';
    chrome.storage.local.get('sentHistory').then(({ sentHistory = {} }) => {
      const sent = {};
      for(const p of ptids){
        const l = (sentHistory[p] || []).filter(e => (!e.loop || e.loop === 'تاسك') && (!month || String(e.at || '').slice(0, 7) >= month));
        if(l.length){ const e = l[l.length - 1]; sent[p] = { at: e.at, employee: e.employee || '', title: e.title || '', state: e.state || '' }; }
      }
      sendResponse({ ok: true, sent });
    });
    return true;
  }
  // The latest local copy (daily fetch or last manual fetch) so the site can load it without fetching again.
  if(msg && msg.type === 'FCW_GET_REPORT'){
    if(!PAGE_ORIGINS.includes(from)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    chrome.storage.local.get(['weeklyLocal', 'weeklyDaily']).then(({ weeklyLocal: w, weeklyDaily: d }) => {
      if(!w) return sendResponse({ ok: false, code: 'NO_LOCAL_COPY' });
      sendResponse({ ok: true, name: w.name, b64: w.b64, at: w.at, how: (d && d.lastHow) || w.how || '', month: w.month || '' });
    });
    return true;
  }
  // New patients: fetch now (page or extension window) / the saved local copy.
  if(msg && msg.type === 'FCW_FETCH_NEW'){
    if(!PAGE_ORIGINS.includes(from) && !fromExtensionPage(sender)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    fetchNewFiles().then(async n => { if(n.ok) await recordNew(n, 'manual'); sendResponse(n); });
    return true;
  }
  if(msg && msg.type === 'FCW_GET_NEW'){
    if(!PAGE_ORIGINS.includes(from) && !fromExtensionPage(sender)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    chrome.storage.local.get('weeklyNew').then(({ weeklyNew: w }) => sendResponse(w ? { ok: true, rows: w.rows, months: w.months, total: w.total, perf: w.perf || null, how: w.how || '', at: w.at } : { ok: false, code: 'NO_LOCAL_COPY' }));
    return true;
  }
  if(msg && msg.type === 'FCW_SYNC_REPORT'){
    if(!PAGE_ORIGINS.includes(from)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    const b64 = String(msg.b64 || '');
    if(!b64 || b64.length > 40e6) { sendResponse({ ok: false, code: 'BAD_FILE' }); return; }
    keepReport({ name: String(msg.name || 'report.xls').slice(0, 120), b64, source: 'site' }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if(msg && msg.type === 'FCW_SYNC_RULES'){
    if(!PAGE_ORIGINS.includes(from)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    syncRules(msg).then(sendResponse);
    return true;
  }
});

// ── New patients (icare.com.sa/new-file?cdm_siss=non_cdm) ────────────────────────────────────────────
// Same call the page makes (GET /new-file with start/end and cdm_siss=non_cdm, 500 per page), limited to the previous
// and the current month. Only analysis fields are kept (no name, mobile or national ID).
const ymOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const ymdOf = d => ymOf(d) + '-' + String(d.getDate()).padStart(2, '0');
const cut = (v, n) => (v == null ? '' : String(v).slice(0, n));
const monthOfDate = v => { const t = String(v || ''); let m = t.match(/^(\d{4})-(\d{2})/); if(m) return m[1] + '-' + m[2]; m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/); return m ? m[3] + '-' + m[2].padStart(2, '0') : ''; };
function compactNew(e){
  return { id: e.id, ptid: cut(e.patient_id, 20), doc: cut(e.doctor_name, 80), city: cut(e.city, 40), region: cut(e.location_region, 60), proj: cut(e.project, 60), cdm: cut(e.cdm_type, 20),
    comp: cut(e.company_name, 80), ins: cut(e.insurance_name, 80), st: cut(e.status_label, 60), la: cut(e.last_action, 80), lat: cut(e.last_action_time, 25),
    cr: cut(e.created_at, 25), fa: cut(e.first_action, 25), vip: Number(e.top_vip) || 0, ref: e.is_referral ? 1 : 0, rs: cut(e.referral_source, 60),
    appr: e.approval_no ? 1 : 0, app: cut(e.app_date, 25), pt: cut(e.pt_date, 25), lab: cut(e.lab_date, 25), nur: cut(e.nursing_date, 25), grp: cut(e.group_name, 60),
    reg: cut(e.register_date, 25), cs: Number(e.csheet_count) || 0, pn: Number(e.prescription_count) || 0, dup: Number(e.mobile_dup_count) > 0 ? 1 : 0,
    vt: cut(e.dr_type, 30), rt: cut(e.record_type, 20), act: e.patient_active == null ? '' : (e.patient_active ? 'Active' : 'De-Active') };
}
// Compact, identity-free performance data (status, services P/D, GP note) of the new patients, for the file-open months.
// Used by the dashboard to explain every new case; names, mobiles and IDs are never included.
const nzObj = o => { const r = {}; for(const [k, v] of Object.entries(o || {})) if(Number(v)) r[k] = Number(v); return r; };
async function perfLite(months, ptids){
  const fo = await icareGet('/performance-follow-up/filter-options');
  const names = ((fo.options && fo.options.cities) || []).map(String).filter(a => Object.values(PERF_CITY_ALIASES).some(re => re.test(a)));
  const out = {};
  for(const month of months){
    const m = out[month] = {};
    for(const city of names){
      const q = new URLSearchParams({ month, city }).toString();
      const plan = await icareGet('/performance-follow-up/report-plan?' + q);
      const ids = Array.isArray(plan.ids) ? plan.ids : [];
      const chunks = [];
      if(!ids.length) chunks.push(await icareGet('/performance-follow-up/report?' + q));
      const size = Math.max(50, Math.min(Number(plan.chunk_max) || 200, 200));
      for(let i = 0; i < ids.length; i += size) chunks.push(await icareGet('/performance-follow-up/report?' + q + '&ids=' + ids.slice(i, i + size).join(',')));
      for(const j of chunks) for(const r of (j.rows || [])){
        const id = String(r.patient_id ?? '');
        if(!id || !ptids.has(id) || m[id]) continue;
        const st = r.patient_status === 'De-Active' ? 'De-Active' : r.in_out === 'Hospital' ? 'Hospital' : r.in_out === 'Traveler' ? 'Traveler' : 'Active';
        m[id] = { st, p: nzObj(r.plan), d: nzObj(r.done), gp: firstNote(r.notes && r.notes.gp).slice(0, 80), lv: String(r.last_visit || '').slice(0, 10), adm: Number(r.hospital_admissions) || 0, doc: String(r.doctor_name || '').slice(0, 80), city: String(r.city || '').slice(0, 20) };
      }
    }
  }
  return out;
}
async function fetchNewFiles(){
  const now = new Date(), prev = ymOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)), cur = ymOf(now);
  // orders created up to two months before the previous month can still be opened in it, so fetch from 3 months back
  const start = ymdOf(new Date(now.getFullYear(), now.getMonth() - 3, 1)), end = ymdOf(new Date(now.getTime() + 86400000));
  try{
    const rows = [], seen = new Set(); let total = 0;
    for(let page = 1; page <= 40; page++){
      const q = new URLSearchParams({ page: String(page), page_size: '500', start, end, cdm_siss: 'non_cdm' }).toString();
      const j = await icareGet('/new-file?' + q);
      const items = Array.isArray(j.items) ? j.items : [];
      total = Number(j.total) || total;
      for(const e of items){ const id = String(e.id); if(!seen.has(id)){ seen.add(id); rows.push(compactNew(e)); } }
      if(!items.length || (total && rows.length >= total)) break;
    }
    // a file belongs to the month its file was OPENED (File Open Time); an order not opened yet belongs to its creation month
    const keep = rows.filter(x => { const m = monthOfDate(x.reg) || monthOfDate(x.cr); return m >= prev && m <= cur; });
    // performance data of the same months for the new patients (a failure here must not lose the new-patients list)
    let perf = null, perfCode = '';
    try{ perf = await perfLite([prev, cur], new Set(keep.map(x => String(x.ptid)))); }catch(e){ perfCode = e.code || 'NETWORK'; }
    return { ok: true, months: [prev, cur], total: keep.length, rows: keep, perf, perfCode, fetchedAt: new Date().toISOString() };
  } catch(e){
    return { ok: false, code: e.code || 'NETWORK' };
  }
}
async function recordNew(n, how){
  await chrome.storage.local.set({ weeklyNew: { rows: n.rows, months: n.months, total: n.total, perf: n.perf || null, how, date: localDate(), at: Date.now() } });
}

// ── Daily fetch + local copies ─────────────────────────────────────────────────────────────────────
// Once per day (needs an iCare session, so it also fires when an iCare tab provides the token) the current
// month's report for Jeddah, Makkah and Yanbu is fetched and kept locally (weeklyReport = latest file,
// weeklyDaily.snapshots = compact copy of the last 14 days used for alerts and trends). Manual fetches count too.
const localDate = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
function snapshotOf(raw, month){
  const act = raw.filter(r => !/de-?active|inactive/i.test(String(r.patient_status || '')));
  const snap = { date: localDate(), at: new Date().toISOString(), month, n: act.length, plan: 0, done: 0, nd: 0, noNote: 0, byDoc: {}, byCity: {}, ndPtids: [] };
  for(const r of act){
    const p = Number((r.plan && r.plan.dr) || 0), d = Number((r.done && r.done.Dr) || 0), eff = d > 0 && p > d ? d : p;
    const doc = String(r.doctor_name || '').trim() || '—', city = String(r.city || '').trim() || '—', nd = p > 0 && d === 0;
    snap.plan += eff; snap.done += d;
    if(nd){ snap.nd++; snap.ndPtids.push(String(r.patient_id)); if(!firstNote(r.notes && r.notes.gp)) snap.noNote++; }
    for(const [m, k] of [[snap.byDoc, doc], [snap.byCity, city]]){
      const o = m[k] || (m[k] = { n: 0, plan: 0, done: 0, nd: 0 });
      o.n++; o.plan += eff; o.done += d; if(nd) o.nd++;
    }
  }
  return snap;
}
async function recordFetch(r, how){
  const rep = { name: `performance-report_${r.month}_${Object.keys(r.counts).join('-')}.xls`, b64: reportB64(r), source: 'icare', month: r.month, counts: r.counts, how, at: Date.now() };
  // weeklyReport = the report the dashboard works on; weeklyLocal = the latest iCare copy (never replaced by a file loaded by hand)
  await chrome.storage.local.set({ weeklyReport: rep, weeklyLocal: rep });
  const { weeklyDaily: d = {} } = await chrome.storage.local.get('weeklyDaily');
  const snaps = (d.snapshots || []).filter(x => x.date !== r.snap.date);
  snaps.push(r.snap); snaps.sort((a, b) => (a.date < b.date ? -1 : 1));
  await chrome.storage.local.set({ weeklyDaily: { ...d, lastDate: r.snap.date, lastAt: r.snap.at, lastHow: how, lastError: '', lastErrorAt: '', snapshots: snaps.slice(-14) } });
}
let dailyRunning = false;
async function dailyCheck(){
  if(dailyRunning) return;
  const st = await chrome.storage.local.get(['weeklyAutoFetch', 'weeklyDaily', 'weeklyNew']);
  if(st.weeklyAutoFetch === false) return;
  const d = st.weeklyDaily || {}, today = localDate();
  const needPerf = d.lastDate !== today, needNew = !st.weeklyNew || st.weeklyNew.date !== today;
  if(!needPerf && !needNew) return;
  if(d.lastErrorAt && Date.now() - Date.parse(d.lastErrorAt) < 55 * 60 * 1000) return; // do not hammer iCare after a failure
  const { token } = await getToken();
  if(!token) return; // waits for an iCare tab (the token arrives with it)
  dailyRunning = true;
  try{
    if(needPerf){
      const r = await fetchPerformance({ month: today.slice(0, 7), cities: Object.keys(PERF_CITY_ALIASES) });
      if(r.ok && r.rows.length) await recordFetch(r, 'auto');
      else { await chrome.storage.local.set({ weeklyDaily: { ...d, lastError: r.ok ? 'EMPTY' : r.code, lastErrorAt: new Date().toISOString() } }); return; }
    }
    if(needNew){
      const n = await fetchNewFiles();
      if(n.ok) await recordNew(n, 'auto');
      else { const { weeklyDaily: d2 = {} } = await chrome.storage.local.get('weeklyDaily'); await chrome.storage.local.set({ weeklyDaily: { ...d2, lastError: 'NEWFILES_' + n.code, lastErrorAt: new Date().toISOString() } }); }
    }
  } catch(e){
    const { weeklyDaily: d3 = {} } = await chrome.storage.local.get('weeklyDaily');
    await chrome.storage.local.set({ weeklyDaily: { ...d3, lastError: 'NETWORK', lastErrorAt: new Date().toISOString() } });
  } finally { dailyRunning = false; }
}
if(chrome.alarms){
  chrome.alarms.create('fcw-daily', { delayInMinutes: 1, periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener(a => { if(a.name === 'fcw-daily') dailyCheck(); });
}
setTimeout(dailyCheck, 4000); // service worker start-up

function fromExtensionPage(sender){
  return !sender.tab && String(sender.url || '').startsWith('chrome-extension://' + chrome.runtime.id + '/');
}
// Latest report (from iCare or from the site) kept for the extension's 📊 tab — same file format as iCare's export.
async function keepReport(rep){
  await chrome.storage.local.set({ weeklyReport: { ...rep, at: Date.now() } });
}
function reportB64(r){
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = '<html><head><meta charset="utf-8"></head><body><table><tr>' + r.headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr>' +
    r.rows.map(row => '<tr>' + row.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</table></body></html>';
  const bytes = new Uint8Array(2 + html.length * 2);
  bytes[0] = 0xFF; bytes[1] = 0xFE;
  for(let i = 0; i < html.length; i++){ const c = html.charCodeAt(i); bytes[2 + i * 2] = c & 255; bytes[3 + i * 2] = c >> 8; }
  let bin = '';
  for(let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// Task rules: the newer copy wins (site or extension window); the reply carries the winning copy.
async function syncRules({ cfg, at }){
  const { weeklyTaskRules: mine } = await chrome.storage.local.get('weeklyTaskRules');
  const theirsAt = Number(at) || 0;
  if(cfg && typeof cfg === 'object' && theirsAt > ((mine && mine.at) || 0)){
    const json = JSON.stringify(cfg);
    if(json.length > 200000) return { ok: false, code: 'TOO_LARGE' };
    const copy = JSON.parse(json);
    await chrome.storage.local.set({ weeklyTaskRules: { cfg: copy, at: theirsAt } });
    return { ok: true, cfg: copy, at: theirsAt };
  }
  return { ok: true, cfg: mine ? mine.cfg : null, at: mine ? mine.at : 0 };
}
})();
