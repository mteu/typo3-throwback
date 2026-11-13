<?php
// Everything here must start fresh on every request. If the function or class
// table survived a request, the declarations below would be fatal the second
// time ("Cannot redeclare").

function declared_on_every_request()
{
    return 1;
}

class DeclaredOnEveryRequest
{
    var $value = 1;
}

define('DEFINED_ON_EVERY_REQUEST', 1);

function count_calls()
{
    static $calls = 0;
    return ++$calls;
}

echo isset($set_by_earlier_request) ? "globals=leaked\n" : "globals=fresh\n";
$set_by_earlier_request = 1;
echo 'static=' . count_calls() . "\n";
echo "state=ok\n";
