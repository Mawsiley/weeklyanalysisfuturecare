const defaults=['Patient refused','Patient admitted','Patient unavailable','Out of city / Travel','Rescheduled','Cancelled','Unable to contact','Plan error','Service completed','Deceased','Other'];
const $=id=>document.getElementById(id);
$('redirect').textContent=chrome.identity.getRedirectURL('google');
chrome.storage.local.get(['clientId','reasons','anyoneWriter'],s=>{$('clientId').value=s.clientId||'';$('reasons').value=(s.reasons||defaults).join('\n');$('anyone').checked=s.anyoneWriter!==false});
$('save').onclick=()=>{const reasons=$('reasons').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);chrome.storage.local.set({clientId:$('clientId').value.trim(),reasons,anyoneWriter:$('anyone').checked},()=>{$('msg').textContent='تم الحفظ.'})};
