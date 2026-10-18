// Test-only stand-in for the extension on the weekly site (served by scripts/dev-server.js with ?mockConnector=1).
// Runs the extension's real src/weekly.js message handlers with a fake chrome API and a fake iCare API
// (synthetic patients). The fake extension storage is exposed as window.__extStore for checks.
(async () => {
  const code = await (await fetch('/icare-extension/src/weekly.js')).text();
  const listeners = [], store = { local: {}, session: { icareToken: 'FAKE', tokenAt: Date.now(), icareBuild: '2316' } };
  window.__extStore = store.local;
  const area = k => ({ get: async keys => { const o = {}; [].concat(keys).forEach(x => { if (x in store[k]) o[x] = store[k][x]; }); return o; },
    set: async o => { Object.assign(store[k], o); }, remove: async ks => { [].concat(ks).forEach(x => delete store[k][x]); } });
  const chrome = { runtime: { id: 'ext', onMessage: { addListener: f => listeners.push(f) }, getManifest: () => ({ version: '1.2.0' }), getURL: p => 'chrome-extension://ext/' + p },
    storage: { local: area('local'), session: area('session') }, tabs: { create: async o => { window.__opened = o.url; return { id: 1 }; } } };
  const cities = { JED: [1001, 1002, 1003, 1004], MKK: [2001, 2002], YNB: [3001], RUH: [4001] };
  const row = id => { const c = Object.keys(cities).find(k => cities[k].includes(id)), k = id % 4;
    return { patient_id: id, patient_name: 'Test Patient ' + id, doctor_name: ['Dr Test Alpha', 'Dr Test Beta', 'Dr Test Gamma'][id % 3], city: c,
      patient_status: id === 1004 ? 'De-Active' : 'Active', plan: { dr: k === 0 ? 0 : 2, nu: 1 }, done: { Dr: k === 1 ? 0 : k === 2 ? 1 : 2, Nur: 1 },
      notes: { gp: k === 1 ? 'Patient refused service||older note' : '' }, harp_score: 5, last_visit: '2026-10-0' + (1 + id % 9) }; };
  const fakeFetch = async url => { const u = new URL(url), p = u.pathname, city = u.searchParams.get('city'); let body;
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
    if (m.type === 'FETCH_PERFORMANCE') reply(await toExt({ type: 'FCW_FETCH_PERFORMANCE', month: m.month, cities: m.cities }));
    if (m.type === 'SYNC_REPORT') reply(await toExt({ type: 'FCW_SYNC_REPORT', name: m.name, b64: b64(m.buffer) }));
    if (m.type === 'SENT') reply(await toExt({ type: 'FCW_SENT', ptids: m.ptids, month: m.month }));
    if (m.type === 'SYNC_RULES') reply(await toExt({ type: 'FCW_SYNC_RULES', cfg: m.cfg, at: m.at }));
    if (m.type === 'OPEN_TASKS') reply(await toExt({ type: 'FCW_OPEN_TASKS', name: m.name, b64: b64(m.buffer) }));
  });
})();
