/* Site password gate: every page asks for the team password (checked by the Netlify Function /api).
   The token is shared with cloud sync (fc-cloud-token), so one sign-in also enables settings sync. */
(()=>{
  const KEY='fc-cloud-token',de=document.documentElement;
  const local=/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)||location.protocol==='file:';
  let token='';try{token=localStorage.getItem(KEY)||''}catch{}
  de.style.visibility='hidden';
  const open=()=>{de.style.visibility=''};
  async function api(action,data,tok){
    const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',...(tok?{Authorization:'Bearer '+tok}:{})},body:JSON.stringify({action,data})});
    const j=await r.json().catch(()=>null);
    if(!j)throw Object.assign(Error('NO_API'),{noApi:true});
    return j;
  }
  function form(msg=''){
    const show=()=>{
      de.style.visibility='';
      const w=document.createElement('div');w.id='fcGate';
      w.innerHTML='<style>#fcGate{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:linear-gradient(135deg,#0f3d2e,#14532d);font-family:system-ui,"Segoe UI",Tahoma,sans-serif}#fcGate form{background:#fff;color:#111827;border-radius:16px;padding:28px 26px;width:min(92vw,360px);box-shadow:0 20px 50px #0006;direction:rtl;text-align:right}#fcGate h2{margin:0 0 6px;font-size:20px}#fcGate p{margin:0 0 16px;color:#4b5563;font-size:14px}#fcGate input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d1d5db;border-radius:10px;font-size:16px;margin-bottom:12px}#fcGate button{width:100%;padding:11px;border:0;border-radius:10px;background:#15803d;color:#fff;font-size:16px;font-weight:700;cursor:pointer}#fcGate button:disabled{opacity:.6}#fcGate .err{color:#dc2626;min-height:18px;margin:8px 0 0;font-size:13px}</style>'+
        '<form><h2>🔒 FutureCare</h2><p>أدخل كلمة مرور الموقع للمتابعة.</p><input type="password" autocomplete="current-password" aria-label="كلمة المرور" required><button>دخول</button><p class="err" role="alert"></p></form>';
      document.body.appendChild(w);
      const f=w.querySelector('form'),inp=w.querySelector('input'),btn=w.querySelector('button'),err=w.querySelector('.err');
      err.textContent=msg;inp.focus();
      f.onsubmit=async e=>{e.preventDefault();btn.disabled=true;err.textContent='';
        try{const j=await api('login',{password:inp.value});
          if(!j.ok){err.textContent=j.code==='INVALID_PASSWORD'?'كلمة المرور غير صحيحة.':'تعذّر الدخول: '+j.code;btn.disabled=false;inp.select();return}
          try{localStorage.setItem(KEY,j.token)}catch{}
          location.reload();
        }catch(x){err.textContent='تعذّر الاتصال بالخادم.';btn.disabled=false}};
    };
    document.body?show():document.addEventListener('DOMContentLoaded',show,{once:true});
  }
  (async()=>{
    if(!token){try{await api('session',{},'')}catch(e){if(e.noApi&&local)return open()}return form()}
    try{const j=await api('session',{},token);if(j.ok)return open();try{localStorage.removeItem(KEY)}catch{}form('انتهت الجلسة — أعد إدخال كلمة المرور.')}
    catch(e){if(e.noApi&&local)return open();open()}/* server unreachable with a saved session: keep working offline */
  })();
})();
