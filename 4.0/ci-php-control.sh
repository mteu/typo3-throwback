# Sourced by the typo3-4-0 job in .github/workflows/images.yml, for its
# default_charset control experiment. Not used by the image. Expects BASE and
# COMPOSE in the environment.
#
# The same technique as the typo3-4-5 job's Ext.Direct step, and copied rather
# than shared: each phase's settings go into a conf.d file read after the shipped
# one, Apache restarts gracefully to read them, and expose_php flips with each
# phase so X-Powered-By says which settings answered.

# apply_php_control <expose_php: On|Off> [more ini lines...]
#
# Returns once a fresh request shows the new expose_php. That proves the settings
# are live somewhere, not that they served any particular later request — see
# served_with_expose_php for that.
apply_php_control() {
    expose="$1"
    shift
    printf '%s\n' "expose_php = $expose" "$@" \
      | $COMPOSE exec -T web sh -c \
          'cat > /usr/local/etc/php/conf.d/zzz-ci-control.ini && apache2ctl -k graceful'
    wait_for_expose_php "$expose"
}

# clear_php_control
#
# Back to the shipped settings, whose expose_php is PHP's default, On.
clear_php_control() {
    $COMPOSE exec -T web sh -c 'rm -f /usr/local/etc/php/conf.d/zzz-ci-control.ini && apache2ctl -k graceful'
    wait_for_expose_php On
}

wait_for_expose_php() {
    for i in $(seq 1 30); do
        curl -sS -o /dev/null -D control.headers "$BASE/" || true
        if grep -qi '^x-powered-by:' control.headers; then seen=On; else seen=Off; fi
        [ "$seen" = "$1" ] && return 0
        sleep 1
    done
    echo "::error::Apache did not pick up the control settings (expose_php still not $1)"
    exit 1
}

# served_with_expose_php <headers file> <On|Off>
#
# Fails unless that response's own headers show the expected expose_php. After a
# graceful restart an old Apache child can still answer a request or two under the
# settings it started with, so this is read off the response being judged.
served_with_expose_php() {
    if grep -qi '^x-powered-by:' "$1"; then seen=On; else seen=Off; fi
    if [ "$seen" != "$2" ]; then
        echo "::error::$1 was served with expose_php $seen, not $2 — not under the settings this phase applied"
        exit 1
    fi
}
