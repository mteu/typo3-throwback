<?php
// PHP 4 syntax on purpose: this runs on the WebAssembly build of PHP 4.4.9.
// GD 2.0.28 as bundled in PHP 4, linked against Emscripten's ports of zlib,
// libpng, libjpeg and FreeType: what GIFBUILDER needs, and what it writes.
//
// Usage: php gd.php <a TrueType font, such as TYPO3's t3lib/fonts/verdana.ttf>

$failures = 0;

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

function captured($function, $image)
{
    ob_start();
    $function($image);
    return ob_get_clean();
}

$font = $argv[1];
$info = gd_info();
expect('GD is the bundled 2.0.28, with FreeType, GIF read and write, PNG and JPEG',
    $info['GD Version'] === 'bundled (2.0.28 compatible)' && $info['FreeType Support']
    && $info['GIF Read Support'] && $info['GIF Create Support'] && $info['PNG Support'] && $info['JPG Support']);

$im = imagecreate(200, 40);
$background = imagecolorallocate($im, 0x7b, 0x8c, 0xa5);
$white = imagecolorallocate($im, 255, 255, 255);
$box = imagettftext($im, 14, 0, 5, 28, $white, $font, 'TYPO3 3.3.0');
expect('imagettftext() measures the text', $box[2] - $box[0] > 80 && $box[1] - $box[5] > 8);

$gif = captured('imagegif', $im);
expect('imagegif() writes a GIF', substr($gif, 0, 4) === 'GIF8');
$read = imagecreatefromstring($gif);
$drawn = 0;
for ($x = 0; $x < 200; $x++) {
    for ($y = 0; $y < 40; $y++) {
        if (imagecolorat($read, $x, $y) == $white) {
            $drawn++;
        }
    }
}
expect('the GIF reads back, with the text drawn in it (' . $drawn . ' pixels)', imagesx($read) === 200 && $drawn > 100);

$truecolor = imagecreatetruecolor(16, 16);
expect('imagepng() writes a PNG', substr(captured('imagepng', $truecolor), 0, 8) === "\x89PNG\r\n\x1a\n");
expect('imagejpeg() writes a JPEG', substr(captured('imagejpeg', $truecolor), 0, 2) === "\xff\xd8");

$text = str_repeat('Rendered by TypoScript on PHP 4.4.9. ', 50);
expect('gzcompress() and gzuncompress() round trip', gzuncompress(gzcompress($text)) === $text && strlen(gzcompress($text)) < 200);

exit($failures === 0 ? 0 : 1);
