// Local test server for the weekly site (no secrets, no real data):
//   static files + a mock /api (team password "mock-pass") + optional stand-in for the iCare extension.
// Usage: node scripts/dev-server.js  → http://localhost:5177   (add ?mockConnector=1 to a page URL to inject the
// stand-in, which runs the extension's real src/weekly.js against a fake iCare API with synthetic patients).
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
http.createServer((req, res) => {
  if (req.url.startsWith('/api')) {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      const { action, data = {} } = JSON.parse(b || '{}'), auth = (req.headers.authorization || '').replace('Bearer ', '');
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (action === 'login') return data.password === 'mock-pass' ? send(200, { ok: true, token: 'MOCK' }) : send(401, { ok: false, code: 'INVALID_PASSWORD' });
      if (auth !== 'MOCK') return send(401, { ok: false, code: 'UNAUTHORIZED' });
      if (action === 'session') return send(200, { ok: true });
      if (action === 'settings.getAll') return send(200, { ok: true, items: {} });
      if (action === 'settings.put') return send(200, { ok: true, key: data.key, rev: 1 });
      send(400, { ok: false });
    }); return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  if (req.url.includes('mockConnector') && p.endsWith('.html')) {
    res.writeHead(200, { 'Content-Type': types['.html'] });
    return res.end(fs.readFileSync(f, 'utf8').replace('<head>', '<head><script src="/icare-extension-tests/mock-site-connector.js"></script>'));
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(5177, () => console.log('weekly site on http://localhost:5177'));
