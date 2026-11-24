// TYPO3 4.5.40 for site.cjs: what its frontend shows, and its ExtJS backend,
// which site-viewport.cjs describes for 4.5 and 6.2 alike.
'use strict';

const assert = require('assert');
const { viewport, viewportChecks } = require('./site-viewport.cjs');

// What the provision script seeds as the content element's bodytext.
const SEEDED_TEXT = 'A text element, stored in tt_content and rendered by css_styled_content.';

// Typed into the editor of a UTF-8 page: the ő and the kanji are outside
// latin1, which 4.0.13's ISO-8859-1 backend could only store as references.
const RENAMED = 'Renamed in a 2015 backend, Gödöllő 日本語';

module.exports = {
  title: 'TYPO3 4.5.40',
  day: '2015-02-19',
  renamed: RENAMED,
  // The seeded content element, as css_styled_content renders it: its header
  // in an <h1> and its bodytext in a paragraph. The page title, which the
  // backend renames, is the <title>, as for 3.8.1.
  assertFrontend(html, title) {
    assert.match(html, /<h1[^>]*>TYPO3 4\.5\.40<\/h1>/, 'the seeded heading is missing');
    assert.ok(html.includes(`<p class="bodytext">${SEEDED_TEXT}</p>`), 'the seeded bodytext is missing');
    assert.ok(html.includes(`<title>${title}</title>`), `the page title is not "${title}"`);
  },
  // The seeded page is text only.
  frontendImages: [],
  backend: {
    ...viewport,
    // The File module moved into the filelist extension in 4.5.
    fileList: 'sysext/filelist/mod1/file_list.php',
    // In the shell's iframe, until the shell turns it away, backend.php finds
    // the shell as top, which has neither top.TYPO3 nor top.TS. Two of its
    // scripts read them as they load: viewportConfiguration.js reads
    // top.TYPO3.LLL, and opendocs.js top.TS.PATH_typo3. Without that
    // configuration the viewport does not build (viewport.js reads
    // items[0]), and modulemenu.js finds no TYPO3.Backend.ContentContainer or
    // ModuleMenuContainer. These five are all it throws.
    turnedAwayErrors: /: Cannot read properties of undefined \(reading '(LLL|PATH_typo3|0|ContentContainer|ModuleMenuContainer)'\)$/,
  },
  remoteModules: [],
  // 4.5.40's menu with the extensions in releases/4.5.40.js's extList.
  minModules: 13,
  phpUploadRefused: /Extension of file name "uploaded\.php" is not allowed/,
  // tce_file.php answers 303 to the form's returnUrl, the file list, and
  // keeps what it refused as a flash message in the backend session, which
  // the list shows above the files. The message names the refused file, so
  // the listing leaves it out.
  async submitUpload({ backend, content, uploadName, fileListShowing }) {
    await content.locator('input[type="submit"]').first().click();
    await fileListShowing(uploadName);
    return backend.frame({ name: 'content' }).evaluate(() => {
      const messages = [...document.querySelectorAll('.typo3-message')];
      const said = messages.map(message => message.innerText).join('\n');
      messages.forEach(message => message.remove());
      return { said, listing: document.body.innerText };
    });
  },
  archiveLicences: /typo3\/contrib\/extjs\/LICENSE\.txt/,
  // titleLen is 30 for a new backend user in 4.5.
  backendChecks: viewportChecks(RENAMED, ['日本語', 'Gödöllő', '2015 backend'], 30),
};
