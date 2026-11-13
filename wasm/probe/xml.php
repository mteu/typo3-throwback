<?php
// ext/xml with the bundled expat, as TYPO3 3.8.1 uses it. Argument 1: the
// root of an unpacked typo3_src-3.8.1 tree. Run with error_reporting 2039,
// E_ALL without notices, as TYPO3 runs.

$failures = 0;
function check($label, $passed, $detail = '')
{
    global $failures;
    if (!$passed) {
        $failures++;
    }
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . ($detail === '' ? '' : "\n     " . $detail) . "\n";
}

// --- the parser, with handlers --------------------------------------------
$events = array();
function xmlStart($parser, $name, $attributes)
{
    global $events;
    ksort($attributes);
    $pairs = array();
    foreach ($attributes as $key => $value) {
        $pairs[] = $key . '=' . $value;
    }
    $events[] = 'start ' . $name . (count($pairs) ? ' ' . implode(' ', $pairs) : '');
}
function xmlEnd($parser, $name)
{
    global $events;
    $events[] = 'end ' . $name;
}
function xmlText($parser, $text)
{
    global $events;
    $last = count($events) - 1;
    // expat may hand one run of text over in several calls.
    if ($last >= 0 && substr($events[$last], 0, 5) === 'text ') {
        $events[$last] .= $text;
    } else {
        $events[] = 'text ' . $text;
    }
}

$parser = xml_parser_create();
xml_parser_set_option($parser, XML_OPTION_CASE_FOLDING, 0);
xml_set_element_handler($parser, 'xmlStart', 'xmlEnd');
xml_set_character_data_handler($parser, 'xmlText');
$parsed = xml_parse($parser, '<root a="1"><item id="x" b="2">one &amp; two</item><empty/></root>', true);
$error = xml_error_string(xml_get_error_code($parser));
xml_parser_free($parser);
$expected = array('start root a=1', 'start item b=2 id=x', 'text one & two', 'end item', 'start empty', 'end empty', 'end root');
check('xml_parse() calls the element and character handlers in document order', $parsed && $events === $expected, $parsed ? implode(' | ', $events) : $error);

$parser = xml_parser_create();
$parsed = xml_parse($parser, '<root><open></root>', true);
$code = xml_get_error_code($parser);
$line = xml_get_current_line_number($parser);
xml_parser_free($parser);
check('xml_parse() reports a mismatched tag', !$parsed && $code === XML_ERROR_TAG_MISMATCH && $line === 1, xml_error_string($code) . ' on line ' . $line);

// t3lib_div::xml2array() skips its charset handling on PHP 4, because "PHP4
// just passed the content through": locallang files are UTF-8, and TYPO3
// converts their labels itself. U+00FC, ü, is two bytes in UTF-8.
$parser = xml_parser_create();
xml_parse_into_struct($parser, '<?xml version="1.0" encoding="utf-8"?><l>' . "\xC3\xBC" . '</l>', $values, $index);
xml_parser_free($parser);
check('xml_parse_into_struct() passes UTF-8 text through unchanged', $values[0]['value'] === "\xC3\xBC", bin2hex($values[0]['value']));

// --- utf8_encode() and utf8_decode() --------------------------------------
$bytes = '';
for ($i = 0; $i < 256; $i++) {
    $bytes .= chr($i);
}
$encoded = utf8_encode($bytes);
check('utf8_encode() maps all 256 ISO-8859-1 bytes to 384 bytes of UTF-8', strlen($encoded) === 128 + 2 * 128 && substr($encoded, 252 * 2 - 128, 2) === "\xC3\xBC", strlen($encoded) . ' bytes');
check('utf8_decode() round-trips all 256 bytes', utf8_decode($encoded) === $bytes);

// --- t3lib_div::xml2array() on every locallang file in 3.8.1 --------------
define('PATH_t3lib', $argv[1] . '/t3lib/');
include_once(PATH_t3lib . 'class.t3lib_div.php');

function findLocallangFiles($dir)
{
    $found = array();
    $handle = opendir($dir);
    while (($entry = readdir($handle)) !== false) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        if (is_dir($dir . '/' . $entry)) {
            $found = array_merge($found, findLocallangFiles($dir . '/' . $entry));
        } elseif (preg_match('/^locallang.*\.xml$/', $entry)) {
            $found[] = $dir . '/' . $entry;
        }
    }
    closedir($handle);
    sort($found);
    return $found;
}

$files = findLocallangFiles($argv[1]);
$unread = array();
$labels = 0;
foreach ($files as $file) {
    $content = implode('', file($file));
    $result = t3lib_div::xml2array($content);
    // The default language's labels, found without expat: each distinct
    // index, since a repeated one overwrites the first, as in an array.
    preg_match('/<languageKey index="default" type="array">(.*?)<\/languageKey>/s', $content, $block);
    preg_match_all('/<label index="([^"]*)"/', $block[1], $indexes);
    $inFile = count(array_unique($indexes[1]));
    $inArray = is_array($result) && is_array($result['data']['default']) ? count($result['data']['default']) : 0;
    if (!is_array($result) || $inFile === 0 || $inArray !== $inFile) {
        $unread[] = substr($file, strlen($argv[1]) + 1) . ': ' . (is_array($result) ? "$inArray of $inFile labels" : $result);
    }
    $labels += $inArray;
}
check('xml2array() reads every default label of all ' . count($files) . " locallang files ($labels labels)", count($files) === 93 && count($unread) === 0, implode("\n     ", $unread));

$core = t3lib_div::xml2array(implode('', file($argv[1] . '/typo3/sysext/lang/locallang_core.xml')));
check('locallang_core.xml: labels.goBack is "Go back"', $core['data']['default']['labels.goBack'] === 'Go back');
check('locallang_core.xml: meta.keep_original_text is the integer 1', $core['meta']['keep_original_text'] === 1);

echo $failures === 0 ? "XML OK\n" : "XML FAIL: $failures\n";
exit($failures === 0 ? 0 : 1);
