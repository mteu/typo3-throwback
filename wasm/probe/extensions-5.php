<?php
// The bundled extensions the PHP 5.6.40 build compiles in, one check each, on
// the CLI. GD has its own probe, gd.php. ext/mysql and sessions need a
// request: probe/request-loop.cjs checks them.

$failures = 0;

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

$modules = get_loaded_extensions();
sort($modules, SORT_STRING | SORT_FLAG_CASE);
$expected = array('Core', 'ctype', 'date', 'dom', 'ereg', 'filter', 'gd', 'hash', 'json', 'libxml',
    'mysql', 'pcre', 'Reflection', 'session', 'SimpleXML', 'SPL', 'standard', 'tokenizer', 'xml', 'zlib');
expect('the modules are ' . implode(', ', $expected), $modules === $expected);

expect('ctype: ctype_digit(), ctype_alpha(), ctype_space()',
    ctype_digit('2015') && !ctype_digit('20a5') && ctype_alpha('TYPO') && ctype_space(" \t\n"));

expect('filter: FILTER_VALIDATE_INT with a range, FILTER_VALIDATE_EMAIL',
    filter_var('42', FILTER_VALIDATE_INT, array('options' => array('min_range' => 1, 'max_range' => 100))) === 42
    && filter_var('420', FILTER_VALIDATE_INT, array('options' => array('max_range' => 100))) === false
    && filter_var('admin@example.com', FILTER_VALIDATE_EMAIL) === 'admin@example.com'
    && filter_var('not an address', FILTER_VALIDATE_EMAIL) === false);

// RFC 4231, test case 2.
expect('hash: hash_hmac() sha256, hash() md5 and crc32b',
    hash_hmac('sha256', 'what do ya want for nothing?', 'Jefe')
        === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    && hash('md5', 'typo3') === md5('typo3')
    && hash('crc32b', 'The quick brown fox jumped over the lazy dog.') === '82a34642');

$data = array('title' => "Gr\xc3\xbc\xc3\x9fe \xe6\x97\xa5\xe6\x9c\xac", 'tid' => 1, 'ok' => true, 'list' => array(1, 2));
// The expected document as hex: ASCII only, each non-ASCII character as a
// backslash-u escape.
$json = json_encode($data);
expect('json: json_encode() escapes UTF-8, json_decode() gives it back',
    bin2hex($json) === '7b227469746c65223a2247725c75303066635c753030646665205c75363565355c7536373263222c22746964223a312c226f6b223a747275652c226c697374223a5b312c325d7d'
    && json_decode($json, true) === $data);
expect('json: a bad document decodes to null with JSON_ERROR_SYNTAX',
    json_decode('{"a":') === null && json_last_error() === JSON_ERROR_SYNTAX);

$tokens = token_get_all('<?php echo 1;');
expect('tokenizer: token_get_all()', is_array($tokens[0]) && $tokens[0][0] === T_OPEN_TAG
    && is_array($tokens[1]) && token_name($tokens[1][0]) === 'T_ECHO');

$text = str_repeat("TYPO3 4.5.40 in the browser. ", 200);
expect('zlib: gzcompress() and gzuncompress() round-trip, smaller', gzuncompress(gzcompress($text)) === $text
    && strlen(gzcompress($text)) < strlen($text) / 10);
expect('zlib: gzencode() and gzdecode() round-trip, with the gzip magic',
    gzdecode(gzencode($text)) === $text && substr(gzencode($text), 0, 2) === "\x1f\x8b");
expect('zlib: gzdeflate() and gzinflate() round-trip', gzinflate(gzdeflate($text, 9)) === $text);
$file = tempnam(sys_get_temp_dir(), 'gz');
file_put_contents('compress.zlib://' . $file, $text);
expect('zlib: the compress.zlib:// stream wrapper', file_get_contents('compress.zlib://' . $file) === $text
    && substr(file_get_contents($file), 0, 2) === "\x1f\x8b");
unlink($file);

echo $failures === 0 ? "EXTENSIONS OK\n" : "extensions: $failures failed\n";
exit($failures === 0 ? 0 : 1);
