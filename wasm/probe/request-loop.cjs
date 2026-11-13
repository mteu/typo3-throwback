// Drives the request-loop build through runtime/php-runtime.js, all requests
// in one instance. Usage:
//   node request-loop.cjs <sapi-node-build-dir> <scratch-dir>
// <scratch-dir> receives the php.ini and the upload directory. TYPO3 through
// the loop is left to probe/bootstrap.cjs and the probe/stack-<release>.cjs files.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PhpRuntime = require('../runtime/php-runtime.js');
const { multipart } = require('./forms.cjs');

const [buildDir, scratch] = process.argv.slice(2).map(p => path.resolve(p));
const www = path.join(__dirname, 'www');
const repoRoot = path.resolve(__dirname, '..', '..');

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
  const iniText = Buffer.concat([
    fs.readFileSync(path.join(repoRoot, 'php4-base', 'php-legacy.ini')),
    Buffer.from([
      '',
      '; probe/request-loop.cjs: errors into the body and the SAPI log, uploads into scratch',
      'display_errors = On',
      'error_log =',
      `upload_tmp_dir = ${path.join(scratch, 'uploads')}`,
      '',
    ].join('\n'), 'latin1'),
  ]);

  const createPhp = require(path.join(buildDir, 'php.js'));
  const php = await PhpRuntime.create(createPhp, { iniSearchPath: path.join(scratch, 'ini'), iniText });

  const probe = (script, options = {}) => php.request({
    scriptFilename: path.join(www, script),
    scriptName: `/${script}`,
    headers: { Host: 'localhost' },
    ...options,
  });

  check('module startup with php4-base/php-legacy.ini logs nothing', () => {
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
    assert.strictEqual(facts.path_translated, path.join(www, 'env.php'));
    assert.strictEqual(facts.getenv_host, 'example.test');
    assert.strictEqual(facts.env_host, 'example.test');
    assert.strictEqual(response.header('X-Probe'), 'env');
    assert.strictEqual(response.header('Set-Cookie'), 'probe=set-by-request-1');
    assert.strictEqual(response.header('Content-Type'), 'text/html; charset=ISO-8859-1');
  });

  check("$HTTP_ENV_VARS holds the request, not Emscripten's made-up process environment", () => {
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
    assert.match(response.text, /Fatal error.*Call to undefined function: call_to_a_function_that_does_not_exist\(\)/);
    assert.doesNotMatch(response.text, /never/);
    assert.strictEqual(response.log.length, 1);
    assert.match(response.log[0], /^PHP Fatal error: {2}Call to undefined function: call_to_a_function_that_does_not_exist\(\) in .*fatal\.php on line 3$/);
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

  console.log(failures === 0 ? 'request loop: all checks passed' : `request loop: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
