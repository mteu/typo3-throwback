<?php
// One line per fact, NAME=VALUE, for probe/request-loop.cjs to assert on.

header('X-Probe: env');
setcookie('probe', 'set-by-request-' . $HTTP_GET_VARS['n']);

function field($array, $name)
{
    return isset($array[$name]) ? $array[$name] : '';
}

echo 'sapi=' . php_sapi_name() . "\n";
echo 'method=' . $HTTP_SERVER_VARS['REQUEST_METHOD'] . "\n";
echo 'get=' . field($HTTP_GET_VARS, 'n') . "\n";
echo 'post=' . field($HTTP_POST_VARS, 'field') . "\n";
echo 'post_latin1_hex=' . bin2hex(field($HTTP_POST_VARS, 'umlaut')) . "\n";
echo 'cookie=' . field($HTTP_COOKIE_VARS, 'probe') . "\n";
echo 'php_self=' . $HTTP_SERVER_VARS['PHP_SELF'] . "\n";
echo 'request_uri=' . $HTTP_SERVER_VARS['REQUEST_URI'] . "\n";
echo 'path_translated=' . $HTTP_SERVER_VARS['PATH_TRANSLATED'] . "\n";
echo 'getenv_host=' . getenv('HTTP_HOST') . "\n";
echo 'env_host=' . field($HTTP_ENV_VARS, 'HTTP_HOST') . "\n";
echo 'env_emscripten_user=' . (isset($HTTP_ENV_VARS['USER']) ? 'present' : 'absent') . "\n";
echo 'uniqid=' . uniqid('') . "\n";
