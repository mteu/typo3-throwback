<?php
$upload = $HTTP_POST_FILES['attachment'];
echo 'name=' . $upload['name'] . "\n";
echo 'size=' . $upload['size'] . "\n";
echo 'error=' . $upload['error'] . "\n";
echo 'is_uploaded_file=' . (is_uploaded_file($upload['tmp_name']) ? 'yes' : 'no') . "\n";
$handle = fopen($upload['tmp_name'], 'rb');
echo 'content=' . fread($handle, 1024) . "\n";
fclose($handle);
echo 'tmp_name=' . $upload['tmp_name'] . "\n";
echo 'other_field=' . $HTTP_POST_VARS['other'] . "\n";
