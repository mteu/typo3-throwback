// TYPO3 4.0.13 on the WebAssembly stack, held to the typo3-4-0 job in
// .github/workflows/images.yml, its smoke test, its backend steps, its
// default_charset control and its TLS step, with 4.0/ci-probe.py's bytes
// (stack.cjs says how):
//
//   4.0/provision.php, unchanged, builds the schema and seeds the site, a
//   root page with a content element, against the shim answering as MySQL 5.5
//   the frontend renders the content element through css_styled_content, as
//   ISO-8859-1
//   the backend serves its login form, and the Install Tool answers
//   source files answer 403, and t3lib/ lists nothing
//   every clock PHP and the server read starts at noon on the release day,
//   in UTC, whatever the host's time zone
//   a page with content_from_pid renders, through 4.0's own clone() for PHP 4
//   the login works as 4.0.13's own form computes it, and opens the frameset
//   a client with no cookie gets a session of its own
//   the record editor saves the charset probe into the content element's
//   bodytext as latin1 bytes, which MySQL stores and the editor and the
//   frontend show, byte for byte
//   default_charset = UTF-8 does not blank the bodytext on PHP 4, as it does
//   on the job's PHP 5.6
//   over HTTPS, redirects and the login go to https://
//   the admin uploads a file into fileadmin/, and TYPO3 refuses a .php one
//   the Install Tool's GD tests pass, and its ImageMagick tests say they are
//   skipped, and it sends its test mail, to nowhere, as Docker does
//   the MySQL server rejects nothing TYPO3 sends
//   the site's snapshot restores into a new instance, with the edits and the
//   upload, and renders the same
//
// Usage: node stack-4.0.13.cjs <work-root>
'use strict';

const {
  USER_AGENT, EDIT_CONTENT_ELEMENT, SEEDED_TEXT, bodytextField, bodytextRendered, check, finish, client, browser, router,
  runScript, printProvisionOutput, assertNoPhpErrors, watchRejectedStatements, checkNothingRejected, checkClock,
  checkSecondProvision, checkSourceProtection, checkRestore, checkBackendLogin, checkBackendLoginOverHttps, saveBodytext, checkUploads,
  checkUploadRestored, checkInstallToolImages, checkInstallToolMail, checkFreshSessions, logIn,
} = require('./stack.cjs');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRelease, repoRoot } = require('./release-site.cjs');

const workRoot = path.resolve(process.argv[2]);

// The job's CHARSET_PROBE: what it saves into the content element's bodytext
// through the record editor, and what a visitor should then read.
const CHARSET_PROBE = 'Skaarhøj · Gödöllő · 日本語';
// The bytes 4.0 stores for it, as 4.0/ci-probe.py computes them: an
// ISO-8859-1 form sends what latin1 can carry as single bytes and the rest as
// decimal character references.
const storedForm = text => [...text].map(char => {
  const code = char.codePointAt(0);
  return code < 256 ? char : `&#${code};`;
}).join('');
// What a browser shows for those bytes: latin1, with the references decoded.
const asBrowserReads = bytes => bytes.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
// PHP's htmlspecialchars() with its default flags: & " < > and not '.
const htmlspecialchars = bytes => bytes.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// ci-probe.py's frontend mode: the bodytext paragraph, as bytes, and as the
// visitor reads it. parseFunc_RTE escapes the text and restores entities, so
// the references reach the browser as references.
function assertBodytextRendered(response, text) {
  const rendered = bodytextRendered(response);
  assert.strictEqual(rendered, storedForm(text), 'the bodytext is not the bytes 4.0 stores');
  assert.strictEqual(asBrowserReads(rendered), text);
}
// The content element's header, as css_styled_content renders it.
const SEEDED_HEADING = /<h1[^>]*>TYPO3 4\.0\.13<\/h1>/;

(async () => {
  const started = Date.now();
  const site = await bootRelease('4.0.13', workRoot);
  const booted = Date.now() - started;
  const get = client(site);
  const rejected = watchRejectedStatements(site);
  // What the frontend's bodytext must say, which the record editor changes
  // below.
  let bodytext = SEEDED_TEXT;

  // The counts provision.php prints against the shim in its MySQL 5.5.62 mode.
  check('4.0/provision.php, unchanged, builds the schema and seeds the site, as MySQL 5.5 answers it', () => {
    const output = site.provisionOutput;
    printProvisionOutput(site, booted);
    assert.match(output, /^\[provision\] connected to MySQL 5\.5\.62 \(client 3\.23\.49\)\n/);
    for (const charset of ['server', 'connection', 'database']) {
      assert.match(output, new RegExp(`\\[provision\\] ${charset} charset: latin1\\n`));
    }
    assert.match(output, /\[provision\] merged 30 tables from 4 files: /);
    assert.match(output, /\[provision\] created 30 tables/);
    assert.match(output, /\[provision\] imported 63 statements from sysext\/cms\/ext_tables_static\+adt\.sql/);
    assert.match(output, /\[provision\] imported 119 statements from sysext\/tsconfig_help\/ext_tables_static\+adt\.sql/);
    assert.match(output, /\[provision\] created backend admin "admin"/);
    assert.match(output, /\[provision\] created root page \(uid 1\)/);
    assert.match(output, /\[provision\] created content element \(uid 1\)/);
    for (const column of ['pages.title', 'tt_content.header', 'tt_content.bodytext']) {
      assert.ok(output.includes(`[provision] ${column} charset: latin1\n`), `${column} is not latin1`);
    }
    assert.match(output, /\[provision\] done\n$/);
  });

  checkClock(site);
  checkSecondProvision(site);

  const frontendChecks = (label, get) => check(label, () => {
    const started = Date.now();
    const response = get('index.php');
    const elapsed = Date.now() - started;
    if (!SEEDED_HEADING.test(response.text)) {
      console.log(`     ${response.status}, ${response.body.length} bytes, log: ${response.log.join(' | ')}`);
      console.log(response.text.slice(0, 1500));
    }
    console.log(`     ${response.status}, ${response.body.length} bytes in ${elapsed} ms`);
    assert.strictEqual(response.status, 200);
    assert.match(response.text, SEEDED_HEADING, 'the seeded heading is missing');
    // The Docker job expects PHP 5.6.40, which its image runs. Here 4.0.13
    // runs on PHP 4.4.9, the oldest PHP it supports in this repository's
    // builds.
    assert.match(response.text, /Rendered by TypoScript on PHP 4\.4\.9/);
    // The job asserts 12:00:00, under its frozen clock. Here the clock runs
    // from noon, as 3.8.1's does.
    assert.match(response.text, /Page generated&nbsp;2009-07-02 12:[0-9]{2}:[0-9]{2}/);
    // ISO-8859-1, as TSFE says when nothing overrides defaultCharSet.
    assert.match(response.header('Content-Type'), /^text\/html; *charset=iso-8859-1$/i);
    // Compared as bytes: written by provision.php or TCEmain, stored by the
    // shim, read back by t3lib_db and rendered by css_styled_content.
    assertBodytextRendered(response, bodytext);
    assertNoPhpErrors(response);
  });

  frontendChecks('the frontend renders the seeded content element through css_styled_content, as ISO-8859-1', get);

  check('the backend serves its login form, with a challenge', () => {
    const response = get('typo3/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /name="userident"/);
    assert.match(response.text, /name="challenge" value="[0-9a-f]{32}"/);
    assertNoPhpErrors(response);
  });

  check('the Install Tool answers with its password form, past the guard 4.0/Dockerfile comments out', () => {
    const response = get('typo3/install/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /<title>TYPO3 Install Tool<\/title>/);
    assert.match(response.text, /name="passwordForm"/);
    assert.doesNotMatch(response.text, /the install script is disabled/);
    assertNoPhpErrors(response);
  });

  checkSourceProtection(site, '/typo3/gfx/refresh_n.gif');

  // The extension cache 4.0 writes into typo3conf (config_default.php:106),
  // denied by location, so 403 whether or not it has been written yet.
  check("typo3conf/'s extension cache answers 403", () => {
    const response = site.handle({ path: '/typo3conf/temp_CACHED_ps0000_ext_localconf.php', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(response.status, 403);
  });

  // 200, not 403, as in the job: 4.0.13 ships a blank t3lib/index.html for
  // exactly this.
  check('t3lib/ lists no files', () => {
    const response = site.handle({ path: '/t3lib/', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(response.status, 200);
    assert.doesNotMatch(Buffer.from(response.body).toString('latin1'), /Index of \//i);
  });

  // Not in the Docker job. A page with content_from_pid makes the frontend
  // copy TSFE with clone() (tslib_pagegen.php:97). On PHP 4 that is a call to
  // 4.0's own clone(), from t3lib/compat_php5.php, which config_default.php
  // loads only below PHP 5: Docker on PHP 5.6 never takes this path. A
  // subpage takes its content from the root page, and an extension template
  // on it shows which page TSFE took the content from.
  check('a page with content_from_pid renders, through 4.0\'s clone() for PHP 4', () => {
    site.query("INSERT INTO pages (pid, title, doktype, content_from_pid) VALUES (1, 'Content from the root page', 1, 1)");
    const uid = Number(site.query('SELECT MAX(uid) FROM pages').rows[0][0]);
    assert.ok(uid > 1, `the subpage got uid ${uid}`);
    site.query("INSERT INTO sys_template (pid, title, root, clear, config) VALUES ("
      + `${uid}, 'Shows TSFE->contentPid', 0, 0, 'page.50 = TEXT\npage.50.data = TSFE:contentPid\npage.50.wrap = <p id="content-pid">|</p>')`);
    const response = get('index.php', { query: `id=${uid}` });
    assert.strictEqual(response.status, 200);
    assert.match(response.text, SEEDED_HEADING, "the subpage did not render the root page's content");
    assert.match(response.text, /<p id="content-pid">1<\/p>/);
    assertNoPhpErrors(response);
  });



  // --- the backend: the job's "Backend login and record editing" step ---

  const admin = browser(site);
  checkBackendLogin(admin);
  // Right after the login, as in the job.
  checkFreshSessions(site, admin);

  // The frameset, which is what 4.0 has where 4.5 has backend.php.
  check('alt_main.php answers with the frameset', () => {
    const response = admin('typo3/alt_main.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /<frameset/);
    assert.match(response.text, /src="alt_intro\.php"/);
    assertNoPhpErrors(response);
  });

  let editor = null;
  check("alt_doc.php shows the content element's bodytext, as ISO-8859-1", () => {
    editor = admin('typo3/alt_doc.php', { query: EDIT_CONTENT_ELEMENT });
    assert.strictEqual(editor.status, 200);
    assert.match(editor.header('Content-Type'), /^text\/html; *charset=iso-8859-1$/i);
    assert.strictEqual(bodytextField(editor), SEEDED_TEXT);
    assertNoPhpErrors(editor);
  });

  // The job posts only the bodytext and doSave, percent-encoded byte for
  // byte. This posts the whole form, as a browser does on an ISO-8859-1 page:
  // what latin1 carries as single bytes, the rest as character references.
  // The probe comes back through TCEforms as htmlspecialchars() over the
  // latin1 bytes, so the references arrive with their ampersands escaped and
  // the field shows them as typed text.
  check('saving a latin1 bodytext stores its bytes, and the form and the frontend show them', () => {
    const response = saveBodytext(admin, editor, storedForm(CHARSET_PROBE));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(bodytextField(response), htmlspecialchars(storedForm(CHARSET_PROBE)));
    assertNoPhpErrors(response);
    // What TCEmain wrote, through the shim's HEX(): one byte per latin1
    // character, so F8 for the ø and not UTF-8's C3B8.
    assert.deepStrictEqual(site.query('SELECT HEX(bodytext) FROM tt_content WHERE uid = 1').rows,
      [[Buffer.from(storedForm(CHARSET_PROBE), 'latin1').toString('hex').toUpperCase()]]);
    // no_cache, as in the job: the question is what the database holds.
    const frontend = get('index.php', { query: 'no_cache=1' });
    assertBodytextRendered(frontend, CHARSET_PROBE);
    assertNoPhpErrors(frontend);
    bodytext = CHARSET_PROBE;
  });
  // And without no_cache: TCEmain cleared the page's cache.
  frontendChecks('the frontend renders the saved bodytext through css_styled_content', get);

  // --- the job's "The default_charset control" step ---

  // On PHP 5.6, htmlspecialchars() takes its charset from default_charset
  // when the call names none, and 4.0 never names one. Under 5.6's own
  // default, UTF-8, every latin1 byte is invalid, and the job shows the
  // bodytext blank, in the editor and on the frontend: 4.0/php-legacy.ini's
  // ISO-8859-1 is load-bearing.
  // PHP 4.4.9's htmlspecialchars() takes ISO-8859-1 whenever the call names
  // no charset (ext/standard/html.c:649), whatever default_charset says. So
  // here the control runs the other way: the same setting changes nothing.
  // php4-base/php-legacy.ini keeps ISO-8859-1 all the same, as Docker's does.
  const shipped = fs.readFileSync(path.join(repoRoot, site.release.ini), 'latin1');
  assert.match(shipped, /^default_charset = "ISO-8859-1"$/m);
  const control = await bootRelease('4.0.13', workRoot, {
    snapshot: site.snapshot(),
    legacyIni: Buffer.from(shipped.replace(/^default_charset = .*$/m, 'default_charset = "UTF-8"'), 'latin1'),
  });
  check('the control instance runs with default_charset = UTF-8', () => {
    const response = runScript(control, 'charset.php', ['<?php', "echo ini_get('default_charset');"]);
    assert.strictEqual(response.text, 'UTF-8');
  });
  check("under it, the editor and the frontend still show the bodytext's bytes, where the job's PHP 5.6 shows them blank", () => {
    const controlAdmin = browser(control);
    assert.strictEqual(logIn(controlAdmin).status, 302);
    const edit = controlAdmin('typo3/alt_doc.php', { query: EDIT_CONTENT_ELEMENT });
    assert.strictEqual(edit.status, 200);
    // TYPO3 still names ISO-8859-1 in its own header, as in the job.
    assert.match(edit.header('Content-Type'), /^text\/html; *charset=iso-8859-1$/i);
    assert.strictEqual(bodytextField(edit), htmlspecialchars(storedForm(CHARSET_PROBE)));
    assertNoPhpErrors(edit);
    const frontend = client(control)('index.php', { query: 'no_cache=1' });
    assertBodytextRendered(frontend, CHARSET_PROBE);
  });

  // --- the job's "Behind TLS" step ---

  // The job recreates the container with HTTPS=on. Here the service worker
  // says per request whether the page was asked over HTTPS, so both
  // phases run on one site. 4.0 has no trustedHostsPattern, so nothing
  // refuses a request once it believes it is on 443.
  check('index_re.php redirects to http:// over HTTP, and to https:// over HTTPS', () => {
    assert.strictEqual(router(site)('typo3/index_re.php').header('Location'), 'http://localhost/typo3/index.php');
    assert.strictEqual(router(site, { https: true })('typo3/index_re.php').header('Location'), 'https://localhost/typo3/index.php');
  });
  check('over HTTPS, the frontend renders the page', () => {
    const response = router(site, { https: true })('');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, SEEDED_HEADING, 'the seeded heading is missing');
    assertNoPhpErrors(response);
  });
  const secure = checkBackendLoginOverHttps(site);
  check('over HTTPS, alt_main.php answers with the frameset', () => {
    const response = secure('typo3/alt_main.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /<frameset/);
    assertNoPhpErrors(response);
  });

  // --- the rest of the backend step, and what 3.8.1's probe also does ---

  // The job's assert_admin_can_upload, and the refusal it does not try.
  checkUploads(site, admin, /Extension of file name &quot;refused\.php&quot; is not allowed in &quot;\/var\/www\/fileadmin\/&quot;!/);
  checkInstallToolMail(checkInstallToolImages(site));

  checkNothingRejected(rejected);

  checkUploadRestored(await checkRestore(site, workRoot, frontendChecks));

  finish('stack 4.0.13');
})();
