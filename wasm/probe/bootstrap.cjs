// A TYPO3 release through the request loop, with no MySQL server: how far
// the release gets on its PHP before it needs a database. Usage:
//   node bootstrap.cjs <work-root> <release>
// The site is the one the browser runs (release-site.cjs), minus the database.
// 4.5.40 and 6.2.31 run on the PHP their Docker stacks run. 6.2.31 has no
// configuration until its installer writes it, so it is taken through the
// installer's first step, which needs no database, before its bootstrap can
// run to its first query.
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

// 6.2 has no configuration until its own installer writes it, so it never
// gets as far as its database on a fresh site. Its checks are below, in
// checkInstallerRelease().
const releaseGeneration = releaseName.split('.').slice(0, 2).join('.');
const hasInstaller = releaseGeneration === '6.2';

// What a release answers when it cannot reach its database. The older ones
// print a "Database Error" page. 4.5 throws a RuntimeException, which its own
// exception handler renders with status 500, and it silences the connect
// warning.
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

const INSTALLER = '/typo3/sysext/install/Start/Install.php';

// What the installer's environment check reports on its first page, and in
// the typo3-6-2 Docker job's log: the archive is copied flat, with no
// typo3_src link, and PHP's upload limit is its default 2 MB, below 6.2's
// 10 MB maxFileSize.
const DOCKER_ENVIRONMENT_ERRORS = [
  '/typo3_src should be a link, but it does not exist',
  'PHP Maximum upload filesize too small',
];

// The hidden fields of the first form that names an installer step, as
// 6.2/install.php reads them.
function stepForm(html) {
  for (const form of html.match(/<form\b[\s\S]*?<\/form>/g) || []) {
    const fields = {};
    for (const input of form.match(/<input\b[^>]*>/g) || []) {
      const attributes = {};
      for (const [, name, value] of input.matchAll(/(\w+)="([^"]*)"/g)) {
        attributes[name] = value.replace(/&amp;/g, '&');
      }
      if (attributes.type === 'hidden' && attributes.name) {
        fields[attributes.name] = attributes.value || '';
      }
    }
    if (fields['install[action]']) {
      return fields;
    }
  }
  return null;
}

async function checkInstallerRelease() {
  const site = await bootRelease(releaseName, workRoot, { database: false });
  const request = (urlPath, form = null) => {
    const [path, query = ''] = urlPath.split('?');
    return site.handle({
      method: form ? 'POST' : 'GET',
      path,
      query,
      headers: { Host: 'localhost', 'User-Agent': USER_AGENT, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? Buffer.from(new URLSearchParams(form).toString(), 'latin1') : null,
    });
  };
  const utf8 = response => Buffer.from(response.body).toString('utf8');
  const FS = site.php.FS;
  const typo3conf = `${site.docroot}/typo3conf`;

  // Bootstrap::redirectToInstallerIfEssentialConfigurationDoesNotExist(),
  // through HttpUtility::redirect(): a 303, absolute, and from the backend
  // with the "../" its caller passes.
  for (const [label, urlPath, location] of [
    ['frontend', '/index.php', `http://localhost${INSTALLER}`],
    ['backend', '/typo3/index.php', `http://localhost/typo3/..${INSTALLER}`],
  ]) {
    check(`${label}: ${urlPath} sends a site with no configuration to the installer`, () => {
      const response = request(urlPath);
      assert.strictEqual(response.status, 303);
      assert.deepStrictEqual(response.headers.filter(([name]) => name === 'Location'), [['Location', location]]);
      assert.deepStrictEqual(response.log, []);
    });
  }

  check("installer: its first step renders, and the environment check reports Docker's errors and no others", () => {
    const response = request(INSTALLER);
    const html = utf8(response);
    assert.strictEqual(response.status, 200);
    assert.match(html, /<title>Installing TYPO3 CMS<\/title>/);
    assert.match(html, /Installing TYPO3 CMS 6\.2\.31/);
    assert.match(html, /System environment check/);
    assert.strictEqual(stepForm(html)['install[action]'], 'environmentAndFolders');
    assert.deepStrictEqual(response.log, []);
    const errors = html.split('class="typo3-message message-error"').slice(1)
      .map(message => message.match(/<strong>([^<]+)<\/strong>/)[1].trim());
    console.log(`     errors: ${errors.join('; ')}`);
    assert.doesNotMatch(html, /message-warning/);
    assert.deepStrictEqual(errors.sort(), [...DOCKER_ENVIRONMENT_ERRORS].sort());
  });

  check('installer: locked without typo3conf/ENABLE_INSTALL_TOOL, open again with it', () => {
    const file = `${typo3conf}/ENABLE_INSTALL_TOOL`;
    const content = FS.readFile(file);
    FS.unlink(file);
    const locked = request(INSTALLER);
    FS.writeFile(file, content);
    assert.strictEqual(locked.status, 200);
    assert.match(utf8(locked), /<title>The Install Tool is locked<\/title>/);
    assert.match(utf8(request(INSTALLER)), /<title>Installing TYPO3 CMS<\/title>/);
  });

  // The first step needs no database. It writes the factory configuration and
  // the package list, so every request after it runs 6.2's whole bootstrap,
  // packages and TCA included, up to its first query.
  check('installer: its first step, posted as install.php posts it, writes LocalConfiguration.php and PackageStates.php', () => {
    const form = stepForm(utf8(request(INSTALLER)));
    const response = request(INSTALLER, { ...form, 'install[set]': 'execute' });
    assert.strictEqual(response.status, 303);
    assert.match(response.headers.find(([name]) => name === 'Location')[1], /Install\.php\?install\[redirectCount\]=0&install\[context\]=standalone&install\[controller\]=step$/);
    assert.deepStrictEqual(response.log, []);
    for (const file of ['LocalConfiguration.php', 'PackageStates.php', 'AdditionalConfiguration.php', 'ENABLE_INSTALL_TOOL']) {
      assert.ok(FS.analyzePath(`${typo3conf}/${file}`).exists, `typo3conf/${file}`);
    }
    // The packages whose metadata says isPartOfFactoryDefault.
    const active = Buffer.from(FS.readFile(`${typo3conf}/PackageStates.php`)).toString().match(/'state' => 'active'/g);
    assert.strictEqual(active.length, 42);
  });

  // The backend gets furthest: with no session cookie it renders the whole
  // login page, and its first query is for the system news below the form.
  // Unless the session garbage collection comes first: starting the backend
  // user runs it when rand() % 100 <= gc_probability, which is 1, so in about
  // 2 requests in 100 (AbstractUserAuthentication.php:190, :517).
  for (const [label, urlPath, thrownBy] of [
    ['frontend', '/index.php', /DatabaseConnection :: connectDB/],
    ['backend', '/typo3/index.php', /LoginController :: makeLoginNews|AbstractUserAuthentication :: gc \(\)/],
  ]) {
    check(`${label}: ${urlPath} then runs to its first query and renders 6.2's own error`, () => {
      const response = request(urlPath);
      const text = utf8(response).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(`     status ${response.status}, ${response.body.length} bytes: "${text.slice(0, 140)}"`);
      assert.strictEqual(response.status, 500);
      assert.match(text, /Uncaught TYPO3 Exception #1270853882: TYPO3 Fatal Error: No database selected!/);
      assert.match(text, /thrown in file \/var\/www\/typo3\/sysext\/core\/Classes\/Database\/DatabaseConnection\.php/);
      assert.match(text, thrownBy);
      assert.deepStrictEqual(response.log, []);
    });
  }

  check('twenty more frontend requests in the same instance give the same page', () => {
    const first = utf8(request('/index.php'));
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(utf8(request('/index.php')), first);
    }
  });
}

(async () => {
  if (hasInstaller) {
    await checkInstallerRelease();
    console.log(failures === 0 ? `bootstrap ${releaseName}: all checks passed` : `bootstrap ${releaseName}: ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  }
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
