<?php
// PHP 5.6's own ext/mysql, built against native/libmysql/, against
// runtime/mysql-sqlite.js. One line per check, then MYSQL OK or MYSQL FAIL.

$failures = 0;
$errors = array();

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

function collect_error($level, $message)
{
    $GLOBALS['errors'][] = array($level, $message);
    return true;
}

error_reporting(E_ALL);
set_error_handler('collect_error');
$link = mysql_connect('db', 'typo3', 'typo3');
restore_error_handler();
expect('mysql_connect() gives a link', is_resource($link) && get_resource_type($link) === 'mysql link');
// PHP 5.5 deprecated ext/mysql, and says so on every connect. A client
// version other than the header's 3.23 would add a mismatch warning.
expect('connecting raises only the deprecation of ext/mysql', count($errors) === 1 && $errors[0][0] === E_DEPRECATED
    && strpos($errors[0][1], 'The mysql extension is deprecated') !== false);
expect('the client is 3.23.49, the server what the shim answers as',
    mysql_get_client_info() === '3.23.49' && mysql_get_server_info($link) === $_GET['server']);
expect('mysql_set_charset() is not built: 4.5.40 sends SET NAMES as a query', !function_exists('mysql_set_charset'));

if (!@mysql_select_db('probe', $link)) {
    mysql_query('CREATE DATABASE probe', $link);
    mysql_select_db('probe', $link);
}
mysql_query('DROP TABLE IF EXISTS t', $link);
expect('CREATE TABLE with ENGINE=InnoDB', mysql_query("CREATE TABLE t (uid int(11) unsigned NOT NULL auto_increment, title varchar(40) DEFAULT '' NOT NULL, PRIMARY KEY (uid)) ENGINE=InnoDB", $link));

expect('mysql_real_escape_string() escapes quote, backslash, double quote and NUL',
    mysql_real_escape_string("O'Reilly \\ \"quoted\" \x00 end", $link) === "O\\'Reilly \\\\ \\\"quoted\\\" \\0 end");
// Without the NUL: the shim hands string literals to SQLite as SQL text,
// which ends at a NUL byte.
$tricky = "O'Reilly \\ \"quoted\" end";
mysql_query("INSERT INTO t (title) VALUES ('" . mysql_real_escape_string($tricky, $link) . "')", $link);
expect('mysql_insert_id()', mysql_insert_id($link) === 1);
mysql_query("INSERT INTO t (title) VALUES ('second'), ('third')", $link);
expect('mysql_affected_rows() after a two-row insert', mysql_affected_rows($link) === 2);

$res = mysql_query('SELECT uid, title FROM t ORDER BY uid', $link);
expect('mysql_num_rows() and mysql_num_fields()', mysql_num_rows($res) === 3 && mysql_num_fields($res) === 2);
$row = mysql_fetch_assoc($res);
expect('the escaped string round-trips byte for byte', $row['title'] === $tricky);
$row = mysql_fetch_row($res);
expect('mysql_fetch_row()', $row === array('2', 'second'));
$row = mysql_fetch_object($res);
expect('mysql_fetch_object()', $row->title === 'third');
expect('mysql_field_name() and mysql_field_type()', mysql_field_name($res, 1) === 'title' && mysql_field_type($res, 0) === 'int');
mysql_free_result($res);

$res = mysql_unbuffered_query('SELECT COUNT(*) FROM t', $link);
$row = mysql_fetch_row($res);
expect('mysql_unbuffered_query()', $row[0] === '3');

$bad = @mysql_query('SELECT nope FROM t', $link);
expect('a bad column is false, errno 1054, with its message', $bad === false && mysql_errno($link) === 1054
    && strpos(mysql_error($link), "Unknown column 'nope'") !== false);
expect('mysql_ping()', mysql_ping($link) === true);
expect('mysql_close()', mysql_close($link) === true);

echo $failures ? "MYSQL FAIL\n" : "MYSQL OK\n";
