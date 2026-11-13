// TYPO3 3.8.1 in the browser, on PHP 4.4.9: what runtime/typo3-site.js needs
// to know that 3.8/Dockerfile, 3.8/entrypoint.sh and 3.8/apache-typo3.conf
// know for the Docker stack. Paths name files in this repository.
//
// The Docker stack runs PHP 5.6.40. 3.8.1 stops only below PHP 4.1.0
// (typo3/init.php:198); wasm/check.sh shows that every file parses on PHP
// 4.4.9 and that the bootstrap runs (#52).
//
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.Typo3Releases = root.Typo3Releases || {})['3.8.1'] = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    release: '3.8.1',
    php: '4.4.9',
    // Noon on the release day, UTC, where 3.8/Dockerfile starts libfaketime.
    clockStartMs: Date.UTC(2005, 10, 14, 12, 0, 0),
    archive: 'vendor-src/typo3-3.8.1/typo3_src-3.8.1.tar.gz',
    archiveRoot: 'typo3_src-3.8.1',
    // Every licence file in the archive, by .github/scripts/licence_inventory.py.
    // site/assemble.sh lists them in LICENSES.txt.
    licenceIndex: '3.8/LICENCES.md',
    // php4-base's, as 3.3 uses: 3.8/php-legacy.ini names E_DEPRECATED and
    // E_STRICT, which PHP 4 does not define.
    ini: 'php4-base/php-legacy.ini',
    provisionScript: '3.8/provision.php',
    // Its database settings default to what localconf.php below says, as in
    // Docker. TYPO3_DOCROOT is where it reads the release's SQL files.
    provisionEnv: ({ source }) => ({ TYPO3_DOCROOT: source, TYPO3_PROVISION: 'auto' }),

    // The archive is the document root, top-level index.php included, as
    // 3.8/Dockerfile copies it.
    docrootLinks: null,
    // 3.8/entrypoint.sh's. The archive has none of them.
    writableDirs: ['typo3conf', 'typo3temp', 'fileadmin/_temp_', 'uploads/pics', 'uploads/media', 'uploads/tf'],
    persistedDirs: ['typo3conf', 'fileadmin', 'uploads', 'typo3temp'],
    snapshotVersion: 1,
    // 3.8/apache-typo3.conf.
    denied: [
      /^(\/typo3)?\/t3lib\/.*\.(php|sql|inc)$/,
      /^\/(typo3conf|typo3temp|uploads|fileadmin)\/.*\.(php|sql|inc)$/,
    ],

    // 3.8/entrypoint.sh's auto-mode localconf.php, but for ImageMagick, which
    // cannot run in a browser. [GFX][im] = 0 makes 3.8.1 limit images to gif,
    // jpg, jpeg and png itself (t3lib/config_default.php:284), so the
    // entrypoint's imagefile_ext and im_* lines go too.
    localconf: [
      "$typo_db_username = 'typo3';",
      "$typo_db_password = 'typo3';",
      "$typo_db_host     = 'db';",
      "$typo_db          = 'typo3';",
      '',
      "$TYPO3_CONF_VARS['SYS']['sitename'] = 'TYPO3 3.8.1';",
      // md5('joh316'), as every stack here sets it.
      "$TYPO3_CONF_VARS['BE']['installToolPassword'] = 'bacb98acf97e0b6112b1d1b650b84971';",
      // The entrypoint's fixed key: TYPO3 salts cHash with it, and a fixed one
      // keeps frontend URLs the same in Docker and here.
      "$TYPO3_CONF_VARS['SYS']['encryptionKey'] = 'c4f7e1ba2d8a4f6b9e0c3d5a7b1f8e2c6d0a9b4e7f3c1d5a8b2e6f0c9d3a7b1e';",
      "$TYPO3_CONF_VARS['GFX']['image_processing'] = 1;",
      "$TYPO3_CONF_VARS['GFX']['im'] = 0;",
      // PHP 4.4.9 bundles GD 2.0.28, as PHP 5.6 bundles a GD 2.
      "$TYPO3_CONF_VARS['GFX']['gdlib'] = 1;",
      "$TYPO3_CONF_VARS['GFX']['gdlib_2'] = 1;",
      "$TYPO3_CONF_VARS['GFX']['gdlib_png'] = 0;",
      // No processes either: file operations use PHP's functions instead of
      // exec('mv ...'), as on Windows (t3lib/config_default.php:122).
      "$TYPO3_CONF_VARS['BE']['disable_exec_function'] = 1;",
    ],

    // 3.8/Dockerfile's one edit, with its check. The guard also refuses any
    // REMOTE_ADDR but 127.0.0.1 and 192.168.*. The runtime sends 127.0.0.1,
    // so here the edit changes nothing; it is made for parity with Docker.
    editSource({ read, write }) {
      const install = 'typo3/install/index.php';
      write(install, read(install).replace(/^(\s*)die\("In the source distribution/m, '$1// die("In the source distribution'));
      if (/^\s*die\("In the source distribution/m.test(read(install))) {
        throw new Error('the Install Tool die() edit did not apply');
      }
    },
  };
});
