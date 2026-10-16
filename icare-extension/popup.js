document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
chrome.runtime.sendMessage({ type: 'FCW_STATUS' }).then(s => {
  const el = document.getElementById('st');
  if(s && s.hasToken){
    el.className = 'st ok';
    el.textContent = `✅ متصل بجلسة iCare (آخر تحديث قبل ${Math.round((Date.now() - s.tokenAt) / 60000)} دقيقة). اجلب التقرير من صفحة التحليل الأسبوعي.`;
  } else {
    el.className = 'st bad';
    el.textContent = '⚠️ لا توجد جلسة iCare — افتح iCare وسجّل الدخول، ثم ارجع لصفحة التحليل.';
  }
}).catch(() => {});
