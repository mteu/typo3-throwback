<?php
// What PHP 5 does that PHP 4 does not, and that TYPO3 4.5.40 relies on. Runs
// on the WebAssembly build of PHP 5.6.40, beside semantics.php on PHP 4.4.9.

$failures = 0;

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

interface Labelled
{
    public function label();
}

class Box implements Labelled
{
    public $v = 1;
    public static $made = 0;

    public function __construct($v)
    {
        $this->v = $v;
        self::$made++;
    }

    public function label()
    {
        return 'box ' . $this->v;
    }

    public static function make($v)
    {
        return new static($v);
    }

    public function __clone()
    {
        $this->v = 'clone of ' . $this->v;
    }
}

class SmallBox extends Box
{
}

class BoxRefused extends RuntimeException
{
}

$a = new Box(2);
$b = $a;
$b->v = 3;
expect('__construct runs', Box::$made === 1);
expect('objects are passed by handle', $a->v === 3);
$c = clone $a;
expect('clone runs __clone and copies', $c->v === 'clone of 3' && $a->v === 3);

expect('interfaces and instanceof', $a instanceof Labelled && $a->label() === 'box 3');
expect('late static binding: new static', get_class(SmallBox::make(4)) === 'SmallBox');
expect('static properties are shared', Box::$made === 2);

try {
    throw new BoxRefused('no room', 7);
} catch (RuntimeException $e) {
    $caught = $e;
}
expect('exceptions caught by parent class', isset($caught) && $caught instanceof BoxRefused
    && $caught->getMessage() === 'no room' && $caught->getCode() === 7);

$base = 10;
$add = function ($x) use ($base) {
    return $x + $base;
};
expect('closures with use()', $add(5) === 15 && array_map($add, array(1, 2)) === array(11, 12));

$loaded = array();
spl_autoload_register(function ($class) use (&$loaded) {
    $loaded[] = $class;
    if ($class === 'AutoloadedBox') {
        eval('class AutoloadedBox {}');
    }
});
expect('spl_autoload_register()', class_exists('AutoloadedBox') && $loaded === array('AutoloadedBox'));

expect('PHP_INT_SIZE is 4, as on the 32-bit wasm target', PHP_INT_SIZE === 4 && PHP_INT_MAX === 2147483647);
expect('E_DEPRECATED is defined', defined('E_DEPRECATED') && E_DEPRECATED === 8192);

expect('md5()', md5('typo3') === 'dc117c9322deb502c3b16769a8a64e08');
expect('preg_match() with named groups', preg_match('/^(?<name>[a-z]+)-(?<n>\d+)$/', 'typo-45', $m) === 1
    && $m['n'] === '45');

// Every sort goes through zend_qsort(), whose compare the build passes
// through an adapter: WebAssembly traps on the cast native code allows.
$numbers = array(3, 1, 2);
sort($numbers);
rsort($numbers);
$keyed = array('b' => 2, 'c' => 3, 'a' => 1);
ksort($keyed);
$values = array('x' => 2, 'y' => 1);
asort($values);
$sorted = array(10, 9, 2, 1);
usort($sorted, function ($a, $b) { return $a - $b; });
$byKey = array(3 => 'c', 1 => 'a');
uksort($byKey, function ($a, $b) { return $a - $b; });
$natural = array('img12', 'img10', 'img2');
natsort($natural);
$columns = array(3, 1, 2);
$other = array('c', 'a', 'b');
array_multisort($columns, $other);
expect('sort(), rsort(), ksort(), asort(), usort(), uksort(), natsort(), array_multisort()',
    $numbers === array(3, 2, 1) && array_keys($keyed) === array('a', 'b', 'c')
    && array_keys($values) === array('y', 'x') && $sorted === array(1, 2, 9, 10)
    && array_keys($byKey) === array(1, 3) && array_values($natural) === array('img2', 'img10', 'img12')
    && $other === array('a', 'b', 'c'));
$heap = new SplMinHeap();
foreach (array(5, 3, 4) as $n) {
    $heap->insert($n);
}
expect('SplMinHeap', $heap->extract() === 3);

// A generator made from a closure with a static variable copies the
// variables with a helper the build makes return int, as it is called.
$countdown = function ($from) {
    static $calls = 0;
    $calls++;
    for ($i = $from; $i > 0; $i--) {
        yield $i;
    }
};
expect('a generator from a closure with a static variable', iterator_to_array($countdown(3)) === array(3, 2, 1));

$round = unserialize(serialize(array(1, 'box' => new Box(5))));
expect('serialize() round trip of an object', $round['box'] instanceof Box && $round['box']->v === 5);

exit($failures === 0 ? 0 : 1);
