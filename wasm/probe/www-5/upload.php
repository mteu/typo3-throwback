<?php
// www/upload.php through PHP 5's superglobals. With ?move=<dir>, the file is
// also moved there with move_uploaded_file(), as TYPO3's file handling does.

$upload = $_FILES['attachment'];
echo 'name=' . $upload['name'] . "\n";
echo 'size=' . $upload['size'] . "\n";
echo 'error=' . $upload['error'] . "\n";
echo 'is_uploaded_file=' . (is_uploaded_file($upload['tmp_name']) ? 'yes' : 'no') . "\n";
echo 'content=' . file_get_contents($upload['tmp_name']) . "\n";
echo 'content_md5=' . md5_file($upload['tmp_name']) . "\n";
echo 'tmp_name=' . $upload['tmp_name'] . "\n";
echo 'other_field=' . $_POST['other'] . "\n";
if (isset($_GET['move'])) {
    $target = $_GET['move'] . '/' . basename($upload['name']);
    echo 'moved=' . (move_uploaded_file($upload['tmp_name'], $target) ? 'yes' : 'no') . "\n";
    echo 'moved_md5=' . md5_file($target) . "\n";
    echo 'tmp_left=' . (file_exists($upload['tmp_name']) ? 'yes' : 'no') . "\n";
}
