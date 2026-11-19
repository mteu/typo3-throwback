<?php
// A session across requests, as TYPO3's backend and Install Tool keep one:
// the first request starts it and sets the cookie, the next one reads it.

session_start();
if (!isset($_SESSION['visits'])) {
    $_SESSION['visits'] = 0;
}
$_SESSION['visits']++;
echo 'session_id=' . session_id() . "\n";
echo 'session_name=' . session_name() . "\n";
echo 'visits=' . $_SESSION['visits'] . "\n";
