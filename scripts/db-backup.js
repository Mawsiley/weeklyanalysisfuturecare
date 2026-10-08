// scripts/db-backup.js <appName>
const fs = require('fs');
const { Firestore } = require('@google-cloud/firestore');
const k = require(process.env.USERPROFILE + '/.secrets/mawsiley-db-2893-netlify-fn.json');
const ns = process.argv[2];
const db = new Firestore({ projectId: k.project_id, credentials: { client_email: k.client_email, private_key: k.private_key } });
(async () => {
  const out = {};
  for (const c of await db.collection('apps').doc(ns).listCollections()) {
    out[c.id] = (await c.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const f = `backup-${ns}-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log('saved', f, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
})();
