// Every release's backend login over HTTPS, as the public site serves it.
//
// 3.8.1 builds its redirects as absolute URLs, with the scheme PHP is told.
// Told http, its login redirected to http://, which sw.js's form-action
// directive blocks: the visitor stayed on the login form. site.cjs serves
// plain HTTP on 127.0.0.1, so it cannot see this.
//
// Usage: node https.cjs <site-root> <release>..., with the directory
// site/assemble.sh wrote. Needs Playwright with Chromium, and openssl for a
// throwaway certificate.
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { serveSite } = require('./static-server.cjs');

const root = path.resolve(process.argv[2]);
const releases = process.argv.slice(3);
assert.ok(releases.length > 0, 'name at least one release');

function throwawayCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'https-probe-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let failures = 0;
async function check(label, test) {
  try {
    await test();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}`);
  }
}

(async () => {
  const server = await serveSite(root, { tls: throwawayCertificate() });
  // A service worker registers only from a script fetched without a
  // certificate error, so Chromium has to ignore them, not just the page.
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  try {
    for (const release of releases) {
      const short = release.split('.').slice(0, 2).join('.');
      // Where the login lands, and what the backend shows there: the
      // frameset of alt_main.php up to 4.0, backend.php from 4.5.
      const { backend: shape } = require(`./site-${release}.cjs`);
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      await check(`${release}: the backend logs in over HTTPS, and stays on https://`, async () => {
        const page = await context.newPage();
        await page.goto(`${server.url}/${short}/index.html`);
        await page.waitForFunction(() => window.siteReady === true, null, { timeout: 120000 });
        const [backend] = await Promise.all([
          context.waitForEvent('page'),
          page.click('nav button[data-path="typo3/index.php"]'),
        ]);
        await backend.waitForSelector('input[name="p_field"]');
        await backend.fill('input[name="username"]', 'admin');
        await backend.fill('input[name="p_field"]', 'password');
        await Promise.all([
          backend.waitForURL(shape.landsOn, { timeout: 30000 }).catch(() => {}),
          backend.click('input[name="commandLI"]'),
        ]);
        console.log(`     ${backend.url()}`);
        // Blocked, the login leaves the visitor on index.php.
        assert.match(server.url, /^https:\/\//);
        assert.strictEqual(backend.url(), `${server.url}/${short}/site/typo3/${shape.page}`);
        await shape.assertLoaded(backend);
      });
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures === 0 ? 'https: all checks passed' : `https: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
