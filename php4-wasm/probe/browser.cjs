// Runs the browser probes in headless Chromium:
//   index.html         the CLI build runs the 3.3.0 TypoScript parser once
//   request-loop.html  the request-loop build serves many requests in one instance
// Usage: node browser.cjs <build-out-dir> <typo3_src-3.3.0-dir>
// Needs Playwright with Chromium. Serves on 127.0.0.1 only.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const roots = {
  out: path.resolve(process.argv[2]),
  typo3: path.resolve(process.argv[3]),
  probe: __dirname,
  wasm: path.resolve(__dirname, '..'),
  repo: path.resolve(__dirname, '..', '..'),
};
const routes = {
  '/index.html': ['probe', 'index.html'],
  '/typoscript.php': ['probe', 'typoscript.php'],
  '/php4.js': ['out', 'web/php4.js'],
  '/php4.wasm': ['out', 'web/php4.wasm'],
  '/t3lib/class.t3lib_div.php': ['typo3', 't3lib/class.t3lib_div.php'],
  '/t3lib/class.t3lib_tsparser.php': ['typo3', 't3lib/class.t3lib_tsparser.php'],

  '/request-loop.html': ['probe', 'request-loop.html'],
  '/php4-runtime.js': ['wasm', 'runtime/php4-runtime.js'],
  '/sapi/php4.js': ['out', 'sapi-web/php4.js'],
  '/sapi/php4.wasm': ['out', 'sapi-web/php4.wasm'],
  '/php-legacy.ini': ['repo', 'php4-base/php-legacy.ini'],
  '/www/state.php': ['probe', 'www/state.php'],
  '/www/env.php': ['probe', 'www/env.php'],
  '/www/fatal.php': ['probe', 'www/fatal.php'],
  '/www/exit.php': ['probe', 'www/exit.php'],
  '/www/mysql.php': ['probe', 'www/mysql.php'],
  '/mysql-sqlite.js': ['wasm', 'runtime/mysql-sqlite.js'],
  '/sqljs/sql-wasm.js': ['wasm', 'node_modules/sql.js/dist/sql-wasm.js'],
  '/sqljs/sql-wasm.wasm': ['wasm', 'node_modules/sql.js/dist/sql-wasm.wasm'],
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const pages = [
  ['/index.html', 'TYPOSCRIPT OK'],
  ['/request-loop.html', 'REQUEST LOOP OK'],
];

const server = http.createServer((req, res) => {
  const route = routes[req.url.split('?')[0]];
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }
  const file = path.join(roots[route[0]], route[1]);
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const browser = await chromium.launch();
  let passed = true;
  try {
    console.log((await browser.newPage().then(page => page.evaluate(() => navigator.userAgent))));
    for (const [url, success] of pages) {
      const page = await browser.newPage();
      page.on('pageerror', e => console.log(`PAGE ERROR ${e.message}`));
      const started = Date.now();
      await page.goto(`http://127.0.0.1:${server.address().port}${url}`);
      await page.waitForFunction(() => window.probeOutput, null, { timeout: 120000 });
      const lines = await page.evaluate(() => window.probeOutput);
      console.log(`${url}, output after ${Date.now() - started} ms:`);
      console.log(lines.join('\n'));
      passed = passed && lines.includes(success);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(passed ? 0 : 1);
});
