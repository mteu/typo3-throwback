// Boots a TYPO3 release in Node the way site/php-worker.js boots it in a
// browser: runtime/typo3-site.js, driven by releases/<release>.js, on the
// in-memory request-loop build. The archive, provision script and ini come
// from this checkout, at the paths the release file names.
//
// workRoot is the directory the builds went to: <workRoot>/php-<version>/
// holds the build of each interpreter, as check.sh lays it out.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const PhpRuntime = require('../runtime/php-runtime.js');
const MysqlOnSqlite = require('../runtime/mysql-sqlite.js');
const readTar = require('../runtime/tar.js');
const Typo3Site = require('../runtime/typo3-site.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const initSqlJs = require(path.join(__dirname, '..', 'node_modules', 'sql.js'));

function loadRelease(name) {
  return require(path.join(__dirname, '..', 'releases', `${name}.js`));
}

// options: anything Typo3Site.boot() takes, such as database or snapshot.
// The site is served from the root, so TYPO3 sees the URLs a Docker stack's
// clients send, and so do the probes' assertions.
async function bootRelease(name, workRoot, options = {}) {
  const release = loadRelease(name);
  const read = file => fs.readFileSync(path.join(repoRoot, file));
  return Typo3Site.boot({
    release,
    PhpRuntime,
    createPhp: require(path.join(workRoot, `php-${release.php}`, 'out', 'sapi-web', 'php.js')),
    MysqlOnSqlite,
    SQL: await initSqlJs(),
    readTar,
    tarball: zlib.gunzipSync(read(release.archive)),
    provisionScript: release.provisionScript ? read(release.provisionScript) : null,
    legacyIni: read(release.ini),
    urlPrefix: '',
    ...options,
  });
}

module.exports = { bootRelease, loadRelease, repoRoot };
