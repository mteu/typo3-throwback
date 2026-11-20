// TYPO3 4.5.40 on the WebAssembly stack, held to the typo3-4-5 job in
// .github/workflows/images.yml, its smoke test, its backend login and record
// editing, its Ext.Direct step with the raw-POST control and its TLS step,
// with 4.5/ci-login.sh, 4.5/ci-extdirect.sh and 4.5/ci-check-page-tree.py
// (stack.cjs says how):
//
//   4.5/provision.php, unchanged, builds the schema, seeds the site and
//   checks its UTF-8 round trip, against the shim answering as MySQL 5.5
//   with --character-set-server=utf8
//   the frontend renders the seeded page through TypoScript, as UTF-8, on
//   the PHP its Docker stack runs, with the charset probe byte for byte
//   the backend serves its login form, and the Install Tool its password
//   form, opened by typo3conf/ENABLE_INSTALL_TOOL alone
//   source files and the deprecation log answer 403, and t3lib/ lists nothing
//   every clock PHP and the server read starts at noon on the release day,
//   in UTC, whatever the host's time zone
//   the login works as 4.5.40's own form computes it, and opens backend.php,
//   the ExtJS viewport
//   a client with no cookie gets a session of its own
//   the record editor shows the probe's UTF-8 bytes, and saves new ones,
//   which MySQL stores and the frontend shows, byte for byte
//   the page tree answers over Ext.Direct, as JSON, with the saved title
//   always_populate_raw_post_data = -1 keeps PHP 5.6's raw-POST deprecation
//   out of that JSON, and 0 puts it in front of it, as in the job
//   over HTTPS, redirects, the login and backend.php's siteUrl say https://
//   the admin uploads a file into fileadmin/, and TYPO3 refuses a .php one,
//   with a message the backend session carries
//   the Install Tool logs in, its GD tests pass, its ImageMagick tests say
//   they are skipped, and it sends its test mail, to nowhere, as Docker does
//   the MySQL server rejects nothing TYPO3 sends
//   the site's snapshot restores into a new instance, with the edit and the
//   upload, and renders the same
//
// It prints how long the boot takes, step by step, and the first frontend
// request.
//
// Usage: node stack-4.5.40.cjs <work-root>
'use strict';

const {
  check, finish, client, browser, router, logIn, saveTitle, upload, UPLOADED, visibleText, runScript,
  printProvisionOutput, assertNoPhpErrors, watchRejectedStatements, checkNothingRejected, checkClock,
  checkSecondProvision, checkSourceProtection, checkRestore, checkFreshSessions, checkUploadRestored,
  callPageTree, assertPageTree, checkRawPostControl, utf8Bytes, titleField, USER_AGENT, EDIT_ROOT_PAGE,
} = require('./stack.cjs');
const assert = require('assert');
const path = require('path');
const { readForm } = require('./forms.cjs');
const { bootRelease } = require('./release-site.cjs');

const workRoot = path.resolve(process.argv[2]);

// The job's CHARSET_PROBE: what a visitor should read in <p id="charset-probe">.
const CHARSET_PROBE = 'Skaarhøj · Gödöllő · 日本語';
// The title the record editor saves, so that the frontend and the page tree
// show a value TCEmain wrote, not one provision.php did.
const CHARSET_PROBE_SAVED = 'Skaarhøj · Gödöllő · 日本語 · gespeichert';
const urlEncoded = fields => fields.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');

(async () => {
  const steps = [];
  const started = Date.now();
  const site = await bootRelease('4.5.40', workRoot, {
    onProgress: text => steps.push([text, Date.now() - started]),
  });
  const booted = Date.now() - started;
  const get = client(site);
  const rejected = watchRejectedStatements(site);
  // What the frontend's probe must say: the root page's title, which the
  // record editor changes below.
  let probeText = CHARSET_PROBE;

  // The counts provision.php prints against the shim as MySQL 5.5.62 with utf8.
  check('4.5/provision.php, unchanged, builds the schema and seeds the site, as MySQL 5.5 with utf8 answers it', () => {
    const output = site.provisionOutput;
    printProvisionOutput(site, booted);
    steps.push(['done', booted]);
    console.log(`     boot steps, ms from the start: ${steps.map(([text, ms]) => `${ms} ${text}`).join('; ')}`);
    // PHP 5's client is the shim's 5.5 API, mysqli's too.
    assert.match(output, /^\[provision\] connected to MySQL 5\.5\.62 \(client 5\.5\.62\)\n/);
    for (const charset of ['server', 'connection', 'database']) {
      assert.match(output, new RegExp(`\\[provision\\] ${charset} charset: utf8\\n`));
    }
    assert.match(output, /\[provision\] merged 40 tables from 6 files: /);
    assert.match(output, /\[provision\] created 40 tables/);
    assert.match(output, /\[provision\] imported 3 statements from sysext\/em\/ext_tables_static\+adt\.sql/);
    assert.match(output, /\[provision\] imported 119 statements from sysext\/tsconfig_help\/ext_tables_static\+adt\.sql/);
    assert.match(output, /\[provision\] created backend admin "admin"/);
    assert.match(output, /\[provision\] created root page \(uid 1\)/);
    assert.match(output, /\[provision\] created root TypoScript template/);
    assert.match(output, /\[provision\] done\n$/);
  });

  check("provisioning's UTF-8 round trip through pages.title passes", () => {
    assert.match(site.provisionOutput, /\[provision\] pages\.title charset: utf8\n/);
    assert.match(site.provisionOutput, /\[provision\] UTF-8 round trip through pages\.title: ok\n/);
  });

  checkClock(site);
  checkSecondProvision(site);

  const frontendChecks = (label, get) => check(label, () => {
    const started = Date.now();
    const response = get('index.php');
    const elapsed = Date.now() - started;
    if (!response.text.includes('<h1>TYPO3 4.5.40</h1>')) {
      console.log(`     ${response.status}, ${response.body.length} bytes, log: ${response.log.join(' | ')}`);
      console.log(response.text.slice(0, 1500));
    }
    console.log(`     ${response.status}, ${response.body.length} bytes in ${elapsed} ms`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.includes('<h1>TYPO3 4.5.40</h1>'), 'the seeded heading is missing');
    // The PHP of the Docker job, which runs the same version.
    assert.match(response.text, /Rendered by TypoScript on PHP 5\.6\.40/);
    // The job asserts 12:00:00, under its frozen clock. Here the clock runs
    // from noon.
    assert.match(response.text, /Page generated&nbsp;2015-02-19 12:[0-9]{2}:[0-9]{2}/);
    // Compared as bytes: written by provision.php, stored by the shim as
    // utf8, read back by t3lib_db and rendered by TypoScript.
    const probe = (response.text.match(/<p id="charset-probe">(.*?)<\/p>/s) || [])[1];
    assert.strictEqual(probe, utf8Bytes(probeText), 'the charset probe is not the UTF-8 bytes stored for the title');
    assert.match(response.header('Content-Type'), /^text\/html; *charset=utf-8$/i);
    assertNoPhpErrors(response);
  });

  frontendChecks('the frontend renders the seeded page through TypoScript, as UTF-8', get);

  check('the backend serves its login form, with a challenge', () => {
    const response = get('typo3/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /name="userident"/);
    // The challenge 4.5 keeps in the PHP session and checks on login.
    assert.match(response.text, /name="challenge" value="[0-9a-f]{32}"/);
    assertNoPhpErrors(response);
  });

  check('the Install Tool answers with its password form, opened by typo3conf/ENABLE_INSTALL_TOOL alone', () => {
    const response = get('typo3/install/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /id="t3-install-form-password"/);
    assert.doesNotMatch(response.text, /The Install Tool is locked/);
    assertNoPhpErrors(response);
  });

  checkSourceProtection(site, '/typo3/gfx/refresh_n.gif');

  check("4.5/apache-typo3.conf's own rules: the deprecation log answers 403, and t3lib/ lists nothing", () => {
    const send = urlPath => site.handle({ path: urlPath, headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(send('/typo3conf/deprecation_0123456789.log').status, 403);
    const listing = send('/t3lib/');
    assert.doesNotMatch(Buffer.from(listing.body).toString('latin1'), /Index of \//i);
  });


  // --- the job's "Backend login and record editing" step -----------------

  // 4.5/ci-login.sh: superchallenged, as 3.8.1 and 4.0.13, since 4.5's
  // loginSecurityLevel is empty (typo3/index.php:110, :143-144). 4.5 keeps
  // the challenge it issued in the PHP session, and answers with a 303 to
  // backend.php, built as an absolute URL.
  const admin = browser(site);
  check('the login, as the form computes it, answers 303 to backend.php', () => {
    const response = logIn(admin);
    console.log(`     ${response.status} to ${response.header('Location')}`);
    assert.strictEqual(response.status, 303);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/backend.php');
    assert.ok(admin.cookie('be_typo_user'), 'no backend session cookie');
    assertNoPhpErrors(response);
  });
  // Right after the login, as for the older releases.
  checkFreshSessions(site, admin);

  // The ExtJS viewport, which is what 4.5 has where 3.8 and 4.0 have a
  // frameset. Its configuration carries the site URL, in its plain-HTTP form,
  // and the token Ext.Direct calls need (4.5/ci-extdirect.sh).
  let extDirectToken = null;
  check("backend.php answers with the ExtJS viewport, siteUrl http://localhost/ and an Ext.Direct token", () => {
    const response = admin('typo3/backend.php');
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.includes('"siteUrl":"http:\\/\\/localhost\\/"'), 'siteUrl is not http://localhost/');
    assert.match(response.text, /Ext\.onReady/);
    extDirectToken = (response.text.match(/TYPO3\.ExtDirectToken = "([0-9a-f]{40})"/) || [])[1];
    assert.ok(extDirectToken, 'backend.php carried no TYPO3.ExtDirectToken');
    assertNoPhpErrors(response);
  });

  // The probe through TCEforms, as UTF-8: the job greps for it in alt_doc.php.
  let editor = null;
  check("alt_doc.php shows the root page's title as its UTF-8 bytes", () => {
    editor = admin('typo3/alt_doc.php', { query: EDIT_ROOT_PAGE });
    assert.strictEqual(editor.status, 200);
    assert.match(editor.header('Content-Type'), /^text\/html; *charset=utf-8$/i);
    assert.strictEqual(titleField(editor), utf8Bytes(CHARSET_PROBE));
    assertNoPhpErrors(editor);
  });

  // Not in the job, which stops at the form: the whole form posted back, as a
  // browser does on a UTF-8 page, with a title outside latin1.
  check('saving a UTF-8 title stores its bytes, and the form and the frontend show them', () => {
    const response = saveTitle(admin, editor, utf8Bytes(CHARSET_PROBE_SAVED));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(titleField(response), utf8Bytes(CHARSET_PROBE_SAVED));
    assertNoPhpErrors(response);
    // What TCEmain wrote, through the shim's HEX(): UTF-8, so C3B8 for the ø.
    assert.deepStrictEqual(site.query('SELECT HEX(title) FROM pages WHERE uid = 1').rows,
      [[Buffer.from(CHARSET_PROBE_SAVED, 'utf8').toString('hex').toUpperCase()]]);
    const frontend = get('index.php', { query: 'no_cache=1' });
    assert.ok(frontend.text.includes(`<p id="charset-probe">${utf8Bytes(CHARSET_PROBE_SAVED)}</p>`), 'the frontend does not show the saved title');
    assertNoPhpErrors(frontend);
    probeText = CHARSET_PROBE_SAVED;
  });
  // And without no_cache: TCEmain cleared the page's cache.
  frontendChecks('the frontend renders the saved title through TypoScript', get);

  // --- the job's "Ext.Direct, and PHP 5.6's raw-POST deprecation" step -----

  check('the page tree answers over Ext.Direct, as JSON, with the saved title below the site', () => {
    const response = callPageTree(admin, extDirectToken);
    assert.strictEqual(response.status, 200);
    assert.match(response.header('Content-Type'), /^application\/json; *charset=utf-8$/i);
    assertPageTree(response, 'TYPO3 4.5.40', probeText);
    assertNoPhpErrors(response);
  });

  // The job's phases 2 and 3.
  await checkRawPostControl(site, workRoot, `be_typo_user=${admin.cookie('be_typo_user')}`, extDirectToken, 'TYPO3 4.5.40', probeText);

  // --- the job's "Behind TLS" step --------------------------------------

  // The job recreates the container with HTTPS=on. Here the service worker
  // says per request whether the page was asked over HTTPS, so both phases
  // run on one site. trustedHostsPattern = '.*' keeps 4.5.40 from refusing a
  // request it believes is on 443 with the Host saying otherwise.
  const secure = router(site, { https: true });
  check('index_re.php redirects to http:// over HTTP, and to https:// over HTTPS', () => {
    assert.strictEqual(router(site)('typo3/index_re.php').header('Location'), 'http://localhost/typo3/index.php');
    assert.strictEqual(secure('typo3/index_re.php').header('Location'), 'https://localhost/typo3/index.php');
  });
  check('over HTTPS, the frontend renders the page, and the backend its login form', () => {
    const frontend = secure('');
    assert.strictEqual(frontend.status, 200);
    assert.ok(frontend.text.includes('<h1>TYPO3 4.5.40</h1>'), 'the seeded heading is missing');
    assertNoPhpErrors(frontend);
    const form = secure('typo3/index.php');
    assert.match(form.text, /name="userident"/);
    assert.doesNotMatch(form.text, /trusted hosts pattern/i);
    assertNoPhpErrors(form);
  });
  check('over HTTPS, the login answers 303 to https://, and backend.php says siteUrl https://', () => {
    const response = logIn(secure, 'https');
    console.log(`     ${response.status} to ${response.header('Location')}`);
    assert.strictEqual(response.status, 303);
    assert.strictEqual(response.header('Location'), 'https://localhost/typo3/backend.php');
    const backend = secure('typo3/backend.php');
    assert.strictEqual(backend.status, 200);
    assert.ok(backend.text.includes('"siteUrl":"https:\\/\\/localhost\\/"'), 'siteUrl is not https://localhost/');
    assertNoPhpErrors(backend);
  });

  // --- uploads, as for 3.8.1 and 4.0.13 ----------------------------------

  // ci-backend-session.sh's assert_admin_can_upload. 4.5 answers with a 303
  // either way, and tells the admin why it refused a file on the next page
  // that shows messages: a t3lib_FlashMessage it keeps in the backend
  // session, serialized with the NUL bytes of its protected properties.
  check('the admin uploads a file into fileadmin/, and it is served back byte for byte', () => {
    const response = upload(site, admin, 'ci-upload.txt', UPLOADED);
    assert.strictEqual(response.status, 303);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/file_list.php');
    assert.deepStrictEqual(response.log, []);
    const served = site.handle({ path: '/fileadmin/ci-upload.txt', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(served.status, 200);
    assert.strictEqual(Buffer.from(served.body).toString('latin1'), UPLOADED);
  });
  check('TYPO3 itself refuses a .php upload, and the file list says so, from the backend session', () => {
    const response = upload(site, admin, 'refused.php', '<?php echo "uploaded"; ?>');
    assert.strictEqual(response.status, 303);
    assert.deepStrictEqual(site.php.FS.readdir(`${site.docroot}/fileadmin`).filter(name => name.endsWith('.php')), []);
    assert.match(site.query('SELECT ses_data FROM be_sessions').rows.map(([data]) => data).join(''),
      /O:18:"t3lib_FlashMessage":4:\{s:17:"\0\*\0storeInSession"/);
    const list = admin('typo3/sysext/filelist/mod1/file_list.php', { query: `id=${encodeURIComponent(`${site.docroot}/fileadmin/`)}` });
    assert.strictEqual(list.status, 200);
    assert.ok(list.text.includes('Extension of file name "refused.php" is not allowed in "/var/www/fileadmin/"!'), 'no refusal message');
    assertNoPhpErrors(list);
  });

  // --- the Install Tool ---------------------------------------------------

  // ImageMagick cannot run in WebAssembly. With [GFX][im] = 0, 4.5.40's own
  // Install Tool skips its ImageMagick tests and says why, and runs its GD
  // tests against the reference images it ships.
  const installTool = browser(site);
  check('the Install Tool logs in with joh316 through its own form, with a 303', () => {
    const page = installTool('typo3/install/index.php');
    const { action, fields } = readForm(page.text);
    const response = installTool(`typo3/install/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlEncoded(fields.map(([name, value]) => [name, name === 'password' ? 'joh316' : value])),
    });
    assert.strictEqual(response.status, 303);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/install/index.php?TYPO3_INSTALL[type]=about');
    assert.ok(installTool.cookie('Typo3InstallTool'), 'no Install Tool session cookie');
  });

  check("the Install Tool's image tests: GD's pass, ImageMagick's are skipped as 4.5.40 intends", () => {
    const imageTest = type => {
      const response = installTool('typo3/install/index.php', { query: `TYPO3_INSTALL[type]=images&TYPO3_INSTALL[images_type]=${type}` });
      assert.strictEqual(response.status, 200);
      assertNoPhpErrors(response);
      return response;
    };
    const gd = imageTest('gdlib');
    const text = visibleText(gd);
    assert.match(text, /ImageMagick enabled: 0 .* GDLib enabled: 1 /);
    // Each test shows the server's image beside 4.5.40's reference, with sizes.
    assert.match(text, /Create simple image Your server: Reference: (\d+) , 170x136 pixels \1 , 170x136 pixels/);
    assert.match(text, /Create image from file Your server: Reference: ([\d.]+ K), 170x136 pixels \1, 170x136 pixels/);
    // FreeType 2 draws the text with other pixels than the reference's, so
    // the size differs.
    assert.match(text, /Render text with TrueType font Your server: Reference: [\d.]+ K?, 170x136 pixels/);
    assert.match(text, /ImageMagick is needed to generate text with the niceText option/);
    assert.match(text, /ImageMagick is needed to generate shadows/);
    const images = gd.text.match(/typo3temp\/install_[0-9a-f]+\.gif/g) || [];
    assert.strictEqual(new Set(images).size, 3);
    for (const image of images) {
      assert.strictEqual(Buffer.from(site.php.FS.readFile(`${site.docroot}/${image}`)).subarray(0, 4).toString('latin1'), 'GIF8');
    }
    for (const type of ['read', 'write', 'scaling', 'combining']) {
      assert.match(visibleText(imageTest(type)), /Test skipped Use of ImageMagick has been disabled in the configuration/, type);
    }
  });

  // Not in the job: the test mail of the Basic Configuration page, which 4.5
  // sends with t3lib_mail, on SwiftMailer, through mail(). Docker's
  // sendmail_path is /bin/true, so the mail is "sent" and goes nowhere; here
  // too, through native/popen.c.
  check('the Install Tool sends its test mail through SwiftMailer and mail(), as Docker does to /bin/true', () => {
    const response = installTool('typo3/install/index.php', {
      query: 'TYPO3_INSTALL[type]=config',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlEncoded([['TYPO3_INSTALL[check_mail]', 'admin@example.com']]),
    });
    assert.strictEqual(response.status, 200);
    assertNoPhpErrors(response);
    assert.match(visibleText(response), /Mail was sent to: admin@example\.com/);
  });

  checkNothingRejected(rejected);

  checkUploadRestored(await checkRestore(site, workRoot, frontendChecks));

  finish('stack 4.5.40');
})();
