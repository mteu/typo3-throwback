// The TYPO3 3.3.0 document root, assembled as 3.3/Dockerfile assembles it:
// symlinks into an unpacked source tree, plus the writable directories and a
// typo3conf/localconf.php.
'use strict';

const fs = require('fs');
const path = require('path');

function buildDocroot(docroot, typo3Src, localconfLines) {
  fs.mkdirSync(docroot, { recursive: true });
  for (const [link, target] of [
    ['typo3', path.join(typo3Src, 'typo3')],
    ['t3lib', path.join(typo3Src, 't3lib')],
    ['tslib', path.join(typo3Src, 'tslib')],
    ['index.php', 'tslib/index_ts.php'],
    ['media', 'tslib/media'],
    ['clear.gif', 't3lib/gfx/clear.gif'],
  ]) {
    fs.symlinkSync(target, path.join(docroot, link));
  }
  for (const dir of ['typo3conf', 'typo3temp', 'fileadmin/_temp_', 'uploads/pics', 'uploads/media', 'uploads/tf']) {
    fs.mkdirSync(path.join(docroot, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(docroot, 'typo3conf', 'localconf.php'), ['<?php', ...localconfLines, '?>', ''].join('\n'));
  return docroot;
}

module.exports = { buildDocroot };
