# Sourced by the typo3-4-5 job in .github/workflows/images.yml, after
# 4.5/ci-login.sh has left a backend session in ./jar. Not used by the
# image. Expects BASE and UA in the environment.

# read_extdirect_token
#
# The token the backend hands its own Ext.Direct calls, printed into backend.php as
# TYPO3.ExtDirectToken (t3lib/class.t3lib_pagerenderer.php:997-1006). The router
# refuses any call without it (t3lib/extjs/class.t3lib_extjs_extdirectrouter.php:
# 93-102). It is an HMAC over the form name and a token kept in the backend
# session (t3lib/formprotection/class.t3lib_formprotection_abstract.php:98-148),
# so one read stays valid for as long as the session does — including across the
# Apache restarts the job's control experiment makes.
read_extdirect_token() {
    curl -fsS -A "$UA" -b jar "$BASE/typo3/backend.php" -o extdirect-backend.html
    EXTDIRECT_TOKEN=$(grep -oE 'TYPO3\.ExtDirectToken = "[0-9a-f]+"' extdirect-backend.html \
        | grep -oE '[0-9a-f]{40}' || true)
    if [ -z "$EXTDIRECT_TOKEN" ]; then
        echo "::error::backend.php carried no TYPO3.ExtDirectToken"
        exit 1
    fi
}

# call_page_tree <file to write the response to>
#
# One Ext.Direct call, made the way the backend's own page tree makes it: a POST
# whose body is JSON rather than a form. That is the request shape PHP 5.6 raises
# its "Automatically populating $HTTP_RAW_POST_DATA" deprecation for — a POST with
# no registered handler for its content type (main/php_content_types.c in
# PHP 5.6.40, populate_raw_post_data()) — and the reason this exists.
#
# The endpoint name is the namespace plus the action
# (class.t3lib_extjs_extdirectrouter.php:145), so this asks
# TYPO3.Components.PageTree.DataProvider, registered by core for every backend
# (t3lib/config_default.php:630-635), for the level below the virtual root. For an
# admin that is one mount, the site, carrying the seeded page as its child. The
# token rides as the last data item, where the router pops it from.
#
# Prints the HTTP status. The response headers go to <file>.headers, so a caller
# can tell which PHP settings served this very request (see served_with_expose_php).
call_page_tree() {
    curl -sS -A "$UA" -b jar \
        -H 'Content-Type: application/json' \
        -H 'X-Requested-With: XMLHttpRequest' \
        --data-binary "{\"action\":\"DataProvider\",\"method\":\"getNextTreeLevel\",\"data\":[\"root\",{\"id\":\"root\"},\"${EXTDIRECT_TOKEN}\"],\"type\":\"rpc\",\"tid\":1}" \
        -o "$1" -D "$1.headers" -w '%{http_code}' \
        "$BASE/typo3/ajax.php?ajaxID=ExtDirect::route&namespace=TYPO3.Components.PageTree"
}

# served_with_expose_php <response file> <On|Off>
#
# Fails unless that response's own headers show the expected expose_php. After a
# graceful restart an old Apache child can still answer a request or two under
# the settings it started with, so a marker read off a different request says the
# new settings are live somewhere, not that they served this one. Reading it off
# the response under test closes that gap; an assertion of absence would
# otherwise pass vacuously on a stale child, since the shipped settings show
# nothing either.
#
# Only an assertion of absence needs this. One of presence identifies its own
# settings by what appears — and a reply PHP has printed an error into during
# request startup cannot carry the marker anyway, because the header is added
# after that point and the output has already sent the headers.
served_with_expose_php() {
    if grep -qi '^x-powered-by:' "$1.headers"; then seen=On; else seen=Off; fi
    if [ "$seen" != "$2" ]; then
        echo "::error::$1 was served with expose_php $seen, not $2 — not under the settings this phase applied"
        exit 1
    fi
}
