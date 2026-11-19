<?php
// The request body as php://input gives it, as 4.5's Ext.Direct router reads
// it (t3lib/extjs/class.t3lib_extjs_extdirectrouter.php:49). Read twice:
// PHP 5.6 keeps the body, so a second read sees it all again.

$first = file_get_contents('php://input');
$second = file_get_contents('php://input');
echo 'input_hex=' . bin2hex($first) . "\n";
echo 'input_again=' . ($second === $first ? 'same' : 'different') . "\n";
echo 'raw_post_data=' . (isset($HTTP_RAW_POST_DATA) ? 'set' : 'unset') . "\n";
echo 'post_fields=' . count($_POST) . "\n";
echo 'content_type=' . $_SERVER['CONTENT_TYPE'] . "\n";
