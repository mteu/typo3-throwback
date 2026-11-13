#!/usr/bin/env bash
# Usage: check.sh <repo-root> <work-root>
# <work-root> holds one directory per interpreter, php-<version>/, each the
# work dir its build.sh wrote to. Needs node and npm: sql.js and Playwright
# come from package-lock.json. The browser steps also need Playwright's
# Chromium (npx playwright install chromium), and are skipped with
# SKIP_BROWSER=1. .github/workflows/pages.yml runs this before every deploy.
#
# Three parts: what each interpreter must do, what every release must do
# (one loop over releases/), and what a release's own stack must do.
set -euo pipefail

repo=$(realpath "$1")
work=$(realpath "$2")
here=$(dirname "$(realpath "$0")")

(cd "$here" && npm ci --no-audit --no-fund --silent)

# --- PHP 4.4.9 --------------------------------------------------------------
php4="$work/php-4.4.9/out"
php=(node "$php4/node/php.js" -n)

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

echo "== request loop: many requests in one instance"
node "$here/probe/request-loop.cjs" "$php4/sapi-node" "$work/request-loop"

echo "== MySQL 3.23 on SQLite"
node "$here/probe/mysql-sqlite.cjs"

# --- every release ----------------------------------------------------------
# A release file's field, read by node, as the runtime reads it.
field() {
    node -e 'const r = require(process.argv[1]); process.stdout.write(String(r[process.argv[2]]))' \
        "$here/releases/$1.js" "$2"
}

# Prints the *.php and *.inc files under an unpacked release that the CLI in
# "${php[@]}" does not parse, one per line, sorted.
lint_failures() {
    (
        cd "$1"
        find . \( -name '*.php' -o -name '*.inc' \) | sort | while read -r file; do
            if ! "${php[@]}" -l "$file" 2>&1 | grep -q '^No syntax errors'; then
                echo "$file"
            fi
        done
    )
}

releases=()
for file in "$here"/releases/*.js; do
    releases+=("$(basename "$file" .js)")
done

for release in "${releases[@]}"; do
    archive=$(field "$release" archive)
    php=(node "$work/php-$(field "$release" php)/out/node/php.js" -n)
    tree="$work/typo3-$release/$(field "$release" archiveRoot)"

    echo "== lint every PHP file in TYPO3 $release, as released"
    (cd "$repo/$(dirname "$archive")" && sha256sum -c SHA256SUMS)
    rm -rf "$work/typo3-$release"
    mkdir "$work/typo3-$release"
    tar -xzf "$repo/$archive" -C "$work/typo3-$release"
    failing=$(lint_failures "$tree")
    total=$(cd "$tree" && find . \( -name '*.php' -o -name '*.inc' \) | wc -l)
    echo "files: $total, failing:"
    echo "$failing"
    case $release in
        3.3.0)
            # Both are bugs in the 2002 source, not in the build: a duplicate
            # method, which releases/3.3.0.js comments out as the Dockerfile
            # does, and a string that leaves its quotes in phpMyAdmin.
            test "$total" -eq 371
            test "$failing" = './t3lib/class.t3lib_parsehtml_proc.php
./typo3/mod/tools/phpadmin/phpMyAdmin-2.2.6/lang/russian-koi8.inc.php'
            duplicate=$("${php[@]}" -l "$tree/t3lib/class.t3lib_parsehtml_proc.php" 2>&1 || true)
            grep -q 'Cannot redeclare ts_tmplparts_rte() in .* on line 1025' <<<"$duplicate"
            ;;
        3.8.1)
            # None, the bundled phpMyAdmin 2.6.4 included: 3.8.1 runs on PHP
            # 4.4.9, though its Docker stack runs PHP 5.6.40 (#52).
            test "$total" -eq 803
            test -z "$failing"
            ;;
        *)
            echo "no lint expectations for $release" >&2
            exit 1
            ;;
    esac

    echo "== TypoScript parser from $release core"
    "${php[@]}" -d error_reporting=2039 "$here/probe/typoscript.php" "$tree"

    echo "== TYPO3 $release through the request loop, without a database"
    node "$here/probe/bootstrap.cjs" "$work" "$release"
done

# --- PHP 4.4.9 again, with files from the release trees above -------------
php=(node "$php4/node/php.js" -n)

echo "== GD, FreeType and zlib, with a font from the 3.3.0 source"
"${php[@]}" "$here/probe/gd.php" "$work/typo3-3.3.0/typo3_src-3.3.0/t3lib/fonts/verdana.ttf"

echo "== ext/xml and its bundled expat, with 3.8.1's locallang files"
"${php[@]}" -d error_reporting=2039 "$here/probe/xml.php" "$work/typo3-3.8.1/typo3_src-3.8.1"

# --- each release's own stack ------------------------------------------------
# Every release has a stack probe: a missing one fails here.
for release in "${releases[@]}"; do
    echo "== TYPO3 $release on the WebAssembly stack, held to its Docker job's assertions"
    node "$here/probe/stack-$release.cjs" "$work"
done

if [ "${SKIP_BROWSER:-0}" != 1 ]; then
    echo "== the TypoScript parser, the request loop and ext/mysql in headless Chromium"
    node "$here/probe/browser.cjs" "$php4" "$work/typo3-3.3.0/typo3_src-3.3.0"

    # Every release, as the site publishes them: .github/workflows/pages.yml
    # deploys what this assembles.
    "$here/site/assemble.sh" "$repo" "$work" "${releases[@]}"
    for release in "${releases[@]}"; do
        echo "== TYPO3 $release's site in headless Chromium: service worker, login, editing, IndexedDB"
        node "$here/probe/site.cjs" "$work/site" "$release"
    done

    echo "== two releases on one origin: each its own PHP, snapshot and reset"
    node "$here/probe/two-sites.cjs" "$work/site"
fi

echo "== all checks passed"
