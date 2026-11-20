// What every release's stack probe shares: the harness, a client for PHP, and
// the checks that hold for any release on the WebAssembly stack. Each
// stack-<release>.cjs holds that release to its own job in
// .github/workflows/images.yml, and uses these for the parts all jobs share.
//
// The site is the one the browser runs, built by runtime/typo3-site.js from
// releases/<release>.js (release-site.cjs): one PHP instance, one
// MySQL-on-SQLite server.
'use strict';

// Far from UTC on purpose: the stack runs in UTC, as the container does, and
// must not take the host's zone from the JS Date. Node applies a TZ set here,
// before any Date is made.
process.env.TZ = 'Asia/Tokyo';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readForm, multipart } = require('./forms.cjs');
const { bootRelease, repoRoot } = require('./release-site.cjs');

// The User-Agent CI sends: 3.3 refuses anything it does not take for a "4+ browser".
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
// .github/scripts/ci-assert.sh's PHP_ERROR_OUTPUT: PHP's own error output, by
// its shape, plain or with html_errors.
const PHP_ERROR_OUTPUT = /(Deprecated|Notice|Warning|Fatal error|Parse error|Strict Standards|Catchable fatal error)(<\/b>)?: .* on line (<b>)?[0-9]/;

const md5 = text => crypto.createHash('md5').update(text, 'latin1').digest('hex');
// Responses are read as latin1, one char per byte, so UTF-8 text is compared
// as its bytes.
const utf8Bytes = text => Buffer.from(text, 'utf8').toString('latin1');
const BOUNDARY = 'probeboundary';
const urlEncoded = fields => fields.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
const visibleText = response => response.text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
// alt_doc.php for the root page. returnUrl is not decoration, as the jobs
// say: with fewer than two GET vars alt_doc.php redirects to the last open
// document.
const EDIT_ROOT_PAGE = 'returnUrl=db_layout.php%3Fid%3D1&edit%5Bpages%5D%5B1%5D=edit';
// The record editor's title, as the hidden field the form posts carries it.
const titleField = response => (response.text.match(/name="data\[pages\]\[1\]\[title\]" value="([^"]*)"/) || [])[1];

let failures = 0;
function check(label, test) {
  try {
    test();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}`);
  }
}

function finish(name) {
  console.log(failures === 0 ? `${name}: all checks passed` : `${name}: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

function cookiesFrom(response) {
  return response.headers
    .filter(([name]) => name.toLowerCase() === 'set-cookie')
    .map(([, value]) => value.split(';')[0]);
}

// Requests go to PHP directly, past the site's router and cookie jar: these
// checks set every cookie themselves, as CI's curl calls do.
function client(site) {
  return (urlPath, { query = '', headers = {}, method = 'GET', body = null } = {}) => site.php.request({
    method,
    scriptFilename: `${site.docroot}/${urlPath}`,
    scriptName: `/${urlPath}`,
    queryString: query,
    headers: { Host: 'localhost', 'User-Agent': USER_AGENT, ...headers },
    body,
  });
}

// A client that keeps cookies, as a browser or curl's -b/-c jar does.
// Responses carry the requests' Set-Cookie headers as they came.
function browser(site) {
  const get = client(site);
  const jar = new Map();
  const send = (urlPath, options = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = get(urlPath, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } });
    for (const pair of cookiesFrom(response)) {
      const equals = pair.indexOf('=');
      jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  };
  send.cookie = name => jar.get(name);
  return send;
}

// Requests through the site's own router and cookie jar, as sw.js sends
// them: over HTTPS when https is set, as on the public site. Takes the same
// options as client().
function router(site, { https = false } = {}) {
  return (urlPath, { query = '', headers = {}, method = 'GET', body = null } = {}) => {
    const response = site.handle({
      method,
      path: `/${urlPath}`,
      query,
      headers: { Host: 'localhost', 'User-Agent': USER_AGENT, ...headers },
      body: body && Buffer.from(body, 'latin1'),
      https,
    });
    const header = name => (response.headers.find(([key]) => key.toLowerCase() === name.toLowerCase()) || [])[1];
    return { ...response, header, text: Buffer.from(response.body).toString('latin1') };
  };
}

// --- the frameset backends, 3.8 and 4.0 -------------------------------------

// .github/scripts/ci-backend-session.sh's login_and_expect: the form
// request starts the PHP session that keeps the challenge, and the
// password goes as md5(username:md5(password):challenge), as the form's
// own JavaScript computes it ("superchallenged"). send is a client that
// keeps cookies: browser() or router().
function logIn(send, scheme = 'http') {
  const form = send('typo3/index.php');
  const challenge = (form.text.match(/name="challenge" value="([0-9a-f]{32})"/) || [])[1];
  assert.ok(challenge, 'the login form carried no challenge');
  return send('typo3/index.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Checked against the host on submitted logins.
      Referer: `${scheme}://localhost/typo3/index.php`,
    },
    body: urlEncoded([
      ['login_status', 'login'], ['username', 'admin'], ['p_field', ''],
      ['userident', md5(`admin:${md5('password')}:${challenge}`)], ['challenge', challenge], ['interface', 'backend'],
    ]),
  });
}

function checkBackendLogin(admin) {
  check('the login, as the form computes it, redirects to the frameset', () => {
    const response = logIn(admin);
    console.log(`     ${response.status} to ${response.header('Location')}`);
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/alt_main.php');
    assert.ok(admin.cookie('be_typo_user'), 'no backend session cookie');
  });
}

// The public site is HTTPS. The redirect is absolute, so an http:// one
// would leave the service worker's scope. Asked as sw.js asks, through the
// site's own cookie jar. Returns that client, logged in.
function checkBackendLoginOverHttps(site) {
  const secure = router(site, { https: true });
  check('over HTTPS, the login redirects to https://', () => {
    const response = logIn(secure, 'https');
    console.log(`     ${response.status} to ${response.header('Location')}`);
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.header('Location'), 'https://localhost/typo3/alt_main.php');
  });
  return secure;
}

// The record editor's form as a browser posts it when the title is changed
// and the save button is clicked: to alt_doc.php itself, which hands the
// data to TCEmain. The visible field and the hidden one the browser's
// JavaScript copies it into both carry the new title. title is a latin1
// string, as an ISO-8859-1 page submits it.
function saveTitle(admin, editor, title) {
  const { action, fields } = readForm(editor.text, 'editform');
  const posted = fields.map(([name, value]) => [name, /^data\[pages\]\[1\]\[title\](_hr)?$/.test(name) ? title : value]);
  posted.push(['_savedok.x', '8'], ['_savedok.y', '9']);
  const url = new URL(action, 'http://localhost/');
  return admin(url.pathname.slice(1), {
    method: 'POST',
    query: url.search.slice(1),
    headers: {
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      Referer: `http://localhost/typo3/alt_doc.php?${EDIT_ROOT_PAGE}`,
    },
    body: multipart(BOUNDARY, posted.map(([name, value]) => ({ name, value }))),
  });
}

// ci-backend-session.sh's assert_admin_can_upload: the file list's upload
// form, posted to tce_file.php. On success it redirects; on any error it
// answers 200 with the error. The provision scripts give the admin
// fileoper_perms = 7, without which even an admin may not upload.
// disable_exec_function makes TYPO3 move the file with PHP's functions.
function upload(site, admin, filename, content) {
  return admin('typo3/tce_file.php', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, Referer: 'http://localhost/typo3/file_upload.php' },
    body: multipart(BOUNDARY, [
      { name: 'file[upload][1][target]', value: `${site.docroot}/fileadmin` },
      { name: 'file[upload][1][data]', value: '1' },
      { name: 'upload_1', filename, value: content },
      { name: 'redirect', value: 'file_list.php' },
    ]),
  });
}

// Every byte value TYPO3 might mangle: a line end, latin1, NUL.
const UPLOADED = 'Uploaded through tce_file.php.\n\xe4\xf6\xfc\xdf\x00\xff\r\n';

// refusal: what the release itself says when it refuses a .php file.
function checkUploads(site, admin, refusal) {
  check('the admin uploads a file into fileadmin/, and it is served back byte for byte', () => {
    const response = upload(site, admin, 'ci-upload.txt', UPLOADED);
    if (response.status !== 302) {
      console.log(`     ${visibleText(response).slice(0, 400)}`);
    }
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.header('Location'), 'http://localhost/typo3/file_list.php');
    assert.deepStrictEqual(response.log, []);
    const served = site.handle({ path: '/fileadmin/ci-upload.txt', headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });
    assert.strictEqual(served.status, 200);
    assert.strictEqual(Buffer.from(served.body).toString('latin1'), UPLOADED);
  });

  check('TYPO3 itself refuses a .php upload', () => {
    const response = upload(site, admin, 'refused.php', '<?php echo "uploaded"; ?>');
    assert.strictEqual(response.status, 200);
    assert.match(visibleText(response), refusal);
    assert.deepStrictEqual(site.php.FS.readdir(`${site.docroot}/fileadmin`).filter(name => name.endsWith('.php')), []);
  });
}

function checkUploadRestored(restored) {
  check('the uploaded file is restored too', () => {
    assert.strictEqual(Buffer.from(restored.php.FS.readFile(`${restored.docroot}/fileadmin/ci-upload.txt`)).toString('latin1'), UPLOADED);
  });
}

// ImageMagick cannot run in WebAssembly. With [GFX][im] = 0, the Install
// Tool skips its ImageMagick tests and says why, and runs its GD tests
// against the reference images it ships. Unlike 3.3.0's, 3.8.1's and
// 4.0.13's do not look for ImageMagick, so PHP logs nothing.
function checkInstallToolImages(site) {
  const release = site.release.release;
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

  check(`the Install Tool's image tests: GD's pass, ImageMagick's are skipped as ${release} intends`, () => {
    const imageTest = type => {
      const response = installTool('typo3/install/index.php', { query: `TYPO3_INSTALL[type]=images&TYPO3_INSTALL[images_type]=${type}` });
      assert.strictEqual(response.status, 200);
      assertNoPhpErrors(response);
      return response;
    };
    const gd = imageTest('gdlib');
    const text = visibleText(gd);
    assert.match(text, /ImageMagick enabled: 0 .* GDLib enabled: 1 GDLib using PNG: 0 GDLib 2 enabled: 1/);
    // Each test shows the server's image beside the release's reference, with
    // sizes.
    assert.match(text, /Create simple image Your server: Reference: (\d+) , 170x136 pixels \1 , 170x136 pixels/);
    assert.match(text, /Create image from file Your server: Reference: ([\d.]+ K), 170x136 pixels \1, 170x136 pixels/);
    // FreeType 2 draws the text with other pixels than the release's did, so
    // the size differs from the reference. 3.8.1 gives it in bytes, 4.0.13's
    // reference in K.
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
  return installTool;
}

// Not in the Docker jobs: the Install Tool's test mail, with mail() and with
// t3lib_htmlmail (class.tx_install.php:1599-1613 in 3.8.1). Docker's
// sendmail_path is /bin/true, so the mail is "sent" and goes nowhere; here
// too, through native/popen.c. Before that, PHP had no mail(), and this was a
// fatal error. installTool: the client checkInstallToolImages() logged in.
function checkInstallToolMail(installTool) {
  check('the Install Tool sends its test mail, with mail() and with t3lib_htmlmail, as Docker does to /bin/true', () => {
    for (const htmlmail of [false, true]) {
      const response = installTool('typo3/install/index.php', {
        query: 'TYPO3_INSTALL[type]=general',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: urlEncoded([['TYPO3_INSTALL[check_mail]', 'admin@example.com'], ...(htmlmail ? [['TYPO3_INSTALL[use_htmlmail]', 'on']] : [])]),
      });
      assert.strictEqual(response.status, 200, `htmlmail: ${htmlmail}`);
      assertNoPhpErrors(response);
      assert.match(visibleText(response), /MAIL WAS SENT TO: admin@example\.com/, `htmlmail: ${htmlmail}`);
    }
  });
}

// ci-backend-session.sh's assert_fresh_sessions_are_distinct, last as in
// the jobs, while admin is logged in. 3.8.1 and 4.0.13 make a session id
// from the clock and the process id, so under a clock that stands still
// every request would get the same one. Here the clock runs.
function checkFreshSessions(site, admin) {
  const get = client(site);
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
}

// --- the ExtJS backends, 4.5 and 6.2 ----------------------------------------

// The jobs' call_page_tree (4.5/ci-extdirect.sh, 6.2/ci-extdirect.sh): the
// backend's own page tree asking for the level below the virtual root, as
// raw JSON, with the token backend.php hands its Ext.Direct calls as the
// last data item. send is a client or a router.
function callPageTree(send, token) {
  return send('typo3/ajax.php', {
    method: 'POST',
    query: 'ajaxID=ExtDirect::route&namespace=TYPO3.Components.PageTree',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ action: 'DataProvider', method: 'getNextTreeLevel', data: ['root', { id: 'root' }, token], type: 'rpc', tid: 1 }),
  });
}

// The jobs' ci-check-page-tree.py: valid JSON, one rpc reply, one mount for
// an admin, the site, and the seeded page below it with the given title,
// which json_encode() has escaped as \uXXXX on the way.
function assertPageTree(response, siteName, title) {
  let replies;
  try {
    replies = JSON.parse(Buffer.from(response.body).toString('utf8'));
  } catch (error) {
    assert.fail(`the Ext.Direct reply is not JSON (${error.message}); it begins: ${response.text.slice(0, 300)}`);
  }
  assert.ok(Array.isArray(replies) && replies.length === 1, `expected one Ext.Direct reply, got: ${response.text.slice(0, 300)}`);
  const [reply] = replies;
  assert.strictEqual(reply.type, 'rpc', `the router answered ${reply.type}: ${reply.message}`);
  assert.ok(Array.isArray(reply.result) && reply.result.length === 1, 'expected one tree mount for an admin');
  const [mount] = reply.result;
  assert.strictEqual(mount.editableText, siteName);
  assert.ok((mount.children || []).map(child => child.editableText).includes(title),
    `the seeded page is not below the mount as ${title}`);
}

// PHP 5.6's deprecation for a POST body no handler reads, which every
// Ext.Direct call is.
const RAW_POST_DEPRECATION = 'Automatically populating $HTTP_RAW_POST_DATA';

// The jobs' phases 2 and 3 of their Ext.Direct step, each on an instance
// booted from the site's snapshot with every display PHP has, as the job's
// conf.d file sets them. The admin's session is in the snapshot, so its
// cookie and token carry over, as they do across the job's Apache
// restarts. expose_php is on in both: here nothing can answer under stale
// settings, and phase 3's reply losing X-Powered-By is the job's last
// finding. siteName and title: what the page tree must show.
async function checkRawPostControl(site, workRoot, sessionCookie, token, siteName, title) {
  const shipped = fs.readFileSync(path.join(repoRoot, site.release.ini), 'latin1');
  assert.match(shipped, /^always_populate_raw_post_data = -1$/m);
  const snapshot = site.snapshot();
  const controlCall = async rawPostSetting => {
    const control = await bootRelease(site.release.release, workRoot, {
      snapshot,
      legacyIni: Buffer.from(`${shipped.replace(/^always_populate_raw_post_data = .*$/m, `always_populate_raw_post_data = ${rawPostSetting}`)}
expose_php = On
error_reporting = E_ALL
display_errors = On
display_startup_errors = On
html_errors = Off
`, 'latin1'),
    });
    const settings = runScript(control, 'settings.php', ['<?php', "echo ini_get('always_populate_raw_post_data'), '|', ini_get('display_startup_errors');"]);
    assert.strictEqual(settings.text, `${rawPostSetting}|1`);
    const send = (urlPath, options) => client(control)(urlPath, {
      ...options, headers: { Cookie: sessionCookie, ...options.headers },
    });
    return callPageTree(send, token);
  };
  const displayed = await controlCall(-1);
  check('with every display on and the shipped -1, the reply is still the page tree, with no deprecation', () => {
    assert.strictEqual(displayed.status, 200);
    assert.ok(!displayed.text.includes(RAW_POST_DEPRECATION), 'the deprecation appeared');
    assert.ok(displayed.header('X-Powered-By'), 'this reply was not served under the control settings');
    assertPageTree(displayed, siteName, title);
    assert.deepStrictEqual(displayed.log, []);
  });
  const broken = await controlCall(0);
  check('with always_populate_raw_post_data = 0, the deprecation leads the reply, breaks the JSON and costs PHP its headers', () => {
    assert.ok(broken.text.trimStart().startsWith(`Deprecated: ${RAW_POST_DEPRECATION}`), `the reply begins: ${broken.text.slice(0, 200)}`);
    assert.throws(() => JSON.parse(broken.text), SyntaxError);
    assert.ok(!broken.header('X-Powered-By'), 'X-Powered-By survived the deprecation');
    assert.ok(broken.log.some(line => line.includes('Cannot modify header information - headers already sent')),
      'PHP did not log that its headers were lost');
  });
}

// Every statement the site's MySQL server answers with an error from now on.
// TYPO3's database layer mostly swallows errors, so without this a statement
// the shim cannot translate would only show as a page that is quietly wrong.
function watchRejectedStatements(site) {
  const rejected = [];
  const handle = site.mysql.handle.bind(site.mysql);
  site.mysql.handle = (op, link, a, b, c) => {
    const response = handle(op, link, a, b, c);
    if (response.kind === 'error') {
      rejected.push(`${response.message}: ${String(a).slice(0, 300)}`);
    }
    return response;
  };
  return rejected;
}

function checkNothingRejected(rejected) {
  check('the MySQL server rejected no statement TYPO3 sent', () => {
    assert.deepStrictEqual(rejected, []);
  });
}

// A script of the probe's own, run by the site's PHP.
function runScript(site, name, lines, queryString = '') {
  site.php.FS.mkdirTree('/opt/probe');
  site.php.FS.writeFile(`/opt/probe/${name}`, lines.join('\n'));
  return site.php.request({ scriptFilename: `/opt/probe/${name}`, scriptName: `/${name}`, queryString });
}

function printProvisionOutput(site, bootMs) {
  console.log(site.provisionOutput.trim().split('\n').map(line => `     ${line}`).join('\n'));
  console.log(`     (${bootMs} ms to boot, unpacking the archive included)`);
}

// Neither the page nor PHP's log may carry PHP's error output. The log is
// where it goes here: display_errors is off.
function assertNoPhpErrors(response) {
  assert.deepStrictEqual(response.log, []);
  const shown = response.text.match(PHP_ERROR_OUTPUT);
  assert.strictEqual(shown, null, `PHP error output in the page: ${shown && shown[0]}`);
}

function checkClock(site) {
  const startMs = site.release.clockStartMs;
  const start = new Date(startMs);
  const day = start.toISOString().slice(0, 10);
  const hour = String(start.getUTCHours()).padStart(2, '0');
  const mktimeArgs = [start.getUTCHours(), 0, 0, start.getUTCMonth() + 1, start.getUTCDate(), start.getUTCFullYear()].join(', ');
  check(`every clock starts at ${day} ${hour}:00, in UTC: time(), date(), mktime(), strftime(), microtime(), uniqid(), NOW()`, () => {
    const response = runScript(site, 'clock.php', [
      '<?php',
      "$link = mysql_connect('db', 'typo3', 'typo3');",
      "$row = mysql_fetch_row(mysql_query('SELECT UNIX_TIMESTAMP(), NOW()', $link));",
      "$micro = explode(' ', microtime());",
      `echo implode('|', array(time(), date('Y-m-d H:i:s T Z'), mktime(${mktimeArgs}), strftime('%H %Z', time()),`,
      "    $micro[1], hexdec(substr(uniqid(''), 0, 8)), $row[0], $row[1]));",
    ]);
    assert.deepStrictEqual(response.log, []);
    console.log(`     ${response.text}`);
    const [time, date, mktime, strftime, microtime, uniqid, unixTimestamp, now] = response.text.split('|');
    const startSeconds = startMs / 1000;
    assert.ok(Number(time) >= startSeconds && Number(time) < startSeconds + 3600, `time() is ${time}`);
    assert.match(date, new RegExp(`^${day} ${hour}:\\d{2}:\\d{2} UTC 0$`));
    assert.strictEqual(Number(mktime), startSeconds);
    assert.strictEqual(strftime, `${hour} UTC`);
    for (const [name, value] of [['microtime()', microtime], ['uniqid()', uniqid], ['UNIX_TIMESTAMP()', unixTimestamp]]) {
      assert.ok(Math.abs(Number(value) - Number(time)) <= 2, `${name} is ${value}, time() is ${time}`);
    }
    assert.match(now, new RegExp(`^${day} ${hour}:\\d{2}:\\d{2}$`));
  });
}

function checkSecondProvision(site) {
  check('a second provision run finds the schema and does nothing, as on a container restart', () => {
    assert.match(site.provision().text, /\[provision\] schema already present, nothing to do/);
  });
}

// The two deny rules every stack's web server has, through the site's own
// router, and a file next to them that must still be served.
function checkSourceProtection(site, servedFile) {
  check('localconf.php and t3lib/*.php answer 403, other files 200', () => {
    const status = path => site.handle({ path, headers: { Host: 'localhost', 'User-Agent': USER_AGENT } }).status;
    assert.strictEqual(status('/typo3conf/localconf.php'), 403);
    assert.strictEqual(status('/t3lib/class.t3lib_div.php'), 403);
    assert.strictEqual(status(servedFile), 200);
  });
}

// What the browser keeps in IndexedDB between visits restores into a new
// instance, which renders the same. Returns the new instance.
async function checkRestore(site, workRoot, frontendCheck) {
  const snapshot = site.snapshot();
  console.log(`     snapshot: ${snapshot.database.length} bytes of database, ${snapshot.files.length} files`);
  const restored = await bootRelease(site.release.release, workRoot, { snapshot });
  check('the snapshot restores, and does not provision again', () => {
    assert.strictEqual(restored.restored, true);
    assert.strictEqual(restored.provisionOutput, undefined);
  });
  frontendCheck('the restored site renders the same in a new instance', client(restored));
  return restored;
}

module.exports = {
  USER_AGENT, EDIT_ROOT_PAGE, md5, utf8Bytes, titleField, visibleText, check, finish, cookiesFrom, client, browser, router, runScript,
  printProvisionOutput, assertNoPhpErrors, watchRejectedStatements, checkNothingRejected, checkClock,
  checkSecondProvision, checkSourceProtection, checkRestore,
  logIn, checkBackendLogin, checkBackendLoginOverHttps, saveTitle, upload, UPLOADED, checkUploads, checkUploadRestored,
  checkInstallToolImages, checkInstallToolMail, checkFreshSessions,
  callPageTree, assertPageTree, RAW_POST_DEPRECATION, checkRawPostControl,
};
