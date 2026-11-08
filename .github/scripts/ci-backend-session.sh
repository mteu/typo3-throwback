# Backend sessions for the frameset backends, 3.3 to 4.0. Sourced by the
# typo3-3-3, typo3-3-8 and typo3-4-0 jobs in .github/workflows/images.yml. Not
# used by any image. Expects BASE (scheme, host and port, no path) and UA in the
# environment.
#
# 4.5 and 6.2 have their own ci-login.sh, because their backend and their login
# answer differently.

# login_and_expect <absolute URL the redirect must point at>
#
# Leaves the session in ./jar.
#
# 4.5/ci-login.sh, with the two things 4.0 does differently. The login
# itself is the same: md5(user:md5(password):challenge), "superchallenged", and the
# challenge is the one kept in the PHP session (t3lib/class.t3lib_userauth.php:
# 1049-1056, on for the backend through challengeStoredInCookie,
# t3lib/class.t3lib_beuserauth.php:108). So 4.0 already behaves like 4.5 here, not
# like 3.3, and the form request has to be the one that starts the session.
#
# What differs is the answer. 4.0 sends a bare header('Location: …')
# (typo3/index.php:473), for which PHP answers 302 where 4.5's
# t3lib_utility_Http::redirect() chose 303; and the target is alt_main.php, the
# frameset, not backend.php. interface=backend still selects it
# (typo3/index.php:462-465), whatever the missing be_typo_user cookie would
# otherwise have asked for (:443-453).
#
# 3.8.1 logs in the same way, which is why the 3.8 job uses this too. The backend
# keeps the challenge in the PHP session (challengeStoredInCookie,
# t3lib/class.t3lib_beuserauth.php:108; typo3/index.php:233-241). interface=backend
# redirects to alt_main.php (:466-467), and the redirect is absolute
# (t3lib_div::locationHeaderUrl, :476). 3.3 is the one that differs: it never
# stores its challenge, so its job logs in without this.
login_and_expect() {
    expected="$1"

    rm -f jar
    curl -fsS -A "$UA" -c jar "$BASE/typo3/index.php" -o login-form.html
    challenge=$(grep -oE 'name="challenge" value="[0-9a-f]{32}"' login-form.html | grep -oE '[0-9a-f]{32}')
    if [ -z "$challenge" ]; then
        echo "::error::the login form carried no challenge"
        exit 1
    fi

    pass_md5=$(printf '%s' password | md5sum | cut -d' ' -f1)
    ident=$(printf 'admin:%s:%s' "$pass_md5" "$challenge" | md5sum | cut -d' ' -f1)

    # The Referer is checked against the host on submitted logins
    # (t3lib/class.t3lib_userauth.php:393-399).
    code=$(curl -sS -A "$UA" -b jar -c jar -e "$BASE/typo3/index.php" \
        -D login.headers -o login.html -w '%{http_code}' \
        -d login_status=login -d username=admin -d p_field= \
        -d "userident=$ident" -d "challenge=$challenge" -d interface=backend \
        "$BASE/typo3/index.php")
    location=$(tr -d '\r' < login.headers | sed -n 's/^[Ll]ocation: //p')

    if [ "$code" != 302 ] || [ "$location" != "$expected" ]; then
        echo "::error::login answered $code to '$location', expected 302 to '$expected'"
        head -c 2000 login.html
        exit 1
    fi
    echo "logged in; redirected to $location"
}

# assert_fresh_sessions_are_distinct
#
# Opens the login form a dozen times with no cookies, while the session in ./jar
# is logged in, and fails unless every answer is a login form with its own
# challenge and its own be_typo_user cookie, none of them the logged-in one.
#
# Under the frozen clock, 4.0's md5(uniqid('').getmypid()) is the same for every
# call within one Apache child, so without one process per connection
# (4.0/apache-typo3.conf) a fresh request on a reused child inherits whichever
# session that child last opened. A single request only hits that when it happens
# to land on such a child, which is how it first surfaced: as one flaky login. A
# dozen against a handful of prefork children cannot all miss.
#
# 3.8.1 makes its ids the same way (t3lib/class.t3lib_userauth.php:231), and 3.3.0
# from the clock alone, md5(uniqid("")) (t3lib/class.t3lib_userauth.php:138). So
# under a frozen clock 3.8 collides per child and 3.3 on every request. Both did
# in CI (issues #12 and #13), and both now let the clock run from the release
# instant instead, which makes uniqid() move again. 4.0 keeps its clock still and
# its one process per connection.
assert_fresh_sessions_are_distinct() {
    logged_in=$(awk '$6 == "be_typo_user" { print $7 }' jar)
    : > fresh-sessions.txt
    for i in $(seq 1 12); do
        code=$(curl -sS -A "$UA" -D fresh.headers -o fresh.html -w '%{http_code}' "$BASE/typo3/index.php")
        if [ "$code" != 200 ]; then
            echo "::error::a cookieless request for the login form answered $code on attempt $i; it found someone's session"
            tr -d '\r' < fresh.headers | grep -i '^location:' || true
            exit 1
        fi
        challenge=$(grep -oE 'name="challenge" value="[0-9a-f]{32}"' fresh.html | grep -oE '[0-9a-f]{32}' || true)
        session=$(tr -d '\r' < fresh.headers | sed -n 's/^[Ss]et-[Cc]ookie: be_typo_user=\([^;]*\).*/\1/p')
        if [ -z "$challenge" ] || [ -z "$session" ]; then
            echo "::error::attempt $i carried no challenge ('$challenge') or no new session cookie ('$session')"
            exit 1
        fi
        if [ "$session" = "$logged_in" ]; then
            echo "::error::attempt $i was handed the logged-in session's id"
            exit 1
        fi
        echo "$challenge $session" >> fresh-sessions.txt
    done
    if [ "$(cut -d' ' -f1 fresh-sessions.txt | sort -u | wc -l)" != 12 ] \
        || [ "$(cut -d' ' -f2 fresh-sessions.txt | sort -u | wc -l)" != 12 ]; then
        echo "::error::twelve fresh requests did not get twelve distinct challenges and sessions"
        cat fresh-sessions.txt
        exit 1
    fi
    echo "twelve fresh requests, twelve distinct challenges and session ids, none the logged-in one"
}
