// A TYPO3 release through the request loop, with no MySQL server: how far
// the release gets on its PHP before it needs a database. Usage:
//   node bootstrap.cjs <work-root> <release>
// The site is the one the browser runs (release-site.cjs), minus the database.
// 4.5.40 runs on the PHP its Docker stack runs.
//
// For 3.8.1 and 4.0.13 this is part of the evidence that they run on PHP
// 4.4.9, though their Docker stacks run PHP 5.6.40.
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

// What a release answers when it cannot reach its database. The older ones
// print a "Database Error" page. 4.5 throws a RuntimeException, which its own
// exception handler renders with status 500, and it silences the connect
// warning.
const releaseGeneration = releaseName.split('.').slice(0, 2).join('.');
const databaseError = releaseGeneration === '4.5' ? {
  status: 500,
  page: /TYPO3 Exception/,
  message: /Database Error: The current username, password or host was not accepted when the connection to the database was attempted to be established!/,
  // Where it is thrown: the frontend's connection, and the backend's, which
  // the bootstrap makes later.
  thrownIn: { frontend: /class\.tslib_fe\.php in line \d+/, backend: /typo3\/init\.php in line \d+/ },
  warnings: /^$/,
  installToolTitle: /<title>\s*TYPO3 4\.5\.40\s+Install Tool on site: /,
  // 4.5 locks the Install Tool unless this file exists.
  installToolLock: { file: 'typo3conf/ENABLE_INSTALL_TOOL', page: /The Install Tool is locked/ },
} : {
  status: 200,
  page: /Database Error/,
  message: /The current username, password or host was not accepted/,
  thrownIn: {},
  warnings: /mysql_p?connect\(\).*Can't connect to MySQL server/,
  installToolTitle: /<title>TYPO3 Install Tool<\/title>/i,
  installToolLock: null,
};

// The only warning a missing server may cause. Anything else in the log is
// the release or the build going wrong.
function assertOnlyTheConnectWarning(response) {
  const other = response.log.filter(line => !databaseError.warnings.test(line));
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
      assert.strictEqual(response.status, databaseError.status);
      assert.match(text(response), databaseError.page);
      assert.match(text(response), databaseError.message);
      if (databaseError.thrownIn[label]) {
        assert.match(visibleText(response), databaseError.thrownIn[label]);
      }
      assertOnlyTheConnectWarning(response);
    });
  }

  // The Install Tool needs no database to show its login form.
  check('Install Tool: answers with its login form', () => {
    const response = get('/typo3/install/index.php');
    console.log(`     status ${response.status}, ${response.body.length} bytes: "${visibleText(response).slice(0, 80)}"`);
    assert.strictEqual(response.status, 200);
    assert.match(text(response), databaseError.installToolTitle);
    assert.match(text(response), /<input[^>]+type="password"[^>]+name="password"|<input[^>]+name="password"[^>]+type="password"/);
    assert.doesNotMatch(text(response), /install script is disabled by a die\(\)/);
    assert.deepStrictEqual(response.log, []);
  });

  if (databaseError.installToolLock) {
    const { file, page } = databaseError.installToolLock;
    check(`Install Tool: locked without ${file}, open again with it`, () => {
      const FS = site.php.FS;
      const path = `${site.docroot}/${file}`;
      const content = FS.readFile(path);
      FS.unlink(path);
      const locked = get('/typo3/install/index.php');
      FS.writeFile(path, content);
      assert.strictEqual(locked.status, 200);
      assert.match(text(locked), page);
      assert.doesNotMatch(text(locked), /type="password"/);
      assert.match(text(get('/typo3/install/index.php')), databaseError.installToolTitle);
    });
  }

  check('twenty more frontend requests in the same instance give the same page', () => {
    const first = text(get('/index.php'));
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(text(get('/index.php')), first);
    }
  });

  console.log(failures === 0 ? `bootstrap ${releaseName}: all checks passed` : `bootstrap ${releaseName}: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
