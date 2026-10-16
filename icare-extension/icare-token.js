// Runs on icare.com.sa: hands the signed-in user's iCare session token (and iCare's build number) to the extension.
// The token stays inside the extension (chrome.storage.session — memory only, cleared when the browser closes)
// and is never sent to the FutureCare page or to any server other than iCare's API.
(() => {
  const KEY = 'portal_auth_token';
  let last = null;
  function share(){
    let token = null;
    try{ token = localStorage.getItem(KEY); }catch(e){}
    if(token === last) return;
    last = token;
    const build = (document.querySelector('meta[name="app-build"]') || {}).content || '';
    chrome.runtime.sendMessage({ type: 'ICARE_TOKEN', token: token || '', build }).catch(() => {});
  }
  share();
  window.addEventListener('storage', e => { if(e.key === KEY || e.key === null) share(); });
  setInterval(share, 60 * 1000);
})();
