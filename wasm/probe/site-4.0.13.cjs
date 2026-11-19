// TYPO3 4.0.13 for site.cjs: what its frontend shows.
'use strict';

const assert = require('assert');
const frameset = require('./site-frameset.cjs');

// The job's CHARSET_PROBE, which 4.0/provision.php seeds as the root page's
// title: ISO-8859-1 bytes and character references, which the browser
// decodes into these characters.
const CHARSET_PROBE = 'Skaarhøj · Gödöllő · 日本語';

module.exports = {
  title: CHARSET_PROBE,
  day: '2009-07-02',
  // Typed into the editor of an ISO-8859-1 page: the ö goes as one byte, and
  // must come back as the same character.
  renamed: 'Renamed in a 2009 backend, schön',
  // 4.0/provision.php's template renders the release in an <h1>, and the
  // page title in <p id="charset-probe">, as TypoScript reads it back from
  // the database. The page is the DOM serialized, so the probe's references
  // show as the characters the browser decoded.
  assertFrontend(html, title) {
    assert.ok(html.includes('<h1>TYPO3 4.0.13</h1>'), 'the seeded heading is missing');
    const probe = (html.match(/<p id="charset-probe">(.*?)<\/p>/s) || [])[1];
    assert.strictEqual(probe, title, `the charset probe is not "${title}"`);
  },
  // The seeded page is text only.
  frontendImages: [],
  backend: frameset,
  remoteModules: [],
  // 4.0.13's menu, with the extensions it loads by default: two more than
  // 3.8.1's.
  minModules: 16,
  phpUploadRefused: /Extension of file name "uploaded\.php" is not allowed/,
  // As in 3.8.1: on any error tce_file.php shows the errors in the content
  // frame, with a Continue button back to the form's returnUrl, the list of
  // fileadmin/.
  async submitUpload({ backend, content, uploadName, fileListShowing }) {
    await content.locator('input[type="submit"]').first().click();
    await backend.waitForFunction(() => {
      const doc = top.content.document;
      return doc.readyState === 'complete' && /\/tce_file\.php$/.test(top.content.location.pathname) && doc.body
        && /Errors:/.test(doc.body.innerText);
    }, null, { timeout: 60000 });
    const errors = backend.frame({ name: 'content' });
    const said = await errors.evaluate(() => document.body.innerText);
    await errors.locator('input[value="Continue"]').click();
    return { said, listing: await fileListShowing(uploadName) };
  },
  archiveLicences: /typo3\/sysext\/adodb\/adodb\/license\.txt/,
  backendChecks: [],
};
