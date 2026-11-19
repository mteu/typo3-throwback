<?php
// www/headers.php through PHP 5's superglobals.

$mode = isset($_GET['mode']) ? $_GET['mode'] : '';
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
