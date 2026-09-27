const defaults=['Patient refused service','Patient was not available','Service rescheduled by patient','Patient traveled','Patient was hospitalized','Medical condition prevented service','Service completed but not documented','Documentation error','Insurance authorization pending','Equipment not available','Staff shortage','Acute','Other (Specify)...'];
const $=id=>document.getElementById(id);
$('redirect').textContent=chrome.identity.getRedirectURL('google');
chrome.storage.local.get(['clientId','reasons','anyoneWriter'],s=>{$('clientId').value=s.clientId||'';$('reasons').value=(s.reasons||defaults).join('\n');$('anyone').checked=s.anyoneWriter!==false});
$('save').onclick=()=>{const reasons=$('reasons').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);chrome.storage.local.set({clientId:$('clientId').value.trim(),reasons,anyoneWriter:$('anyone').checked},()=>{$('msg').textContent='تم الحفظ.'})};
