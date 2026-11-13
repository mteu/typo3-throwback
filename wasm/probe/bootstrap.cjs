// A TYPO3 release through the request loop, with no MySQL server: how far
// the release gets on its PHP before it needs a database. Usage:
//   node bootstrap.cjs <work-root> <release>
// The site is the one the browser runs (release-site.cjs), minus the database.
//
// For 3.8.1 this is part of the evidence that it runs on PHP 4.4.9, though
// its Docker stack runs PHP 5.6.40 (#52).
'use strict';

const assert = require('assert');
const path = require('path');
const { bootRelease } = require('./release-site.cjs');

const [workRoot, releaseName] = [path.resolve(process.argv[2]), process.argv[3]];
// The User-Agent CI sends: 3.3 refuses anything it does not take for a "4+ browser".
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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

const text = response => Buffer.from(response.body).toString('latin1');
const visibleText = response => text(response).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// The one warning a missing server must cause. Anything else in the log is
// the release or the build going wrong.
function assertOnlyTheConnectWarning(response) {
  const other = response.log.filter(line => !/mysql_p?connect\(\).*Can't connect to MySQL server/.test(line));
  assert.deepStrictEqual(other, [], 'PHP logged more than the failed connection');
}

(async () => {
  const site = await bootRelease(releaseName, workRoot, { database: false });
  const get = urlPath => site.handle({ path: urlPath, headers: { Host: 'localhost', 'User-Agent': USER_AGENT } });

  // Each of these renders an error page that comes after the release has
  // found its own path from SCRIPT_FILENAME or PATH_TRANSLATED, loaded t3lib
  // and its configuration, and tried ext/mysql. A wrong path stops it
  // earlier, with "Path to TYPO3 main dir could not be resolved".
  for (const [label, urlPath] of [['frontend', '/index.php'], ['backend', '/typo3/index.php']]) {
    check(`${label}: ${urlPath} runs to the database connection and renders TYPO3's own error`, () => {
      const response = get(urlPath);
      console.log(`     status ${response.status}, ${response.body.length} bytes: "${visibleText(response).slice(0, 140)}"`);
      assert.strictEqual(response.status, 200);
      assert.match(text(response), /Database Error/);
      assert.match(text(response), /The current username, password or host was not accepted/);
      assertOnlyTheConnectWarning(response);
    });
  }

  // The Install Tool needs no database to show its login form.
  check('Install Tool: answers with its login form', () => {
    const response = get('/typo3/install/index.php');
    console.log(`     status ${response.status}, ${response.body.length} bytes: "${visibleText(response).slice(0, 80)}"`);
    assert.strictEqual(response.status, 200);
    assert.match(text(response), /<title>TYPO3 Install Tool<\/title>/i);
    assert.doesNotMatch(text(response), /install script is disabled by a die\(\)/);
    assert.deepStrictEqual(response.log, []);
  });

  check('twenty more frontend requests in the same instance give the same page', () => {
    const first = text(get('/index.php'));
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(text(get('/index.php')), first);
    }
  });

  console.log(failures === 0 ? `bootstrap ${releaseName}: all checks passed` : `bootstrap ${releaseName}: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
