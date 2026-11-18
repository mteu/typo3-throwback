// TYPO3 3.8.1 on the WebAssembly stack, held to the typo3-3-8 job in
// .github/workflows/images.yml, its smoke test and its backend steps
// (stack.cjs says how):
//
//   3.8/provision.php, unchanged, builds the schema and seeds the site
//   the frontend renders the seeded page through TypoScript
//   the backend serves its login form, and the Install Tool answers
//   source files answer 403, and t3lib/ lists nothing
//   every clock PHP and the server read starts at noon on the release day,
//   in UTC, whatever the host's time zone
//   the login works as 3.8.1's own form computes it, and opens the frameset
//   over HTTPS, the login redirects to https://, not http://
//   the record editor shows labels from locallang XML, and saves a new page
//   title, which the frontend then shows
//   the admin uploads a file into fileadmin/, and TYPO3 refuses a .php one
//   the Install Tool's GD tests pass, and its ImageMagick tests say they are
//   skipped, and it sends its test mail, to nowhere, as Docker does
//   a client with no cookie gets a session of its own
//   the MySQL server rejects nothing TYPO3 sends
//   the site's snapshot restores into a new instance, which renders the same
//
// Usage: node stack-3.8.1.cjs <work-root>
'use strict';

const {
  USER_AGENT, EDIT_ROOT_PAGE, check, finish, client, browser, printProvisionOutput, assertNoPhpErrors,
  watchRejectedStatements, checkNothingRejected, checkClock, checkSecondProvision, checkSourceProtection, checkRestore,
  checkBackendLogin, checkBackendLoginOverHttps, saveTitle, checkUploads, checkUploadRestored, checkInstallToolImages,
  checkInstallToolMail, checkFreshSessions,
} = require('./stack.cjs');
const assert = require('assert');
const path = require('path');
const { bootRelease } = require('./release-site.cjs');

const workRoot = path.resolve(process.argv[2]);

(async () => {
  const started = Date.now();
  const site = await bootRelease('3.8.1', workRoot);
  const booted = Date.now() - started;
  const get = client(site);
  const rejected = watchRejectedStatements(site);
  // What the frontend's <title> must say: the root page's title, which the
  // record editor changes below.
  let pageTitle = 'TYPO3 3.8.1';

  check('3.8/provision.php, unchanged, builds the schema and seeds the site', () => {
    const output = site.provisionOutput;
    printProvisionOutput(site, booted);
    assert.match(output, /\[provision\] merged 27 tables from 4 files: /);
    assert.match(output, /\[provision\] created 27 tables/);
    assert.match(output, /\[provision\] imported 63 statements from sysext\/cms\/ext_tables_static\+adt\.sql/);
    assert.match(output, /\[provision\] imported 237 statements from sysext\/tsconfig_help\/ext_tables_static\+adt\.sql/);
    assert.match(output, /\[provision\] created backend admin "admin"/);
    assert.match(output, /\[provision\] created root page \(uid 1\)/);
    assert.match(output, /\[provision\] done\n$/);
  });

  checkClock(site);
  checkSecondProvision(site);

  const frontendChecks = (label, get) => check(label, () => {
    const started = Date.now();
    const response = get('index.php');
    const elapsed = Date.now() - started;
    if (!response.text.includes('<h1>TYPO3 3.8.1</h1>')) {
      console.log(`     ${response.status}, ${response.body.length} bytes, log: ${response.log.join(' | ')}`);
      console.log(response.text.slice(0, 1500));
    }
    console.log(`     ${response.status}, ${response.body.length} bytes in ${elapsed} ms`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.includes('<h1>TYPO3 3.8.1</h1>'), 'the seeded title is missing');
    assert.ok(response.text.includes(`<title>${pageTitle}</title>`), `the page title is not "${pageTitle}"`);
    // The Docker job expects PHP 5.6.40, which its image runs. Here 3.8.1
    // runs on PHP 4.4.9, the oldest PHP it supports in this repository's
    // builds.
    assert.match(response.text, /Rendered by TypoScript on PHP 4\.4\.9/);
    // The release day, within its first hour, as the job asserts.
    assert.match(response.text, /Page generated&nbsp;2005-11-14 12:[0-9]{2}:[0-9]{2}/);
    assertNoPhpErrors(response);
  });

  frontendChecks('the frontend renders the seeded page through TypoScript', get);

  check('the backend serves its login form', () => {
    const response = get('typo3/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /name="userident"/);
    assertNoPhpErrors(response);
  });

  check('the Install Tool answers, past the guard 3.8/Dockerfile comments out', () => {
    const response = get('typo3/install/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /<title>TYPO3 Install Tool<\/title>/);
    assert.doesNotMatch(response.text, /the install script is disabled/);
  });

  checkSourceProtection(site, '/typo3/gfx/refresh_n.gif');

  // 200, not 403, as in the job: 3.8.1 ships a blank t3lib/index.html for
  // exactly this.
  check('t3lib/ lists no files', () => {
    const response = site.handle({ path: '/t3lib/', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(response.status, 200);
    assert.doesNotMatch(Buffer.from(response.body).toString('latin1'), /Index of \//i);
  });


  // --- the backend: the job's "Backend login and record editing" step ---

  const admin = browser(site);
  checkBackendLogin(admin);
  checkBackendLoginOverHttps(site);

  check('alt_main.php answers with the frameset', () => {
    const response = admin('typo3/alt_main.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /<frameset/);
    assertNoPhpErrors(response);
  });

  let editor = null;
  check('alt_doc.php renders the root page header for editing', () => {
    editor = admin('typo3/alt_doc.php', { query: EDIT_ROOT_PAGE });
    if (!/name="data\[pages\]\[1\]\[title\]"/.test(editor.text)) {
      console.log(`     ${editor.status}, ${editor.body.length} bytes, log: ${editor.log.join(' | ')}`);
    }
    assert.strictEqual(editor.status, 200);
    assert.match(editor.text, /name="data\[pages\]\[1\]\[title\]"/);
    assertNoPhpErrors(editor);
  });

  // "Save document" is rm.saveDoc in typo3/sysext/lang/locallang_core.xml,
  // which has no locallang_core.php beside it: only ext/xml can read it.
  check('the editor shows labels from locallang XML, not their keys', () => {
    assert.match(editor.text, /title="Save document"/);
    assert.doesNotMatch(editor.text, /rm\.saveDoc|LLL:EXT:/);
  });

  const newTitle = 'TYPO3 3.8.1, saved in the backend';
  check('saving the form stores the new title, and the frontend shows it', () => {
    const response = saveTitle(admin, editor, newTitle);
    assert.strictEqual(response.status, 200);
    assertNoPhpErrors(response);
    assert.ok(response.text.includes(`value="${newTitle}"`), 'the form did not come back with the new title');
    assert.deepStrictEqual(site.query('SELECT title FROM pages WHERE uid = 1').rows, [[newTitle]]);
    // TCEmain cleared the page's cache, so no no_cache is needed.
    pageTitle = newTitle;
    const frontend = get('index.php');
    assert.ok(frontend.text.includes(`<title>${newTitle}</title>`), 'the frontend still shows the old title');
  });
  frontendChecks('the frontend renders the saved title through TypoScript', get);

  checkUploads(site, admin, /Fileextension &quot;php&quot; is not allowed in &quot;\/var\/www\/fileadmin\/&quot;!/);
  const installTool = checkInstallToolImages(site);
  checkInstallToolMail(installTool);
  checkFreshSessions(site, admin);

  checkNothingRejected(rejected);

  checkUploadRestored(await checkRestore(site, workRoot, frontendChecks));

  finish('stack 3.8.1');
})();
