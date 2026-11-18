// TYPO3 4.0.13 in the browser, on PHP 4.4.9: what runtime/typo3-site.js needs
// to know that 4.0/Dockerfile, 4.0/entrypoint.sh and 4.0/apache-typo3.conf
// know for the Docker stack. Paths name files in this repository.
//
// The Docker stack runs PHP 5.6.40. 4.0.13 stops only below PHP 4.1.0
// (typo3/init.php:226); wasm/check.sh shows that every file but nine PHP 5
// files of the bundled ADOdb parses on PHP 4.4.9, and that the bootstrap
// runs.
//
// 4.0/provision.php reads what only a MySQL 5 server answers: the charset
// variables and information_schema. So the shim answers as the MySQL 5.5 of
// 4.0/compose.yaml here.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.Typo3Releases = root.Typo3Releases || {})['4.0.13'] = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    release: '4.0.13',
    php: '4.4.9',
    // Noon on the release day, UTC, where 4.0/Dockerfile starts libfaketime.
    clockStartMs: Date.UTC(2009, 6, 2, 12, 0, 0),
    archive: 'vendor-src/typo3-4.0.13/typo3_src-4.0.13.tar.gz',
    archiveRoot: 'typo3_src-4.0.13',
    // Every licence file in the archive, by .github/scripts/licence_inventory.py.
    // site/assemble.sh lists them in LICENSES.txt.
    licenceIndex: '4.0/LICENCES.md',
    // php4-base's, as 3.3 and 3.8 use: 4.0/php-legacy.ini names E_DEPRECATED
    // and E_STRICT, which PHP 4 does not define. Both set default_charset to
    // ISO-8859-1.
    ini: 'php4-base/php-legacy.ini',
    provisionScript: '4.0/provision.php',
    // Its database settings default to what localconf.php below says, as in
    // Docker. TYPO3_DOCROOT is where it reads the release's SQL files.
    provisionEnv: ({ source }) => ({ TYPO3_DOCROOT: source, TYPO3_PROVISION: 'auto' }),
    // mysql:5.5, the server 4.0/compose.yaml runs, at its last release. 3.23,
    // the shim's default, has no @@character_set_server, and provisioning
    // stops there.
    mysqlServerVersion: '5.5.62',

    // The archive is the document root, top-level index.php included, as
    // 4.0/Dockerfile copies it.
    docrootLinks: null,
    // 4.0/entrypoint.sh's: the Install Tool's directory check
    // (typo3/sysext/install/mod/class.tx_install.php:1695-1712). The archive
    // has none of them.
    writableDirs: [
      'typo3conf', 'typo3temp/pics', 'typo3temp/temp', 'typo3temp/llxml', 'typo3temp/cs', 'typo3temp/GB',
      'fileadmin/_temp_', 'uploads/pics', 'uploads/media', 'uploads/tf',
    ],
    persistedDirs: ['typo3conf', 'fileadmin', 'uploads', 'typo3temp'],
    snapshotVersion: 1,
    // 4.0/apache-typo3.conf, the same rules as 3.8's.
    denied: [
      /^(\/typo3)?\/t3lib\/.*\.(php|sql|inc)$/,
      /^\/(typo3conf|typo3temp|uploads|fileadmin)\/.*\.(php|sql|inc)$/,
    ],

    // 4.0/entrypoint.sh's auto-mode localconf.php, but for ImageMagick, which
    // cannot run in a browser. With [GFX][im] = 0, the entrypoint's im_* and
    // imagefile_ext lines go too, as in 3.8.1's release file.
    localconf: [
      "$typo_db_username = 'typo3';",
      "$typo_db_password = 'typo3';",
      "$typo_db_host     = 'db';",
      "$typo_db          = 'typo3';",
      '',
      "$TYPO3_CONF_VARS['SYS']['sitename'] = 'TYPO3 4.0.13';",
      // md5('joh316'), as every stack here sets it.
      "$TYPO3_CONF_VARS['BE']['installToolPassword'] = 'bacb98acf97e0b6112b1d1b650b84971';",
      // What the 1-2-3 wizard writes for a new site; the default is '3.8'
      // (t3lib/config_default.php:60).
      "$TYPO3_CONF_VARS['SYS']['compat_version'] = '4.0';",
      // The entrypoint's fixed key: TYPO3 salts cHash with it, and a fixed one
      // keeps frontend URLs the same in Docker and here.
      "$TYPO3_CONF_VARS['SYS']['encryptionKey'] = '7d2a9f4c1e8b6d3a0f5c9e2b7a4d1f8c3e6b0a9d5f2c8e1b4a7d0c3f6e9b2a5d';",
      "$TYPO3_CONF_VARS['GFX']['im'] = 0;",
      // PHP 4.4.9 bundles GD 2.0.28, as PHP 5.6 bundles a GD 2.
      "$TYPO3_CONF_VARS['GFX']['gdlib_2'] = 1;",
      // No processes either: file operations use PHP's functions instead of
      // exec('mv ...'), as on Windows (t3lib/config_default.php:137).
      "$TYPO3_CONF_VARS['BE']['disable_exec_function'] = 1;",
    ],

    // 4.0/Dockerfile's one edit, the same as 3.8's, with its check.
    editSource({ read, write }) {
      const install = 'typo3/install/index.php';
      write(install, read(install).replace(/^(\s*)die\("In the source distribution/m, '$1// die("In the source distribution'));
      if (/^\s*die\("In the source distribution/m.test(read(install))) {
        throw new Error('the Install Tool die() edit did not apply');
      }
    },
  };
});
