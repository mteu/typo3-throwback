#!/usr/bin/env bash
# Assembles the static site that runs TYPO3 releases in a browser, laid out
# as GitHub Pages serves it:
#
#   wasm/                every file the releases share or load, published once,
#                        each under a name with a hash of its content: PHP,
#                        sql.js, the runtime, the release files, each
#                        release's archive and scripts, the PHP worker; and
#                        LICENSES.txt
#   <major.minor>/       per release: index.html, the shell, and sw.js, whose
#                        scope is this directory
#
# Usage: assemble.sh <repo-root> <work-root> <release>...
# <work-root> is the one check.sh takes: php-<version>/ holds each
# interpreter's build. The site goes to <work-root>/site, or to $SITE when it
# is set. The release files come from wasm/releases/, or from $RELEASES when
# it is set: check.sh assembles a test site that way. Needs sql.js in
# wasm/node_modules (npm ci). Serve the result from any static web server
# over HTTPS or on localhost, which service workers require.
set -euo pipefail

repo=$(realpath "$1")
work=$(realpath "$2")
shift 2
releases=("$@")
here=$(dirname "$(realpath "$0")")
wasm=$(dirname "$here")
site=${SITE:-$work/site}
shared="$site/wasm"
release_files=${RELEASES:-$wasm/releases}

field() {
    node -e 'const r = require(process.argv[1]); process.stdout.write(String(r[process.argv[2]]))' \
        "$release_files/$1.js" "$2"
}

rm -rf "$site"
mkdir -p "$shared"

# Content-hashed names, so that a browser cannot mix files from two deploys:
# Pages lets it cache each file for ten minutes. A name changes only when its
# content does. The worker finds each file by its logical name in a map:
# "runtime/tar.js", "php-4.4.9/php.wasm", or the path in this repository
# that a release file names. The map has each file's size too, which the
# worker counts its download against.
map='{'
declare -A size=()
publish() {
    local logical=$1 source=$2 base hash published
    # Releases can share an input, such as php4-base/php-legacy.ini.
    [[ ${size[$logical]+set} ]] && return
    base=$(basename "$logical")
    hash=$(sha256sum "$source" | cut -c1-16)
    case $base in
        *.tar.gz) published="${base%.tar.gz}.$hash.tar.gz" ;;
        *.*) published="${base%.*}.$hash.${base##*.}" ;;
    esac
    cp "$source" "$shared/$published"
    size[$logical]=$(stat -c %s "$source")
    map+="\"$logical\":[\"$published\",${size[$logical]}],"
}
runtime=(runtime/php-runtime.js runtime/mysql-sqlite.js runtime/tar.js runtime/typo3-site.js runtime/step-installer.js)

for logical in "${runtime[@]}"; do
    publish "$logical" "$wasm/$logical"
done
for name in sql-wasm.js sql-wasm.wasm; do
    publish "sql.js/$name" "$wasm/node_modules/sql.js/dist/$name"
done
# Named in LICENSES.txt as installed, so an update cannot leave it stale.
sql_js_version=$(node -p 'require(require("path").resolve(process.argv[1])).version' "$wasm/node_modules/sql.js/package.json")
[[ $sql_js_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]

interpreters=()
for release in "${releases[@]}"; do
    php=$(field "$release" php)
    [[ " ${interpreters[*]} " == *" $php "* ]] || interpreters+=("$php")
    archive=$(field "$release" archive)
    (cd "$repo/$(dirname "$archive")" && sha256sum -c SHA256SUMS)
    publish "releases/$release.js" "$release_files/$release.js"
    for input in "$archive" "$(field "$release" provisionScript)" "$(field "$release" ini)"; do
        publish "$input" "$repo/$input"
    done
done
for php in "${interpreters[@]}"; do
    for name in php.js php.wasm; do
        publish "php-$php/$name" "$work/php-$php/out/sapi-web/$name"
    done
done

# What a visit downloads: every file the worker loads for the release. The
# worker and the shell are left out: they are small, and the worker cannot
# name its own size. The worker counts its download up to this number, and
# the shell's release menu shows it.
declare -A download=()
for release in "${releases[@]}"; do
    php=$(field "$release" php)
    total=0
    for logical in "${runtime[@]}" sql.js/sql-wasm.js sql.js/sql-wasm.wasm "releases/$release.js" \
        "$(field "$release" archive)" "$(field "$release" provisionScript)" "$(field "$release" ini)" \
        "php-$php/php.js" "php-$php/php.wasm"; do
        total=$((total + ${size[$logical]}))
    done
    download[$release]=$total
done
downloads='{'
for release in "${releases[@]}"; do
    downloads+="\"$release\":${download[$release]},"
done
# In megabytes, as the worker writes them, so that both say the same.
megabytes() {
    node -p '(Number(process.argv[1]) / 1e6).toFixed(1)' "$1"
}

# The worker names every other file, so it is hashed after they are, with
# the map in it.
cp "$here/php-worker.js" "$work/php-worker.js"
test "$(grep -c '^const FILES = {};$' "$work/php-worker.js")" = 1
test "$(grep -c '^const DOWNLOAD_BYTES = {};$' "$work/php-worker.js")" = 1
sed -i -e "s|^const FILES = {};\$|const FILES = ${map%,}};|" \
    -e "s|^const DOWNLOAD_BYTES = {};\$|const DOWNLOAD_BYTES = ${downloads%,}};|" "$work/php-worker.js"
worker=$(hash=$(sha256sum "$work/php-worker.js" | cut -c1-16); echo "php-worker.$hash.js")
mv "$work/php-worker.js" "$shared/$worker"

# The release menu, one entry per release: its year is the one its clock
# starts in. The shell's own release is marked as the current page.
menu_entry() {
    local release=$1 current=$2 year
    year=$(node -e 'const r = require(process.argv[1]); process.stdout.write(String(new Date(r.clockStartMs).getUTCFullYear()))' \
        "$release_files/$release.js")
    printf '      <li><a href="../%s/"%s><span class="version">%s</span><span class="meta">%s · PHP %s</span><span class="size">%s MB</span></a></li>\n' \
        "${release%.*}" "$([[ $release == "$current" ]] && echo ' aria-current="page"')" \
        "$release" "$year" "$(field "$release" php)" "$(megabytes "${download[$release]}")"
}

# One shell and one service worker per release. Nothing else is per release:
# the shell starts the shared worker with the release's name.
marker='      <!-- assemble.sh lists the releases here -->'
test "$(grep -cxF "$marker" "$here/index.html")" = 1
test "$(grep -c "^const WORKER = '../wasm/php-worker.js';$" "$here/index.html")" = 1
for release in "${releases[@]}"; do
    dir="$site/${release%.*}"
    mkdir -p "$dir"
    cp "$here/sw.js" "$dir/"
    menu=$(for other in "${releases[@]}"; do menu_entry "$other" "$release"; done)
    sed -e "s|^const WORKER = '../wasm/php-worker.js';\$|const WORKER = '../wasm/$worker';|" \
        -e "s|__RELEASE__|$release|g" "$here/index.html" \
        | MENU=$menu awk -v marker="$marker" '$0 == marker { print ENVIRON["MENU"]; next } { print }' > "$dir/index.html"
    ! grep -q __RELEASE__ "$dir/index.html"
    test "$(grep -c '<li><a href=' "$dir/index.html")" = "${#releases[@]}"
done

# The licenses travel with the binaries: PHP's, Zend's and PCRE's ask for
# their notices in any binary redistribution, and so do the MIT licenses.
# libjpeg's and FreeType's ask for a credit line in the documentation, and
# OpenSSL's two licenses for an acknowledgement in any redistribution. Each
# interpreter the releases name gets its paragraph, and each license text its
# build put in out/licences/ is printed once.
php_paragraph() {
    case $1 in
        4.4.9) cat <<'EOF'

PHP 4.4.9 (php-4.4.9/php.js, php.wasm), PHP License 3.01
    This product includes PHP software, freely available from
    <http://www.php.net/software/>.
    This product includes the Zend Engine, freely available at
    <http://www.zend.com/>.
    It also includes PCRE, under the BSD license, and expat 1.95.6, under
    the MIT license in expat-COPYING. It was compiled with
    Emscripten, whose runtime and musl libc it contains (MIT and
    University of Illinois/NCSA).
    It includes GD 2.0.28 as bundled in PHP, under the GD license in
    gd-README, and links these libraries, built by Emscripten's ports:
    zlib (zlib license), libpng (libpng license), libjpeg 9f and FreeType
    (FreeType License).
EOF
            ;;
        5.6.40) cat <<'EOF'

PHP 5.6.40 (php-5.6.40/php.js, php.wasm), PHP License 3.01
    This product includes PHP software, freely available from
    <http://www.php.net/software/>.
    This product includes the Zend Engine, freely available at
    <http://www.zend.com/>.
    It also includes PCRE, under the BSD license, and links libxml2 2.9.14,
    under the MIT license in libxml2-Copyright. It was compiled with
    Emscripten, whose runtime and musl libc it contains (MIT and
    University of Illinois/NCSA).
    It links OpenSSL 1.0.2u, under the OpenSSL and SSLeay licenses in
    openssl-LICENSE.
    This product includes software developed by the OpenSSL Project for
    use in the OpenSSL Toolkit (http://www.openssl.org/).
    This product includes cryptographic software written by Eric Young
    (eay@cryptsoft.com).
    It includes GD 2.1 as bundled in PHP, under the GD license in
    gd-COPYING, and libmagic and libzip as bundled in PHP, under the BSD
    licenses in libmagic-LICENSE and libzip-LICENSE. It links these
    libraries, built by Emscripten's ports: zlib (zlib license), libpng
    (libpng license), libjpeg 9f and FreeType (FreeType License).
EOF
            ;;
        *)
            echo "no license paragraph for PHP $1" >&2
            return 1
            ;;
    esac
}
{
    echo 'This site runs third-party software. Each part keeps its own license. The'
    echo 'full texts follow.'
    for release in "${releases[@]}"; do
        cat <<EOF

TYPO3 $release ($(basename "$(field "$release" archive)")), GPL-2.0-or-later
    The archive is TYPO3's complete source as released. It carries the GPL
    text and the licenses of the third-party code it bundles, in these files:
EOF
        # The rows of the release's LICENCES.md table: | `dir` | `file` | what |
        rows=$(sed -n 's/^| `\([^`]*\)` | `\([^`]*\)` | \(.*\) |$/        \1\/\2: \3/p' "$repo/$(field "$release" licenceIndex)" | sed 's|(root)/||')
        test -n "$rows"
        echo "$rows"
    done
    cat <<'EOF'

"TYPO3" is a registered trademark of the TYPO3 Association. This site is not
affiliated with or endorsed by it.
EOF
    for php in "${interpreters[@]}"; do
        php_paragraph "$php"
    done
    cat <<'EOF'
    This software is based in part on the work of the Independent JPEG
    Group.
    Portions of this software are copyright (C) 1996-2026 The FreeType Project
    (www.freetype.org). All rights reserved.
EOF
    printf '\nsql.js %s (sql-wasm.js, sql-wasm.wasm), MIT\n' "$sql_js_version"
    cat <<'EOF'
    It compiles SQLite, which is in the public domain.

Everything else on this site comes from https://github.com/mteu/typo3-throwback
and is under that project's MIT license, whose text comes last.
EOF
    # Each text once. Both builds carry some of the same files, such as
    # Emscripten's. A name whose text differs between them says whose it is.
    declare -A printed=()
    for php in "${interpreters[@]}"; do
        licences="$work/php-$php/out/licences"
        test -s "$licences/php-$php-LICENSE"
        for path in "$licences"/*; do
            file=$(basename "$path")
            hash=$(sha256sum "$path" | cut -c1-64)
            if [[ ${printed[$file]+set} ]]; then
                [[ ${printed[$file]} == "$hash" ]] && continue
                printf '\n\n===== %s (PHP %s) =====\n\n' "$file" "$php"
            else
                printf '\n\n===== %s =====\n\n' "$file"
                printed[$file]=$hash
            fi
            cat "$path"
        done
    done
    printf '\n\n===== sql.js-LICENSE =====\n\n'
    cat "$wasm/node_modules/sql.js/LICENSE"
    printf '\n\n===== typo3-throwback LICENSE =====\n\n'
    cat "$repo/LICENSE"
} > "$shared/LICENSES.txt"

du -sh "$site"
