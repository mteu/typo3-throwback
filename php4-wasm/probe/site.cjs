// The assembled site (site/assemble.sh) in headless Chromium, driven the way a
// visitor would: the shell boots PHP in a worker, the service worker relays
// the iframe's requests, and TYPO3's own 2002 JavaScript does the login.
//
//   the frontend renders "template; GREEN", and every image it names loads
//   the page is generated on the release day, at noon UTC, though the
//   browser's time zone is Tokyo's
//   nginx.conf's rules answer: source 403, images 200
//   the Backend button opens the backend in a tab of its own, where the
//   login form, filled in and submitted, logs in to the frameset, and a
//   module in the menu loads (its frames call top.goToModule())
//   the page title is renamed in alt_doc.php, and the frontend shows it
//   a subpage made in the backend's form appears in GREEN's GIFBUILDER menu,
//   as a GIF that GD drew with its title in TrueType text
//   a file uploaded through the backend's form lands in fileadmin/ byte for
//   byte, and a .php upload is refused
//   no page, frame or tab throws a JavaScript error along the way
//   a second shell tab runs no PHP of its own: it uses the first tab's, and
//   a tab showing LICENSES.txt does not stall the relay
//   when the tab that runs PHP closes, the second takes over, rename included
//   a reload restores the site from IndexedDB, rename and upload included
//   "Reset site", clicked in a tab that does not run PHP, provisions a fresh
//   one and reloads both tabs
//   a shell cached from before a deploy, which names a worker that is gone,
//   says so instead of hanging
//
// Usage: node site.cjs <site-dir>. Needs Playwright with Chromium.
// Serves on 127.0.0.1, which counts as a secure origin for service workers.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2]);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.gz': 'application/gzip', '.php': 'text/plain', '.ini': 'text/plain', '.txt': 'text/plain',
};
const RENAMED = 'Renamed in a 2002 backend';
const SUBPAGE = 'Made in 2002';
// 1 MiB holding every byte value, so that a body decoded as text anywhere on
// its way from the file input to fileadmin/ would show.
const UPLOAD_NAME = 'upload-2002.bin';
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
    // 2002 JavaScript that breaks in a 2026 browser, or in this setup,
    // fails the check it happened in, not just the log.
    assert.deepStrictEqual(pageErrors.slice(errorsBefore), [], 'JavaScript errors');
    console.log(`ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}`);
  }
}

// Under a path, as GitHub Pages serves a project site, so that the origin
// holds more than this site, as it does there.
const SITE_PATH = '/typo3-throwback';
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

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}${SITE_PATH}`;
  const browser = await chromium.launch();
  // Far from UTC on purpose: the site must keep the container's UTC.
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  context.on('page', opened => {
    opened.on('pageerror', error => {
      pageErrors.push(`${opened.url()}: ${error.message}`);
      console.log(`     page error: ${error.message}`);
    });
    // sw.js's Content-Security-Policy must not block anything 3.3.0 does.
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
    assert.ok(references.includes('clear.gif'), `no clear.gif among ${references}`);
    const results = await frame().evaluate(async refs => Promise.all(refs.map(async ref => [ref, (await fetch(ref)).status])), references);
    console.log(`     ${results.length} references: ${results.map(([ref, code]) => `${ref} ${code}`).join(', ')}`);
    assert.deepStrictEqual(results.filter(([, code]) => code !== 200), []);
  };

  // The uploaded file as the site serves it, from the frontend the iframe shows.
  const servedUpload = () => frame().evaluate(async name => {
    const response = await fetch(`fileadmin/${name}`);
    const bytes = await response.arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return { status: response.status, length: bytes.byteLength, sha256: [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  }, UPLOAD_NAME);

  try {
    await page.goto(`${base}/index.html`);

    await check('the shell boots PHP, provisions the site and shows the frontend', async () => {
      const { ms, text } = await boot();
      console.log(`     ${text} (${ms} ms)`);
      assert.match(text, /Provisioned a fresh site/);
      const html = await frontend();
      assert.ok(html.includes('<font face="verdana" color="white"><b>TYPO3 3.3.0</b></font>'), 'GREEN title missing');
      assert.match(html, /Rendered by TypoScript on PHP 4\.4\.9/);
      // The release day, within its first hour, as CI asserts for the image.
      assert.match(html, /Page generated&nbsp;2002-06-03 12:[0-9]{2}:[0-9]{2}/);
    });

    await check('every image the frontend names loads', everyFrontendImageLoads);

    await check("nginx.conf's rules: source files 403, images 200", async () => {
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

    await check("sw.js's Content-Security-Policy keeps a script in a 3.3.0 page from sending data elsewhere", async () => {
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
      const text = await page.evaluate(async () => (await fetch('LICENSES.txt')).text());
      assert.match(text, /This product includes PHP software, freely available from/);
      assert.match(text, /This product includes the Zend Engine, freely available at/);
      assert.match(text, /The PHP License, version 3\.01/);
      assert.match(text, /Zend Engine License, version 2\.00/);
      // libjpeg's and FreeType's licences ask for these lines in the
      // documentation of a binary.
      assert.match(text, /This software is based in part on the work of the Independent JPEG\s+Group\./);
      assert.match(text, /Portions of this software are copyright \(C\) 1996-2026 The FreeType Project/);
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
      // help_quick redirects to the 2002 online manual on typo3.org.
      const local = modules.filter(name => name !== 'help_quick');
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
      assert.ok(local.length >= 20, `only ${local.length} modules in the menu`);
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
      const html = await frontend();
      assert.ok(html.includes(`<b>${RENAMED}</b>`), 'the frontend does not show the new title');
    });

    await check("a subpage made in the backend's own form shows up in GREEN's menu, as a GIF GD drew", async () => {
      await backend.evaluate(() => {
        top.content.location.href = 'alt_doc.php?returnUrl=db_layout.php%3Fid%3D1&edit%5Bpages%5D%5B1%5D=new';
      });
      await backend.waitForFunction(() => {
        const doc = top.content.document;
        return doc.readyState === 'complete' && doc.querySelector('input[name^="data[pages][NEW"][name$="[title]_hr"]');
      }, null, { timeout: 30000 });
      const content = backend.frame({ name: 'content' });
      const title = content.locator('input[name^="data[pages][NEW"][name$="[title]_hr"]');
      await title.fill(SUBPAGE);
      await title.dispatchEvent('change');
      // New pages start hidden, in 3.3.0 as now.
      const hidden = content.locator('input[type="checkbox"][name^="data[pages][NEW"][name$="[hidden]_0"]');
      assert.ok(await hidden.isChecked(), 'a new page did not start hidden');
      await hidden.click();
      await content.locator('input[name="_savedok"]').first().click();
      await backend.waitForFunction(title => {
        const doc = top.content.document;
        const saved = doc.readyState === 'complete' && doc.querySelector('input[name$="[title]"][type="hidden"]');
        return saved && saved.value === title && !/\[NEW/.test(saved.name);
      }, SUBPAGE, { timeout: 30000 });

      const html = await frontend();
      const menu = await frame().evaluate(async () => {
        const images = [...document.querySelectorAll('img')].filter(img => /typo3temp\/m_[0-9a-f]+\.gif$/.test(img.getAttribute('src')));
        return Promise.all(images.map(async img => {
          await img.decode();
          const bytes = new Uint8Array(await (await fetch(img.getAttribute('src'))).arrayBuffer());
          // Pixels that differ from the top-left one, the background: the
          // bullets alone are about 20, the title is the rest.
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const context = canvas.getContext('2d');
          context.drawImage(img, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let differ = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) {
              differ++;
            }
          }
          return { src: img.getAttribute('src'), magic: String.fromCharCode(...bytes.slice(0, 6)), width: img.naturalWidth, height: img.naturalHeight, differ };
        }));
      });
      console.log(`     ${menu.map(item => `${item.src} ${item.magic} ${item.width}x${item.height}, ${item.differ} pixels drawn`).join('; ')}`);
      assert.ok(html.includes(`alt="${SUBPAGE}"`) || html.includes(SUBPAGE), 'the frontend does not name the new page');
      assert.strictEqual(menu.length, 1, 'one menu item, for the one subpage');
      assert.match(menu[0].magic, /^GIF8[79]a$/);
      assert.strictEqual(menu[0].height, 19);
      assert.ok(menu[0].differ > 150, `only ${menu[0].differ} pixels besides the background: no title drawn`);
    });

    await check("a file uploaded through the backend's form lands in fileadmin/ byte for byte, and a .php upload is refused", async () => {
      // The fileadmin/ mount as PHP sees it: runtime/typo3-site.js puts the
      // document root at /var/www plus the site's URL path.
      const fileadmin = `/var/www${new URL(base).pathname}/site/fileadmin`;
      await backend.evaluate(target => {
        top.content.location.href = `file_upload.php?number=2&target=${encodeURIComponent(target)}`;
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
      // tce_file.php moves the files and redirects to status_file.php. That
      // reports TYPO3's log of the operation in an alert(), which the
      // context's dialog handler accepts and this records, and after an
      // upload it opens the File module (refreshList()), with no folder
      // chosen. Its list of fileadmin/, not a fetch, shows the .php file is
      // not there: nginx.conf's rule answers 403 for any .php under
      // fileadmin/, stored or not.
      const alerts = [];
      const record = dialog => alerts.push(dialog.message());
      backend.on('dialog', record);
      let listed;
      try {
        await content.locator('input[type="submit"]').first().click();
        const tree = () => backend.frame({ name: 'nav_frame' });
        await backend.waitForFunction(() => {
          const nav = top.content && top.content.nav_frame;
          return nav && nav.document.readyState === 'complete' && /alt_file_navframe\.php$/.test(nav.location.pathname);
        }, null, { timeout: 60000 });
        await tree().locator('a', { hasText: 'fileadmin/' }).first().click();
        listed = await backend.waitForFunction(name => {
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
          return lists.find(text => text.includes(name));
        }, UPLOAD_NAME, { timeout: 60000 });
      } finally {
        backend.off('dialog', record);
      }
      console.log(`     TYPO3 said: ${alerts.join(' | ').replace(/\s+/g, ' ')}`);
      assert.match(alerts.join('\n'), /Fileextension 'php' is not allowed/);
      assert.doesNotMatch(alerts.join('\n'), /not allowed to upload files|could not be moved/);

      const served = await servedUpload();
      assert.deepStrictEqual(served, { status: 200, length: UPLOAD_BYTES.length, sha256: UPLOAD_SHA256 });
      assert.doesNotMatch(await listed.jsonValue(), /uploaded\.php/);
    });

    await check('the shell turns the backend away from its iframe', async () => {
      await page.evaluate(() => {
        document.getElementById('site').src = 'site/typo3/alt_main.php';
      });
      await page.waitForFunction(() => /tab of its own/.test(document.getElementById('status').textContent));
      await page.waitForFunction(() => {
        const doc = document.getElementById('site').contentDocument;
        return doc && doc.readyState === 'complete' && /\/site\/$/.test(doc.location.pathname);
      });
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
      assert.ok((await frontend(second)).includes(`<b>${RENAMED}</b>`));
    });

    await check('a tab showing LICENSES.txt, focused last, does not stall the relay', async () => {
      const licences = await context.newPage();
      try {
        await licences.goto(`${base}/LICENSES.txt`);
        await licences.bringToFront();
        const code = await frame(second).evaluate(() => Promise.race([
          fetch('clear.gif').then(response => response.status),
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
      assert.ok((await frontend()).includes(`<b>${RENAMED}</b>`));
    });

    await check('a reload restores the site from IndexedDB, rename and upload included', async () => {
      await page.waitForTimeout(1000);
      await page.reload();
      const { ms, text } = await boot();
      console.log(`     ${text} (${ms} ms)`);
      assert.match(text, /Restored from your last visit/);
      assert.ok((await frontend()).includes(`<b>${RENAMED}</b>`));
      // The menu GIF lives in typo3temp/, which the snapshot does not keep.
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
        assert.ok((await frontend(shell)).includes('<b>TYPO3 3.3.0</b>'));
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
          const html = (await response.text()).replace(/new Worker\('php-worker\.[0-9a-f]{16}\.js'\)/, "new Worker('php-worker.0000000000000000.js')");
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
  console.log(failures === 0 ? 'site: all checks passed' : `site: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
});
