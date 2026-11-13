<?php
// PHP's own ext/mysql against runtime/mysql-sqlite.js. Prints one line per
// check, then MYSQL OK or MYSQL FAIL. PHP 4 syntax.

$failures = 0;

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

$link = mysql_pconnect('db', 'typo3', 'typo3');
expect('mysql_pconnect gives a persistent link resource', is_resource($link) && get_resource_type($link) == 'mysql link persistent');
expect('server and client both say 3.23.49', mysql_get_server_info($link) == '3.23.49' && mysql_get_client_info() == '3.23.49');

if (!@mysql_select_db('probe')) {
    mysql_query('CREATE DATABASE probe');
    mysql_select_db('probe');
}
mysql_query('DROP TABLE IF EXISTS t');
expect('CREATE TABLE in MySQL 3.23 syntax', mysql_query("CREATE TABLE t (uid int(11) unsigned DEFAULT '0' NOT NULL auto_increment, title varchar(20) DEFAULT '' NOT NULL, PRIMARY KEY (uid))"));
mysql_query("INSERT INTO t (title) VALUES ('" . addslashes("O'Reilly") . "')");
expect('mysql_insert_id', mysql_insert_id() == 1);
mysql_query("INSERT INTO t (title) VALUES ('Gr\xfc\xdfe')");

$databases = mysql_list_dbs();
expect('mysql_list_dbs lists the database', mysql_num_rows($databases) == 1 && mysql_db_name($databases, 0) == 'probe');
$res = @mysql('probe', 'SELECT * FROM t ORDER BY uid');
expect('mysql() and mysql_num_rows', mysql_num_rows($res) == 2);
$row = mysql_fetch_assoc($res);
expect('an escaped quote round-trips', $row['title'] == "O'Reilly");
$row = mysql_fetch_row($res);
expect('ISO-8859-1 bytes round-trip', $row[1] == "Gr\xfc\xdfe");
expect('mysql_field_type and mysql_field_flags', mysql_field_type($res, 0) == 'int' && strstr(mysql_field_flags($res, 0), 'auto_increment'));

$bad = @mysql_query('SELECT nope FROM t');
expect('a bad column is errno 1054', $bad === false && mysql_errno() == 1054);

echo $failures ? "MYSQL FAIL\n" : "MYSQL OK\n";
