# Sourced by the typo3-4-5 job in .github/workflows/images.yml, which
# logs in twice, once over each scheme TYPO3 believes it is on. Not used by the
# image. Expects BASE and UA in the environment.

# login_and_expect <absolute URL the 303 must point at>
#
# Leaves the session in ./jar.
#
# The 4.5 backend login, done the way the form's JavaScript does it:
# md5(user:md5(password):challenge). Unlike 3.3, which compares against whatever
# challenge is posted, 4.5 keeps the one it issued in the PHP session and refuses
# any other (t3lib/class.t3lib_userauth.php:1322-1331), so it has to be read out
# of the form, and the form request has to be the one that starts the session.
#
# interface=backend is what makes the answer a redirect to backend.php in every
# case (typo3/index.php:386-393), rather than to the cookie-retry URL a missing
# be_typo_user cookie would otherwise produce.
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
    # (t3lib/class.t3lib_userauth.php:525-531).
    code=$(curl -sS -A "$UA" -b jar -c jar -e "$BASE/typo3/index.php" \
        -D login.headers -o login.html -w '%{http_code}' \
        -d login_status=login -d username=admin -d p_field= \
        -d "userident=$ident" -d "challenge=$challenge" -d interface=backend \
        "$BASE/typo3/index.php")
    location=$(tr -d '\r' < login.headers | sed -n 's/^[Ll]ocation: //p')

    if [ "$code" != 303 ] || [ "$location" != "$expected" ]; then
        echo "::error::login answered $code to '$location', expected 303 to '$expected'"
        head -c 2000 login.html
        exit 1
    fi
    echo "logged in; redirected to $location"
}
