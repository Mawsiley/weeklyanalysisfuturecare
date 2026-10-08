'use strict';
// Settings sync API for the FutureCare dashboard.
// Stores only app settings (browser localStorage keys starting with "futurecare-"): duty schedule, leave,
// exceptions, doctor directory, staff list, CME plan. Never patient data.
// Firestore path: apps/<APP_NAMESPACE>/settings/<key>
// Access: one team password (PBKDF2 hash + salt in Netlify env) -> HS256 token.
const crypto = require('crypto');
const { col, now } = require('../lib/db');

const SECRET = process.env.SETTINGS_SESSION_SECRET || '';
const ITER = 120000;
const TOKEN_HOURS = 24 * 7;
const KEY_RE = /^futurecare-[a-z0-9-]{1,60}$/;
const SKIP = new Set(['futurecare-theme-v1', 'futurecare-config-meta-v1']);
const MAX_VALUE = 300000; // characters per setting

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hash = (password, salt) => new Promise((res, rej) =>
  crypto.pbkdf2(String(password), salt, ITER, 64, 'sha512', (e, k) => (e ? rej(e) : res(k.toString('hex')))));
function safeEqHex(a, b) {
  const A = Buffer.from(String(a), 'hex'), B = Buffer.from(String(b), 'hex');
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}
function signJwt(payload, hours) {
  const t = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = b64url(JSON.stringify({ ...payload, iat: t, exp: t + hours * 3600 }));
  const s = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest());
  return `${h}.${b}.${s}`;
}
function verifyJwt(token) {
  try {
    const [h, b, s] = String(token || '').split('.');
    const exp = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest());
    if (!s || s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return p.exp > Math.floor(Date.now() / 1000) ? p : null;
  } catch { return null; }
}
const authed = (event) => {
  const h = event.headers.authorization || event.headers.Authorization || '';
  const p = verifyJwt(h.replace(/^Bearer\s+/i, ''));
  return p && p.role === 'team' ? p : null;
};
const res = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return res(405, { ok: false, code: 'METHOD' });
  if (!SECRET) return res(500, { ok: false, code: 'NOT_CONFIGURED' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return res(400, { ok: false, code: 'INVALID_JSON' }); }
  const { action, data = {} } = body;

  try {
    if (action === 'login') {
      const h = process.env.TEAM_PASSWORD_HASH, s = process.env.TEAM_PASSWORD_SALT;
      if (!h || !s) return res(500, { ok: false, code: 'NOT_CONFIGURED' });
      if (!data.password || !safeEqHex(await hash(data.password, s), h)) {
        await sleep(800); // slow down guessing
        return res(401, { ok: false, code: 'INVALID_PASSWORD' });
      }
      return res(200, { ok: true, token: signJwt({ sub: 'team', role: 'team' }, TOKEN_HOURS), expiresInHours: TOKEN_HOURS });
    }

    if (!authed(event)) return res(401, { ok: false, code: 'UNAUTHORIZED' });

    if (action === 'settings.getAll') {
      const snap = await col('settings').get();
      const items = {};
      snap.docs.forEach((d) => { const x = d.data(); if (!x.deleted) items[d.id] = { value: x.value, rev: x.rev || 0, updatedAt: x.updatedAt }; });
      return res(200, { ok: true, items });
    }

    if (action === 'settings.put') {
      const key = String(data.key || '');
      if (!KEY_RE.test(key) || SKIP.has(key)) return res(400, { ok: false, code: 'INVALID_KEY' });
      const ref = col('settings').doc(key);
      if (data.value === null) {
        await ref.set({ deleted: true, value: '', updatedAt: now() }, { merge: true });
        return res(200, { ok: true, key, deleted: true });
      }
      if (typeof data.value !== 'string' || data.value.length > MAX_VALUE) return res(400, { ok: false, code: 'INVALID_VALUE' });
      const rev = await ref.firestore.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const next = ((cur.exists && cur.data().rev) || 0) + 1;
        tx.set(ref, { value: data.value, rev: next, deleted: false, updatedAt: now(), ...(cur.exists ? {} : { createdAt: now() }) }, { merge: true });
        return next;
      });
      return res(200, { ok: true, key, rev });
    }

    return res(400, { ok: false, code: 'UNKNOWN_ACTION' });
  } catch (e) {
    console.error('API_ERROR', action, e.code, e.message); // never log data or secrets
    return res(500, { ok: false, code: 'SERVER_ERROR' });
  }
};
