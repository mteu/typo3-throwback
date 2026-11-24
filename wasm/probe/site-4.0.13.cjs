// TYPO3 4.0.13 for site.cjs: what its frontend shows.
'use strict';

const assert = require('assert');
const frameset = require('./site-frameset.cjs');

// What the provision script seeds as the content element's bodytext.
const SEEDED_TEXT = 'A text element, stored in tt_content and rendered by css_styled_content.';

module.exports = {
  title: 'TYPO3 4.0.13',
  day: '2009-07-02',
  // Typed into the editor of an ISO-8859-1 page: the ö goes as one byte, and
  // must come back as the same character.
  renamed: 'Renamed in a 2009 backend, schön',
  // The seeded content element, as css_styled_content renders it: its header
  // in an <h1> and its bodytext in a paragraph. The page title, which the
  // backend renames, is the <title>, as for 3.8.1.
  assertFrontend(html, title) {
    assert.match(html, /<h1[^>]*>TYPO3 4\.0\.13<\/h1>/, 'the seeded heading is missing');
    assert.ok(html.includes(`<p class="bodytext">${SEEDED_TEXT}</p>`), 'the seeded bodytext is missing');
    assert.ok(html.includes(`<title>${title}</title>`), `the page title is not "${title}"`);
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
