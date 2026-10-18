/* iCare connection for FutureCare pages.
   Talks to the "FutureCare Weekly — iCare Reports" Chrome extension (Desktop folder "FutureCare Weekly iCare"), which uses the signed-in iCare
   session. The iCare token never reaches this page; the page only receives the requested report rows.
   Each page declares where its data comes from and how it is loaded (ICARE_SOURCES below). The fetched report
   is rebuilt as the same HTML-in-.xls file iCare exports and handed to the page's own file input, so every page
   keeps its existing parsing rules. */
(()=>{
  const PAGES={
    'index.html':{source:'performance',input:'#file',anchor:'#drop',
      how:'تقرير الأداء (Performance Follow-up) — يدخل نفس مسار رفع الملف: يُستبعد Deactive، تُصفّر الحالات الجزئية، ويُحدد الفترة من أول/آخر Last Visit.'},
    'dr-not-done.html':{source:'performance',input:'#fileInput',anchor:'#dropzone',
      how:'تقرير الأداء — يُستخرج منه DR NOT DONE (DRP>0 و DRD=0) مع استبعاد Deactive.'},
    'gp-extra-requests.html':{source:null,
      how:'ملف gp-extra-req-list — الربط المباشر غير مفعّل بعد؛ استمر برفع الملف يدويًا.'},
  };
  const SOURCES={
    performance:{label:'تقرير الأداء',url:'https://icare.com.sa/performance-follow-up/report',cities:{Jeddah:'جدة',Makkah:'مكة',Yanbu:'ينبع'}},
  };
  window.ICARE_SOURCES={pages:PAGES,sources:SOURCES};
  const page=(location.pathname.split('/').pop()||'index.html').toLowerCase();
  const cfg=PAGES[page]||PAGES['index.html'];
  if(!cfg||!cfg.source)return;
  const src=SOURCES[cfg.source];

  let seq=0;const waiting=new Map();
  window.addEventListener('message',e=>{if(e.source!==window||e.origin!==location.origin)return;const m=e.data;if(!m||m.source!=='fc-weekly-ext'||!waiting.has(m.id))return;waiting.get(m.id)(m);waiting.delete(m.id)});
  const ask=(type,extra={},ms=300000)=>new Promise(res=>{const id='q'+(++seq)+Date.now();waiting.set(id,res);window.postMessage({source:'fc-weekly',id,type,...extra},location.origin);setTimeout(()=>{if(waiting.has(id)){waiting.delete(id);res({ok:false,code:'NO_EXTENSION'})}},type==='STATUS'?1500:ms)});

  window.fcIcare={ask}; // used by the dashboard's Tasks tab (status + hand-off to the extension window)
  const ERR={NO_EXTENSION:'إضافة FutureCare Weekly — iCare غير مثبتة أو غير مفعّلة على هذا المتصفح.',NO_TOKEN:'لا توجد جلسة iCare — افتح iCare وسجّل الدخول ثم أعد المحاولة.',TOKEN_EXPIRED:'انتهت جلسة iCare — افتح iCare وسجّل الدخول من جديد.',CITY_NOT_FOUND:'لم يتم العثور على المدن المطلوبة في قائمة مدن iCare.',NETWORK:'تعذّر الاتصال بـ iCare.',BAD_MONTH:'الشهر غير صحيح.',FORBIDDEN_ORIGIN:'هذه الصفحة غير مسموح لها في الإضافة.',EXTENSION_ERROR:'أُعيد تحميل الإضافة — حدّث الصفحة.'};
  const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const thisMonth=()=>{const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`};

  function asIcareFile(res){
    const html='<html><head><meta charset="utf-8"></head><body><table><tr>'+res.headers.map(h=>`<th>${esc(h)}</th>`).join('')+'</tr>'+
      res.rows.map(r=>'<tr>'+r.map(c=>`<td>${esc(c)}</td>`).join('')+'</tr>').join('')+'</table></body></html>';
    const u16=new Uint16Array(html.length+1);u16[0]=0xFEFF;for(let i=0;i<html.length;i++)u16[i+1]=html.charCodeAt(i);
    const cities=Object.keys(res.counts||{}).join('-');
    return new File([u16.buffer],`performance-report_${res.month}_${cities||'icare'}.xls`,{type:'application/vnd.ms-excel'});
  }
  let lastFile=null; // report currently loaded in this page (fetched or uploaded) — for opening tasks
  // keep the extension's 📊 tab in step with the report loaded here (main page only; silent if no extension)
  const pushReport=file=>{if(window!==window.top||!file)return;file.arrayBuffer().then(buffer=>ask('SYNC_REPORT',{name:file.name,buffer},15000)).catch(()=>{})};
  function feed(file){
    lastFile=file;
    const input=document.querySelector(cfg.input);if(!input)throw Error('لم يتم العثور على حقل رفع الملف في هذه الصفحة');
    const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  }

  function mount(){
    const anchor=document.querySelector(cfg.anchor);if(!anchor||document.getElementById('icareBox'))return;
    const box=document.createElement('div');box.id='icareBox';box.dir='rtl';
    box.innerHTML=`<style>#icareBox{margin:12px auto;max-width:900px;border:1px solid #99f6e4;background:#f0fdfa;color:#134e4a;border-radius:12px;padding:12px 14px;font:14px system-ui,"Segoe UI",Tahoma,sans-serif;text-align:right}#icareBox .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}#icareBox b{font-size:15px}#icareBox label{display:inline-flex;gap:4px;align-items:center}#icareBox input[type=month]{padding:5px 8px;border:1px solid #5eead4;border-radius:8px}#icareBox button{background:#0f766e;color:#fff;border:0;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer}#icareBox button:disabled{opacity:.55;cursor:default}#icareBox .msg{margin-top:8px;font-size:13px}#icareBox .msg.err{color:#b91c1c}#icareBox .how{margin-top:6px;font-size:12px;color:#0f766e}#icareBox a{color:#0f766e}@media(prefers-color-scheme:dark){#icareBox{background:#042f2e;color:#ccfbf1;border-color:#115e59}#icareBox .how,#icareBox a{color:#5eead4}#icareBox .msg.err{color:#fca5a5}}</style>
      <div class="row"><b>📥 جلب ${esc(src.label)} من iCare</b>
      <label>الشهر <input type="month" id="icareMonth" value="${thisMonth()}"></label>
      ${Object.entries(src.cities).map(([k,v])=>`<label><input type="checkbox" class="icareCity" value="${k}" checked> ${v}</label>`).join('')}
      <button type="button" id="icareFetch">جلب الآن</button>
      <button type="button" id="icareLocal" hidden title="التقرير المحفوظ محلياً في الإضافة (جلب يومي تلقائي أو آخر جلب) — يُحمَّل دون جلب جديد"></button>
      <button type="button" id="icareTasks" hidden title="يفتح نافذة التاسكات في الإضافة مع هذا التقرير للمراجعة — لا يُرسل شيء قبل أن تبدأ التشغيل هناك">📨 فتح تاسكات iCare من هذا التقرير</button></div>
      <div class="msg" id="icareMsg" role="status">⏳ التحقق من إضافة iCare…</div>
      <div class="how">المصدر: <a href="${src.url}" target="_blank" rel="noopener">${esc(src.url.replace('https://',''))}</a> — ${esc(cfg.how)}</div>`;
    anchor.parentNode.insertBefore(box,anchor);
    const msg=box.querySelector('#icareMsg'),btn=box.querySelector('#icareFetch'),tbtn=box.querySelector('#icareTasks');
    const lbtn=box.querySelector('#icareLocal');
    const dayName=ms=>{const d=new Date(ms),t=new Date();return d.toDateString()===t.toDateString()?'اليوم':d.toLocaleDateString('ar-SA',{day:'numeric',month:'numeric'})};
    let tasksOk=false;const syncTasks=()=>{tbtn.hidden=!tasksOk;tbtn.disabled=!lastFile};
    const input=document.querySelector(cfg.input);input&&input.addEventListener('change',()=>{if(input.files&&input.files[0]&&input.files[0]!==lastFile){lastFile=input.files[0];pushReport(lastFile);syncTasks()}});
    anchor.addEventListener('drop',e=>{const f=e.dataTransfer&&e.dataTransfer.files[0];if(f){lastFile=f;pushReport(f);syncTasks()}},true);
    let received='';const say=(t,err)=>{msg.textContent=t;msg.className='msg'+(err?' err':'')};
    btn.disabled=true;
    ask('STATUS').then(s=>{
      if(received)return; // a report from the main page is already shown
      if(!s.ok){say(ERR.NO_EXTENSION+' ثبّتها من مجلد "FutureCare Weekly iCare" على سطح المكتب (chrome://extensions ← Load unpacked).',true);return}
      btn.disabled=false;tasksOk=!!s.tasks;syncTasks();
      if(s.localAt){lbtn.hidden=false;lbtn.textContent='📦 نسخة محلية: '+dayName(s.localAt)+' '+new Date(s.localAt).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'})+(s.localHow==='auto'?' (تلقائي)':s.localHow==='manual'?' (يدوي)':'')}
      say(s.hasToken?`✅ متصل بجلسة iCare (الإضافة ${s.version}).`:'⚠️ الإضافة جاهزة لكن لا توجد جلسة iCare — افتح iCare وسجّل الدخول.',!s.hasToken);
    });
    btn.onclick=async()=>{
      const month=box.querySelector('#icareMonth').value,cities=[...box.querySelectorAll('.icareCity:checked')].map(x=>x.value);
      if(!cities.length)return say('اختر مدينة واحدة على الأقل.',true);
      btn.disabled=true;say(`⏳ جارٍ جلب ${src.label} لشهر ${month} (${cities.map(c=>src.cities[c]).join('، ')})… قد يستغرق دقيقة.`);
      const r=await ask('FETCH_PERFORMANCE',{month,cities});
      btn.disabled=false;
      if(!r.ok){say((ERR[r.code]||'تعذّر الجلب: '+r.code)+(r.available?` المدن المتاحة: ${r.available.join('، ')}`:''),true);return}
      if(!r.rows.length){say(`لا توجد حالات في iCare لهذا الشهر والمدن المحددة.`,true);return}
      const file=asIcareFile(r);
      try{feed(file)}catch(e){say(e.message,true);return}
      const parts=Object.entries(r.counts).map(([c,n])=>`${src.cities[c]}: ${n}`).join(' | ');
      const summary=`${r.rows.length} مريض (${parts}) — شهر ${r.month}، جُلب ${new Date(r.fetchedAt).toLocaleTimeString('ar-SA')}`;
      say(`✅ تم جلب ${r.rows.length} مريض من iCare (${parts})${r.missing.length?` — لم توجد: ${r.missing.map(c=>src.cities[c]).join('، ')}`:''}. وقت الجلب ${new Date(r.fetchedAt).toLocaleTimeString('ar-SA')}.`);
      syncTasks();share(file,summary);
    };
    // Receive a report fetched in the main page (this page embedded as a tab) without fetching again.
    lbtn.onclick=async()=>{
      lbtn.disabled=true;say('⏳ تحميل النسخة المحلية…');
      const r=await ask('GET_REPORT',{},30000);lbtn.disabled=false;
      if(!r.ok||!r.b64){say('لا توجد نسخة محلية في الإضافة بعد — اضغط «جلب الآن».',true);return}
      const bin=atob(r.b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
      const file=new File([u],r.name||'performance-report.xls',{type:'application/vnd.ms-excel'});
      try{feed(file)}catch(e){say(e.message,true);return}
      syncTasks();say('📦 حُمِّلت النسخة المحلية المحفوظة في الإضافة ('+dayName(r.at)+' '+new Date(r.at).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'})+') — بدون جلب جديد.');share(file,'نسخة محلية');
    };
    tbtn.onclick=async()=>{
      if(!lastFile)return say('حمّل التقرير أو اجلبه أولاً.',true);
      tbtn.disabled=true;say('⏳ فتح نافذة التاسكات…');
      const r=await ask('OPEN_TASKS',{name:lastFile.name,buffer:await lastFile.arrayBuffer()},30000);
      tbtn.disabled=false;
      say(r.ok?`📨 فُتحت نافذة التاسكات في تبويب جديد مع «${lastFile.name}». راجع القاعدة (سبب الإرسال) والحالات، ثم ابدأ التشغيل من هناك — لا يُرسل شيء قبل ذلك.`:(ERR[r.code]||'تعذّر فتح نافذة التاسكات: '+r.code),!r.ok);
    };
    window.__icareReceive=(file,summary)=>{try{feed(file);syncTasks();received=summary;btn.disabled=false;say('📥 نفس التقرير المجلوب في الصفحة الرئيسية: '+summary)}catch(e){say(e.message,true)}};
    if(window!==window.top){
      // after the page's own load handlers have attached to its file input
      const pull=()=>setTimeout(()=>{try{const s=window.parent.__icareShared;if(s&&s.source===cfg.source)window.__icareReceive(s.file,s.summary)}catch{}},0);
      document.readyState==='complete'?pull():window.addEventListener('load',pull,{once:true});
    }
  }
  // Main page: keep the latest fetched report and pass it to embedded tabs that use the same source
  // (e.g. "DR Not Done المتقدم"); tabs opened later pick it up when they load.
  function share(file,summary){
    if(window!==window.top)return;
    window.__icareShared={source:cfg.source,file,summary};
    document.querySelectorAll('iframe[src]').forEach(f=>{try{
      const p=(new URL(f.src,location.href).pathname.split('/').pop()||'').toLowerCase(),c=PAGES[p];
      if(c&&c.source===cfg.source&&f.contentWindow.__icareReceive)f.contentWindow.__icareReceive(file,summary);
    }catch{}});
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',mount,{once:true}):mount();
})();
