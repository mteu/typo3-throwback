<?php
// Every reader of the clock PHP 5.6 has, one per field, for
// probe/request-loop.cjs to hold against the start it gave the clock.

$micro = explode(' ', microtime());
$now = new DateTime();
echo implode('|', array(
    time(),
    date('Y-m-d H:i:s T Z'),
    mktime(12, 0, 0, 2, 19, 2015),
    strftime('%H %Z', time()),
    $micro[1],
    floor(microtime(true)),
    hexdec(substr(uniqid(''), 0, 8)),
    $now->format('U'),
    $now->format('T'),
    $_SERVER['REQUEST_TIME'],
    floor($_SERVER['REQUEST_TIME_FLOAT']),
    date_default_timezone_get(),
));
