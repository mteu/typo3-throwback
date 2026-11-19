<?php
// ext/xml, dom and SimpleXML on libxml2, as TYPO3 4.5.40 uses them.
// Argument 1: the root of an unpacked typo3_src-4.5.40 tree.

$failures = 0;
function check($label, $passed, $detail = '')
{
    global $failures;
    if (!$passed) {
        $failures++;
    }
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . ($detail === '' ? '' : "\n     " . $detail) . "\n";
}

$root = $argv[1];

// --- t3lib_div::xml2array() ------------------------------------------------
// xml2array() looks the document up in a cache in the database first, and
// parses it with xml2arrayProcess() when the cache has nothing. That parse is
// what runs here, without a database.
require_once $root . '/t3lib/class.t3lib_div.php';
$process = new ReflectionMethod('t3lib_div', 'xml2arrayProcess');
$process->setAccessible(true);
$xml2array = function ($xml) use ($process) {
    return $process->invoke(null, $xml);
};

function findLocallangFiles($dir)
{
    $found = array();
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $file) {
        if (preg_match('/^locallang.*\.xml$/', $file->getFilename())) {
            $found[] = $file->getPathname();
        }
    }
    sort($found);
    return $found;
}

$files = findLocallangFiles($root);
$unread = array();
$labels = 0;
foreach ($files as $file) {
    $content = file_get_contents($file);
    $result = $xml2array($content);
    // The default language's labels, found without libxml2: each distinct
    // index, since a repeated one overwrites the first, as in an array.
    preg_match('/<languageKey index="default" type="array">(.*?)<\/languageKey>/s', $content, $block);
    $inFile = 0;
    if ($block) {
        preg_match_all('/<label\b[^>]*\bindex="([^"]*)"/', $block[1], $indexes);
        $inFile = count(array_unique($indexes[1]));
    }
    $inArray = is_array($result) && isset($result['data']['default']) && is_array($result['data']['default'])
        ? count($result['data']['default']) : 0;
    if (!is_array($result) || $inArray !== $inFile) {
        $unread[] = substr($file, strlen($root) + 1) . ': ' . (is_array($result) ? "$inArray of $inFile labels" : $result);
    }
    $labels += $inArray;
}
check('xml2array() reads every default label of all ' . count($files) . " locallang files ($labels labels)",
    count($files) === 220 && $labels > 0 && count($unread) === 0, implode("\n     ", $unread));

$core = $xml2array(file_get_contents($root . '/typo3/sysext/lang/locallang_core.xml'));
check('locallang_core.xml: labels.goBack is "Go back"', $core['data']['default']['labels.goBack'] === 'Go back');

// 4.5.40's own default labels are all within latin1, so these are added in
// the same format: Cyrillic, Japanese and an em dash, which are two, three
// and three bytes in UTF-8.
$russian = "\xD0\x9D\xD0\xB0\xD0\xB7\xD0\xB0\xD0\xB4";
$japanese = "\xE6\x88\xBB\xE3\x82\x8B";
$dash = "\xE2\x80\x94";
$document = '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<T3locallang>
	<meta type="array"><type>module</type></meta>
	<data type="array">
		<languageKey index="ru" type="array"><label index="labels.goBack">' . $russian . '</label></languageKey>
		<languageKey index="ja" type="array"><label index="labels.goBack">' . $japanese . '</label></languageKey>
		<languageKey index="default" type="array"><label index="labels.dash">a ' . $dash . ' b</label></languageKey>
	</data>
</T3locallang>';
$labels = $xml2array($document);
check('xml2array(): labels outside latin1 come back as the same UTF-8 bytes',
    is_array($labels) && $labels['data']['ru']['labels.goBack'] === $russian
    && $labels['data']['ja']['labels.goBack'] === $japanese && $labels['data']['default']['labels.dash'] === "a $dash b",
    is_array($labels) ? bin2hex($labels['data']['ja']['labels.goBack']) : $labels);

$broken = $xml2array('<T3locallang><data></T3locallang>');
check('xml2array(): a mismatched tag is an error message, as TYPO3 reports it',
    is_string($broken) && strpos($broken, 'Line 1: Mismatched tag') === 0, (string) $broken);

// --- utf8_encode() and utf8_decode() ----------------------------------------
$bytes = '';
for ($i = 0; $i < 256; $i++) {
    $bytes .= chr($i);
}
$encoded = utf8_encode($bytes);
check('utf8_encode() maps all 256 ISO-8859-1 bytes to 384 bytes of UTF-8',
    strlen($encoded) === 384 && substr($encoded, 252 * 2 - 128, 2) === "\xC3\xBC", strlen($encoded) . ' bytes');
check('utf8_decode() round-trips all 256 bytes', utf8_decode($encoded) === $bytes);

// --- dom ---------------------------------------------------------------------
$dom = new DOMDocument('1.0', 'utf-8');
check('DOMDocument loads 4.5.40\'s locallang_core.xml', $dom->load($root . '/typo3/sysext/lang/locallang_core.xml'));
$xpath = new DOMXPath($dom);
$goBack = $xpath->query('//languageKey[@index="default"]/label[@index="labels.goBack"]');
check('DOMXPath finds labels.goBack', $goBack->length === 1 && $goBack->item(0)->textContent === 'Go back');

$built = new DOMDocument('1.0', 'utf-8');
$element = $built->createElement('label');
$element->appendChild($built->createTextNode($japanese . ' & <' . $russian . '>'));
$element->setAttribute('index', 'x');
$built->appendChild($element);
$saved = $built->saveXML();
$reloaded = new DOMDocument();
$reloaded->loadXML($saved);
check('DOMDocument saves escaped UTF-8 and loads it back',
    strpos($saved, '&amp; &lt;') !== false && $reloaded->documentElement->textContent === $japanese . ' & <' . $russian . '>',
    $saved);

// --- SimpleXML ---------------------------------------------------------------
$simple = simplexml_load_string($document);
$ru = $simple->xpath('//languageKey[@index="ru"]/label');
check('simplexml_load_string() and xpath()', $simple instanceof SimpleXMLElement && (string) $ru[0] === $russian);
$imported = dom_import_simplexml($simple);
check('dom_import_simplexml()', $imported instanceof DOMElement && $imported->tagName === 'T3locallang');

echo $failures === 0 ? "XML OK\n" : "XML FAIL: $failures\n";
exit($failures === 0 ? 0 : 1);
