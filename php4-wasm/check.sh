#!/usr/bin/env bash
# Usage: check.sh <repo-root> <work-dir>
# <work-dir> is the one build.sh wrote to. Needs node and npm: sql.js and
# Playwright come from package-lock.json. The browser steps also need
# Playwright's Chromium (npx playwright install chromium), and are skipped
# with SKIP_BROWSER=1. .github/workflows/pages.yml runs this before every
# deploy.
set -euo pipefail

repo=$(realpath "$1")
work=$(realpath "$2")
here=$(dirname "$(realpath "$0")")
php=(node "$work/out/node/php.js" -n)

(cd "$here" && npm ci --no-audit --no-fund --silent)

echo "== PHP 4 semantics"
"${php[@]}" "$here/probe/semantics.php"

echo "== fatal error bailout"
set +e
fatal=$("${php[@]}" "$here/probe/fatal.php" 2>&1)
status=$?
set -e
echo "$fatal"
test "$status" -eq 255
grep -q 'Fatal error: Call to undefined function: undefined_function_call()' <<<"$fatal"
grep -q 'shutdown function ran after fatal' <<<"$fatal"
! grep -q never <<<"$fatal"

echo "== lint every PHP file in TYPO3 3.3.0"
(cd "$repo/vendor-src/typo3-3.3.0" && sha256sum -c SHA256SUMS)
rm -rf "$work/typo3-3.3.0"
mkdir "$work/typo3-3.3.0"
tar -xzf "$repo/vendor-src/typo3-3.3.0/typo3_src-3.3.0.tar.gz" -C "$work/typo3-3.3.0"
typo3="$work/typo3-3.3.0/typo3_src-3.3.0"
failing=$(
    cd "$typo3"
    find . \( -name '*.php' -o -name '*.inc' \) | sort | while read -r file; do
        if ! "${php[@]}" -l "$file" 2>&1 | grep -q '^No syntax errors'; then
            echo "$file"
        fi
    done
)
total=$(cd "$typo3" && find . \( -name '*.php' -o -name '*.inc' \) | wc -l)
echo "files: $total, failing:"
echo "$failing"
# Both failures are in the 2002 source, not in the build. See the doc, section 3.
expected='./t3lib/class.t3lib_parsehtml_proc.php
./typo3/mod/tools/phpadmin/phpMyAdmin-2.2.6/lang/russian-koi8.inc.php'
test "$failing" = "$expected"
duplicate=$("${php[@]}" -l "$typo3/t3lib/class.t3lib_parsehtml_proc.php" 2>&1 || true)
grep -q 'Cannot redeclare ts_tmplparts_rte() in .* on line 1025' <<<"$duplicate"

echo "== TypoScript parser from 3.3.0 core"
"${php[@]}" -d error_reporting=2039 "$here/probe/typoscript.php" "$typo3"

echo "== GD, FreeType and zlib, with a font from the 3.3.0 source"
"${php[@]}" "$here/probe/gd.php" "$typo3/t3lib/fonts/verdana.ttf"

echo "== request loop: many requests in one instance, and the 3.3.0 frontend"
node "$here/probe/request-loop.cjs" "$work/out/sapi-node" "$typo3" "$work/request-loop"

echo "== MySQL 3.23 on SQLite"
node "$here/probe/mysql-sqlite.cjs"

echo "== TYPO3 3.3.0 on the WebAssembly stack, held to CI's 3.3 assertions"
# A second copy of the source with 3.3/Dockerfile's two edits, made by the
# same commands with the same assertions. The copy above stays as released,
# because the lint step expects the duplicate method.
rm -rf "$work/typo3-3.3.0-stack"
mkdir "$work/typo3-3.3.0-stack"
tar -xzf "$repo/vendor-src/typo3-3.3.0/typo3_src-3.3.0.tar.gz" -C "$work/typo3-3.3.0-stack"
stack="$work/typo3-3.3.0-stack/typo3_src-3.3.0"
sed -i 's|^\(\s*\)die("In the main source distribution|\1// die("In the main source distribution|' \
    "$stack/typo3/install/index.php"
! grep -qE '^[[:space:]]*die\("In the main source distribution' "$stack/typo3/install/index.php"
f="$stack/t3lib/class.t3lib_parsehtml_proc.php"
sed -n '1025p' "$f" | grep -aqx "$(printf '\tfunction TS_tmplParts_rte($value)\t{')"
sed -i '1025,1045s|^|//|' "$f"
test "$(grep -ac '^[[:space:]]*function TS_tmplParts_rte' "$f")" = 1
"${php[@]}" -l "$f" | grep -q '^No syntax errors'
node "$here/probe/typo3-stack.cjs" "$work/out/sapi-node" "$stack" "$work/typo3-stack"

if [ "${SKIP_BROWSER:-0}" != 1 ]; then
    echo "== the TypoScript parser, the request loop and ext/mysql in headless Chromium"
    node "$here/probe/browser.cjs" "$work/out" "$typo3"

    echo "== the whole site in headless Chromium: service worker, login, editing, IndexedDB"
    "$here/site/assemble.sh" "$repo" "$work"
    node "$here/probe/site.cjs" "$work/out/site"
fi

echo "== all checks passed"
