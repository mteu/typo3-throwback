// TYPO3 6.2.31 on the WebAssembly stack, held to the typo3-6-2 job in
// .github/workflows/images.yml, its steps "The installer's own record",
// "Smoke test", "Backend login and record editing", "Ext.Direct, and PHP
// 5.6's raw-POST deprecation" and "Behind TLS", with 6.2/ci-login.sh,
// 6.2/ci-rsa.py, 6.2/ci-extdirect.sh and 6.2/ci-check-page-tree.py
// (stack.cjs says how):
//
//   the site provisions as 6.2/entrypoint.sh does on first boot:
//   6.2/provision.php preflight, unchanged, finds a utf8 server and an empty
//   database; runtime/step-installer.js, the twin of 6.2/install.php, walks
//   the installer's five steps; 6.2/provision.php seed, unchanged, seeds the
//   site, a root page with a content element
//   every line they log is the job's, but the client version mysqli reports
//   the installer's environment check says what it says in Docker, word for
//   word, and nothing more
//   the installer creates the tables it creates in Docker
//   the frontend renders the content element through css_styled_content, as
//   UTF-8, on the PHP its Docker stack runs
//   the backend serves rsaauth's login form, and the Install Tool its
//   password form, opened by typo3conf/ENABLE_INSTALL_TOOL alone
//   configuration, logs and source files answer 403
//   every clock PHP and the server read starts at noon on the release day,
//   in UTC, whatever the host's time zone
//   seed, run again as on every container start, does nothing
//   the login works as rsaauth's form does it, with a key OpenSSL generates
//   in PHP and a password Node encrypts, and opens backend.php
//   cookieless requests get sessions of their own, and a request with the
//   cookie finds its session through mysqli's prepared statements
//   the record editor saves the charset probe into the page's title and the
//   content element's bodytext as UTF-8 bytes, which MySQL stores and the
//   editor and the frontend show, byte for byte
//   the page tree answers over Ext.Direct, as JSON, with the saved title
//   always_populate_raw_post_data = -1 keeps PHP 5.6's raw-POST deprecation
//   out of that JSON, and 0 puts it in front of it, as in the job
//   over HTTPS, redirects, the login and backend.php's siteUrl say https://
//   the admin uploads a file into fileadmin/ through FAL, and TYPO3 refuses
//   a .php one, which the file list says
//   the Install Tool logs in with the admin's password; its database
//   analyzer finds nothing to change, its GD tests draw, its ImageMagick
//   tests fail as in Docker, which has no ImageMagick either, and it sends
//   its test mail, to nowhere, as Docker does
//   the Install Tool renames the site and creates a second admin
//   the MySQL server rejects nothing 6.2 sends, but the installer's two
//   tries of the empty default configuration, which fail in Docker too
//   TYPO3 logs no PHP error to sys_log
//   the site's snapshot restores into a new instance, renders the same, and
//   keeps the edits and the upload
//
// It prints how long the boot takes, each installer step, the size of
// typo3conf/ and typo3temp/ afterwards, and how long rsaauth's login form
// and its public key take. The key request makes two keys with OpenSSL: one
// to see that OpenSSL works (PhpBackend.php, isAvailable()), and the pair.
//
// Usage: node stack-6.2.31.cjs <work-root>
'use strict';

const {
  check, finish, client, browser, router, printProvisionOutput, assertNoPhpErrors, checkClock, checkRestore, checkNothingRejected,
  cookiesFrom, runScript, saveTitle, saveBodytext, visibleText, utf8Bytes, titleField, bodytextField, bodytextRendered,
  callPageTree, assertPageTree, checkRawPostControl, UPLOADED, checkUploadRestored, USER_AGENT, EDIT_ROOT_PAGE,
  EDIT_CONTENT_ELEMENT, SEEDED_TEXT,
} = require('./stack.cjs');
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { readForm, multipart } = require('./forms.cjs');
const { bootRelease } = require('./release-site.cjs');
const MysqlOnSqlite = require('../runtime/mysql-sqlite.js');

const workRoot = path.resolve(process.argv[2]);

// The job's CHARSET_PROBE: what it saves through the record editor into the
// page's title and the content element's bodytext.
const CHARSET_PROBE = 'Skaarhøj · Gödöllő · 日本語';
const SITE_NAME = 'TYPO3 6.2.31';
// The content element's header, as css_styled_content renders it.
const SEEDED_HEADING = /<h1[^>]*>TYPO3 6\.2\.31<\/h1>/;
// The bodytext the record editor shows, as bytes. The factory configuration
// loads rtehtmlarea, whose hidden <textarea> carries the field transformed for
// the editor: each line of plain text in a <p>.
const shownBodytext = response => (bodytextField(response) || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/^<p>([\s\S]*)<\/p>$/, '$1');
// What the Install Tool renames the site to, as UTF-8.
const RENAMED_SITE = 'TYPO3 6.2.31 · gespeichert';

// The Install Tool's two edits, as a site holds them: the name in
// LocalConfiguration.php, as var_export() writes it, and the admin in
// be_users, with a salted hash, not the password.
function assertEdits(site) {
  const configuration = Buffer.from(site.php.FS.readFile(`${site.docroot}/typo3conf/LocalConfiguration.php`)).toString('latin1');
  assert.ok(configuration.includes(`'sitename' => '${utf8Bytes(RENAMED_SITE)}',`), 'the site name is not in LocalConfiguration.php');
  const editor = site.query("SELECT username, admin, password FROM be_users WHERE username = 'editor' AND deleted = 0");
  assert.strictEqual(editor.kind, 'result');
  assert.strictEqual(editor.rows.length, 1);
  const [username, admin, password] = editor.rows[0];
  assert.deepStrictEqual([username, admin], ['editor', '1']);
  assert.match(password, /^\$P\$|^\$1\$|^\$pbkdf2/, `not a salted hash: ${password}`);
}

// The part of install.php's environment-check line that lists what the
// check found, from a typo3-6-2 job's log: no typo3_src link, since the
// archive is copied flat, and the default 2 MB upload limit.
const DOCKER_ENVIRONMENT_FINDINGS = 'Detailed analysis /typo3_src should be a link, but it does not exist'
  + ' Links cannot be fixed by this system PHP Maximum upload filesize too small PHP upload_max_filesize = 2048 KB'
  + ' TYPO3_CONF_VARS[BE][maxFileSize] = 10240 KB Currently PHP determines the limits for uploaded file\'s sizes'
  + ' and not TYPO3. It is recommended that the value of upload_max_filesize is at least equal to the value of'
  + ' TYPO3_CONF_VARS[BE][maxFileSize]. &nbsp;';

// The statements the server refused, from the first one: the installer's
// own included, which run before the probe has the site.
const rejected = [];
class WatchedMysql extends MysqlOnSqlite {
  handle(op, link, a, b, c) {
    const response = super.handle(op, link, a, b, c);
    if (response.kind === 'error') {
      rejected.push(`${response.message}: ${String(a).slice(0, 300)}`);
    }
    return response;
  }
}

function directorySize(FS, directory) {
  let files = 0;
  let bytes = 0;
  const walk = dir => {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') {
        continue;
      }
      const stat = FS.lstat(`${dir}/${name}`);
      if (FS.isDir(stat.mode)) {
        walk(`${dir}/${name}`);
      } else {
        files++;
        bytes += stat.size;
      }
    }
  };
  walk(directory);
  return { files, bytes };
}

// 6.2/ci-login.sh's login_and_expect, as rsaauth's form script does it
// (rsaauth/resources/BackendLoginFormRsaEncryption.js): the form starts the
// session, ajax.php hands out a public key and keeps the private half in
// the PHP session, and the password goes as rsa:<base64>, encrypted with
// PKCS#1 v1.5 padding, as 6.2/ci-rsa.py and jsbn do. send is a client that
// keeps cookies: browser() or router(). Returns the post's response, and
// how long the form and the key took.
function logIn(send, scheme = 'http') {
  let started = Date.now();
  const form = send('typo3/index.php');
  const formMs = Date.now() - started;
  assert.match(form.text, /id="typo3-login-form"/, "the login form is not rsaauth's");
  started = Date.now();
  const key = send('typo3/ajax.php', { query: 'ajaxID=BackendLogin%3A%3AgetRsaPublicKey&skipSessionUpdate=1' });
  const keyMs = Date.now() - started;
  assert.strictEqual(key.status, 200);
  const { publicKeyModulus, exponent } = JSON.parse(key.text);
  const hex = value => Buffer.from(value.length % 2 ? `0${value}` : value, 'hex').toString('base64url');
  const publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: hex(publicKeyModulus), e: hex(exponent) }, format: 'jwk' });
  const encrypted = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from('password'));
  const response = send('typo3/index.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Checked against the host on submitted logins
      // (AbstractUserAuthentication.php:668).
      Referer: `${scheme}://localhost/typo3/index.php`,
    },
    body: new URLSearchParams([
      ['login_status', 'login'], ['username', 'admin'], ['p_field', ''],
      ['userident', `rsa:${encrypted.toString('base64')}`], ['interface', 'backend'], ['commandLI', 'Submit'],
    ]).toString(),
  });
  return { response, formMs, keyMs, keyBits: publicKey.asymmetricKeyDetails.modulusLength };
}

// The file list's upload form, filled in and posted as a browser posts it:
// to tce_file.php, with the form's own fields, its formToken among them,
// and the file in upload_1[]. 6.2 stores it through FAL, in the storage
// the installer created for fileadmin/, and answers with a 303 to the file
// list either way, which shows any refusal as a flash message.
const UPLOAD_FORM = 'target=1%3A%2F';
function upload(admin, filename, content) {
  const form = admin('typo3/file_upload.php', { query: UPLOAD_FORM });
  assert.strictEqual(form.status, 200);
  const { action, fields } = readForm(form.text);
  assert.strictEqual(action, 'tce_file.php');
  const response = admin('typo3/tce_file.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'multipart/form-data; boundary=probeboundary',
      Referer: `http://localhost/typo3/file_upload.php?${UPLOAD_FORM}`,
    },
    body: multipart('probeboundary', [...fields.map(([name, value]) => ({ name, value })), { name: 'upload_1[]', filename, value: content }]),
  });
  return { response, redirect: new Map(fields).get('redirect') };
}

(async () => {
  const steps = [];
  const started = Date.now();
  const site = await bootRelease('6.2.31', workRoot, {
    MysqlOnSqlite: WatchedMysql,
    onProgress: text => steps.push([text, Date.now() - started]),
  });
  const booted = Date.now() - started;
  const get = client(site);
  const output = site.provisionOutput;
  const rejectedWhileProvisioning = rejected.splice(0);
  // The root page's title and the content element's bodytext, which the
  // record editor changes below.
  let title = SITE_NAME;
  let bodytext = SEEDED_TEXT;

  // --- the job's "The installer's own record" -----------------------------

  check('6.2/entrypoint.sh\'s first boot: provision.php preflight, the installer, provision.php seed', () => {
    printProvisionOutput(site, booted);
    steps.push(['done', booted]);
    console.log(`     boot steps, ms from the start: ${steps.map(([text, ms]) => `${ms} ${text}`).join('; ')}`);
    console.log(`     installer steps, ms each: ${site.installerSteps.map(({ action, ms }) => `${action} ${ms}`).join(', ')}`
      + ` (${site.installerSteps.reduce((sum, { ms }) => sum + ms, 0)} in all)`);
    for (const directory of ['typo3conf', 'typo3temp']) {
      const { files, bytes } = directorySize(site.php.FS, `${site.docroot}/${directory}`);
      console.log(`     ${directory}/ afterwards: ${files} files, ${bytes} bytes`);
    }
    // The job's log has the same lines, but this one: Docker's mysqli is on
    // mysqlnd, and the shim's client is the 5.5 API.
    const lines = output.split('\n');
    assert.strictEqual(lines.filter(line => line === '[provision] connected to MySQL 5.5.62 (client 5.5.62)').length, 2);
    const preflight = [
      '[provision] server charset: utf8',
      '[provision] connection charset: utf8',
      '[provision] database charset: utf8',
      '[provision] database typo3 is empty, ready for the installer',
    ];
    assert.deepStrictEqual(lines.slice(1, 5), preflight);
    assert.deepStrictEqual(lines.slice(5, 12).map(line => line.replace(/^(\[install\] the environment check reported errors or warnings:).*/, '$1')), [
      '[install] step 1: environmentAndFolders',
      '[install] the environment check reported errors or warnings:',
      '[install] step 2: databaseConnect',
      '[install] step 3: databaseSelect',
      '[install] step 4: databaseData',
      '[install] step 5: defaultConfiguration',
      '[install] installer finished after environmentAndFolders, databaseConnect, databaseSelect, databaseData, defaultConfiguration;'
        + ' it sent the browser to http://127.0.0.1/typo3/sysext/install/Start/../../../index.php',
    ]);
    assert.deepStrictEqual(lines.slice(13), [
      ...preflight.slice(0, 3),
      '[provision] the installer created 60 tables, 18 of them for the caching framework',
      '[provision] created root page (uid 1)',
      '[provision] created content element (uid 1)',
      '[provision] pages.title charset: utf8',
      '[provision] tt_content.header charset: utf8',
      '[provision] tt_content.bodytext charset: utf8',
      '[provision] created root TypoScript template',
      '[provision] done',
      '',
    ]);
  });

  check("the installer's environment check finds what it finds in Docker, and nothing more", () => {
    const line = output.split('\n').find(text => text.startsWith('[install] the environment check reported'));
    const findings = line.replace(/^.*?(Detailed analysis)/, '$1').replace(/ TYPO3 CMS\. Copyright.*$/, '');
    assert.strictEqual(findings, DOCKER_ENVIRONMENT_FINDINGS);
  });

  check('PHP logged nothing while the site provisioned', () => {
    assert.deepStrictEqual(site.provisionLog, []);
  });

  // DatabaseConnect::needsExecution() tries the configuration it has, an
  // empty one, on localhost, then writes 127.0.0.1 as the default host and
  // tries again, before the form asks for anything. In Docker both fail
  // too, as connection errors: nothing listens there in the web container.
  // The shim answers every host, so they fail as a refused login.
  check("the server refused only the installer's two tries of its empty default configuration", () => {
    assert.deepStrictEqual(rejectedWhileProvisioning, [
      "Access denied for user ''@'localhost' (using password: NO): null",
      "Access denied for user ''@'127.0.0.1' (using password: NO): 127.0.0.1",
    ]);
  });

  check('provision.php seed, run again as on every container start, finds the pages seeded', () => {
    const response = site.provision(['seed']);
    assert.match(response.text, /\[provision\] pages already seeded, nothing to do\n$/);
  });

  // --- the job's "Smoke test" ----------------------------------------------

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
    assert.match(response.text, /Rendered by TypoScript on PHP 5\.6\.40/);
    // The job asserts 12:00:00, under its frozen clock. Here the clock runs
    // from noon.
    assert.match(response.text, /Page generated&nbsp;2017-04-18 12:[0-9]{2}:[0-9]{2}/);
    // Compared as bytes: written by provision.php or DataHandler, read back
    // and rendered by css_styled_content.
    assert.strictEqual(bodytextRendered(response), utf8Bytes(bodytext), 'the bodytext is not the UTF-8 bytes stored for it');
    assert.ok(response.text.includes(`<title>${utf8Bytes(title)}</title>`), 'the page title is not the UTF-8 bytes stored for it');
    assert.match(response.header('Content-Type'), /^text\/html; *charset=utf-8$/i);
    assertNoPhpErrors(response);
  });

  frontendChecks('the frontend renders the seeded content element through css_styled_content, as UTF-8', get);

  check("the backend serves rsaauth's login form, which the installer's configuration selects", () => {
    const response = get('typo3/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /id="typo3-login-form"/);
    assertNoPhpErrors(response);
  });

  // install.php keeps its cookies to itself, so a visitor's first Install
  // Tool page asks for the password. Through the site's router, with the
  // site's own cookie jar, as the tab sends it.
  check("the installer's session stays with the installer: the site's own cookie jar opens the Install Tool at its password form", () => {
    const response = site.handle({ path: '/typo3/sysext/install/Start/Install.php', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(response.status, 200);
    assert.match(Buffer.from(response.body).toString('latin1'), /id="t3-install-form-password"/);
  });

  check('the Install Tool answers with its password form, opened by typo3conf/ENABLE_INSTALL_TOOL alone', () => {
    // The old entry point answers a relative 303 to the new one, which the
    // job's curl -L follows.
    const old = get('typo3/install/index.php');
    assert.strictEqual(old.status, 303);
    const location = old.header('Location');
    const target = new URL(location, 'http://localhost/typo3/install/');
    const response = get(target.pathname.slice(1), { query: target.search.slice(1) });
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /id="t3-install-form-password"/);
    assertNoPhpErrors(response);
  });

  check("configuration, logs and source files answer 403, other files 200, and typo3/sysext/ lists nothing", () => {
    const send = urlPath => site.handle({ path: urlPath, headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    for (const urlPath of ['typo3conf/LocalConfiguration.php', 'typo3conf/PackageStates.php',
      'typo3conf/AdditionalConfiguration.php', 'typo3temp/logs/typo3.log',
      'typo3/sysext/core/Configuration/DefaultConfiguration.php', 'composer.json', 'ChangeLog']) {
      assert.strictEqual(send(`/${urlPath}`).status, 403, `/${urlPath}`);
    }
    assert.strictEqual(send('/typo3/gfx/alt_backend_logo.gif').status, 200);
    assert.doesNotMatch(Buffer.from(send('/typo3/sysext/').body).toString('latin1'), /Index of \//i);
  });

  checkClock(site);

  // --- the job's "Backend login and record editing" step -----------------

  const admin = browser(site);
  check("the login, as rsaauth's form does it, answers 303 to backend.php", () => {
    const { response, formMs, keyMs, keyBits } = logIn(admin);
    console.log(`     the form in ${formMs} ms, a ${keyBits}-bit public key in ${keyMs} ms; ${response.status} to ${response.header('Location')}`);
    assert.strictEqual(response.status, 303);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/backend.php');
    assert.ok(admin.cookie('be_typo_user'), 'no backend session cookie');
    assertNoPhpErrors(response);
  });

  // ci-backend-session.sh's assert_fresh_sessions_are_distinct, right after
  // the login, as for the older releases. Each form request starts two
  // sessions: TYPO3's, and the PHP session rsaauth keeps its key in.
  check('twelve cookieless requests get twelve fresh sessions, none the logged-in one', () => {
    const backendSessions = new Set();
    const phpSessions = new Set();
    for (let i = 0; i < 12; i++) {
      const response = get('typo3/index.php');
      assert.strictEqual(response.status, 200, `attempt ${i + 1} answered ${response.status}: it found someone's session`);
      assert.match(response.text, /id="typo3-login-form"/);
      const cookies = new Map(cookiesFrom(response).map(pair => pair.split('=')));
      assert.ok(cookies.get('be_typo_user') && cookies.get('PHPSESSID'), `attempt ${i + 1} started no session`);
      assert.notStrictEqual(cookies.get('be_typo_user'), admin.cookie('be_typo_user'), `attempt ${i + 1} was handed the logged-in session`);
      backendSessions.add(cookies.get('be_typo_user'));
      phpSessions.add(cookies.get('PHPSESSID'));
    }
    assert.strictEqual(backendSessions.size, 12);
    assert.strictEqual(phpSessions.size, 12);
  });

  // 6.2 finds a session through mysqli's prepared statements
  // (AbstractUserAuthentication.php:1111-1140). The shim's client prepares a
  // SELECT by running it with NULL for each placeholder, to learn its
  // columns, and executes it with the bound values as literals, so the
  // server sees both.
  let extDirectToken = null;
  check("backend.php finds the admin's session through a prepared statement, and answers with siteUrl http://localhost/", () => {
    const lookups = [];
    const handle = site.mysql.handle;
    site.mysql.handle = (op, link, a, b, c) => {
      const lookup = String(a).match(/^SELECT \* FROM be_sessions,be_users WHERE be_sessions\.ses_id = (NULL|'[0-9a-f]+')\s/);
      if (lookup) {
        lookups.push(lookup[1]);
      }
      return handle.call(site.mysql, op, link, a, b, c);
    };
    const started = Date.now();
    let response;
    try {
      response = admin('typo3/backend.php');
    } finally {
      site.mysql.handle = handle;
    }
    console.log(`     ${response.status}, ${response.body.length} bytes in ${Date.now() - started} ms`);
    assert.deepStrictEqual(lookups, ['NULL', `'${admin.cookie('be_typo_user')}'`]);
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.includes('"siteUrl":"http:\\/\\/localhost\\/"'), 'siteUrl is not http://localhost/');
    assert.match(response.text, /Ext\.onReady/);
    extDirectToken = (response.text.match(/TYPO3\.ExtDirectToken = "([0-9a-f]{40})"/) || [])[1];
    assert.ok(extDirectToken, 'backend.php carried no TYPO3.ExtDirectToken');
    assertNoPhpErrors(response);
  });

  // The job opens both records in one form and posts the two fields, doSave
  // and the form's token. This posts each whole form back, as a browser does
  // on a UTF-8 page, with text outside latin1.
  let editor = null;
  check("alt_doc.php shows the root page's title", () => {
    editor = admin('typo3/alt_doc.php', { query: EDIT_ROOT_PAGE });
    assert.strictEqual(editor.status, 200);
    assert.match(editor.header('Content-Type'), /^text\/html; *charset=utf-8$/i);
    assert.strictEqual(titleField(editor), title);
    assertNoPhpErrors(editor);
  });
  check('saving a UTF-8 title stores its bytes, and the form shows them', () => {
    const response = saveTitle(admin, editor, utf8Bytes(CHARSET_PROBE));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(titleField(response), utf8Bytes(CHARSET_PROBE));
    assertNoPhpErrors(response);
    // What DataHandler wrote, through the shim's HEX(): UTF-8, so C3B8 for
    // the ø.
    assert.deepStrictEqual(site.query('SELECT HEX(title) FROM pages WHERE uid = 1').rows,
      [[Buffer.from(CHARSET_PROBE, 'utf8').toString('hex').toUpperCase()]]);
    title = CHARSET_PROBE;
  });

  let contentEditor = null;
  check("alt_doc.php shows the content element's bodytext", () => {
    contentEditor = admin('typo3/alt_doc.php', { query: EDIT_CONTENT_ELEMENT });
    assert.strictEqual(contentEditor.status, 200);
    assert.strictEqual(shownBodytext(contentEditor), SEEDED_TEXT);
    assertNoPhpErrors(contentEditor);
  });
  check('saving a UTF-8 bodytext stores its bytes, and the form and the frontend show them', () => {
    const response = saveBodytext(admin, contentEditor, utf8Bytes(CHARSET_PROBE));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(shownBodytext(response), utf8Bytes(CHARSET_PROBE));
    assertNoPhpErrors(response);
    assert.deepStrictEqual(site.query('SELECT HEX(bodytext) FROM tt_content WHERE uid = 1').rows,
      [[Buffer.from(CHARSET_PROBE, 'utf8').toString('hex').toUpperCase()]]);
    const frontend = get('index.php', { query: 'no_cache=1' });
    assert.strictEqual(bodytextRendered(frontend), utf8Bytes(CHARSET_PROBE), 'the frontend does not show the saved bodytext');
    assertNoPhpErrors(frontend);
    bodytext = CHARSET_PROBE;
  });
  // And without no_cache: DataHandler cleared the page's cache.
  frontendChecks('the frontend renders the saved title and bodytext', get);

  // --- the job's "Ext.Direct, and PHP 5.6's raw-POST deprecation" step -----

  check('the page tree answers over Ext.Direct, as JSON, with the saved title below the site', () => {
    const response = callPageTree(admin, extDirectToken);
    assert.strictEqual(response.status, 200);
    assert.match(response.header('Content-Type'), /^application\/json; *charset=utf-8$/i);
    assertPageTree(response, SITE_NAME, title);
    assertNoPhpErrors(response);
  });

  // The job's phases 2 and 3.
  await checkRawPostControl(site, workRoot, `be_typo_user=${admin.cookie('be_typo_user')}`, extDirectToken, SITE_NAME, title);

  // --- the job's "Behind TLS" step --------------------------------------

  // The job recreates the container with HTTPS=on. Here the service worker
  // says per request whether the page was asked over HTTPS, so both phases
  // run on one site, through its own router and cookie jar.
  // trustedHostsPattern = '.*' keeps 6.2 from refusing a request it believes
  // is on 443 with the Host saying otherwise.
  const plain = router(site);
  const secure = router(site, { https: true });
  check("without a session, backend.php sends the visitor to the login, as http:// over HTTP and as https:// over HTTPS", () => {
    assert.strictEqual(plain('typo3/backend.php').header('Location'), 'http://localhost/typo3/');
    assert.strictEqual(secure('typo3/backend.php').header('Location'), 'https://localhost/typo3/');
  });
  check("over HTTPS, the frontend renders the page, and the backend rsaauth's login form", () => {
    const frontend = secure('');
    assert.strictEqual(frontend.status, 200);
    assert.match(frontend.text, SEEDED_HEADING, 'the seeded heading is missing');
    assertNoPhpErrors(frontend);
    const form = secure('typo3/index.php');
    assert.match(form.text, /id="typo3-login-form"/);
    assert.doesNotMatch(form.text, /trusted hosts pattern/i);
    assertNoPhpErrors(form);
  });
  check('over HTTPS, the login answers 303 to https://, and backend.php says siteUrl https://', () => {
    const { response } = logIn(secure, 'https');
    console.log(`     ${response.status} to ${response.header('Location')}`);
    assert.strictEqual(response.status, 303);
    assert.strictEqual(response.header('Location'), 'https://localhost/typo3/backend.php');
    const backend = secure('typo3/backend.php');
    assert.strictEqual(backend.status, 200);
    assert.ok(backend.text.includes('"siteUrl":"https:\\/\\/localhost\\/"'), 'siteUrl is not https://localhost/');
    assertNoPhpErrors(backend);
  });

  // --- uploads, as for the older releases --------------------------------

  // ci-backend-session.sh's assert_admin_can_upload, through 6.2's file
  // list. FAL records the file in sys_file, with the MIME type the local
  // driver reads with fileinfo, as Docker's PHP has it.
  check('the admin uploads a file into fileadmin/ through FAL, and it is served back byte for byte', () => {
    const { response, redirect } = upload(admin, 'ci-upload.txt', UPLOADED);
    assert.strictEqual(response.status, 303);
    assert.strictEqual(response.header('Location'), redirect);
    assert.deepStrictEqual(response.log, []);
    const served = site.handle({ path: '/fileadmin/ci-upload.txt', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(served.status, 200);
    assert.strictEqual(Buffer.from(served.body).toString('latin1'), UPLOADED);
    const recorded = site.query("SELECT storage, identifier, name, size, sha1, mime_type FROM sys_file WHERE name = 'ci-upload.txt'");
    assert.deepStrictEqual(recorded.rows.map(row => row.slice(0, 5)),
      [['1', '/ci-upload.txt', 'ci-upload.txt', String(UPLOADED.length), crypto.createHash('sha1').update(UPLOADED, 'latin1').digest('hex')]]);
    const mimeType = recorded.rows[0][5];
    const finfo = runScript(site, 'finfo.php', ['<?php', '$finfo = new finfo(FILEINFO_MIME_TYPE);', `echo $finfo->file('${site.docroot}/fileadmin/ci-upload.txt');`]);
    console.log(`     sys_file records ${mimeType}; fileinfo says ${finfo.text}`);
    assert.strictEqual(mimeType, finfo.text);
  });
  check('TYPO3 itself refuses a .php upload, and the file list says so', () => {
    const { response, redirect } = upload(admin, 'refused.php', '<?php echo "uploaded"; ?>');
    assert.strictEqual(response.status, 303);
    assert.deepStrictEqual(site.php.FS.readdir(`${site.docroot}/fileadmin`).filter(name => name.endsWith('.php')), []);
    const list = admin('typo3/mod.php', { query: new URL(redirect).search.slice(1) });
    assert.strictEqual(list.status, 200);
    assert.ok(visibleText(list).includes('Extension of file name &quot;refused.php&quot; is not allowed in &quot;/&quot;!'), 'no refusal message');
    assert.ok(list.text.includes('ci-upload.txt'), 'the file list does not show the uploaded file');
    assertNoPhpErrors(list);
  });

  // --- what the shim owes and Docker does not ------------------------------

  // A person in the Install Tool: log in with the password the installer
  // set, the admin's, and press buttons in "Important actions". Each button
  // posts its own form, with the form's token.
  const installTool = browser(site);
  const INSTALL_TOOL = 'typo3/sysext/install/Start/Install.php';
  const actionQuery = action => `install[controller]=tool&install[action]=${action}&install[context]=standalone`;
  const IMPORTANT_ACTIONS = actionQuery('importantActions');
  const urlEncodedForm = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const pressButton = (button, values = {}, action = 'importantActions') => {
    const page = installTool(INSTALL_TOOL, { query: actionQuery(action) });
    const forms = page.text.split(/(?=<form\b)/).filter(form => form.includes(`install[set][${button}]`));
    assert.strictEqual(forms.length, 1, `no form with the button ${button}; not logged in?`);
    const fields = readForm(forms[0]).fields.map(([name, value]) => {
      const key = (name.match(/^install\[values\]\[(\w+)\]$/) || [])[1];
      return [name, key && key in values ? values[key] : value];
    });
    const response = installTool(INSTALL_TOOL, {
      method: 'POST',
      query: actionQuery(action),
      headers: urlEncodedForm,
      body: new URLSearchParams([...fields, [`install[set][${button}]`, '1']]).toString(),
    });
    assertNoPhpErrors(response);
    return response;
  };

  check('the Install Tool logs in with the admin password, which the installer set as its own', () => {
    const login = readForm(installTool(INSTALL_TOOL).text);
    const response = installTool(INSTALL_TOOL, {
      method: 'POST',
      headers: urlEncodedForm,
      body: new URLSearchParams(login.fields.map(([name, value]) => [name, name === 'install[values][password]' ? 'password' : value])).toString(),
    });
    assert.ok([200, 303].includes(response.status), `logging in answered ${response.status}`);
    assert.match(installTool(INSTALL_TOOL, { query: IMPORTANT_ACTIONS }).text, /Compare current database with specification/);
  });

  // "Compare current database with specification": what 6.2 expects, from
  // every ext_tables.sql and the caching framework, against what the shim
  // says the tables are, through SHOW TABLES, SHOW COLUMNS and SHOW KEYS.
  check("the Install Tool's database analyzer finds nothing to change", () => {
    const analyzed = pressButton('databaseAnalyzerAnalyze');
    assert.match(analyzed.text, /Analyzed current database/);
    const suggestions = [...analyzed.text.matchAll(/<label for="t3-install-db-[0-9a-f]+">\s*([\s\S]*?)\s*<\/label>/g)]
      .map(([, statement]) => statement.replace(/\s+/g, ' '));
    assert.deepStrictEqual(suggestions, [], 'the analyzer suggests changes');
  });

  // "Test setup", as Docker has it: [GFX][im] is on, at /usr/bin/, and
  // neither stack has ImageMagick. Each call to it finds no program, as sh
  // would (native/popen.c). So GD draws, 6.2 cannot tell ImageMagick's
  // version, and each ImageMagick test says its images failed.
  const IMAGE_GENERATION_FAILED = 'Image generation failed ImageMagick / GraphicsMagick handling is enabled,'
    + ' but the execute command returned an error.';
  check("the Install Tool's image tests: GD's draw, ImageMagick's fail, as in Docker, which has no ImageMagick either", () => {
    const gd = pressButton('testGdlib', {}, 'testSetup');
    assert.strictEqual(gd.status, 200);
    const text = visibleText(gd);
    assert.match(text, /ImageMagick enabled: Yes ImageMagick or GraphicsMagick: ImageMagick ImageMagick path: \/usr\/bin\/ ImageMagick version: IM5 effects/);
    // Each test shows 6.2.31's reference beside the image drawn here.
    const size = '([\\d.]+ K?Bytes), 170 x 136 pixel';
    assert.match(text, new RegExp(`Create simple image Reference Your system ${size} \\1, 170 x 136 pixel`));
    assert.match(text, new RegExp(`Create image from file Reference Your system ${size} \\1, 170 x 136 pixel`));
    // FreeType 2 draws the text with other pixels than the reference's.
    // niceText and the shadow need ImageMagick, so their images are GD's
    // text alone.
    for (const title of ['Render text with TrueType font', "Render text with TrueType font using 'niceText' option",
      "Render 'niceText' with a shadow under"]) {
      assert.match(text, new RegExp(`${title} (Note on .*? )?Reference Your system ${size} ${size}`), title);
    }
    const images = [...new Set(gd.text.match(/typo3temp\/installTool-[\w-]+\.\d+\.gif/g) || [])];
    console.log(`     ${images.length} images: ${images.map(image => image.replace(/^typo3temp\/installTool-([\w-]+?)[0-9a-f]{13}\d\.\d+\.gif$/, '$1')).join(', ')}`);
    assert.strictEqual(images.length, 5);
    for (const image of images) {
      assert.strictEqual(Buffer.from(site.php.FS.readFile(`${site.docroot}/${image}`)).subarray(0, 4).toString('latin1'), 'GIF8');
    }
    const failures = {};
    for (const button of ['testConvertImageFormatsToJpg', 'testWriteGifAndPng', 'testScalingImages', 'testCombiningImages']) {
      const response = pressButton(button, {}, 'testSetup');
      assert.strictEqual(response.status, 200, button);
      failures[button] = visibleText(response).split(IMAGE_GENERATION_FAILED).length - 1;
    }
    console.log(`     failed: ${Object.entries(failures).map(([button, count]) => `${button} ${count}`).join(', ')}`);
    assert.deepStrictEqual(failures, { testConvertImageFormatsToJpg: 9, testWriteGifAndPng: 2, testScalingImages: 3, testCombiningImages: 2 });
  });

  // Not in the job: the test mail, which 6.2 sends with SwiftMailer, through
  // mail(). Docker's sendmail_path is /bin/true, so the mail is "sent" and
  // goes nowhere; here too, through native/popen.c.
  check('the Install Tool sends its test mail through SwiftMailer and mail(), as Docker does to /bin/true', () => {
    const response = pressButton('testMail', { testEmailRecipient: 'admin@example.com' }, 'testSetup');
    assert.strictEqual(response.status, 200);
    assert.match(visibleText(response), /Test mail sent Recipient: admin@example\.com/);
  });

  // Two edits for the saved site to carry: one to typo3conf/, one to the
  // database.
  check('the Install Tool renames the site, in LocalConfiguration.php, and creates a second admin, in be_users', () => {
    assert.match(pressButton('changeSiteName', { newSiteName: RENAMED_SITE }).text, /Site name changed/);
    assert.match(pressButton('createAdministrator', {
      newUserUsername: 'editor', newUserPassword: 'password2', newUserPasswordCheck: 'password2',
    }).text, /Administrator with username &quot;editor&quot;\.|Administrator with username "editor"\./);
    assertEdits(site);
  });

  checkNothingRejected(rejected);

  // TYPO3's error handler keeps PHP's warnings out of the page and writes
  // them to sys_log instead, where assertNoPhpErrors() cannot see them.
  check('TYPO3 logged no PHP error to sys_log', () => {
    assert.deepStrictEqual(site.query("SELECT details FROM sys_log WHERE details LIKE 'Core: Error handler%'").rows, []);
  });

  for (const directory of ['typo3conf', 'typo3temp']) {
    const { files, bytes } = directorySize(site.php.FS, `${site.docroot}/${directory}`);
    console.log(`     ${directory}/ after these requests: ${files} files, ${bytes} bytes`);
  }

  const restored = await checkRestore(site, workRoot, frontendChecks);
  check("the restored site keeps the Install Tool's two edits", () => assertEdits(restored));
  checkUploadRestored(restored);
  check('the restored site keeps the upload in sys_file, and the saved title and bodytext', () => {
    assert.deepStrictEqual(restored.query("SELECT identifier FROM sys_file WHERE name = 'ci-upload.txt'").rows, [['/ci-upload.txt']]);
    const probeHex = Buffer.from(CHARSET_PROBE, 'utf8').toString('hex').toUpperCase();
    assert.deepStrictEqual(restored.query('SELECT HEX(title) FROM pages WHERE uid = 1').rows, [[probeHex]]);
    assert.deepStrictEqual(restored.query('SELECT HEX(bodytext) FROM tt_content WHERE uid = 1').rows, [[probeHex]]);
  });

  finish('stack 6.2.31');
})().catch(error => {
  console.log(`FAIL ${error.stack}`);
  process.exit(1);
});
