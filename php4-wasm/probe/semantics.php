<?php
// PHP 4 syntax on purpose: this runs on the WebAssembly build of PHP 4.4.9.

class Box
{
    var $v = 1;

    function Box()
    {
        $this->v = 2;
    }
}

$failures = 0;

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

$a = new Box();
$b = $a;
$b->v = 3;
expect('PHP 4 style constructor runs', $a->v === 2);
expect('objects are copied on assignment (PHP 4 semantics)', $a->v === 2 && $b->v === 3);

expect('ereg() with captures', ereg('^([a-z]+)-([0-9]+)$', 'typo-33', $m) && $m[2] === '33');
expect('split()', count(split(',', 'a,b,c')) === 3);

$arr = array('x' => 1, 'y' => 2);
$sum = 0;
reset($arr);
while (list($k, $v) = each($arr)) {
    $sum += $v;
}
expect('each() iteration', $sum === 3);

expect('md5()', md5('typo3') === 'dc117c9322deb502c3b16769a8a64e08');
expect('sprintf() with floats', sprintf('%.2f', 3.14159) === '3.14');
expect('date() in UTC', gmdate('Y-m-d H:i', 1023105600) === '2002-06-03 12:00');

$ids = array();
for ($i = 0; $i < 10000; $i++) {
    $ids[uniqid('')] = 1;
}
expect('uniqid() is distinct across 10000 calls (wasm_clock.c)', count($ids) === 10000);

$file = tempnam('/tmp', 'p4');
$fp = fopen($file, 'w');
fwrite($fp, 'hi');
fclose($fp);
expect('file write and read', implode('', file($file)) === 'hi');
unlink($file);

$round = unserialize(serialize(array(1, 'box' => new Box())));
expect('serialize() round trip of an object', $round['box']->v === 2);

exit($failures === 0 ? 0 : 1);
