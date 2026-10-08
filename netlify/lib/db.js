'use strict';
const { Firestore, FieldValue } = require('@google-cloud/firestore');

let db;
function getDb() {
  if (!db) {
    db = new Firestore({
      projectId: process.env.FIRESTORE_PROJECT_ID,
      credentials: {
        client_email: process.env.FIRESTORE_CLIENT_EMAIL,
        private_key: (process.env.FIRESTORE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      preferRest: true,              // أسرع في Lambda (بدون gRPC cold start)
      ignoreUndefinedProperties: true,
    });
  }
  return db;
}

const NS = () => {
  const ns = process.env.APP_NAMESPACE;
  if (!ns) throw new Error('APP_NAMESPACE_NOT_SET');
  return ns;
};
const col = (name) => getDb().collection('apps').doc(NS()).collection(name);
const now = () => new Date().toISOString();
const toObj = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);

// ── CRUD عام ──────────────────────────────────────────────
async function list(name, { where = [], orderBy = 'createdAt', dir = 'desc', limit = 50, after = null, includeDeleted = false } = {}) {
  let q = col(name);
  if (!includeDeleted) q = q.where('deleted', '==', false);
  for (const [f, op, v] of where) q = q.where(f, op, v);
  q = q.orderBy(orderBy, dir).limit(Math.min(limit, 500));
  if (after) {
    const cur = await col(name).doc(after).get();
    if (cur.exists) q = q.startAfter(cur);
  }
  const snap = await q.get();
  const items = snap.docs.map(toObj);
  return { items, next: items.length === limit ? items[items.length - 1].id : null };
}

async function get(name, id) {
  return toObj(await col(name).doc(String(id)).get());
}

async function create(name, data, id = null) {
  const doc = { ...data, createdAt: now(), updatedAt: now(), deleted: false };
  const ref = id ? col(name).doc(String(id)) : col(name).doc();
  await ref.create(doc);               // يفشل بـ ALREADY_EXISTS (code 6) إن وُجد
  return { id: ref.id, ...doc };
}

async function update(name, id, patch) {
  const { id: _i, createdAt: _c, ...clean } = patch;
  await col(name).doc(String(id)).update({ ...clean, updatedAt: now() }); // NOT_FOUND (5) إن لم يوجد
  return get(name, id);
}

async function softDelete(name, id) {
  await col(name).doc(String(id)).update({ deleted: true, deletedAt: now(), updatedAt: now() });
  return { id, deleted: true };
}

async function count(name, where = []) {
  let q = col(name).where('deleted', '==', false);
  for (const [f, op, v] of where) q = q.where(f, op, v);
  return (await q.count().get()).data().count;
}

// كتابة دفعات (حد Firestore: 500 عملية لكل batch)
async function bulkCreate(name, rows, idField = null) {
  let written = 0;
  for (let i = 0; i < rows.length; i += 450) {
    const batch = getDb().batch();
    for (const r of rows.slice(i, i + 450)) {
      const ref = idField && r[idField] ? col(name).doc(String(r[idField])) : col(name).doc();
      batch.set(ref, { ...r, createdAt: r.createdAt || now(), updatedAt: now(), deleted: false });
    }
    await batch.commit();
    written += Math.min(450, rows.length - i);
  }
  return written;
}

module.exports = { getDb, col, list, get, create, update, softDelete, count, bulkCreate, FieldValue, now };
