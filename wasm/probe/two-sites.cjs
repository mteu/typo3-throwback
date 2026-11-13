// Two releases on one origin, as GitHub Pages serves them: /3.3/ and /3.8/
// of one assembled site, in one browser.
//
//   each release's shell runs its own PHP: the Web Lock is per release
//   each keeps its own snapshot, in an IndexedDB database of its own
//   "Reset site" in one provisions it afresh, and leaves the other's tab
//   and saved site alone
//
// Usage: node two-sites.cjs <site-root>, the directory site/assemble.sh
// wrote for 3.3.0 and 3.8.1. Needs Playwright with Chromium.
'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');
const { serveSite } = require('./static-server.cjs');

const root = path.resolve(process.argv[2]);

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

const status = shell => shell.locator('#status').textContent();
// Ready, and settled: the frontend the shell opens once it is ready has
// loaded, and the worker has saved what that request wrote, 400 ms after
// the last write.
const boot = async shell => {
  await shell.waitForFunction(() => window.siteReady === true
    || document.getElementById('status').classList.contains('error'), null, { timeout: 120000 });
  await shell.waitForFunction(() => {
    const doc = document.getElementById('site').contentDocument;
    return doc && doc.readyState === 'complete' && /\/site\/$/.test(doc.location.pathname);
  }, null, { timeout: 60000 });
  await shell.waitForTimeout(1000);
  return status(shell);
};

// The SHA-256 of a release's saved database, read in the given page.
const savedDatabase = (shell, release) => shell.evaluate(async name => {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(`typo3-throwback-${name}`);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  if (!db.objectStoreNames.contains('state')) {
    db.close();
    return null;
  }
  const snapshot = await new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get('snapshot');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  if (!snapshot) {
    return null;
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot.database));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}, release);

(async () => {
  const server = await serveSite(root);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  context.on('page', opened => opened.on('dialog', dialog => dialog.accept()));
  try {
    const old = await context.newPage();
    const newer = await context.newPage();
    await old.goto(`${server.url}/3.3/index.html`);
    await newer.goto(`${server.url}/3.8/index.html`);

    await check('each release runs its own PHP, under a Web Lock of its own', async () => {
      assert.match(await boot(old), /Provisioned a fresh site/);
      assert.match(await boot(newer), /Provisioned a fresh site/);
      assert.strictEqual(old.workers().length, 1);
      assert.strictEqual(newer.workers().length, 1);
      const scopes = await old.evaluate(async () => (await navigator.serviceWorker.getRegistrations())
        .map(registration => new URL(registration.scope).pathname).sort());
      assert.deepStrictEqual(scopes, ['/typo3-throwback/3.3/', '/typo3-throwback/3.8/']);
    });

    let oldSaved = null;
    await check('each release keeps its own snapshot', async () => {
      oldSaved = await savedDatabase(old, '3.3.0');
      const newerSaved = await savedDatabase(old, '3.8.1');
      assert.ok(oldSaved && newerSaved, 'a release saved no snapshot');
      assert.notStrictEqual(oldSaved, newerSaved);
    });

    await check('"Reset site" in 3.8 provisions 3.8 afresh, and leaves 3.3\'s tab and saved site alone', async () => {
      await old.evaluate(() => {
        window.notReloaded = true;
      });
      const reloaded = newer.waitForEvent('load');
      await newer.click('#reset');
      await reloaded;
      assert.match(await boot(newer), /Provisioned a fresh site/);
      assert.strictEqual(await old.evaluate(() => window.notReloaded), true, 'the 3.3 tab reloaded');
      assert.strictEqual(old.workers().length, 1);
      assert.strictEqual(await savedDatabase(old, '3.3.0'), oldSaved);
      await old.close();
      const again = await context.newPage();
      await again.goto(`${server.url}/3.3/index.html`);
      assert.match(await boot(again), /Restored from your last visit/);
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures === 0 ? 'two sites: all checks passed' : `two sites: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
