// TYPO3 3.8.1 for site.cjs: what its frontend shows.
'use strict';

const assert = require('assert');

module.exports = {
  title: 'TYPO3 3.8.1',
  day: '2005-11-14',
  renamed: 'Renamed in a 2005 backend',
  // 3.8/provision.php's template renders the release in an <h1>, and the
  // page title in <title>.
  assertFrontend(html, title) {
    assert.ok(html.includes('<h1>TYPO3 3.8.1</h1>'), 'the seeded heading is missing');
    assert.ok(html.includes(`<title>${title}</title>`), `the page title is not "${title}"`);
  },
  // The seeded page is text only.
  frontendImages: [],
  remoteModules: [],
  // 3.8.1's menu, with the extensions it loads by default.
  minModules: 14,
  phpUploadRefused: /Fileextension "php" is not allowed/,
  // Unlike 3.3.0, no alert(): on any error tce_file.php shows the errors in
  // the content frame, with a Continue button back to the form's returnUrl,
  // the list of fileadmin/ (t3lib_extFileFunctions::printLogErrorMessages()).
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
  archiveLicences: /typo3\/ext\/phpmyadmin\/modsub\/phpMyAdmin-2\.6\.4-pl3\/LICENSE/,
  backendChecks: [],
};
