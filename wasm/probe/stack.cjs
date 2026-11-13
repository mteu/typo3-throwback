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
const { bootRelease } = require('./release-site.cjs');

// The User-Agent CI sends: 3.3 refuses anything it does not take for a "4+ browser".
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
// .github/scripts/ci-assert.sh's PHP_ERROR_OUTPUT: PHP's own error output, by
// its shape, plain or with html_errors.
const PHP_ERROR_OUTPUT = /(Deprecated|Notice|Warning|Fatal error|Parse error|Strict Standards|Catchable fatal error)(<\/b>)?: .* on line (<b>)?[0-9]/;

const md5 = text => crypto.createHash('md5').update(text, 'latin1').digest('hex');

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
  USER_AGENT, md5, check, finish, cookiesFrom, client, browser, runScript, printProvisionOutput, assertNoPhpErrors,
  watchRejectedStatements, checkNothingRejected, checkClock, checkSecondProvision, checkSourceProtection, checkRestore,
};
