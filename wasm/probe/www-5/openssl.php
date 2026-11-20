<?php
// ext/openssl on OpenSSL 1.0.2u, as TYPO3 6.2.31 uses it. Two modes:
//
//   ?mode=key      what rsaauth's PhpBackend does for a login form, step by
//                  step: isAvailable() generates a key, createNewKeyPair()
//                  another, exports it, and reads the modulus and exponent
//                  back out of a CSR's text. One line per check, then
//                  "KEY " and the key pair as JSON for the next request.
//   ?mode=decrypt  PhpBackend::decrypt(): a POST of privateKey and data
//                  (base64), as the login form sends it, decrypted with
//                  PHP's default padding. Prints the plaintext.
//
// Plus what 6.2 takes besides keys: openssl_random_pseudo_bytes() for its
// random bytes (GeneralUtility.php:1245), and the Install Tool's check
// (Check.php:576).

$failures = 0;

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

// The two regular expressions of PhpBackend.php:113-131, as they are.
function extractExponent($data)
{
    $index = strpos($data, 'Exponent: ');
    return (int)substr($data, $index + 10);
}

function extractPublicKeyModulus($data)
{
    $fragment = preg_replace('/.*Modulus.*?\\n(.*)Exponent:.*/ms', '\\1', $data);
    $fragment = preg_replace('/[\\s\\n\\r:]/', '', $fragment);
    return trim(strtoupper(substr($fragment, 2)));
}

if ($_GET['mode'] === 'decrypt') {
    $result = '';
    if (!@openssl_private_decrypt(base64_decode($_POST['data']), $result, $_POST['privateKey'])) {
        echo "DECRYPT FAIL\n";
        exit;
    }
    echo $result;
    exit;
}

expect('ext/openssl is loaded, on OpenSSL 1.0.2u', extension_loaded('openssl')
    && OPENSSL_VERSION_TEXT === 'OpenSSL 1.0.2u  20 Dec 2019');
expect('OPENSSL_CONF names the openssl.cnf beside php.ini', getenv('OPENSSL_CONF') === dirname(php_ini_loaded_file()) . '/openssl.cnf'
    && is_file(getenv('OPENSSL_CONF')));

// Check.php:576, the Install Tool's check, and PhpBackend::isAvailable().
$started = microtime(true);
$testKey = @openssl_pkey_new();
$availableMs = (microtime(true) - $started) * 1000;
expect('openssl_pkey_new() with no arguments gives a key, as the Install Tool and isAvailable() ask', is_resource($testKey));
openssl_free_key($testKey);

// PhpBackend::createNewKeyPair().
$started = microtime(true);
$privateKey = @openssl_pkey_new();
$keyMs = (microtime(true) - $started) * 1000;
$privateKeyStr = '';
expect('openssl_pkey_export()', openssl_pkey_export($privateKey, $privateKeyStr) === true
    && strpos($privateKeyStr, '-----BEGIN PRIVATE KEY-----') === 0);
$details = openssl_pkey_get_details($privateKey);
expect('the key has the 2048 bits openssl.cnf names, as in Docker, and the exponent 65537',
    $details['bits'] === 2048 && $details['type'] === OPENSSL_KEYTYPE_RSA && bin2hex($details['rsa']['e']) === '010001');
$exportedData = '';
$csr = openssl_csr_new(array(
    'localityName' => 'foo',
    'organizationName' => 'bar',
), $privateKey);
expect('openssl_csr_new() and openssl_csr_export() as text', is_resource($csr)
    && openssl_csr_export($csr, $exportedData, false) === true && strpos($exportedData, 'Modulus') !== false);
$publicKey = extractPublicKeyModulus($exportedData);
$exponent = extractExponent($exportedData);
expect('rsaauth reads the modulus and exponent out of the CSR text',
    $publicKey === strtoupper(bin2hex($details['rsa']['n'])) && strlen($publicKey) === 512 && $exponent === 65537);
openssl_free_key($privateKey);

$first = openssl_random_pseudo_bytes(32, $strong);
$second = openssl_random_pseudo_bytes(32);
expect('openssl_random_pseudo_bytes() gives strong bytes, different each call',
    strlen($first) === 32 && $strong === true && $first !== $second);
expect('the CSPRNG is seeded from /dev/urandom, which Emscripten fills from crypto.getRandomValues()',
    strlen(file_get_contents('/dev/urandom', false, null, 0, 16)) === 16);

echo $failures ? "OPENSSL FAIL\n" : "OPENSSL OK\n";
echo 'KEY ' . json_encode(array(
    'modulus' => $publicKey,
    'exponent' => $exponent,
    'privateKey' => $privateKeyStr,
    'availableMs' => round($availableMs),
    'keyMs' => round($keyMs),
)) . "\n";
