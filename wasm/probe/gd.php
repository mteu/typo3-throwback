<?php
// PHP 4 syntax on purpose: this runs on the WebAssembly builds of PHP 4.4.9
// and PHP 5.6.40. The GD each bundles, 2.0.28 and 2.1, linked against
// Emscripten's ports of zlib, libpng, libjpeg and FreeType: what GIFBUILDER
// needs, and what it writes.
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

// The pixels in an image that have the given colour.
function count_colour($image, $colour)
{
    $count = 0;
    for ($x = 0; $x < imagesx($image); $x++) {
        for ($y = 0; $y < imagesy($image); $y++) {
            if (imagecolorat($image, $x, $y) == $colour) {
                $count++;
            }
        }
    }
    return $count;
}

$font = $argv[1];
$info = gd_info();
// GD 2.1 calls its JPEG entry "JPEG Support", GD 2.0.28 "JPG Support".
$jpeg = isset($info['JPEG Support']) ? $info['JPEG Support'] : $info['JPG Support'];
$bundled = $info['GD Version'] === 'bundled (2.0.28 compatible)' || $info['GD Version'] === 'bundled (2.1.0 compatible)';
expect('GD is the bundled one (' . $info['GD Version'] . '), with FreeType, GIF read and write, PNG and JPEG',
    $bundled && $info['FreeType Support']
    && $info['GIF Read Support'] && $info['GIF Create Support'] && $info['PNG Support'] && $jpeg);
expect('imagetypes() has GIF, JPEG and PNG',
    (imagetypes() & (IMG_GIF | IMG_JPG | IMG_PNG)) === (IMG_GIF | IMG_JPG | IMG_PNG));

$im = imagecreate(200, 40);
$background = imagecolorallocate($im, 0x7b, 0x8c, 0xa5);
$white = imagecolorallocate($im, 255, 255, 255);
$box = imagettftext($im, 14, 0, 5, 28, $white, $font, 'TYPO3 in the browser');
expect('imagettftext() measures the text', $box[2] - $box[0] > 80 && $box[1] - $box[5] > 8);

$gif = captured('imagegif', $im);
expect('imagegif() writes a GIF', substr($gif, 0, 4) === 'GIF8');
$read = imagecreatefromstring($gif);
$drawn = count_colour($read, $white);
expect('the GIF reads back, with the text drawn in it (' . $drawn . ' pixels)', imagesx($read) === 200 && $drawn > 100);

// GIFBUILDER draws on true colour images, and writes PNG and JPEG too.
$truecolor = imagecreatetruecolor(64, 24);
$red = imagecolorallocate($truecolor, 255, 0, 0);
imagefilledrectangle($truecolor, 0, 0, 31, 23, $red);
$png = captured('imagepng', $truecolor);
expect('imagepng() writes a PNG', substr($png, 0, 8) === "\x89PNG\r\n\x1a\n");
$fromPng = imagecreatefromstring($png);
expect('the PNG reads back with its pixels', imagesx($fromPng) === 64 && imagecolorat($fromPng, 5, 5) === 0xff0000
    && imagecolorat($fromPng, 50, 5) === 0);
$jpg = captured('imagejpeg', $truecolor);
expect('imagejpeg() writes a JPEG', substr($jpg, 0, 2) === "\xff\xd8");
// Reading runs libjpeg's message handler on every marker.
$fromJpeg = imagecreatefromstring($jpg);
$rgb = imagecolorat($fromJpeg, 5, 5);
expect('the JPEG reads back, red where it was red', imagesx($fromJpeg) === 64 && (($rgb >> 16) & 0xff) > 200
    && (($rgb >> 8) & 0xff) < 60);

$white = imagecolorallocate($truecolor, 255, 255, 255);
imagettftext($truecolor, 10, 0, 34, 16, $white, $font, 'T3');
expect('imagettftext() draws on a true colour image', count_colour($truecolor, $white) > 5);

$text = str_repeat('Rendered by TypoScript. ', 50);
expect('gzcompress() and gzuncompress() round trip', gzuncompress(gzcompress($text)) === $text && strlen(gzcompress($text)) < 200);

exit($failures === 0 ? 0 : 1);
