// Sets the site/team password on Netlify (stores only a PBKDF2 hash + salt; never prints them).
// Usage (from the project folder, after `netlify link`):  node scripts/set-team-password.js <new-password>
// Then redeploy (or push) so the function picks up the new values.
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const pw = process.argv[2];
if (!pw || pw.length < 6) { console.error('Usage: node scripts/set-team-password.js <password (6+ chars)>'); process.exit(1); }
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync(pw, salt, 120000, 64, 'sha512').toString('hex');
const set = (k, v) => execFileSync('netlify', ['env:set', k, v], { shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
set('TEAM_PASSWORD_SALT', salt);
set('TEAM_PASSWORD_HASH', hash);
console.log('Team password updated on Netlify (TEAM_PASSWORD_HASH, TEAM_PASSWORD_SALT). Redeploy to apply.');
