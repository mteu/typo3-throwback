// TYPO3 6.2.31 for site.cjs: what its frontend shows, where its web server's
// rules and its Install Tool are, and how its file list takes an upload.
// Its backend is an ExtJS viewport, as 4.5's is (site-viewport.cjs).
'use strict';

const { viewport, viewportChecks } = require('./site-viewport.cjs');
const assert = require('assert');

// What the provision script seeds as the content element's bodytext.
const SEEDED_TEXT = 'A text element, stored in tt_content and rendered by css_styled_content.';

const RENAMED = 'Renamed in a 2017 backend, Gödöllő 日本語';
// The file list's upload form for the storage the installer made of
// fileadmin/, by FAL's combined identifier.
const UPLOAD_FORM = 'file_upload.php?target=1%3A%2F';

module.exports = {
  title: 'TYPO3 6.2.31',
  day: '2017-04-18',
  renamed: RENAMED,
  // The seeded content element, as css_styled_content renders it: its header
  // in an <h1> and its bodytext in a paragraph. The page title, which the
  // backend renames, is the <title>, as for 3.8.1.
  assertFrontend(html, title) {
    assert.match(html, /<h1[^>]*>TYPO3 6\.2\.31<\/h1>/, 'the seeded heading is missing');
    assert.ok(html.includes(`<p class="bodytext">${SEEDED_TEXT}</p>`), 'the seeded bodytext is missing');
    assert.ok(html.includes(`<title>${title}</title>`), `the page title is not "${title}"`);
  },
  // The seeded page is text only.
  frontendImages: [],
  // Paths of the job's smoke test: 6.2 keeps its configuration in PHP files
  // of typo3conf/, and its core configuration under Configuration/.
  serverRules: [
    ['typo3conf/LocalConfiguration.php', 403],
    ['typo3/sysext/core/Configuration/DefaultConfiguration.php', 403],
    ['typo3/gfx/alt_backend_logo.gif', 200],
  ],
  // The old entry point answers a 303 to the new one.
  installToolLandsOn: /\/site\/typo3\/sysext\/install\/Start\/Install\.php$/,
  // rsaauth's form script posts the password encrypted, never as typed.
  loginUserident: /^rsa:[A-Za-z0-9+/]+=*$/,
  backend: {
    ...viewport,
    // 6.2 routes its modules through mod.php.
    fileListShown: /\/mod\.php\?M=file_list(&|$)/,
    // 4.5's five errors (site-4.5.40.cjs), and one more: backend.php's
    // inline script makes a TYPO3.state.ExtDirectProvider
    // (BackendController.php:198), and in the shell's iframe there is no
    // TYPO3.state.
    turnedAwayErrors: /: Cannot read properties of undefined \(reading '(LLL|PATH_typo3|0|ContentContainer|ModuleMenuContainer|ExtDirectProvider)'\)$/,
  },
  remoteModules: [],
  // Help > Documentation's list saves its state in a cookie through a
  // DataTables callback that calls $.fn (documentation/Resources/Public/
  // JavaScript/main.js:35). 6.2 loads jQuery in noConflict mode, so $ is
  // not jQuery there, in any browser: 6.2.31 throws this in Docker too.
  moduleErrors: {
    help_DocumentationDocumentation: /: Cannot read properties of undefined \(reading 'fn'\)$/,
  },
  // 6.2.31's menu, with the extensions its installer's factory
  // configuration loads.
  minModules: 21,
  phpUploadRefused: /Extension of file name "uploaded\.php" is not allowed/,
  // 6.2's form has one input, which takes several files.
  async chooseUploads({ backend, files }) {
    await backend.evaluate(form => {
      document.querySelector('iframe[name="content"]').contentWindow.location.href = form;
    }, UPLOAD_FORM);
    await backend.waitForFunction(() => {
      const doc = document.querySelector('iframe[name="content"]').contentDocument;
      return doc.readyState === 'complete' && doc.querySelector('input[type="file"][name="upload_1[]"]');
    }, null, { timeout: 30000 });
    await backend.frame({ name: 'content' }).setInputFiles('input[name="upload_1[]"]', files);
  },
  // tce_file.php answers 303 to the file list, which shows what it refused
  // as a flash message above the files. The message names the refused
  // file, so the listing leaves it out.
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
  archiveLicences: /typo3\/contrib\/Psr\/Log\/LICENSE/,
  // titleLen is 50 for a new backend user in 6.2
  // (BackendUserAuthentication.php:349), so the tree shows the whole title.
  backendChecks: viewportChecks(RENAMED, ['日本語', 'Gödöllő', '2017 backend'], 50),
};
