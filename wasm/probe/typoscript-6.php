<?php
// typoscript.php for a release whose core is namespaced: unmodified TYPO3
// core classes, loaded by their namespace instead of from t3lib/.
// Argument 1: the root of an unpacked typo3_src tree.
//
// A file of its own because typoscript.php must stay PHP 4.

// The constants 6.2's bootstrap defines before anything else
// (SystemEnvironmentBuilder.php:101-104). The parser splits lines on LF.
define('TAB', chr(9));
define('LF', chr(10));
define('CR', chr(13));
define('CRLF', CR . LF);

$core = $argv[1] . '/typo3/sysext/core/Classes/';
spl_autoload_register(function ($class) use ($core) {
    $prefix = 'TYPO3\\CMS\\Core\\';
    if (strpos($class, $prefix) === 0) {
        $file = $core . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require $file;
        }
    }
});

use TYPO3\CMS\Core\TypoScript\Parser\TypoScriptParser;
use TYPO3\CMS\Core\Utility\GeneralUtility;

$typoScript = '
page = PAGE
page.typeNum = 0
page.10 = TEXT
page.10.value = Hello from TYPO3 on PHP ' . phpversion() . ' in WebAssembly
page.10.wrap = <h1>|</h1>
page.bodyTag = <body bgcolor="green">
lib.copy < page.10
lib.copy.wrap = <p>|</p>
';

$parser = new TypoScriptParser();
$parser->parse($typoScript);

echo 'page.10.value      = ' . $parser->setup['page.']['10.']['value'] . "\n";
echo 'page.bodyTag       = ' . $parser->setup['page.']['bodyTag'] . "\n";
echo 'lib.copy           = ' . $parser->setup['lib.']['copy'] . ' / ' . $parser->setup['lib.']['copy.']['wrap'] . "\n";
echo 'trimExplode        = ' . implode('|', GeneralUtility::trimExplode(',', ' a , b ,c ')) . "\n";
echo 'shortMD5           = ' . GeneralUtility::shortMD5('typo3') . "\n";

$passed = $parser->setup['page.']['bodyTag'] === '<body bgcolor="green">'
    && $parser->setup['lib.']['copy'] === 'TEXT'
    && $parser->setup['lib.']['copy.']['wrap'] === '<p>|</p>'
    && GeneralUtility::shortMD5('typo3') === 'dc117c9322';

echo $passed ? "TYPOSCRIPT OK\n" : "TYPOSCRIPT FAIL\n";
exit($passed ? 0 : 1);
