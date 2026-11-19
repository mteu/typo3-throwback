// The browser build of the request loop, driven through runtime/php-runtime.js
// in Node: its filesystem is in memory, so the script is written into it
// first, as runtime/typo3-site.js writes a release. Usage:
//   node request-loop-web.cjs <sapi-web-build-dir>
'use strict';

const assert = require('assert');
const path = require('path');
const PhpRuntime = require('../runtime/php-runtime.js');

const buildDir = path.resolve(process.argv[2]);

(async () => {
  const createPhp = require(path.join(buildDir, 'php.js'));
  const php = await PhpRuntime.create(createPhp, {
    iniSearchPath: '/etc/php',
    iniText: 'display_errors = On\nerror_log =\ndate.timezone = "UTC"\n',
  });
  assert.deepStrictEqual(php.startupLog, []);

  php.FS.mkdirTree('/var/www');
  php.FS.writeFile('/var/www/input.php', [
    '<?php',
    "header('X-Probe: web');",
    "echo PHP_VERSION, '|', php_sapi_name(), '|', bin2hex(file_get_contents('php://input'));",
  ].join('\n'));

  const body = Buffer.from('{"tid":1,"data":["Grüße"]}', 'utf8');
  for (let i = 0; i < 3; i++) {
    const response = php.request({
      method: 'POST',
      scriptFilename: '/var/www/input.php',
      scriptName: '/input.php',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: new Uint8Array(body),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.header('X-Probe'), 'web');
    assert.deepStrictEqual(response.log, []);
    const [version, sapi, input] = response.text.split('|');
    assert.strictEqual(sapi, 'wasm');
    assert.strictEqual(input, body.toString('hex'));
    if (i === 0) {
      console.log(`ok   PHP ${version}'s browser build serves from its in-memory filesystem, php://input included`);
    }
  }
  console.log('ok   three requests in one instance');
})().catch(error => {
  console.log(`FAIL ${error.message}`);
  process.exit(1);
});
