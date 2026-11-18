<?php
// Usage: php compat-php5.php <typo3_src-4.0.13 tree>
//
// TYPO3 4.0 copies objects with clone(), a PHP 5 keyword. On PHP 4 that is a
// function call, and t3lib/compat_php5.php defines the function, inside an
// eval(). t3lib/config_default.php:360 loads it only below PHP 5, so the
// Docker stack, on PHP 5.6, never runs it. The frontend needs it for any page
// with content_from_pid (typo3/sysext/cms/tslib/class.tslib_pagegen.php:97).

include $argv[1] . '/t3lib/compat_php5.php';

class Page {
    var $title = 'original';
    var $cloned = false;

    function __clone() {
        $this->cloned = true;
    }
}

$page = new Page();
$copy = clone($page);
$copy->title = 'copy';

if (!function_exists('clone')) {
    echo "FAIL compat_php5.php defined no clone()\n";
    exit(1);
}
if ($page->title != 'original' || $copy->title != 'copy') {
    echo "FAIL the copy is not separate: original '$page->title', copy '$copy->title'\n";
    exit(1);
}
if (!$copy->cloned || $page->cloned) {
    echo "FAIL __clone() ran on the wrong object\n";
    exit(1);
}
echo "CLONE OK\n";
?>
