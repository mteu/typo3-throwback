// TYPO3 3.3.0 in the browser: what runtime/typo3-site.js needs to know that
// 3.3/Dockerfile, 3.3/entrypoint.sh and php4-base/nginx.conf know for the
// Docker stack. Paths name files in this repository; site/assemble.sh
// publishes each one, and the probes read them from the checkout.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.Typo3Releases = root.Typo3Releases || {})['3.3.0'] = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    release: '3.3.0',
    php: '4.4.9',
    // Noon on the release day, UTC, where 3.3/compose.yaml starts libfaketime.
    clockStartMs: Date.UTC(2002, 5, 3, 12, 0, 0),
    archive: 'vendor-src/typo3-3.3.0/typo3_src-3.3.0.tar.gz',
    archiveRoot: 'typo3_src-3.3.0',
    // Every licence file in the archive, by .github/scripts/licence_inventory.py.
    // site/assemble.sh lists them in LICENSES.txt.
    licenceIndex: '3.3/LICENCES.md',
    ini: 'php4-base/php-legacy.ini',
    provisionScript: '3.3/provision.php',
    provisionEnv: ({ source }) => ({ TYPO3_SRC: source, TYPO3_PROVISION: 'auto' }),

    // 3.3/Dockerfile's document root: symlinks into the source tree, which
    // stays where it was unpacked. Targets that start with "/" are in the
    // source; the others are relative to the link.
    docrootLinks: [
      ['typo3', '/typo3'],
      ['t3lib', '/t3lib'],
      ['tslib', '/tslib'],
      ['index.php', 'tslib/index_ts.php'],
      ['media', 'tslib/media'],
      ['clear.gif', 't3lib/gfx/clear.gif'],
    ],
    writableDirs: ['typo3conf', 'typo3temp', 'fileadmin/_temp_', 'uploads/pics', 'uploads/media', 'uploads/tf'],
    // The directories TYPO3 writes to, kept across visits as a container's
    // volume keeps them. typo3temp is a cache, but not one that rebuilds
    // itself: the page cache in the database names the GIFBUILDER images in
    // it, and serves those names until the page is edited.
    persistedDirs: ['typo3conf', 'fileadmin', 'uploads', 'typo3temp'],
    // A snapshot of another version is provisioned afresh instead of
    // restored. 2: GD is on; a version 1 snapshot holds a localconf.php with
    // image processing off and a template that still asks for niceText.
    // 3: mysql-sqlite.js's catalog tables are __phpwasm_*, no longer
    // __php4wasm_*.
    snapshotVersion: 3,
    // php4-base/nginx.conf: source files that must never be served.
    denied: [
      /^(\/typo3)?\/t3lib\/.*\.(php|sql|inc)$/,
      /^\/(typo3conf|typo3temp|uploads|fileadmin)\/.*\.(php|sql|inc)$/,
    ],

    // 3.3/entrypoint.sh's auto-mode localconf.php, but for ImageMagick,
    // which cannot run in a browser. [GFX][im] = 0 is 3.3.0's own way of
    // saying so (t3lib/config_default.php): GD alone draws GIFBUILDER's
    // menus and text, and TYPO3 limits images to gif, jpg and png.
    localconf: [
      "$typo_db_username = 'typo3';",
      "$typo_db_password = 'typo3';",
      "$typo_db_host     = 'db';",
      "$typo_db          = 'typo3';",
      '',
      "$TYPO3_CONF_VARS['SYS']['sitename'] = 'TYPO3 3.3.0';",
      // md5('joh316'), the historical default the 3.3 stack uses.
      "$TYPO3_CONF_VARS['BE']['installToolPassword'] = 'bacb98acf97e0b6112b1d1b650b84971';",
      "$TYPO3_CONF_VARS['GFX']['image_processing'] = 1;",
      "$TYPO3_CONF_VARS['GFX']['im'] = 0;",
      "$TYPO3_CONF_VARS['GFX']['gdlib'] = 1;",
      "$TYPO3_CONF_VARS['GFX']['gdlib_png'] = 0;",
      // No processes either: file operations such as moving an upload into
      // fileadmin/ use PHP's functions instead of exec('mv ...'), as 3.3.0
      // does on Windows (t3lib/class.t3lib_extfilefunc.php:116).
      "$TYPO3_CONF_VARS['BE']['disable_exec_function'] = 1;",
    ],

    // 3.3/Dockerfile's two edits, each with the check the Dockerfile makes.
    // read and write take paths relative to the source tree.
    editSource({ read, write }) {
      const install = 'typo3/install/index.php';
      write(install, read(install).replace(/^(\s*)die\("In the main source distribution/m, '$1// die("In the main source distribution'));
      if (/^\s*die\("In the main source distribution/m.test(read(install))) {
        throw new Error('the Install Tool die() edit did not apply');
      }
      // The second TS_tmplParts_rte(), which PHP 4.4.9 refuses at compile
      // time (docs/how-it-works.md, 3.3.0).
      const parser = 't3lib/class.t3lib_parsehtml_proc.php';
      const lines = read(parser).split('\n');
      if (lines[1024] !== '\tfunction TS_tmplParts_rte($value)\t{') {
        throw new Error('line 1025 of class.t3lib_parsehtml_proc.php is not the duplicate declaration');
      }
      for (let i = 1024; i <= 1044; i++) {
        lines[i] = `//${lines[i]}`;
      }
      write(parser, lines.join('\n'));
      if ((read(parser).match(/^\s*function TS_tmplParts_rte/gm) || []).length !== 1) {
        throw new Error('the duplicate TS_tmplParts_rte() edit did not apply');
      }
    },

    // GREEN's GMENU draws its titles with niceText = 1: GD writes the text at
    // twice the size, and ImageMagick scales it down. Without ImageMagick the
    // titles are simply missing. A 2002 site on a GD-only server turned
    // niceText off in its own template's constants, which 3.3.0 reads after
    // the static templates it includes; this does the same to the root
    // template provision.php seeds. Its constants are empty until then.
    afterProvision(query) {
      const result = query("UPDATE sys_template SET constants = 'styles.gmenu_layer.green.niceText = 0' WHERE root = 1 AND deleted = 0 AND constants = ''");
      if (result.kind !== 'ok' || result.affectedRows !== 1) {
        throw new Error(`could not turn off niceText in the root template: ${JSON.stringify(result)}`);
      }
    },
  };
});
