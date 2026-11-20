// TYPO3 6.2.31 in the browser, on PHP 5.6.40: what runtime/typo3-site.js needs
// to know that 6.2/Dockerfile, 6.2/entrypoint.sh and 6.2/apache-typo3.conf
// know for the Docker stack. Paths name files in this repository.
//
// 6.2.31 stops below PHP 5.3.7
// (typo3/sysext/install/Classes/SystemEnvironment/Check.php:281), so it runs on
// the same PHP as its Docker stack, as 4.5.40 does.
//
// Unlike every older release, 6.2 is not configured from a file written here.
// Its configuration, LocalConfiguration.php and PackageStates.php, is what its
// own step installer writes. Until that has run, every entry point redirects to
// the installer. So it provisions in three steps, as 6.2/entrypoint.sh does on
// first boot: provision.php preflight, the installer, provision.php seed.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.Typo3Releases = root.Typo3Releases || {})['6.2.31'] = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    release: '6.2.31',
    php: '5.6.40',
    // Noon on the release day, UTC, where 6.2/Dockerfile starts libfaketime.
    clockStartMs: Date.UTC(2017, 3, 18, 12, 0, 0),
    archive: 'vendor-src/typo3-6.2.31/typo3_src-6.2.31.tar.gz',
    archiveRoot: 'typo3_src-6.2.31',
    // Every licence file in the archive, by .github/scripts/licence_inventory.py.
    // site/assemble.sh lists them in LICENSES.txt.
    licenceIndex: '6.2/LICENCES.md',
    // The stack's own: it is 4.5's, with the limits INSTALL.md asks for.
    ini: '6.2/php-legacy.ini',
    provisionScript: '6.2/provision.php',
    // What 6.2/entrypoint.sh exports, with its defaults, for provision.php
    // and the installer alike.
    provisionEnv: () => ({
      TYPO3_DB_HOST: 'db',
      TYPO3_DB_NAME: 'typo3',
      TYPO3_DB_USER: 'typo3',
      TYPO3_DB_PASSWORD: 'typo3',
      TYPO3_SITENAME: 'TYPO3 6.2.31',
      TYPO3_ADMIN_USER: 'admin',
      TYPO3_ADMIN_PASSWORD: 'password',
    }),
    // 6.2/entrypoint.sh's first boot. provision.php is a CLI script and reads
    // its mode from $argv[1]. The installer is runtime/step-installer.js, the
    // twin of 6.2/install.php. done: the last line each mode prints when it
    // succeeds.
    provisionSteps: [
      { argv: ['preflight'], done: /\[provision\] database typo3 is empty, ready for the installer\n$/ },
      { installer: true },
      { argv: ['seed'], done: /\[provision\] done\n$/ },
    ],
    // mysql:5.5, the server 6.2/compose.yaml runs, at its last release, with
    // the stack's --character-set-server=utf8.
    mysqlServerVersion: '5.5.62',
    mysqlCharset: 'utf8',
    // 6.2/compose.yaml's MYSQL_DATABASE, which the mysql image creates before
    // anything else runs. provision.php preflight expects it there, empty,
    // and the installer is told to use it.
    mysqlDatabase: 'typo3',

    // The archive is the document root, top-level index.php included, as
    // 6.2/Dockerfile copies it.
    docrootLinks: null,
    // 6.2/entrypoint.sh's four trees. The installer's first step creates what
    // it wants below them itself.
    writableDirs: ['typo3conf', 'typo3temp', 'uploads', 'fileadmin'],
    docrootFiles: {
      // 6.2 locks the Install Tool unless this file exists, and the installer
      // runs inside the Install Tool. KEEP_FILE because 6.2 removes the file
      // once it is an hour old, and the installer's last step removes it,
      // unless it says so (EnableFileService.php:35).
      'typo3conf/ENABLE_INSTALL_TOOL': 'KEEP_FILE\n',
      // 6.2 loads this after LocalConfiguration.php on every request, and
      // nothing in 6.2 writes it. So it carries the stack's decisions, while
      // LocalConfiguration.php stays the installer's own output.
      'typo3conf/AdditionalConfiguration.php': [
        '<?php',
        // 6.2/entrypoint.sh's two lines. The page is served from whatever host
        // the tab is on.
        "$GLOBALS['TYPO3_CONF_VARS']['SYS']['trustedHostsPattern'] = '.*';",
        // The entrypoint's fixed key: TYPO3 salts cHash with it, and a fixed
        // one keeps frontend URLs the same in Docker and here. The installer
        // writes a random one into LocalConfiguration.php.
        "$GLOBALS['TYPO3_CONF_VARS']['SYS']['encryptionKey'] = '5c1f9a7e3b2d8c6a0e4f7b1d9c3a5e8f2b6d0a4c7e1f3b9d5a8c2e6f0b4d7a1c3e9f5b2d8a6c0e4f7b1d3a9c5e8f2b6';",
        // [GFX][im] stays at 6.2's default, on, at /usr/bin/, as in Docker,
        // whose image has no ImageMagick either. Each call to it finds no
        // program, as sh would (native/popen.c), so 6.2 does what it does
        // there: GD draws, and what needs ImageMagick fails. Switched off,
        // 6.2.31's Install Tool cannot render its own GD test.
        //
        // No processes: file operations use PHP's functions instead of
        // exec().
        "$GLOBALS['TYPO3_CONF_VARS']['BE']['disable_exec_function'] = 1;",
        '',
      ].join('\n'),
    },
    persistedDirs: ['typo3conf', 'fileadmin', 'uploads', 'typo3temp'],
    snapshotVersion: 1,
    // 6.2/apache-typo3.conf, on the path below the document root. Its
    // FilesMatch, which Apache tests on the file name, is tested here on the
    // last path segment: each "^" became "/", and nothing crosses a "/".
    denied: [
      /^\/(typo3conf|typo3temp|uploads|fileadmin)\/.*\.(php|sql|inc|log)$/,
      /_(recycler|temp)_\//,
      /^\/fileadmin\/templates\/.*\.(txt|ts)$/,
      /^\/(typo3\/vendor|typo3_src|typo3temp\/logs)(\/|$)/,
      /\/(typo3conf\/ext|typo3\/sysext|typo3\/ext)\/[^/]+\/(Configuration|Resources\/Private|Tests?|Documentation|docs?)\//,
      /\/\./,
      /(?:\/\.|\/#[^/]*#|\/(?:ChangeLog|ToDo|Readme|License)(?:\.md|\.txt)?|\/composer\.(?:json|lock)|\/ext_conf_template\.txt|\/ext_typoscript_constants\.txt|\/ext_typoscript_setup\.txt|flexform[^./]*\.xml|locallang[^./]*\.(?:xml|xlf)|\.(?:bak|co?nf|cfg|ya?ml|ts|dist|fla|in[ci]|log|sh|sql(?:\.[^/]*)?|sw[op]|git[^/]*)|[^/]*(?:~|rc))$/i,
    ],

    // No localconf.php: 6.2 would take one for a 4.x site to migrate.
    localconf: null,
  };
});
