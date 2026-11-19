<?php
// The paths of 4.5.40's core that a default site takes where the PHP 5.6.40
// build has no function to call: it has no openssl, mcrypt, iconv or mbstring.
// Argument 1: the root of an unpacked typo3_src-4.5.40 tree.

$failures = 0;

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

define('PATH_site', $argv[1] . '/');
define('PATH_t3lib', $argv[1] . '/t3lib/');
define('TYPO3_OS', '');
define('TYPO3_MODE', 'BE');
$GLOBALS['TYPO3_CONF_VARS']['SYS']['encryptionKey'] = 'b3e9d1a74c2f8e6051d7a9c3f2b8e4a6d0c5f1e9a7b3d8c2e6f4a0b9d5c1e7f3';
$GLOBALS['TYPO3_CONF_VARS']['SYS']['t3lib_cs_convMethod'] = '';
$GLOBALS['TYPO3_CONF_VARS']['SYS']['t3lib_cs_utils'] = '';
$GLOBALS['TYPO3_CONF_VARS']['SYS']['curlUse'] = false;

include_once(PATH_t3lib . 'class.t3lib_div.php');
include_once(PATH_t3lib . 'class.t3lib_cs.php');

expect('the build has none of the functions the core can prefer',
    !function_exists('openssl_random_pseudo_bytes') && !function_exists('mcrypt_create_iv')
    && !function_exists('iconv') && !function_exists('mb_substr') && !function_exists('curl_init'));

// t3lib_div::generateRandomBytes() takes openssl, then mcrypt, then its own
// generator, which is what session ids and salts come from here.
$first = t3lib_div::generateRandomBytes(16);
$second = t3lib_div::generateRandomBytes(16);
$long = t3lib_div::generateRandomBytes(5000);
expect('generateRandomBytes() returns the bytes asked for, different each time',
    strlen($first) === 16 && strlen($second) === 16 && $first !== $second && strlen($long) === 5000);
expect('getRandomHexString() returns hex of the length asked for',
    preg_match('/^[0-9a-f]{32}$/', t3lib_div::getRandomHexString(32)) === 1);

// With [SYS][t3lib_cs_convMethod] empty, the conversions run on TYPO3's own PHP
// code and its tables in t3lib/csconvtbl.
$cs = new t3lib_cs();
$german = "Gr\xc3\xbc\xc3\x9fe";
expect('t3lib_cs::conv(): utf-8 to iso-8859-1 and back',
    $cs->conv($german, 'utf-8', 'iso-8859-1') === "Gr\xfc\xdfe"
    && $cs->conv("Gr\xfc\xdfe", 'iso-8859-1', 'utf-8') === $german);
expect('t3lib_cs::conv(): a character the target lacks becomes an entity',
    $cs->conv("a\xe6\x97\xa5b", 'utf-8', 'iso-8859-1', 1) === 'a&#x65e5;b');
expect('t3lib_cs::conv(): windows-1252 to utf-8',
    $cs->conv("\x80", 'windows-1252', 'utf-8') === "\xe2\x82\xac");
expect('t3lib_cs: utf8_strlen(), utf8_substr(), conv_case()',
    $cs->utf8_strlen("\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e") === 3
    && $cs->substr('utf-8', "\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e", 1, 1) === "\xe6\x9c\xac"
    && $cs->conv_case('utf-8', "\xc3\xa4\xc3\xb6", 'toUpper') === "\xc3\x84\xc3\x96");

echo $failures === 0 ? "CORE FUNCTIONS OK\n" : "core functions: $failures failed\n";
exit($failures === 0 ? 0 : 1);
