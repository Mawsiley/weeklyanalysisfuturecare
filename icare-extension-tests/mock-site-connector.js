// Test-only stand-in for the extension on the weekly site (served by scripts/dev-server.js with ?mockConnector=1).
// Runs the extension's real src/weekly.js message handlers with a fake chrome API and a fake iCare API
// (synthetic patients). The fake extension storage is exposed as window.__extStore for checks.
(async () => {
  const code = await (await fetch('/icare-extension/src/weekly.js')).text();
  const listeners = [], store = { local: (() => { try { return JSON.parse(sessionStorage.getItem('__extLocal') || '{}'); } catch { return {}; } })(), session: { icareToken: 'FAKE', tokenAt: Date.now(), icareBuild: '2316' } };
  window.__extStore = store.local;
  const area = k => ({ get: async keys => { const o = {}; [].concat(keys).forEach(x => { if (x in store[k]) o[x] = store[k][x]; }); return o; },
    set: async o => { Object.assign(store[k], o); if (k === 'local') try { sessionStorage.setItem('__extLocal', JSON.stringify(store.local)); } catch {} }, remove: async ks => { [].concat(ks).forEach(x => delete store[k][x]); } });
  const chrome = { runtime: { id: 'ext', onMessage: { addListener: f => listeners.push(f) }, getManifest: () => ({ version: '1.2.0' }), getURL: p => 'chrome-extension://ext/' + p },
    storage: { local: area('local'), session: area('session') }, tabs: { create: async o => { window.__opened = o.url; return { id: 1 }; } } };
  const cities = { JED: [1001, 1002, 1003, 1004], MKK: [2001, 2002], YNB: [3001], RUH: [4001] };
  const row = id => { const c = Object.keys(cities).find(k => cities[k].includes(id)), k = id % 4;
    return { patient_id: id, patient_name: 'Test Patient ' + id, doctor_name: ['Dr Test Alpha', 'Dr Test Beta', 'Dr Test Gamma'][id % 3], city: c,
      patient_status: id === 1004 ? 'De-Active' : 'Active', plan: { dr: k === 0 ? 0 : 2, nu: 1 }, done: { Dr: k === 1 ? 0 : k === 2 ? 1 : 2, Nur: 1 },
      notes: { gp: k === 1 ? 'Patient refused service||older note' : '' }, harp_score: 5, last_visit: '2026-10-0' + (1 + id % 9) }; };
  const fakeFetch = async url => { const u = new URL(url), p = u.pathname, city = u.searchParams.get('city'); let body;
    if (p.endsWith('/new-file')) { const now = new Date(), ym = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), cur = ym(now), prev = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1)), docs = ['Dr Test Alpha', 'Dr Test Beta', 'Dr Test Gamma'], items = [];
      for (let i = 0; i < 40; i++) { const m0 = i < 18 ? prev : cur, day = String(1 + (i % 27)).padStart(2, '0'); items.push({ id: 700 + i, patient_id: 8000 + i, patient_name: 'SECRET NAME ' + i, mobile: '05000000' + i, pid: '10000000' + i, nationality: 'X', city: ['Jeddah', 'Makkah', 'Yanbu'][i % 3], doctor_name: i === 1 ? 'Dr Only Prev' : docs[i % 3], company_name: i % 4 ? 'Co A' : 'Co B', status_label: i % 5 ? 'Open' : 'Waiting', project: ['Home Care', 'Tele', 'Tabadul'][i % 3 === 2 && i % 2 ? 2 : i % 3], created_at: m0 + '-' + day + ' 09:00:00', register_date: i % 6 ? (i % 8 === 0 && i < 18 ? cur + '-02' : m0 + '-' + day) : '', csheet_count: i % 3 ? 1 : 0, approval_no: i % 2 ? 'A' + i : '', app_date: i % 4 ? m0 + '-' + day : '', is_referral: i % 7 === 0, referral_source: 'Hospital X', mobile_dup_count: i % 9 === 0 ? 1 : 0, last_action: 'Call', patient_active: i % 5 !== 0 }); }
      items.push({ id: 999, patient_id: 9999, doctor_name: 'Dr Old', city: 'Jeddah', created_at: '2025-01-05 10:00:00', csheet_count: 1 });
      const pg = Number(u.searchParams.get('page') || 1); return new Response(JSON.stringify({ items: pg === 1 ? items : [], total: items.length }), { status: 200 }); }
    if (p.endsWith('/filter-options')) body = { options: { cities: Object.keys(cities) } };
    else if (p.endsWith('/report-plan')) body = { ids: cities[city] || [], chunk_max: 200 };
    else if (p.endsWith('/report')) body = { rows: (u.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number).map(row) };
    return new Response(JSON.stringify(body), { status: 200 }); };
  new Function('chrome', 'fetch', code)(chrome, fakeFetch);
  const toExt = msg => new Promise(res => { for (const l of listeners) { if (l(msg, { url: location.href, id: 'ext' }, res) === true) return; } res(null); });
  const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  window.addEventListener('message', async e => {
    const m = e.data; if (!m || m.source !== 'fc-weekly' || !m.id) return;
    const reply = o => window.postMessage({ source: 'fc-weekly-ext', id: m.id, ...o }, location.origin);
    if (m.type === 'STATUS') reply(await toExt({ type: 'FCW_STATUS' }));
    if (m.type === 'FETCH_PERFORMANCE') reply(await toExt({ type: 'FCW_FETCH_PERFORMANCE', month: m.month, cities: m.cities, noRecord: m.noRecord === true }));
    if (m.type === 'SYNC_REPORT') reply(await toExt({ type: 'FCW_SYNC_REPORT', name: m.name, b64: b64(m.buffer) }));
    if (m.type === 'GET_REPORT') reply(await toExt({ type: 'FCW_GET_REPORT' }));
    if (m.type === 'FETCH_NEW') reply(await toExt({ type: 'FCW_FETCH_NEW' }));
    if (m.type === 'GET_NEW') reply(await toExt({ type: 'FCW_GET_NEW' }));
    if (m.type === 'SENT') reply(await toExt({ type: 'FCW_SENT', ptids: m.ptids, month: m.month }));
    if (m.type === 'SYNC_RULES') reply(await toExt({ type: 'FCW_SYNC_RULES', cfg: m.cfg, at: m.at }));
    if (m.type === 'OPEN_TASKS') reply(await toExt({ type: 'FCW_OPEN_TASKS', name: m.name, b64: b64(m.buffer), autostart: m.autostart === true }));
  });
})();
