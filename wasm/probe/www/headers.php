<?php
// mode=404: PHP's own status line. mode=redirect: Location implies 302.
// mode=cgi-status: the CGI "Status:" header, which the runtime maps as a CGI
// server would.

$mode = isset($HTTP_GET_VARS['mode']) ? $HTTP_GET_VARS['mode'] : '';
if ($mode === '404') {
    header('HTTP/1.0 404 Not Found');
    echo "not found\n";
} elseif ($mode === 'redirect') {
    header('Location: http://localhost/elsewhere.php');
} elseif ($mode === 'cgi-status') {
    header('Status: 503 Service Unavailable');
    echo "unavailable\n";
} elseif ($mode === 'latin1') {
    header('Content-Type: text/html; charset=iso-8859-1');
    echo "Gr\xfc\xdfe\n";
} elseif ($mode === 'big') {
    echo str_repeat('x', 1048576);
}
