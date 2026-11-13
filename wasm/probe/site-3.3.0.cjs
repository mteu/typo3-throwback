// TYPO3 3.3.0 for site.cjs: what its frontend shows, and the checks only
// 3.3.0 has.
'use strict';

const assert = require('assert');

const SUBPAGE = 'Made in 2002';

module.exports = {
  title: 'TYPO3 3.3.0',
  day: '2002-06-03',
  renamed: 'Renamed in a 2002 backend',
  // "template; GREEN" draws the page title in its header.
  assertFrontend(html, title) {
    assert.ok(html.includes(`<font face="verdana" color="white"><b>${title}</b></font>`), `GREEN shows no title "${title}"`);
  },
  // One of 3.3/Dockerfile's document root links.
  frontendImages: ['clear.gif'],
  // help_quick redirects to the 2002 online manual on typo3.org.
  remoteModules: ['help_quick'],
  minModules: 20,
  phpUploadRefused: /Fileextension 'php' is not allowed/,
  // tce_file.php moves the files and redirects to status_file.php. That
  // reports TYPO3's log of the operation in an alert(), which the
  // context's dialog handler accepts and this records, and after an upload
  // it opens the File module (refreshList()), with no folder chosen.
  async submitUpload({ backend, content, uploadName, fileListShowing }) {
    const alerts = [];
    const record = dialog => alerts.push(dialog.message());
    backend.on('dialog', record);
    try {
      await content.locator('input[type="submit"]').first().click();
      await backend.waitForFunction(() => {
        const nav = top.content && top.content.nav_frame;
        return nav && nav.document.readyState === 'complete' && /alt_file_navframe\.php$/.test(nav.location.pathname);
      }, null, { timeout: 60000 });
      await backend.frame({ name: 'nav_frame' }).locator('a', { hasText: 'fileadmin/' }).first().click();
      const listing = await fileListShowing(uploadName);
      return { said: alerts.join('\n'), listing };
    } finally {
      backend.off('dialog', record);
    }
  },
  archiveLicences: /typo3\/mod\/tools\/phpadmin\/phpMyAdmin-2\.2\.6\/LICENSE/,
  backendChecks: [
    ["a subpage made in the backend's own form shows up in GREEN's menu, as a GIF GD drew", async ({ frame, frontend, backend }) => {
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
    }],
  ],
};
