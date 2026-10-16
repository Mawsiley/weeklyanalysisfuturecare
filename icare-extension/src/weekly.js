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
    return { ok: true, month, matched, missing, counts, headers: PERF_HEADERS, rows: all.map((r, i) => perfRow(r, i + 1)), fetchedAt: new Date().toISOString() };
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
      : chrome.storage.session.remove(['icareToken', 'tokenAt'])).then(() => sendResponse({ ok: true }));
    return true;
  }
  if(msg && msg.type === 'FCW_STATUS'){
    if(!PAGE_ORIGINS.includes(from) && sender.id !== chrome.runtime.id) return;
    getToken().then(t => sendResponse({ ok: true, hasToken: !!t.token, tokenAt: t.at, version: chrome.runtime.getManifest().version, tasks: true }));
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
    if(!PAGE_ORIGINS.includes(from)) { sendResponse({ ok: false, code: 'FORBIDDEN_ORIGIN' }); return; }
    fetchPerformance(msg).then(sendResponse);
    return true;
  }
});
})();
