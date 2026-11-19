// Drives the request-loop build through runtime/php-runtime.js, all requests
// in one instance. Usage:
//   node request-loop.cjs <sapi-node-build-dir> <scratch-dir> <php-version>
// <scratch-dir> receives the php.ini and the upload directory. <php-version>
// is 4.4.9 or 5.6.40, the interpreter the build dir holds. TYPO3 through the
// loop is left to probe/bootstrap.cjs and the probe/stack-<release>.cjs files.
'use strict';

// Far from UTC on purpose, as in stack.cjs: PHP's clock must read UTC
// whatever zone the host is in. Node applies a TZ set here, before any Date
// is made.
process.env.TZ = 'Asia/Tokyo';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PhpRuntime = require('../runtime/php-runtime.js');
const { multipart } = require('./forms.cjs');

const [buildDir, scratch] = process.argv.slice(2, 4).map(p => path.resolve(p));
const phpVersion = process.argv[4];
const repoRoot = path.resolve(__dirname, '..', '..');

// What differs between the interpreters. Each runs with the ini of the
// releases it serves. PHP 5.4 removed the $HTTP_*_VARS arrays that www/'s
// scripts read, so www-5/ has their superglobal versions, and the scripts
// only PHP 5 needs. A script not in www-5/ comes from www/.
const PROFILES = {
  '4.4.9': {
    ini: 'php4-base/php-legacy.ini',
    www: ['www'],
    // The servers ext/mysql is checked against: what the releases on this
    // PHP talk to.
    mysqlServers: [{ serverVersion: '3.23.49' }],
    undefinedFunction: 'Call to undefined function: call_to_a_function_that_does_not_exist()',
    defaultContentType: 'text/html; charset=ISO-8859-1',
  },
  '5.6.40': {
    ini: '4.5/php-legacy.ini',
    www: ['www-5', 'www'],
    mysqlServers: [{ serverVersion: '5.5.62', charset: 'latin1' }, { serverVersion: '5.5.62', charset: 'utf8' }],
    undefinedFunction: 'Call to undefined function call_to_a_function_that_does_not_exist()',
    defaultContentType: 'text/html; charset=UTF-8',
  },
};
const profile = PROFILES[phpVersion];
if (!profile) {
  console.error(`usage: node request-loop.cjs <sapi-node-build-dir> <scratch-dir> <${Object.keys(PROFILES).join('|')}>`);
  process.exit(2);
}
const scriptPath = script => {
  const dirs = profile.www.map(dir => path.join(__dirname, dir));
  return path.join(dirs.find(dir => fs.existsSync(path.join(dir, script))) || dirs[dirs.length - 1], script);
};
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

function lines(response) {
  const facts = {};
  for (const line of response.text.split('\n')) {
    const equals = line.indexOf('=');
    if (equals > 0) {
      facts[line.slice(0, equals)] = line.slice(equals + 1);
    }
  }
  return facts;
}

function prepareScratch() {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, 'uploads'), { recursive: true });
}

(async () => {
  prepareScratch();
  // Bytes in, bytes out: the ini is UTF-8, and PHP reads it as bytes.
  const iniWith = (...settings) => Buffer.concat([
    fs.readFileSync(path.join(repoRoot, profile.ini)),
    Buffer.from([
      '',
      '; probe/request-loop.cjs: errors into the body and the SAPI log, uploads into scratch',
      'display_errors = On',
      'error_log =',
      `upload_tmp_dir = ${path.join(scratch, 'uploads')}`,
      `session.save_path = ${path.join(scratch, 'sessions')}`,
      ...settings,
      '',
    ].join('\n'), 'latin1'),
  ]);

  const createPhp = require(path.join(buildDir, 'php.js'));
  // Each instance gets an ini directory of its own: under NODERAWFS it is a
  // real directory, and PHP reads php.ini only at module startup.
  const startPhp = (name, options) => PhpRuntime.create(createPhp, { iniSearchPath: path.join(scratch, name), ...options });
  const php = await startPhp('ini', { iniText: iniWith() });

  const request = (instance, script, options = {}) => instance.request({
    scriptFilename: scriptPath(script),
    scriptName: `/${script}`,
    headers: { Host: 'localhost' },
    ...options,
  });
  const probe = (script, options) => request(php, script, options);

  check(`module startup with ${profile.ini} logs nothing`, () => {
    assert.deepStrictEqual(php.startupLog, []);
  });

  check('GET: server variables, getenv, PHP_SELF, headers and cookies', () => {
    const response = probe('env.php', { queryString: 'n=1', headers: { Host: 'example.test', Cookie: 'probe=from-browser' } });
    const facts = lines(response);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(facts.sapi, 'wasm');
    assert.strictEqual(facts.method, 'GET');
    assert.strictEqual(facts.get, '1');
    assert.strictEqual(facts.cookie, 'from-browser');
    assert.strictEqual(facts.php_self, '/env.php');
    assert.strictEqual(facts.request_uri, '/env.php?n=1');
    assert.strictEqual(facts.path_translated, scriptPath('env.php'));
    assert.strictEqual(facts.getenv_host, 'example.test');
    assert.strictEqual(facts.env_host, 'example.test');
    assert.strictEqual(response.header('X-Probe'), 'env');
    assert.strictEqual(response.header('Set-Cookie'), 'probe=set-by-request-1');
    assert.strictEqual(response.header('Content-Type'), profile.defaultContentType);
  });

  check("the ENV array holds the request, not Emscripten's made-up process environment", () => {
    assert.strictEqual(lines(probe('env.php')).env_emscripten_user, 'absent');
  });

  check('POST: form fields, ISO-8859-1 bytes arrive unchanged', () => {
    const response = probe('env.php', {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'field=hello&umlaut=%FC',
    });
    const facts = lines(response);
    assert.strictEqual(facts.method, 'POST');
    assert.strictEqual(facts.post, 'hello');
    assert.strictEqual(facts.post_latin1_hex, 'fc');
  });

  check('globals, functions, classes, constants and statics start fresh on every request', () => {
    for (let i = 0; i < 3; i++) {
      const response = probe('state.php');
      assert.strictEqual(response.text, 'globals=fresh\nstatic=1\nstate=ok\n', `request ${i + 1}: ${response.text}`);
    }
  });

  check('a fatal error ends the request, not the instance', () => {
    const response = probe('fatal.php');
    assert.match(response.text, /^before the fatal\n/);
    assert.match(response.text, new RegExp(`Fatal error.*${escapeRegExp(profile.undefinedFunction)}`));
    assert.doesNotMatch(response.text, /never/);
    assert.strictEqual(response.log.length, 1);
    assert.match(response.log[0], new RegExp(`^PHP Fatal error: {2}${escapeRegExp(profile.undefinedFunction)} in .*fatal\\.php on line 3$`));
    assert.strictEqual(probe('state.php').text, 'globals=fresh\nstatic=1\nstate=ok\n');
  });

  check("a request leaves the Node process's working directory where it was", () => {
    const before = process.cwd();
    probe('state.php');
    assert.strictEqual(process.cwd(), before);
  });

  check('a parse error ends the request, not the instance', () => {
    assert.match(probe('parse-error.php').text, /Parse error/);
    assert.strictEqual(probe('state.php').text, 'globals=fresh\nstatic=1\nstate=ok\n');
  });

  check('exit() ends the request, not the instance', () => {
    assert.strictEqual(probe('exit.php').text, 'before exit\nexit message\n');
    assert.strictEqual(probe('state.php').text, 'globals=fresh\nstatic=1\nstate=ok\n');
  });

  check('status line, Location redirect and the CGI Status header', () => {
    assert.strictEqual(probe('headers.php', { queryString: 'mode=404' }).status, 404);
    const redirect = probe('headers.php', { queryString: 'mode=redirect' });
    assert.strictEqual(redirect.status, 302);
    assert.strictEqual(redirect.header('Location'), 'http://localhost/elsewhere.php');
    const unavailable = probe('headers.php', { queryString: 'mode=cgi-status' });
    assert.strictEqual(unavailable.status, 503);
    assert.strictEqual(unavailable.header('Status'), null);
    assert.strictEqual(probe('headers.php').status, 200);
  });

  check('ISO-8859-1 output arrives as the bytes PHP wrote', () => {
    const response = probe('headers.php', { queryString: 'mode=latin1' });
    assert.deepStrictEqual(Array.from(response.body), Array.from(Buffer.from('Gr\xfc\xdfe\n', 'latin1')));
    assert.strictEqual(response.header('Content-Type'), 'text/html; charset=iso-8859-1');
  });

  check('a 1 MB response', () => {
    assert.strictEqual(probe('headers.php', { queryString: 'mode=big' }).body.length, 1048576);
  });

  check('a missing script is a 404, as under CGI', () => {
    const response = probe('does-not-exist.php');
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.text, 'No input file specified.\n');
  });

  check('multipart upload: file and field arrive, temp file removed after the request', () => {
    const boundary = 'phpwasmboundary';
    const response = probe('upload.php', {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, [
        { name: 'attachment', filename: 'hello.txt', value: 'uploaded content' },
        { name: 'other', value: 'field value' },
      ]),
    });
    const facts = lines(response);
    assert.strictEqual(facts.name, 'hello.txt');
    assert.strictEqual(facts.size, '16');
    assert.strictEqual(facts.error, '0');
    assert.strictEqual(facts.is_uploaded_file, 'yes');
    assert.strictEqual(facts.content, 'uploaded content');
    assert.strictEqual(facts.other_field, 'field value');
    assert.ok(facts.tmp_name.startsWith(path.join(scratch, 'uploads')), facts.tmp_name);
    assert.strictEqual(fs.existsSync(facts.tmp_name), false);
  });

  check('uniqid() is distinct across 500 requests', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i++) {
      ids.add(lines(probe('env.php')).uniqid);
    }
    assert.strictEqual(ids.size, 500);
  });

  // ext/mysql, built against native/libmysql/, with the shim answering as
  // each server the releases on this PHP talk to. Each run stores and reads
  // back strings with NUL bytes, as serialize() writes them.
  const MysqlOnSqlite = require('../runtime/mysql-sqlite.js');
  const initSqlJs = require(path.join(__dirname, '..', 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  for (const server of profile.mysqlServers) {
    const label = `MySQL ${server.serverVersion}${server.charset ? ` ${server.charset}` : ''}`;
    const withMysql = await startPhp(`ini-mysql-${server.serverVersion}-${server.charset || 'latin1'}`, {
      iniText: iniWith(),
      mysql: new MysqlOnSqlite(SQL, server),
    });
    check(`ext/mysql against the shim as ${label}: connect, escape, NUL bytes, serialize(), fetch, errors`, () => {
      const response = request(withMysql, 'mysql.php', { queryString: `server=${server.serverVersion}` });
      console.log(response.text.trimEnd().split('\n').map(line => `     ${line}`).join('\n'));
      assert.deepStrictEqual(response.log, []);
      assert.match(response.text, /MYSQL OK\n$/);
    });
  }

  if (phpVersion === '5.6.40') {
    await php5Checks();
  }

  const scripts = ['state.php', 'env.php', 'fatal.php', 'exit.php', 'parse-error.php'];
  const mixed = count => {
    for (let i = 0; i < count; i++) {
      probe(scripts[i % scripts.length]);
    }
  };
  check('memory and time per request stay flat over 5000 more requests', () => {
    mixed(500);
    const before = php.memoryBytes;
    const batchMs = [];
    for (let batch = 0; batch < 5; batch++) {
      const started = process.hrtime.bigint();
      mixed(1000);
      batchMs.push(Number(process.hrtime.bigint() - started) / 1e6 / 1000);
    }
    console.log(`     ms per request by batch of 1000: ${batchMs.map(ms => ms.toFixed(2)).join(', ')}; wasm memory ${before / 1048576} MB before, ${php.memoryBytes / 1048576} MB after`);
    assert.strictEqual(php.memoryBytes, before);
    // Generous on purpose: this catches growth that compounds per request,
    // as an earlier log callback did, not noise between batches.
    assert.ok(batchMs[4] < batchMs[0] * 3 + 0.5, `per-request time grew: ${batchMs}`);
    assert.strictEqual(probe('state.php').text, 'globals=fresh\nstatic=1\nstate=ok\n');
  });

  // What PHP 5.6 does that the PHP 4 loop never had to: the raw body for
  // php://input, the raw-POST deprecation, binary uploads, every clock
  // reader, and its own allocator over many requests.
  async function php5Checks() {
    const json = '{"action":"ExtDirect","method":"probe","data":["Grüße 日本"],"type":"rpc","tid":1}';
    const jsonBytes = Buffer.from(json, 'utf8');
    const postJson = (instance, body = jsonBytes) => request(instance, 'input.php', {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: new Uint8Array(body),
    });

    check('a JSON body arrives at php://input byte for byte, twice, and fills no form field', () => {
      const facts = lines(postJson(php));
      assert.strictEqual(facts.input_hex, jsonBytes.toString('hex'));
      assert.strictEqual(facts.input_again, 'same');
      assert.strictEqual(facts.post_fields, '0');
      assert.strictEqual(facts.content_type, 'application/json');
    });

    check('every byte value, NUL and CR LF included, arrives at php://input unchanged', () => {
      const bytes = Buffer.alloc(512);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = i % 256;
      }
      assert.strictEqual(lines(postJson(php, bytes)).input_hex, bytes.toString('hex'));
    });

    // The ini sets error_reporting without E_DEPRECATED, so these two
    // instances report everything: what -1 does not raise, it does not raise
    // at all. The deprecation comes at request startup, so with
    // display_startup_errors off it goes only to the log, as in the
    // typo3-4-5 job.
    const deprecation = 'PHP Deprecated:  Automatically populating $HTTP_RAW_POST_DATA is deprecated';
    const rawPostWith = value => startPhp(`ini-raw-post-${value}`, {
      iniText: iniWith('error_reporting = E_ALL', `always_populate_raw_post_data = ${value}`),
    });
    const populating = await rawPostWith('0');
    const notPopulating = await rawPostWith('-1');
    check('always_populate_raw_post_data = 0: a JSON POST logs the deprecation, and the page does not show it', () => {
      const response = postJson(populating);
      assert.strictEqual(response.log.length, 1, response.log.join('\n'));
      assert.ok(response.log[0].startsWith(deprecation), response.log[0]);
      assert.doesNotMatch(response.text, /deprecated/i);
      const facts = lines(response);
      assert.strictEqual(facts.raw_post_data, 'set');
      assert.strictEqual(facts.input_hex, jsonBytes.toString('hex'));
    });
    check('always_populate_raw_post_data = 0: a form POST logs nothing, as PHP parses it', () => {
      const response = request(populating, 'input.php', {
        method: 'POST',
        headers: { Host: 'localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'field=hello',
      });
      assert.deepStrictEqual(response.log, []);
      assert.strictEqual(lines(response).post_fields, '1');
    });
    check('always_populate_raw_post_data = -1, as 4.5/php-legacy.ini sets it: nothing is logged, php://input still has the body', () => {
      const response = postJson(notPopulating);
      assert.deepStrictEqual(response.log, []);
      const facts = lines(response);
      assert.strictEqual(facts.raw_post_data, 'unset');
      assert.strictEqual(facts.input_hex, jsonBytes.toString('hex'));
    });

    check('a binary upload arrives byte for byte, and move_uploaded_file() moves it', () => {
      const boundary = 'phpwasmboundary';
      let binary = '';
      for (let i = 0; i < 1024; i++) {
        binary += String.fromCharCode(i % 256);
      }
      const md5 = require('crypto').createHash('md5').update(Buffer.from(binary, 'latin1')).digest('hex');
      const target = path.join(scratch, 'moved');
      fs.mkdirSync(target, { recursive: true });
      const response = probe('upload.php', {
        method: 'POST',
        queryString: `move=${encodeURIComponent(target)}`,
        headers: { Host: 'localhost', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: multipart(boundary, [
          { name: 'attachment', filename: 'every-byte.bin', value: binary },
          { name: 'other', value: 'field value' },
        ]),
      });
      const facts = lines(response);
      assert.strictEqual(facts.name, 'every-byte.bin');
      assert.strictEqual(facts.size, '1024');
      assert.strictEqual(facts.error, '0');
      assert.strictEqual(facts.content_md5, md5);
      assert.strictEqual(facts.other_field, 'field value');
      assert.strictEqual(facts.moved, 'yes');
      assert.strictEqual(facts.moved_md5, md5);
      assert.strictEqual(facts.tmp_left, 'no');
      assert.strictEqual(fs.readFileSync(path.join(target, 'every-byte.bin')).toString('latin1'), binary);
    });

    check('a session started in one request is read in the next, through its cookie', () => {
      fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
      const first = probe('session.php');
      const cookie = first.header('Set-Cookie');
      assert.match(cookie, /^PHPSESSID=[a-z0-9]{26,}; path=\//);
      const facts = lines(first);
      assert.strictEqual(facts.visits, '1');
      const second = lines(probe('session.php', { headers: { Host: 'localhost', Cookie: cookie.split(';')[0] } }));
      assert.strictEqual(second.session_id, facts.session_id);
      assert.strictEqual(second.visits, '2');
      const other = lines(probe('session.php'));
      assert.notStrictEqual(other.session_id, facts.session_id);
      assert.strictEqual(other.visits, '1');
    });

    // 4.5.40's release instant, as its Docker stack starts the clock.
    const startMs = Date.UTC(2015, 1, 19, 12, 0, 0);
    const clocked = await startPhp('ini-clock', { iniText: iniWith(), clock: PhpRuntime.clockStartingAt(startMs) });
    check('every clock reader starts at 2015-02-19 12:00, in UTC, with the host in Asia/Tokyo', () => {
      const response = request(clocked, 'clock.php');
      assert.deepStrictEqual(response.log, []);
      console.log(`     ${response.text}`);
      const [time, date, mktime, strftime, micro, microFloat, uniqid, dateTime, dateTimeZone, requestTime, requestTimeFloat, zone]
        = response.text.split('|');
      const startSeconds = startMs / 1000;
      assert.ok(Number(time) >= startSeconds && Number(time) < startSeconds + 60, `time() is ${time}`);
      assert.match(date, /^2015-02-19 12:00:\d{2} UTC 0$/);
      assert.strictEqual(Number(mktime), startSeconds);
      assert.strictEqual(strftime, '12 UTC');
      assert.strictEqual(dateTimeZone, 'UTC');
      assert.strictEqual(zone, 'UTC');
      for (const [name, value] of [['microtime()', micro], ['microtime(true)', microFloat], ['uniqid()', uniqid],
        ['new DateTime()', dateTime], ["$_SERVER['REQUEST_TIME']", requestTime], ["$_SERVER['REQUEST_TIME_FLOAT']", requestTimeFloat]]) {
        assert.ok(Math.abs(Number(value) - Number(time)) <= 1, `${name} is ${value}, time() is ${time}`);
      }
    });

    const fresh = await startPhp('ini-heap', { iniText: iniWith() });
    const heapAfter = {};
    let served = 0;
    for (const count of [10, 100, 500]) {
      for (; served < count; served++) {
        request(fresh, ['state.php', 'env.php', 'fatal.php', 'exit.php', 'input.php'][served % 5]);
      }
      heapAfter[count] = fresh.memoryBytes;
    }
    check('wasm memory after 10, 100 and 500 requests is the same', () => {
      console.log(`     wasm memory after 10, 100, 500 requests: ${[10, 100, 500].map(n => heapAfter[n] / 1048576).join(', ')} MB`);
      assert.strictEqual(heapAfter[500], heapAfter[10]);
    });
  }

  console.log(failures === 0 ? 'request loop: all checks passed' : `request loop: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
