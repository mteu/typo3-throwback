// Every release on one origin, as GitHub Pages serves them: /3.3/, /3.8/,
// /4.0/ and so on of one assembled site, in one browser.
//
//   each release's shell runs its own PHP: the Web Lock is per release
//   each keeps its own snapshot, in an IndexedDB database of its own
//   "Reset site" in the newest provisions it afresh, and leaves every other
//   release's tab and saved site alone
//
// Usage: node two-sites.cjs <site-root> <release>..., the directory
// site/assemble.sh wrote, and at least two of the releases it assembled,
// oldest first. Needs Playwright with Chromium.
'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');
const { serveSite } = require('./static-server.cjs');

const root = path.resolve(process.argv[2]);
const releases = process.argv.slice(3);
assert.ok(releases.length >= 2, 'name at least two releases');
// The directory each release is published under: 3.8.1 at /3.8/.
const dirOf = release => release.replace(/\.\d+$/, '');

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
    const shells = new Map();
    for (const release of releases) {
      const shell = await context.newPage();
      await shell.goto(`${server.url}/${dirOf(release)}/index.html`);
      shells.set(release, shell);
    }
    const oldest = releases[0];
    const newest = releases[releases.length - 1];
    const others = releases.slice(0, -1);

    await check('each release runs its own PHP, under a Web Lock of its own', async () => {
      for (const [release, shell] of shells) {
        assert.match(await boot(shell), /Provisioned a fresh site/, release);
        assert.strictEqual(shell.workers().length, 1, release);
      }
      const scopes = await shells.get(oldest).evaluate(async () => (await navigator.serviceWorker.getRegistrations())
        .map(registration => new URL(registration.scope).pathname).sort());
      assert.deepStrictEqual(scopes, releases.map(release => `/typo3-throwback/${dirOf(release)}/`).sort());
    });

    const saved = new Map();
    await check('each release keeps its own snapshot', async () => {
      for (const release of releases) {
        saved.set(release, await savedDatabase(shells.get(oldest), release));
        assert.ok(saved.get(release), `${release} saved no snapshot`);
      }
      assert.strictEqual(new Set(saved.values()).size, releases.length, 'two releases share a snapshot');
    });

    await check(`"Reset site" in ${dirOf(newest)} provisions it afresh, and leaves ${others.map(dirOf).join(' and ')} alone, tabs and saved sites`, async () => {
      for (const release of others) {
        await shells.get(release).evaluate(() => {
          window.notReloaded = true;
        });
      }
      const resetting = shells.get(newest);
      const reloaded = resetting.waitForEvent('load');
      await resetting.click('#reset');
      await reloaded;
      assert.match(await boot(resetting), /Provisioned a fresh site/);
      for (const release of others) {
        const shell = shells.get(release);
        assert.strictEqual(await shell.evaluate(() => window.notReloaded), true, `the ${dirOf(release)} tab reloaded`);
        assert.strictEqual(shell.workers().length, 1, release);
        assert.strictEqual(await savedDatabase(resetting, release), saved.get(release), `${release}'s saved site changed`);
      }
      await shells.get(oldest).close();
      const again = await context.newPage();
      await again.goto(`${server.url}/${dirOf(oldest)}/index.html`);
      assert.match(await boot(again), /Restored from your last visit/);
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures === 0 ? `${releases.length} sites: all checks passed` : `${releases.length} sites: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
