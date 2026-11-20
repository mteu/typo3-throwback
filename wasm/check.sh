#!/usr/bin/env bash
# Usage: check.sh <repo-root> <work-root>
# <work-root> holds one directory per interpreter, php-<version>/, each the
# work dir its build.sh wrote to. Needs node and npm: sql.js and Playwright
# come from package-lock.json. The browser steps also need Playwright's
# Chromium (npx playwright install chromium), and are skipped with
# SKIP_BROWSER=1. The HTTPS probe needs openssl for a throwaway certificate.
# .github/workflows/pages.yml runs this before every deploy.
#
# Three parts: what each interpreter must do, what every release must do
# (one loop over releases/), and what a release's own stack must do.
set -euo pipefail

repo=$(realpath "$1")
work=$(realpath "$2")
here=$(dirname "$(realpath "$0")")

(cd "$here" && npm ci --no-audit --no-fund --silent)

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

# probe/fatal.php on the CLI in "${php[@]}": the engine bails out of the
# script with exit status 255 and the message given, and still runs the
# shutdown function.
check_bailout() {
    local fatal status
    set +e
    fatal=$("${php[@]}" "$here/probe/fatal.php" 2>&1)
    status=$?
    set -e
    echo "$fatal"
    test "$status" -eq 255
    grep -qF "$1" <<<"$fatal"
    grep -q 'shutdown function ran after fatal' <<<"$fatal"
    ! grep -q never <<<"$fatal"
}

# --- PHP 4.4.9 --------------------------------------------------------------
php4="$work/php-4.4.9/out"
php=(node "$php4/node/php.js" -n)

echo "== PHP 4 semantics"
"${php[@]}" "$here/probe/semantics.php"

echo "== fatal error bailout"
check_bailout 'Fatal error: Call to undefined function: undefined_function_call()'

echo "== mail() through /bin/true, as every Docker stack's sendmail_path"
"${php[@]}" "$here/probe/mail.php"
"${php[@]}" -d sendmail_path=sendmail "$here/probe/mail.php" refused

echo "== request loop: many requests in one instance"
node "$here/probe/request-loop.cjs" "$php4/sapi-node" "$work/request-loop" 4.4.9

echo "== MySQL 3.23 on SQLite"
node "$here/probe/mysql-sqlite.cjs"

# --- PHP 5.6.40 -------------------------------------------------------------
php5="$work/php-5.6.40/out"
php=(node "$php5/node/php.js" -n)

echo "== PHP 5 semantics"
"${php[@]}" "$here/probe/semantics-5.php"

echo "== fatal error bailout, on PHP 5"
check_bailout 'Fatal error: Call to undefined function undefined_function_call()'

echo "== PHP 5's bundled extensions: ctype, filter, hash, json, tokenizer, zlib"
"${php[@]}" "$here/probe/extensions-5.php"

echo "== mail() through /bin/true, on PHP 5"
"${php[@]}" "$here/probe/mail.php"
"${php[@]}" -d sendmail_path=sendmail "$here/probe/mail.php" refused

echo "== request loop on PHP 5: many requests, php://input, the raw-POST deprecation, uploads, ext/mysql, sessions, the clock"
node "$here/probe/request-loop.cjs" "$php5/sapi-node" "$work/request-loop-5" 5.6.40

echo "== request loop on PHP 5, the browser build: its in-memory filesystem, through php-runtime.js"
node "$here/probe/request-loop-web.cjs" "$php5/sapi-web"

# --- every release ----------------------------------------------------------
# A release file's field, read by node, as the runtime reads it.
field() {
    node -e 'const r = require(process.argv[1]); process.stdout.write(String(r[process.argv[2]]))' \
        "$here/releases/$1.js" "$2"
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
            # 4.4.9, though its Docker stack runs PHP 5.6.40.
            test "$total" -eq 803
            test -z "$failing"
            ;;
        4.0.13)
            # All nine are PHP 5 code in the bundled ADOdb, which only the
            # DBAL extension loads, and DBAL is not in the default extList
            # (t3lib/config_default.php:107). Even with DBAL, PHP 4 never
            # reaches them:
            # - adodb-iterator: only when PHP_VERSION >= 5 (adodb.inc.php:2699)
            # - adodb-exceptions: only when PHP_VERSION >= 5
            #   (tests/test-active-record.php:8), or from two PHP 5 tests
            # - ado5: only when PHP_VERSION >= 5 (adodb.inc.php:3938,
            #   adodb-ado_access.inc.php:18, adodb-ado_mssql.inc.php:22)
            # - pdo and pdo_mysql: only for a "pdo" DSN, and PDO is PHP 5.1's
            # - tests/: ADOdb's own test scripts, which nothing includes
            test "$total" -eq 516
            test "$failing" = './typo3/sysext/adodb/adodb/adodb-exceptions.inc.php
./typo3/sysext/adodb/adodb/adodb-iterator.inc.php
./typo3/sysext/adodb/adodb/drivers/adodb-ado5.inc.php
./typo3/sysext/adodb/adodb/drivers/adodb-pdo.inc.php
./typo3/sysext/adodb/adodb/drivers/adodb-pdo_mysql.inc.php
./typo3/sysext/adodb/adodb/tests/pdo.php
./typo3/sysext/adodb/adodb/tests/test-php5.php
./typo3/sysext/adodb/adodb/tests/test2.php
./typo3/sysext/adodb/adodb/tests/test3.php'

            echo "== TYPO3 4.0.13's clone() for PHP 4, which PHP 5 never loads"
            "${php[@]}" -d error_reporting=2047 "$here/probe/compat-php5.php" "$tree"
            ;;
        4.5.40)
            # None: 4.5.40 runs on PHP 5.6.40, as its Docker stack does.
            test "$total" -eq 1736
            test -z "$failing"

            echo "== ext/xml, dom and SimpleXML on libxml2, with 4.5.40's locallang files"
            "${php[@]}" -d error_reporting=22519 "$here/probe/xml-5.php" "$tree"

            echo "== GD, FreeType and zlib on PHP 5, with a font from the 4.5.40 source"
            "${php[@]}" "$here/probe/gd.php" "$tree/t3lib/fonts/vera.ttf"

            # Where the core can choose, what a default site takes on this build.
            echo "== 4.5.40's random bytes from openssl, and charset conversion with no iconv or mbstring"
            "${php[@]}" -d error_reporting=22519 "$here/probe/core-functions-5.php" "$tree"
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

    echo "== every release on one origin: each its own PHP, snapshot and reset"
    node "$here/probe/two-sites.cjs" "$work/site" "${releases[@]}"

    echo "== every release's backend login over HTTPS, as the public site serves it"
    node "$here/probe/https.cjs" "$work/site" "${releases[@]}"

    # PHP 5.6.40 through the whole site, before a release that needs it: 3.8.1
    # as its Docker stack runs it, on PHP 5.6.40 with 3.8/php-legacy.ini. The
    # test release is releases/3.8.1.js with those two lines changed, in a
    # test site of its own, so the published site is not touched.
    echo "== PHP 5.6.40 through the whole site: TYPO3 3.8.1 on it, as its Docker stack runs it"
    test_releases="$work/test-releases"
    rm -rf "$test_releases"
    mkdir -p "$test_releases"
    sed -e "s|^    php: '4.4.9',\$|    php: '5.6.40',|" \
        -e "s|^    ini: 'php4-base/php-legacy.ini',\$|    ini: '3.8/php-legacy.ini',|" \
        "$here/releases/3.8.1.js" > "$test_releases/3.8.1.js"
    test "$(RELEASES=$test_releases node -e 'const r = require(process.env.RELEASES + "/3.8.1.js"); process.stdout.write(r.php + " " + r.ini)')" \
        = "5.6.40 3.8/php-legacy.ini"
    RELEASES="$test_releases" SITE="$work/site-php-5.6.40" "$here/site/assemble.sh" "$repo" "$work" 3.8.1
    RELEASES="$test_releases" node "$here/probe/site.cjs" "$work/site-php-5.6.40" 3.8.1
fi

echo "== all checks passed"
