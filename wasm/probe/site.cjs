// An assembled release (site/assemble.sh) in headless Chromium, driven the
// way a visitor would: the shell boots PHP in a worker, the service worker
// relays the iframe's requests, and the release's own JavaScript does the
// login. What differs between releases comes from site-<release>.cjs.
//
//   the frontend renders the seeded page, and every image it names loads
//   the page is generated on the release day, at noon UTC, though the
//   browser's time zone is Tokyo's
//   the web server's rules answer: source 403, images 200
//   the Backend button opens the backend in a tab of its own, where the
//   login form, filled in and submitted, logs in to the frameset, and every
//   module in the menu loads (its frames call top.goToModule())
//   the page title is renamed in alt_doc.php, and the frontend shows it
//   a file uploaded through the backend's form lands in fileadmin/ byte for
//   byte, and a .php upload is refused
//   no page, frame or tab throws a JavaScript error along the way, and
//   sw.js's Content-Security-Policy blocks nothing the release does
//   a second shell tab runs no PHP of its own: it uses the first tab's, and
//   a tab showing LICENSES.txt does not stall the relay
//   when the tab that runs PHP closes, the second takes over, rename included
//   a reload restores the site from IndexedDB, rename and upload included
//   "Reset site", clicked in a tab that does not run PHP, provisions a fresh
//   one and reloads both tabs
//   a shell cached from before a deploy, which names a worker that is gone,
//   says so instead of hanging
//
// It prints the boot time, the restore time and the memory PHP took.
//
// Usage: node site.cjs <site-root> <release>. <site-root> is the directory
// site/assemble.sh wrote, with wasm/ and the release's directory in it.
// Needs Playwright with Chromium.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { chromium } = require('playwright');
const { serveSite } = require('./static-server.cjs');

const root = path.resolve(process.argv[2]);
const releaseName = process.argv[3];
const spec = require(`./site-${releaseName}.cjs`);
const RELEASE_DIR = releaseName.replace(/\.\d+$/, '');
const RENAMED = spec.renamed;
// 1 MiB holding every byte value, so that a body decoded as text anywhere on
// its way from the file input to fileadmin/ would show.
const UPLOAD_NAME = `upload-${releaseName}.bin`;
const UPLOAD_BYTES = Buffer.from(Array.from({ length: 1 << 20 }, (_, i) => (i * 131 + (i >> 8)) & 0xff));
const UPLOAD_SHA256 = crypto.createHash('sha256').update(UPLOAD_BYTES).digest('hex');

let failures = 0;
const pageErrors = [];
// Set while a check provokes violations of sw.js's policy on purpose.
let expectCspViolations = false;
async function check(label, test) {
  const errorsBefore = pageErrors.length;
  try {
    await test();
    // A release's JavaScript that breaks in a 2026 browser, or in this setup,
    // fails the check it happened in, not just the log.
    assert.deepStrictEqual(pageErrors.slice(errorsBefore), [], 'JavaScript errors');
    console.log(`ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}`);
  }
}

(async () => {
  const server = await serveSite(root);
  const shared = `${server.url}/wasm`;
  const base = `${server.url}/${RELEASE_DIR}`;
  const browser = await chromium.launch();
  // Far from UTC on purpose: the site must keep the container's UTC.
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  context.on('page', opened => {
    opened.on('pageerror', error => {
      pageErrors.push(`${opened.url()}: ${error.message}`);
      console.log(`     page error: ${error.message}`);
    });
    // sw.js's Content-Security-Policy must not block anything the release does.
    opened.on('console', message => {
      if (!expectCspViolations && message.type() === 'error' && /Content Security Policy/.test(message.text())) {
        pageErrors.push(`${opened.url()}: ${message.text()}`);
        console.log(`     CSP: ${message.text()}`);
      }
    });
    opened.on('dialog', dialog => dialog.accept());
  });
  // The shell that runs PHP. It changes when that tab closes and another
  // takes over.
  let page = await context.newPage();
  let backend = null;

  const status = (shell = page) => shell.locator('#status').textContent();
  const frame = (shell = page) => shell.frame({ url: /\/site\// });
  const boot = async (shell = page) => {
    const started = Date.now();
    await shell.waitForFunction(() => window.siteReady === true
      || document.getElementById('status').classList.contains('error'), null, { timeout: 120000 });
    const text = await status(shell);
    if (!(await shell.evaluate(() => window.siteReady === true))) {
      throw new Error(`the shell did not start: ${text}`);
    }
    return { ms: Date.now() - started, text };
  };
  // Marks the document the iframe shows now, so that the wait below sees the
  // frontend load again, even when the iframe already showed it.
  const frontend = async (shell = page) => {
    // The shell opens the frontend itself once it is ready. That load has to
    // finish first, or it lands after the click below and replaces the page
    // this returns.
    await shell.waitForFunction(() => {
      const doc = document.getElementById('site').contentDocument;
      return doc && doc.readyState === 'complete' && /\/site\//.test(doc.location.pathname);
    }, null, { timeout: 60000 });
    await shell.evaluate(() => {
      const win = document.getElementById('site').contentWindow;
      if (win) {
        win.staleFrontend = true;
      }
    });
    await shell.click('nav button[data-path=""]');
    await shell.waitForFunction(() => {
      const win = document.getElementById('site').contentWindow;
      const doc = win && win.document;
      return doc && !win.staleFrontend && doc.readyState === 'complete' && /\/site\/$/.test(doc.location.pathname) && doc.body;
    });
    return frame(shell).content();
  };

  // Run on the frontend the iframe shows.
  const everyFrontendImageLoads = async () => {
    const references = await frame().evaluate(() => [...new Set([...document.querySelectorAll('[src], [background]')]
      .map(element => element.getAttribute('src') || element.getAttribute('background')))]);
    for (const image of spec.frontendImages) {
      assert.ok(references.includes(image), `no ${image} among ${references}`);
    }
    const results = await frame().evaluate(async refs => Promise.all(refs.map(async ref => [ref, (await fetch(ref)).status])), references);
    console.log(`     ${results.length} references: ${results.map(([ref, code]) => `${ref} ${code}`).join(', ')}`);
    assert.deepStrictEqual(results.filter(([, code]) => code !== 200), []);
  };

  // The text of a file list (file_list.php) in any frame of the backend tab
  // once it names the file.
  const fileListShowing = async name => (await backend.waitForFunction(fileName => {
    const lists = [];
    const walk = win => {
      if (/\/file_list\.php$/.test(win.location.pathname) && win.document.readyState === 'complete' && win.document.body) {
        lists.push(win.document.body.innerText);
      }
      for (let i = 0; i < win.frames.length; i++) {
        walk(win.frames[i]);
      }
    };
    walk(window);
    return lists.find(text => text.includes(fileName));
  }, name, { timeout: 60000 })).jsonValue();

  // The uploaded file as the site serves it, from the frontend the iframe shows.
  const servedUpload = () => frame().evaluate(async name => {
    const response = await fetch(`fileadmin/${name}`);
    const bytes = await response.arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return { status: response.status, length: bytes.byteLength, sha256: [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  }, UPLOAD_NAME);

  // The WebAssembly memory of the PHP worker's PHP, in MiB. It only grows,
  // so this is the most PHP has used so far. sql.js's database is beside
  // it, in its own memory.
  const memory = async (shell = page) => {
    const [worker] = shell.workers();
    const bytes = await worker.evaluate(() => ({ php: site.php.memoryBytes, database: site.mysql.exportDatabase('typo3').length }));
    return `PHP's memory ${(bytes.php / 2 ** 20).toFixed(0)} MiB, database ${(bytes.database / 2 ** 20).toFixed(1)} MiB`;
  };
  // What a release's own checks get (site-<release>.cjs).
  const probe = {
    frame,
    frontend,
    get backend() {
      return backend;
    },
  };

  try {
    await page.goto(`${base}/index.html`);

    await check('the shell boots PHP, provisions the site and shows the frontend', async () => {
      const { ms, text } = await boot();
      console.log(`     ${text} (${ms} ms, ${await memory()})`);
      assert.match(text, /Provisioned a fresh site/);
      const html = await frontend();
      spec.assertFrontend(html, spec.title);
      assert.match(html, /Rendered by TypoScript on PHP 4\.4\.9/);
      // The release day, within its first hour, as CI asserts for the image.
      assert.match(html, new RegExp(`Page generated&nbsp;${spec.day} 12:[0-9]{2}:[0-9]{2}`));
    });

    await check('every image the frontend names loads', everyFrontendImageLoads);

    await check("the web server's rules: source files 403, images 200", async () => {
      const codes = await frame().evaluate(async () => Promise.all(['typo3conf/localconf.php', 't3lib/class.t3lib_div.php', 'typo3/gfx/refresh_n.gif']
        .map(async ref => (await fetch(ref)).status)));
      assert.deepStrictEqual(codes, [403, 403, 200]);
    });

    await check('another site cannot reach site/: a link from elsewhere, or a typed address, gets 403', async () => {
      // The shell stays open in `page`, so sw.js has a PHP worker to relay to.
      const other = await context.newPage();
      try {
        await other.route('http://elsewhere.test/**', route => route.fulfill({
          contentType: 'text/html',
          body: `<form method="post" action="${base}/site/typo3/index.php"><input name="username" value="admin"><button>go</button></form>`,
        }));
        await other.goto('http://elsewhere.test/');
        const [posted] = await Promise.all([other.waitForEvent('load'), other.click('button')]);
        assert.ok(posted);
        assert.match(await other.content(), /only answers its own pages/);
        const typed = await other.goto(`${base}/site/`);
        assert.strictEqual(typed.status(), 403);
        const own = await other.goto(`${base}/index.html`);
        assert.strictEqual(own.status(), 200);
      } finally {
        await other.close();
      }
    });

    await check(`sw.js's Content-Security-Policy keeps a script in a ${releaseName} page from sending data elsewhere`, async () => {
      expectCspViolations = true;
      try {
        const blocked = await frame().evaluate(() => {
          const seen = [];
          document.addEventListener('securitypolicyviolation', event => seen.push(`${event.effectiveDirective} ${event.blockedURI}`));
          fetch('http://elsewhere.test/collect').catch(() => {});
          // Same origin, but not this site: another Pages site of the account.
          fetch('/another-pages-site/collect').catch(() => {});
          new Image().src = 'http://elsewhere.test/beacon.gif';
          return new Promise(resolve => setTimeout(() => resolve(seen.sort()), 1000));
        });
        const origin = new URL(base).origin;
        assert.deepStrictEqual(blocked, [
          `connect-src ${origin}/another-pages-site/collect`,
          'connect-src http://elsewhere.test/collect',
          'img-src http://elsewhere.test/beacon.gif',
        ]);
      } finally {
        await page.waitForTimeout(200);
        expectCspViolations = false;
      }
    });

    await check('the shell opens only its three entry points from ?path=', async () => {
      const other = await context.newPage();
      try {
        await other.goto(`${base}/index.html?path=${encodeURIComponent('typo3/alt_doc.php?edit[pages][1]=edit')}`);
        await other.waitForFunction(() => {
          const doc = document.getElementById('site').contentDocument;
          return doc && doc.readyState === 'complete' && /\/site\/$/.test(doc.location.pathname) && doc.body;
        }, null, { timeout: 60000 });
        await other.goto(`${base}/index.html?path=typo3/install/index.php`);
        await other.waitForFunction(() => {
          const doc = document.getElementById('site').contentDocument;
          return doc && doc.readyState === 'complete' && /\/site\/typo3\/install\/index\.php$/.test(doc.location.pathname);
        }, null, { timeout: 60000 });
      } finally {
        await other.close();
      }
    });

    await check('LICENSES.txt carries the notices PHP and the Zend Engine ask for', async () => {
      const text = await page.evaluate(async () => (await fetch('../wasm/LICENSES.txt')).text());
      assert.match(text, /This product includes PHP software, freely available from/);
      assert.match(text, /This product includes the Zend Engine, freely available at/);
      assert.match(text, /The PHP License, version 3\.01/);
      assert.match(text, /Zend Engine License, version 2\.00/);
      // libjpeg's and FreeType's licences ask for these lines in the
      // documentation of a binary.
      assert.match(text, /This software is based in part on the work of the Independent JPEG\s+Group\./);
      assert.match(text, /Portions of this software are copyright \(C\) 1996-2026 The FreeType Project/);
      // The licence files the release archive carries, from its LICENCES.md.
      assert.match(text, spec.archiveLicences);
    });

    await check("the Backend button opens a tab of its own, and TYPO3's login form logs in there", async () => {
      [backend] = await Promise.all([
        context.waitForEvent('page'),
        page.click('nav button[data-path="typo3/index.php"]'),
      ]);
      await backend.waitForSelector('input[name="p_field"]');
      await backend.fill('input[name="username"]', 'admin');
      await backend.fill('input[name="p_field"]', 'password');
      await Promise.all([
        backend.waitForURL(/\/alt_main\.php$/, { timeout: 30000 }),
        backend.click('input[name="commandLI"]'),
      ]);
      await backend.waitForFunction(() => document.readyState === 'complete' && document.querySelectorAll('frame').length > 0);
      const frames = await backend.evaluate(() => [...document.querySelectorAll('frame')].map(f => f.getAttribute('name')));
      console.log(`     alt_main.php frames: ${frames.join(', ')}`);
      assert.ok(frames.length >= 2, 'no frameset');
      assert.strictEqual(await backend.evaluate(() => typeof window.goToModule), 'function');
    });

    await check('a module in the menu loads: Web > Page, through top.goToModule()', async () => {
      const menu = backend.frame({ name: 'menu' });
      const link = menu.locator('a[onclick*="goToModule(\'web_layout\')"]').first();
      await link.waitFor();
      await link.click();
      await backend.waitForFunction(() => {
        const frames = [];
        const walk = win => {
          frames.push(win);
          for (let i = 0; i < win.frames.length; i++) {
            walk(win.frames[i]);
          }
        };
        walk(window);
        return frames.some(win => /\/db_layout\.php$/.test(win.location.pathname) && win.document.readyState === 'complete');
      }, null, { timeout: 30000 });
      const loaded = backend.frames().map(f => new URL(f.url()).pathname.replace(/^.*\/typo3\//, '')).filter(Boolean);
      console.log(`     frames now: ${loaded.join(', ')}`);
    });

    await check('every module in the menu opens without a JavaScript or PHP error', async () => {
      const menu = backend.frame({ name: 'menu' });
      const modules = await menu.evaluate(() => [...new Set([...document.querySelectorAll('a[onclick*="goToModule("]')]
        .map(link => link.getAttribute('onclick').match(/goToModule\('([^']+)'/)[1]))]);
      const local = modules.filter(name => !spec.remoteModules.includes(name));
      const broken = [];
      for (const name of local) {
        await menu.locator(`a[onclick*="goToModule('${name}')"]`).first().click();
        await backend.waitForTimeout(500);
        await backend.waitForFunction(() => {
          const pending = [];
          const walk = win => {
            pending.push(win.document.readyState !== 'complete');
            for (let i = 0; i < win.frames.length; i++) {
              walk(win.frames[i]);
            }
          };
          walk(window);
          return !pending.includes(true);
        }, null, { timeout: 30000 });
        for (const frame of backend.frames()) {
          const text = await frame.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
          const problem = text.match(/(Fatal error|Parse error|Warning|Notice): .{0,120}/);
          if (problem) {
            broken.push(`${name}: ${problem[0]}`);
          }
        }
      }
      console.log(`     ${local.length} modules opened`);
      assert.ok(local.length >= spec.minModules, `only ${local.length} modules in the menu`);
      assert.deepStrictEqual(broken, []);
    });

    await check('the page title is renamed in alt_doc.php and saved', async () => {
      await backend.evaluate(() => {
        top.content.location.href = 'alt_doc.php?returnUrl=db_layout.php%3Fid%3D1&edit%5Bpages%5D%5B1%5D=edit';
      });
      const content = () => backend.frame({ name: 'content' });
      await backend.waitForFunction(() => {
        const doc = top.content.document;
        return doc.readyState === 'complete' && doc.querySelector('input[name="data[pages][1][title]_hr"]');
      }, null, { timeout: 30000 });
      const field = content().locator('input[name="data[pages][1][title]_hr"]');
      await field.fill(RENAMED);
      await field.dispatchEvent('change');
      await content().locator('input[name="_savedok"]').first().click();
      await backend.waitForFunction(title => {
        const doc = top.content.document;
        const hidden = doc.readyState === 'complete' && doc.querySelector('input[name="data[pages][1][title]"]');
        return hidden && hidden.value === title;
      }, RENAMED, { timeout: 30000 });
      spec.assertFrontend(await frontend(), RENAMED);
    });

    for (const [label, test] of spec.backendChecks) {
      await check(label, () => test(probe));
    }

    await check("a file uploaded through the backend's form lands in fileadmin/ byte for byte, and a .php upload is refused", async () => {
      // The fileadmin/ mount as PHP sees it: runtime/typo3-site.js puts the
      // document root at /var/www plus the site's URL path.
      const fileadmin = `/var/www${new URL(base).pathname}/site/fileadmin`;
      // returnUrl is where 3.8.1 sends the browser after the upload. 3.3.0's
      // form has no such parameter, and ignores it.
      await backend.evaluate(target => {
        top.content.location.href = `file_upload.php?number=2&target=${encodeURIComponent(target)}`
          + `&returnUrl=${encodeURIComponent(`file_list.php?id=${target}/`)}`;
      }, fileadmin);
      await backend.waitForFunction(() => {
        const doc = top.content.document;
        return doc.readyState === 'complete' && doc.querySelector('input[type="file"][name="upload_1"]');
      }, null, { timeout: 30000 });
      const content = backend.frame({ name: 'content' });
      await content.setInputFiles('input[name="upload_0"]', { name: UPLOAD_NAME, mimeType: 'application/octet-stream', buffer: UPLOAD_BYTES });
      await content.setInputFiles('input[name="upload_1"]', {
        name: 'uploaded.php', mimeType: 'text/plain', buffer: Buffer.from('<?php echo "uploaded code ran"; ?>'),
      });
      // What TYPO3 says about the two files, and its list of fileadmin/
      // afterwards. The list, not a fetch, shows the .php file is not there:
      // the web server's rule answers 403 for any .php under fileadmin/,
      // stored or not.
      const { said, listing } = await spec.submitUpload({ backend, content, uploadName: UPLOAD_NAME, fileListShowing });
      console.log(`     TYPO3 said: ${said.replace(/\s+/g, ' ')}`);
      assert.match(said, spec.phpUploadRefused);
      assert.doesNotMatch(said, /not allowed to upload files|could not be moved/);
      assert.match(listing, new RegExp(UPLOAD_NAME.replace(/\./g, '\\.')));
      assert.doesNotMatch(listing, /uploaded\.php/);

      const served = await servedUpload();
      assert.deepStrictEqual(served, { status: 200, length: UPLOAD_BYTES.length, sha256: UPLOAD_SHA256 });
    });

    await check('the shell turns the backend away from its iframe', async () => {
      const errorsBefore = pageErrors.length;
      await page.evaluate(() => {
        document.getElementById('site').src = 'site/typo3/alt_main.php';
      });
      await page.waitForFunction(() => /tab of its own/.test(document.getElementById('status').textContent));
      await page.waitForFunction(() => {
        const doc = document.getElementById('site').contentDocument;
        return doc && doc.readyState === 'complete' && /\/site\/$/.test(doc.location.pathname);
      });
      // Until the shell turns it away, the frameset's frames run in the
      // iframe, where top is the shell. 3.8.1's call a function of the
      // backend's own top window as they load, which the shell does not
      // have: the reason the backend gets a tab of its own. Only those
      // errors are expected here.
      const expected = /: top\.\w+ is not a function$/;
      const thrown = pageErrors.splice(errorsBefore);
      pageErrors.push(...thrown.filter(error => !expected.test(error)));
      if (thrown.length > 0) {
        console.log(`     expected, while the backend was in the iframe: ${thrown.filter(error => expected.test(error)).length} calls to top`);
      }
      await backend.close();
    });

    let second = null;
    await check("a second shell tab runs no PHP of its own, and uses the first tab's", async () => {
      second = await context.newPage();
      await second.goto(`${base}/index.html`);
      const { text } = await boot(second);
      assert.match(text, /PHP runs in another tab/);
      assert.strictEqual(second.workers().length, 0, 'the second tab started a PHP worker');
      assert.strictEqual(page.workers().length, 1);
      spec.assertFrontend(await frontend(second), RENAMED);
    });

    await check('a tab showing LICENSES.txt, focused last, does not stall the relay', async () => {
      const licences = await context.newPage();
      try {
        await licences.goto(`${shared}/LICENSES.txt`);
        await licences.bringToFront();
        const code = await frame(second).evaluate(() => Promise.race([
          fetch('typo3/gfx/refresh_n.gif').then(response => response.status),
          new Promise(resolve => setTimeout(() => resolve('no answer in 10 s'), 10000)),
        ]));
        assert.strictEqual(code, 200);
      } finally {
        await licences.close();
      }
    });

    await check('when the tab that runs PHP closes, the second takes over, rename included', async () => {
      // The snapshot is saved 400 ms after the last write.
      await page.waitForTimeout(1000);
      await page.close();
      page = second;
      await page.waitForFunction(() => /took over/.test(document.getElementById('status').textContent)
        || document.getElementById('status').classList.contains('error'), null, { timeout: 60000 });
      assert.match(await status(), /took over/);
      assert.strictEqual(page.workers().length, 1);
      spec.assertFrontend(await frontend(), RENAMED);
    });

    await check('a reload restores the site from IndexedDB, rename and upload included', async () => {
      await page.waitForTimeout(1000);
      await page.reload();
      const { ms, text } = await boot();
      console.log(`     ${text} (${ms} ms, ${await memory()})`);
      assert.match(text, /Restored from your last visit/);
      spec.assertFrontend(await frontend(), RENAMED);
      await everyFrontendImageLoads();
      assert.deepStrictEqual(await servedUpload(), { status: 200, length: UPLOAD_BYTES.length, sha256: UPLOAD_SHA256 });
    });

    await check('"Reset site", clicked in a tab that does not run PHP, provisions a fresh site and reloads both', async () => {
      const follower = await context.newPage();
      await follower.goto(`${base}/index.html`);
      assert.match((await boot(follower)).text, /PHP runs in another tab/);
      // The reset reloads both shells; waiting for those loads, not the
      // current ones, keeps boot() from reading the old pages' status.
      const reloaded = [page.waitForEvent('load'), follower.waitForEvent('load')];
      await follower.click('#reset');
      await Promise.all(reloaded);
      await Promise.all([boot(page), boot(follower)]);
      // Either tab may win the lock after the reload. Exactly one runs PHP.
      const shells = [page, follower];
      let leader = null;
      for (let tries = 0; !leader && tries < 600; tries++) {
        for (const shell of shells) {
          if (/Provisioned a fresh site|took over/.test(await status(shell))) {
            leader = shell;
          }
        }
        await page.waitForTimeout(100);
      }
      assert.ok(leader, 'no tab provisioned a fresh site');
      const running = shells.filter(shell => shell.workers().length === 1);
      assert.strictEqual(running.length, 1, `${running.length} tabs run PHP`);
      for (const shell of shells) {
        spec.assertFrontend(await frontend(shell), spec.title);
      }
      await follower.close();
    });

    await check('a shell from before a deploy names a worker that is gone, and says to reload', async () => {
      // A context of its own: its own service worker and IndexedDB.
      const stale = await browser.newContext();
      try {
        const shell = await stale.newPage();
        await shell.route(`${base}/index.html`, async route => {
          const response = await route.fetch();
          const html = (await response.text()).replace(/^const WORKER = '\.\.\/wasm\/php-worker\.[0-9a-f]{16}\.js';$/m, "const WORKER = '../wasm/php-worker.0000000000000000.js';");
          assert.ok(html.includes('php-worker.0000000000000000.js'), 'index.html names no hashed worker');
          await route.fulfill({ response, body: html });
        });
        await shell.goto(`${base}/index.html`);
        await shell.waitForFunction(() => document.getElementById('status').classList.contains('error'), null, { timeout: 30000 });
        assert.match(await status(shell), /did not load\. If the site was just updated, reload/);
      } finally {
        await stale.close();
      }
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures === 0 ? `site ${releaseName}: all checks passed` : `site ${releaseName}: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
