// Runs on the weekly analysis site: a narrow bridge between the page and this extension.
// The page can only ask for status and request the performance report for a month and cities.
// The iCare token is never exposed to the page.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const reply = (id, payload) => window.postMessage({ source: 'fc-weekly-ext', id, ...payload }, location.origin);
  document.documentElement.dataset.fcWeeklyIcare = VERSION;
  window.addEventListener('message', async e => {
    if(e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if(!m || m.source !== 'fc-weekly' || !m.id) return;
    try{
      if(m.type === 'STATUS'){
        reply(m.id, await chrome.runtime.sendMessage({ type: 'FCW_STATUS' }));
      } else if(m.type === 'FETCH_PERFORMANCE'){
        const cities = Array.isArray(m.cities) ? m.cities.map(String).slice(0, 10) : [];
        reply(m.id, await chrome.runtime.sendMessage({ type: 'FCW_FETCH_PERFORMANCE', month: String(m.month || ''), cities }));
      }
    } catch(err){
      reply(m.id, { ok: false, code: 'EXTENSION_ERROR' });
    }
  });
})();
