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
//   the record editor shows labels from locallang XML, and saves a new page
//   title, which the frontend then shows
//   the admin uploads a file into fileadmin/, and TYPO3 refuses a .php one
//   the Install Tool's GD tests pass, and its ImageMagick tests say they are
//   skipped
//   a client with no cookie gets a session of its own
//   the MySQL server rejects nothing TYPO3 sends
//   the site's snapshot restores into a new instance, which renders the same
//
// Usage: node stack-3.8.1.cjs <work-root>
'use strict';

const {
  USER_AGENT, md5, check, finish, cookiesFrom, client, browser, printProvisionOutput, assertNoPhpErrors,
  watchRejectedStatements, checkNothingRejected, checkClock, checkSecondProvision, checkSourceProtection, checkRestore,
} = require('./stack.cjs');
const { readForm, multipart } = require('./forms.cjs');
const assert = require('assert');
const path = require('path');
const { bootRelease } = require('./release-site.cjs');

const workRoot = path.resolve(process.argv[2]);
const BOUNDARY = 'probeboundary';
const visibleText = response => response.text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const urlEncoded = fields => fields.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');

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
    // builds (#52).
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

  // .github/scripts/ci-backend-session.sh's login_and_expect: the form
  // request starts the PHP session that keeps the challenge, and the
  // password goes as md5(username:md5(password):challenge), as the form's
  // own JavaScript computes it ("superchallenged", typo3/index.php:169-175).
  const admin = browser(site);
  check('the login, as the form computes it, redirects to the frameset', () => {
    const form = admin('typo3/index.php');
    const challenge = (form.text.match(/name="challenge" value="([0-9a-f]{32})"/) || [])[1];
    assert.ok(challenge, 'the login form carried no challenge');
    const response = admin('typo3/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Checked against the host on submitted logins.
        Referer: 'http://localhost/typo3/index.php',
      },
      body: urlEncoded([
        ['login_status', 'login'], ['username', 'admin'], ['p_field', ''],
        ['userident', md5(`admin:${md5('password')}:${challenge}`)], ['challenge', challenge], ['interface', 'backend'],
      ]),
    });
    console.log(`     ${response.status} to ${response.header('Location')}`);
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/alt_main.php');
    assert.ok(admin.cookie('be_typo_user'), 'no backend session cookie');
  });

  check('alt_main.php answers with the frameset', () => {
    const response = admin('typo3/alt_main.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /<frameset/);
    assertNoPhpErrors(response);
  });

  // returnUrl is not decoration, as the job says: with fewer than two GET
  // vars alt_doc.php redirects to the last open document.
  const editQuery = 'returnUrl=db_layout.php%3Fid%3D1&edit%5Bpages%5D%5B1%5D=edit';
  let editor = null;
  check('alt_doc.php renders the root page header for editing', () => {
    editor = admin('typo3/alt_doc.php', { query: editQuery });
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

  // The form as a browser posts it when the title is changed and the save
  // button is clicked: to alt_doc.php itself, which hands the data to
  // TCEmain. The visible field and the hidden one the browser's JavaScript
  // copies it into both carry the new title.
  const newTitle = 'TYPO3 3.8.1, saved in the backend';
  check('saving the form stores the new title, and the frontend shows it', () => {
    const { action, fields } = readForm(editor.text, 'editform');
    const posted = fields.map(([name, value]) => [name, /^data\[pages\]\[1\]\[title\](_hr)?$/.test(name) ? newTitle : value]);
    posted.push(['_savedok.x', '8'], ['_savedok.y', '9']);
    const url = new URL(action, 'http://localhost/');
    const response = admin(url.pathname.slice(1), {
      method: 'POST',
      query: url.search.slice(1),
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        Referer: `http://localhost/typo3/alt_doc.php?${editQuery}`,
      },
      body: multipart(BOUNDARY, posted.map(([name, value]) => ({ name, value }))),
    });
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

  // ci-backend-session.sh's assert_admin_can_upload: the file list's upload
  // form, posted to tce_file.php. On success it redirects; on any error it
  // answers 200 with the error. 3.8/provision.php gives the admin
  // fileoper_perms = 7, without which even an admin may not upload.
  // disable_exec_function makes TYPO3 move the file with PHP's functions.
  const upload = (filename, content) => admin('typo3/tce_file.php', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, Referer: 'http://localhost/typo3/file_upload.php' },
    body: multipart(BOUNDARY, [
      { name: 'file[upload][1][target]', value: `${site.docroot}/fileadmin` },
      { name: 'file[upload][1][data]', value: '1' },
      { name: 'upload_1', filename, value: content },
      { name: 'redirect', value: 'file_list.php' },
    ]),
  });
  // Every byte value TYPO3 might mangle: a line end, latin1, NUL.
  const uploaded = 'Uploaded through tce_file.php.\n\xe4\xf6\xfc\xdf\x00\xff\r\n';
  check('the admin uploads a file into fileadmin/, and it is served back byte for byte', () => {
    const response = upload('ci-upload.txt', uploaded);
    if (response.status !== 302) {
      console.log(`     ${visibleText(response).slice(0, 400)}`);
    }
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/file_list.php');
    assert.deepStrictEqual(response.log, []);
    const served = site.handle({ path: '/fileadmin/ci-upload.txt', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(served.status, 200);
    assert.strictEqual(Buffer.from(served.body).toString('latin1'), uploaded);
  });

  check('TYPO3 itself refuses a .php upload', () => {
    const response = upload('refused.php', '<?php echo "uploaded"; ?>');
    assert.strictEqual(response.status, 200);
    assert.match(visibleText(response), /Fileextension &quot;php&quot; is not allowed in &quot;\/var\/www\/fileadmin\/&quot;!/);
    assert.deepStrictEqual(site.php.FS.readdir(`${site.docroot}/fileadmin`).filter(name => name.endsWith('.php')), []);
  });

  // ImageMagick cannot run in WebAssembly. With [GFX][im] = 0, 3.8.1's own
  // Install Tool skips its ImageMagick tests and says why, and runs its GD
  // tests against the reference images it ships. Unlike 3.3.0's, it does not
  // look for ImageMagick, so PHP logs nothing.
  const installTool = browser(site);
  check('the Install Tool logs in with joh316 through its own form', () => {
    const page = installTool('typo3/install/index.php');
    const { action, fields } = readForm(page.text);
    const response = installTool(`typo3/install/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlEncoded(fields.map(([name, value]) => [name, name === 'password' ? 'joh316' : value])),
    });
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.header('Location'), 'index.php?TYPO3_INSTALL[type]=about');
    assert.ok(installTool.cookie('Typo3InstallTool'), 'no Install Tool session cookie');
  });

  check("the Install Tool's image tests: GD's pass, ImageMagick's are skipped as 3.8.1 intends", () => {
    const imageTest = type => {
      const response = installTool('typo3/install/index.php', { query: `TYPO3_INSTALL[type]=images&TYPO3_INSTALL[images_type]=${type}` });
      assert.strictEqual(response.status, 200);
      assertNoPhpErrors(response);
      return response;
    };
    const gd = imageTest('gdlib');
    const text = visibleText(gd);
    assert.match(text, /ImageMagick enabled: 0 .* GDLib enabled: 1 GDLib using PNG: 0 GDLib 2 enabled: 1/);
    // Each test shows the server's image beside 3.8.1's reference, with sizes.
    assert.match(text, /Create simple image Your server: Reference: (\d+) , 170x136 pixels \1 , 170x136 pixels/);
    assert.match(text, /Create image from file Your server: Reference: ([\d.]+ K), 170x136 pixels \1, 170x136 pixels/);
    // FreeType 2 draws the text with other pixels than 2005's did, so the
    // size differs from the reference.
    assert.match(text, /Render text with TrueType font Your server: Reference: \d+ , 170x136 pixels/);
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

  // ci-backend-session.sh's assert_fresh_sessions_are_distinct, last as in
  // the job. 3.8.1 makes a session id from the clock and the process id, so
  // under a clock that stands still every request would get the same one
  // (#13). Here the clock runs, as in Docker.
  check('twelve cookieless requests get twelve fresh sessions, none the logged-in one', () => {
    const challenges = new Set();
    const sessions = new Set();
    for (let i = 0; i < 12; i++) {
      const response = get('typo3/index.php');
      assert.strictEqual(response.status, 200, `attempt ${i + 1} answered ${response.status}: it found someone's session`);
      const challenge = (response.text.match(/name="challenge" value="([0-9a-f]{32})"/) || [])[1];
      const session = (cookiesFrom(response).find(pair => pair.startsWith('be_typo_user=')) || '').slice('be_typo_user='.length);
      assert.ok(challenge && session, `attempt ${i + 1} carried no challenge or no session cookie`);
      assert.notStrictEqual(session, admin.cookie('be_typo_user'), `attempt ${i + 1} was handed the logged-in session`);
      challenges.add(challenge);
      sessions.add(session);
    }
    assert.strictEqual(challenges.size, 12);
    assert.strictEqual(sessions.size, 12);
  });

  checkNothingRejected(rejected);

  const restored = await checkRestore(site, workRoot, frontendChecks);
  check('the uploaded file is restored too', () => {
    assert.strictEqual(Buffer.from(restored.php.FS.readFile(`${restored.docroot}/fileadmin/ci-upload.txt`)).toString('latin1'), uploaded);
  });

  finish('stack 3.8.1');
})();
