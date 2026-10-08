const { Firestore } = require('@google-cloud/firestore');
const k = require(process.env.USERPROFILE + '/.secrets/mawsiley-db-2893-netlify-fn.json');
const ns = process.argv[2] || 'default';
const db = new Firestore({ projectId: k.project_id, credentials: { client_email: k.client_email, private_key: k.private_key } });
(async () => {
  const ref = db.collection('apps').doc(ns).collection('_healthcheck').doc('ping');
  await ref.set({ at: new Date().toISOString() });
  console.log('READ OK', (await ref.get()).data());
  await ref.delete();
  console.log('DB OK for namespace:', ns);
})().catch((e) => { console.error('FAIL', e.code, e.message); process.exit(1); });
