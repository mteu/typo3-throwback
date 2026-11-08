# Assertions shared by the stack jobs in .github/workflows/images.yml.
# Sourced by their steps; not used by any image.

# refute_in <file> <grep arguments...>
#
# Fails the step when the pattern IS found. Exists because the obvious spelling,
# `! grep -q pattern file`, is a no-op under `set -e`: bash exempts a negated
# command from errexit, so a match sets $? to 1 and the step carries on. The 3.3
# and 3.8 jobs used that spelling for every negative check they made, so none of
# those checks could ever fail.
refute_in() {
    file="$1"
    shift
    if grep -q "$@" "$file"; then
        echo "::error::$file matches $*"
        grep "$@" "$file" | head -5
        exit 1
    fi
}

# PHP's own error output, which must never reach a page: a 2002 page carrying a
# much later PHP's deprecation warnings is no longer the page that shipped.
#
# Matched by its shape rather than by its first word. PHP writes
# "Warning: <message> in <file> on line <n>", and with html_errors on — mod_php's
# default — it wraps the parts in <b>…</b>, so the colon follows "</b>" and not
# the word. The pattern this replaces, 'Deprecated:|Notice:|Warning:|Fatal error:',
# missed that HTML form entirely, and matched the TYPO3 4.5 login page's own
# JavaScript comment "showWarning: shows warning if true".
PHP_ERROR_OUTPUT='(Deprecated|Notice|Warning|Fatal error|Parse error|Strict Standards|Catchable fatal error)(</b>)?: .* on line (<b>)?[0-9]'

refute_php_errors_in() {
    refute_in "$1" -E "$PHP_ERROR_OUTPUT"
}
