<?php
// The bundled extensions the PHP 5.6.40 build compiles in, one check each, on
// the CLI. GD has its own probe, gd.php. ext/mysql, mysqli, openssl and
// sessions need a request: probe/request-loop.cjs checks them.

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
$expected = array('Core', 'ctype', 'date', 'dom', 'ereg', 'fileinfo', 'filter', 'gd', 'hash', 'json', 'libxml',
    'mysql', 'mysqli', 'openssl', 'pcre', 'Reflection', 'session', 'SimpleXML', 'soap', 'SPL', 'standard', 'tokenizer',
    'xml', 'xmlreader', 'zip', 'zlib');
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

// The MIME types 6.2's file abstraction layer stores for an upload
// (LocalDriver::getMimeTypeOfFile()), from the libmagic bundled in PHP, as
// in Docker's image.
$directory = sys_get_temp_dir() . '/fileinfo-' . getmypid();
mkdir($directory);
$image = imagecreatetruecolor(4, 4);
imagepng($image, "$directory/image.png");
imagejpeg($image, "$directory/image.jpg");
imagegif($image, "$directory/image.gif");
imagedestroy($image);
file_put_contents("$directory/script.php", "<?php\necho 'TYPO3';\n");
$fileInfo = new finfo();
$types = array();
foreach (array('image.png', 'image.jpg', 'image.gif', 'script.php') as $name) {
    $types[$name] = $fileInfo->file("$directory/$name", FILEINFO_MIME_TYPE);
}
expect('fileinfo: finfo names a PNG, a JPEG, a GIF and a PHP file', $types === array(
    'image.png' => 'image/png',
    'image.jpg' => 'image/jpeg',
    'image.gif' => 'image/gif',
    'script.php' => 'text/x-php',
));
expect('fileinfo: mime_content_type() and finfo_buffer() agree',
    mime_content_type("$directory/image.png") === 'image/png'
    && finfo_buffer(finfo_open(FILEINFO_MIME_TYPE), file_get_contents("$directory/image.gif")) === 'image/gif');

// The Extension Manager packs an extension with ZipArchive
// (FileHandlingUtility::createZipFileFromExtension()) and unpacks an upload
// with zip_open() and zip_read() (FileHandlingUtility::unzipExtensionFromFile()).
$zipFile = "$directory/extension.zip";
$zip = new ZipArchive();
$opened = $zip->open($zipFile, ZipArchive::CREATE);
$zip->addFromString('ext_emconf.php', "<?php\n\$EM_CONF[\$_EXTKEY] = array('title' => 'Probe');\n");
$zip->addFromString('Resources/Public/text.txt', $text);
$closed = $zip->close();
$entries = array();
$archive = zip_open($zipFile);
if (is_resource($archive)) {
    while (($entry = zip_read($archive)) !== false) {
        $entries[zip_entry_name($entry)] = zip_entry_read($entry, zip_entry_filesize($entry));
    }
    zip_close($archive);
}
expect('zip: ZipArchive writes an archive, zip_read() reads it back, deflated',
    $opened === true && $closed === true
    && array_keys($entries) === array('ext_emconf.php', 'Resources/Public/text.txt')
    && $entries['Resources/Public/text.txt'] === $text
    && filesize($zipFile) < strlen($text) / 10);
expect('fileinfo: finfo names the zip', $fileInfo->file($zipFile, FILEINFO_MIME_TYPE) === 'application/zip');
foreach (array('image.png', 'image.jpg', 'image.gif', 'script.php', 'extension.zip') as $name) {
    unlink("$directory/$name");
}
rmdir($directory);

// Only the Install Tool's check asks for soap: it looks for the extension and
// nothing in 6.2's core makes a client. A client in non-WSDL mode needs no
// network until it sends; this one answers its own request, so the envelope
// is encoded and the answer decoded with no socket.
class LoopbackSoapClient extends SoapClient
{
    public $sent = '';

    public function __doRequest($request, $location, $action, $version, $oneWay = 0)
    {
        $this->sent = $request;
        return '<?xml version="1.0" encoding="UTF-8"?>'
            . '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:typo3">'
            . '<SOAP-ENV:Body><ns1:pingResponse><return>pong ' . "Gr\xc3\xbc\xc3\x9fe" . '</return></ns1:pingResponse>'
            . '</SOAP-ENV:Body></SOAP-ENV:Envelope>';
    }
}
$client = new LoopbackSoapClient(null, array('location' => 'http://localhost/soap', 'uri' => 'urn:typo3'));
$answer = $client->__soapCall('ping', array('TYPO3'));
expect('soap: a SoapClient in non-WSDL mode encodes a call and decodes the answer',
    strpos($client->sent, '<ns1:ping>') !== false && strpos($client->sent, '>TYPO3</') !== false
    && $answer === "pong Gr\xc3\xbc\xc3\x9fe" && class_exists('SoapServer'));

// The Extension Manager reads the repository's extension list with
// XMLReader (ExtensionXmlPullParser).
$reader = new XMLReader();
$reader->XML('<?xml version="1.0" encoding="utf-8"?><extensions><extension extensionkey="news">'
    . '<version version="3.2.8"><title>Gr' . "\xc3\xbc\xc3\x9f" . 'e</title></version></extension></extensions>');
$seen = array();
while ($reader->read()) {
    if ($reader->nodeType === XMLReader::ELEMENT && $reader->name === 'extension') {
        $seen[] = $reader->getAttribute('extensionkey');
    }
    if ($reader->nodeType === XMLReader::TEXT) {
        $seen[] = $reader->value;
    }
}
$reader->close();
expect('xmlreader: XMLReader reads elements, attributes and UTF-8 text',
    $seen === array('news', "Gr\xc3\xbc\xc3\x9fe"));

echo $failures === 0 ? "EXTENSIONS OK\n" : "extensions: $failures failed\n";
exit($failures === 0 ? 0 : 1);
