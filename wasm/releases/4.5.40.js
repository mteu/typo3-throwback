// TYPO3 4.5.40 in the browser, on PHP 5.6.40: what runtime/typo3-site.js needs
// to know that 4.5/Dockerfile, 4.5/entrypoint.sh and 4.5/apache-typo3.conf
// know for the Docker stack. Paths name files in this repository.
//
// 4.5.40 stops below PHP 5.2.0 (typo3/init.php:63), so it runs on the same
// PHP as its Docker stack.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.Typo3Releases = root.Typo3Releases || {})['4.5.40'] = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    release: '4.5.40',
    php: '5.6.40',
    // Noon on the release day, UTC, where 4.5/Dockerfile starts libfaketime.
    clockStartMs: Date.UTC(2015, 1, 19, 12, 0, 0),
    archive: 'vendor-src/typo3-4.5.40/typo3_src-4.5.40.tar.gz',
    archiveRoot: 'typo3_src-4.5.40',
    // Every licence file in the archive, by .github/scripts/licence_inventory.py.
    // site/assemble.sh lists them in LICENSES.txt.
    licenceIndex: '4.5/LICENCES.md',
    // The stack's own: it works on PHP 5.6 as it is.
    ini: '4.5/php-legacy.ini',
    provisionScript: '4.5/provision.php',
    // Its database settings default to what localconf.php below says, as in
    // Docker. TYPO3_DOCROOT is where it reads the release's SQL files.
    provisionEnv: ({ source }) => ({ TYPO3_DOCROOT: source, TYPO3_PROVISION: 'auto' }),
    // mysql:5.5, the server 4.5/compose.yaml runs, at its last release, with
    // the stack's --character-set-server=utf8. 4.5/provision.php refuses any
    // other charset.
    mysqlServerVersion: '5.5.62',
    mysqlCharset: 'utf8',

    // The archive is the document root, top-level index.php included, as
    // 4.5/Dockerfile copies it.
    docrootLinks: null,
    // 4.5/entrypoint.sh's: the Install Tool's directory check
    // (typo3/sysext/install/mod/class.tx_install.php:2874-2890). The archive
    // has none of them.
    writableDirs: [
      'typo3conf', 'typo3temp/pics', 'typo3temp/temp', 'typo3temp/llxml', 'typo3temp/cs', 'typo3temp/GB',
      'typo3temp/locks', 'fileadmin/_temp_', 'uploads/pics', 'uploads/media', 'uploads/tf',
    ],
    // Files the site starts with. 4.5 locks the Install Tool unless
    // typo3conf/ENABLE_INSTALL_TOOL exists (typo3/install/index.php:58), and
    // removes the file once it is an hour old unless it reads KEEP_FILE.
    docrootFiles: {
      'typo3conf/ENABLE_INSTALL_TOOL': 'KEEP_FILE\n',
    },
    persistedDirs: ['typo3conf', 'fileadmin', 'uploads', 'typo3temp'],
    snapshotVersion: 1,
    // 4.5/apache-typo3.conf: 3.8's rules, and .log files too, for
    // typo3conf/deprecation_<hash>.log.
    denied: [
      /^(\/typo3)?\/t3lib\/.*\.(php|sql|inc)$/,
      /^\/(typo3conf|typo3temp|uploads|fileadmin)\/.*\.(php|sql|inc|log)$/,
    ],

    // 4.5/entrypoint.sh's auto-mode localconf.php, but for ImageMagick, which
    // cannot run in a browser. [GFX][im] = 0 makes 4.5.40 limit images to gif,
    // jpg, jpeg and png itself (t3lib/config_default.php:815-820), so the
    // entrypoint's im_* and imagefile_ext lines go too.
    localconf: [
      "$typo_db_username = 'typo3';",
      "$typo_db_password = 'typo3';",
      "$typo_db_host     = 'db';",
      "$typo_db          = 'typo3';",
      '',
      "$TYPO3_CONF_VARS['SYS']['sitename'] = 'TYPO3 4.5.40';",
      // Without it every request but the Install Tool's dies: below '4.5'
      // 4.5.40 takes the site for one that was just upgraded
      // (t3lib/config_default.php:725-770).
      "$TYPO3_CONF_VARS['SYS']['compat_version'] = '4.5';",
      // The default list, t3skin, without which the backend has no skin, and
      // css_styled_content, which renders the seeded page's content element.
      "$TYPO3_CONF_VARS['EXT']['extList'] = 'filelist,version,tsconfig_help,context_help,extra_page_cm_options,impexp,belog,about,cshmanual,aboutmodules,setup,opendocs,install,t3editor,felogin,feedit,recycler,t3skin,css_styled_content';",
      // The page is served from whatever host the tab is on.
      "$TYPO3_CONF_VARS['SYS']['trustedHostsPattern'] = '.*';",
      // md5('joh316'), as every stack here sets it.
      "$TYPO3_CONF_VARS['BE']['installToolPassword'] = 'bacb98acf97e0b6112b1d1b650b84971';",
      "$TYPO3_CONF_VARS['BE']['forceCharset'] = 'utf-8';",
      "$TYPO3_CONF_VARS['SYS']['setDBinit'] = 'SET NAMES utf8';",
      // The entrypoint's fixed key: TYPO3 salts cHash with it, and a fixed one
      // keeps frontend URLs the same in Docker and here.
      "$TYPO3_CONF_VARS['SYS']['encryptionKey'] = 'b3e9d1a74c2f8e6051d7a9c3f2b8e4a6d0c5f1e9a7b3d8c2e6f4a0b9d5c1e7f3';",
      "$TYPO3_CONF_VARS['GFX']['im'] = 0;",
      // No processes either: file operations use PHP's functions instead of
      // exec('mv ...'), as on Windows (t3lib/config_default.php:218).
      "$TYPO3_CONF_VARS['BE']['disable_exec_function'] = 1;",
    ],
  };
});
