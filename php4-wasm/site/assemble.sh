#!/usr/bin/env bash
# Assembles the static site that runs TYPO3 3.3.0 in a browser: the shell
# page, the service worker, the PHP worker and everything they load.
#
# Usage: assemble.sh <repo-root> <work-dir>
# <work-dir> is the one build.sh wrote to; the site goes to <work-dir>/out/site.
# Needs sql.js in php4-wasm/node_modules (npm ci). Serve the result from any
# static web server over HTTPS or on localhost, which service workers require.
set -euo pipefail

repo=$(realpath "$1")
work=$(realpath "$2")
here=$(dirname "$(realpath "$0")")
wasm=$(dirname "$here")
site="$work/out/site"

(cd "$repo/vendor-src/typo3-3.3.0" && sha256sum -c SHA256SUMS)

rm -rf "$site"
mkdir -p "$site"
cp "$here/index.html" "$here/sw.js" "$here/php-worker.js" "$site/"
cp "$wasm/runtime/php4-runtime.js" "$wasm/runtime/mysql-sqlite.js" "$wasm/runtime/tar.js" \
    "$wasm/runtime/typo3-site.js" "$site/"
cp "$work/out/sapi-web/php4.js" "$work/out/sapi-web/php4.wasm" "$site/"
cp "$wasm/node_modules/sql.js/dist/sql-wasm.js" "$wasm/node_modules/sql.js/dist/sql-wasm.wasm" "$site/"
cp "$repo/vendor-src/typo3-3.3.0/typo3_src-3.3.0.tar.gz" "$repo/3.3/provision.php" \
    "$repo/php4-base/php-legacy.ini" "$site/"

# Content-hashed names, so that a browser cannot mix files from two deploys:
# Pages lets it cache each file for ten minutes. A name changes only when its
# content does. index.html, sw.js and LICENSES.txt keep their names: they are
# what visitors and the service worker registration ask for.
hashed() {
    local name=$1 hash
    hash=$(sha256sum "$site/$name" | cut -c1-16)
    local renamed="${name%.*}.$hash.${name##*.}"
    case $name in *.tar.gz) renamed="${name%.tar.gz}.$hash.tar.gz" ;; esac
    mv "$site/$name" "$site/$renamed"
    printf '%s' "$renamed"
}
map='{'
for name in php4-runtime.js mysql-sqlite.js tar.js typo3-site.js sql-wasm.js sql-wasm.wasm \
    php4.js php4.wasm typo3_src-3.3.0.tar.gz provision.php php-legacy.ini; do
    map+="\"$name\":\"$(hashed "$name")\","
done
map="${map%,}}"
# php-worker.js names every other file, so it is hashed after they are, with
# the map in it.
test "$(grep -c '^const FILES = {};$' "$site/php-worker.js")" = 1
sed -i "s|^const FILES = {};\$|const FILES = $map;|" "$site/php-worker.js"
worker=$(hashed php-worker.js)
test "$(grep -c "new Worker('php-worker.js')" "$site/index.html")" = 1
sed -i "s|new Worker('php-worker.js')|new Worker('$worker')|" "$site/index.html"

# The licenses travel with the binaries: PHP's, Zend's and PCRE's ask for
# their notices in any binary redistribution, and so do the MIT licenses.
# libjpeg's and FreeType's ask for a credit line in the documentation.
licences="$work/out/licences"
{
    cat <<'EOF'
This site runs third-party software. Each part keeps its own license. The
full texts follow.

TYPO3 3.3.0 (typo3_src-3.3.0.tar.gz), GPL-2.0-or-later
    The archive is TYPO3's complete source as released. It carries the GPL
    text in typo3/, t3lib/ and tslib/. "TYPO3" is a registered trademark of
    the TYPO3 Association. This site is not affiliated with or endorsed by it.

PHP 4.4.9 (php4.js, php4.wasm), PHP License 3.01
    This product includes PHP software, freely available from
    <http://www.php.net/software/>.
    This product includes the Zend Engine, freely available at
    <http://www.zend.com/>.
    It also includes PCRE, under the BSD license, and was compiled with
    Emscripten, whose runtime and musl libc it contains (MIT and
    University of Illinois/NCSA).
    It includes GD 2.0.28 as bundled in PHP, under the GD license in
    gd-README, and links these libraries, built by Emscripten's ports:
    zlib (zlib license), libpng (libpng license), libjpeg 9f and FreeType
    (FreeType License).
    This software is based in part on the work of the Independent JPEG
    Group.
    Portions of this software are copyright (C) 1996-2026 The FreeType Project
    (www.freetype.org). All rights reserved.

sql.js 1.14.2 (sql-wasm.js, sql-wasm.wasm), MIT
    It compiles SQLite, which is in the public domain.

Everything else on this site comes from https://github.com/mteu/typo3-throwback-src
and is under that project's MIT license, whose text comes last.
EOF
    for file in php-4.4.9-LICENSE zend-engine-LICENSE pcre-LICENCE emscripten-LICENSE musl-COPYRIGHT \
        gd-README zlib-LICENSE libpng-LICENSE libjpeg-README freetype-FTL.TXT; do
        printf '\n\n===== %s =====\n\n' "$file"
        cat "$licences/$file"
    done
    printf '\n\n===== sql.js-LICENSE =====\n\n'
    cat "$wasm/node_modules/sql.js/LICENSE"
    printf '\n\n===== typo3-throwback-src LICENSE =====\n\n'
    cat "$repo/LICENSE"
} > "$site/LICENSES.txt"

du -sh "$site"
