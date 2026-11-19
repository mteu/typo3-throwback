<?php
// www/env.php through PHP 5's superglobals: PHP 5.4 removed the
// $HTTP_*_VARS arrays that one reads.

header('X-Probe: env');
setcookie('probe', 'set-by-request-' . (isset($_GET['n']) ? $_GET['n'] : ''));

function field($array, $name)
{
    return isset($array[$name]) ? $array[$name] : '';
}

echo 'sapi=' . php_sapi_name() . "\n";
echo 'method=' . $_SERVER['REQUEST_METHOD'] . "\n";
echo 'get=' . field($_GET, 'n') . "\n";
echo 'post=' . field($_POST, 'field') . "\n";
echo 'post_latin1_hex=' . bin2hex(field($_POST, 'umlaut')) . "\n";
echo 'cookie=' . field($_COOKIE, 'probe') . "\n";
echo 'php_self=' . $_SERVER['PHP_SELF'] . "\n";
echo 'request_uri=' . $_SERVER['REQUEST_URI'] . "\n";
echo 'path_translated=' . $_SERVER['PATH_TRANSLATED'] . "\n";
echo 'getenv_host=' . getenv('HTTP_HOST') . "\n";
echo 'env_host=' . field($_ENV, 'HTTP_HOST') . "\n";
echo 'env_emscripten_user=' . (isset($_ENV['USER']) ? 'present' : 'absent') . "\n";
echo 'uniqid=' . uniqid('') . "\n";
