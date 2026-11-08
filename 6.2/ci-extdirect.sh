# Sourced by the typo3-6-2 job in .github/workflows/images.yml, after
# 6.2/ci-login.sh has left a backend session in ./jar. Not used by the
# image. Expects BASE and UA in the environment.
#
# 4.5/ci-extdirect.sh, carried to 6.2 with its references moved to 6.2's
# namespaced classes. Copied rather than shared, as the 4.0 job's helpers are: the
# two stacks are pinned to different sources, and a helper that serves both would
# carry two sets of line numbers.

# read_extdirect_token
#
# The token the backend hands its own Ext.Direct calls, printed into backend.php as
# TYPO3.ExtDirectToken (typo3/sysext/core/Classes/Page/PageRenderer.php:1395-1409).
# The router pops it off the call's data and refuses the call without it
# (Classes/ExtDirect/ExtDirectRouter.php:73-81). It is an HMAC over the form name
# and a token kept in the backend session
# (Classes/FormProtection/AbstractFormProtection.php:78-97), so one read stays
# valid for as long as the session does — including across the Apache restarts
# the job's control experiment makes.
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
# The endpoint name is the namespace plus the action, so this asks
# TYPO3.Components.PageTree.DataProvider, registered by core for every backend
# (typo3/sysext/core/Classes/Core/Bootstrap.php:463), for the level below the
# virtual root. ajax.php routes it to ExtDirect::route, which is registered without
# ajax.php's own CSRF check because the router has its own
# (Configuration/DefaultConfiguration.php:700-704). For an admin that is one mount,
# the site, carrying the seeded page as its child. The token rides as the last
# data item, where the router pops it from.
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
