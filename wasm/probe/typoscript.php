<?php
// Runs unmodified TYPO3 3.x core classes. Argument 1: the root of an unpacked
// typo3_src-3.3.0 or typo3_src-3.8.1 tree. Both keep t3lib/ at the top.

define('PATH_t3lib', $argv[1] . '/t3lib/');
include_once(PATH_t3lib . 'class.t3lib_div.php');
include_once(PATH_t3lib . 'class.t3lib_tsparser.php');

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

$parser = new t3lib_TSparser();
$parser->parse($typoScript);

echo 'page.10.value      = ' . $parser->setup['page.']['10.']['value'] . "\n";
echo 'page.bodyTag       = ' . $parser->setup['page.']['bodyTag'] . "\n";
echo 'lib.copy           = ' . $parser->setup['lib.']['copy'] . ' / ' . $parser->setup['lib.']['copy.']['wrap'] . "\n";
echo 'trimExplode        = ' . implode('|', t3lib_div::trimExplode(',', ' a , b ,c ')) . "\n";
echo 'shortMD5           = ' . t3lib_div::shortMD5('typo3') . "\n";

$passed = $parser->setup['page.']['bodyTag'] === '<body bgcolor="green">'
    && $parser->setup['lib.']['copy'] === 'TEXT'
    && $parser->setup['lib.']['copy.']['wrap'] === '<p>|</p>'
    && t3lib_div::shortMD5('typo3') === 'dc117c9322';

echo $passed ? "TYPOSCRIPT OK\n" : "TYPOSCRIPT FAIL\n";
exit($passed ? 0 : 1);
