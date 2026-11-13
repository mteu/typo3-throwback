// The assembled site (site/assemble.sh), served as GitHub Pages serves it:
// static files under a path, so that the origin holds more than this site,
// as it does there. On 127.0.0.1, which counts as a secure origin for
// service workers.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const SITE_PATH = '/typo3-throwback';
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.gz': 'application/gzip', '.php': 'text/plain', '.ini': 'text/plain', '.txt': 'text/plain',
};

// Resolves to the URL the site root is served at, and a function that stops
// the server.
function serveSite(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const inSite = url.pathname.startsWith(`${SITE_PATH}/`);
    const file = path.join(root, path.normalize(decodeURIComponent(url.pathname.slice(SITE_PATH.length))).replace(/^(\.\.[/\\])+/, ''));
    if (!inSite || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}${SITE_PATH}`,
      close: () => server.close(),
    }));
  });
}

module.exports = { serveSite };
