<?php
// What a script written for the CLI reads of its command line: the globals
// $argv and $argc, which PHP sets only when the SAPI has a command line, and
// $_SERVER's copies, which a web request fills from the query string.
echo json_encode(array(
    'argv' => isset($argv) ? $argv : null,
    'argc' => isset($argc) ? $argc : null,
    'server_argv' => isset($_SERVER['argv']) ? $_SERVER['argv'] : null,
    'server_argc' => isset($_SERVER['argc']) ? $_SERVER['argc'] : null,
));
