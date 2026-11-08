# Sourced by the typo3-6-2 job in .github/workflows/images.yml, which
# logs in once over each scheme TYPO3 believes it is on. Not used by the image.
# Expects BASE and UA in the environment.

# login_and_expect <absolute URL the 303 must point at>
#
# Leaves the session in ./jar.
#
# Not 4.5's md5 challenge. A fresh 6.2 logs in with rsaauth and saltedpasswords:
# the installer writes [BE][loginSecurityLevel] = 'rsa' from
# FactoryConfiguration.php, and hashes the admin password with phpass
# (DatabaseData.php, getHashedPassword()). So this does what the login form's
# JavaScript does (rsaauth/resources/BackendLoginFormRsaEncryption.js):
#
#   1. open the form, which starts the session
#   2. ask ajax.php for a public key. rsaauth keeps the private half in the PHP
#      session (Classes/Storage/SessionStorage.php), so this has to ride the
#      same cookies as the login that follows
#   3. post the password encrypted with it, as rsa:<base64>, and commandLI=Submit,
#      the field the script adds to stand in for the button
#
# interface=backend makes the answer a redirect to backend.php
# (LoginController.php:388-392), sent by HttpUtility::redirect() as a 303.
login_and_expect() {
    expected="$1"

    rm -f jar
    curl -fsS -A "$UA" -c jar "$BASE/typo3/index.php" -o login-form.html
    if ! grep -q 'id="typo3-login-form"' login-form.html; then
        echo "::error::the login form is not rsaauth's (no typo3-login-form)"
        head -c 2000 login-form.html
        exit 1
    fi

    curl -fsS -A "$UA" -b jar -c jar \
        "$BASE/typo3/ajax.php?ajaxID=BackendLogin%3A%3AgetRsaPublicKey&skipSessionUpdate=1" -o rsa-key.json
    modulus=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["publicKeyModulus"])' rsa-key.json)
    exponent=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["exponent"])' rsa-key.json)
    userident=$(python3 -I 6.2/ci-rsa.py "$modulus" "$exponent" password)

    # The Referer is checked against the host on submitted logins
    # (AbstractUserAuthentication.php:668).
    code=$(curl -sS -A "$UA" -b jar -c jar -e "$BASE/typo3/index.php" \
        -D login.headers -o login.html -w '%{http_code}' \
        -d login_status=login -d username=admin -d p_field= \
        --data-urlencode "userident=$userident" -d interface=backend -d commandLI=Submit \
        "$BASE/typo3/index.php")
    location=$(tr -d '\r' < login.headers | sed -n 's/^[Ll]ocation: //p')

    if [ "$code" != 303 ] || [ "$location" != "$expected" ]; then
        echo "::error::login answered $code to '$location', expected 303 to '$expected'"
        head -c 2000 login.html
        exit 1
    fi
    echo "logged in over rsaauth; redirected to $location"
}
