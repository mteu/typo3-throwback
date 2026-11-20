<?php
// PHP 5.6's own mysqli, built against native/libmysql/, against
// runtime/mysql-sqlite.js: the connection 6.2.31 opens, the queries
// 6.2/provision.php sends, and prepared statements the way 6.2's
// PreparedStatement drives them. One line per check, then MYSQLI OK or
// MYSQLI FAIL. The query string names the server's version and charset.

$failures = 0;
$server = $_GET['server'];
$serverCharset = $_GET['charset'];
// Outside latin1, as 6.2/provision.php's probe is.
$utf8Text = "Sk\xc3\xa5rh\xc3\xb8j \xc2\xb7 G\xc3\xb6d\xc3\xb6ll\xc5\x91 \xc2\xb7 \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e";
$tricky = "O'Reilly \\ \"quoted\" \x00 end ?";

function expect($label, $passed)
{
    global $failures;
    echo ($passed ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$passed) {
        $failures++;
    }
}

mysqli_report(MYSQLI_REPORT_OFF);
expect('mysqli is loaded, against the 5.5.62 client, not mysqlnd',
    extension_loaded('mysqli') && mysqli_get_client_info() === '5.5.62' && mysqli_get_client_version() === 50562);
expect('mysqli.reconnect is off, as 6.2\'s Install Tool requires', ini_get('mysqli.reconnect') === '0');

$refused = @new mysqli('db', 'typo3', 'wrong');
expect('a wrong password is connect_errno 1045, with its message',
    $refused->connect_errno === 1045 && strpos($refused->connect_error, 'Access denied') !== false
    && mysqli_connect_errno() === 1045);

// The way 6.2's DatabaseConnection::sql_pconnect() connects.
$link = mysqli_init();
$connected = $link->real_connect('db', 'typo3', 'typo3', null, 3306, null, 0);
expect('mysqli_init() and real_connect(), as 6.2 connects', $connected === true && $link->connect_errno === 0);
expect('server_info is the server the shim answers as, host_info says what answers',
    $link->server_info === $server && $link->server_version === (int) vsprintf('%d%02d%02d', explode('.', $server))
    && strpos($link->host_info, 'via SQLite in WebAssembly') !== false);
expect('a connection starts in the server\'s charset', $link->character_set_name() === $serverCharset);
expect('set_charset() of a charset the client does not know is false, errno 2019',
    $link->set_charset('klingon') === false && $link->errno === 2019);
expect('set_charset(utf8), as 6.2 does after connecting', $link->set_charset('utf8') === true
    && $link->character_set_name() === 'utf8');
$charset = $link->get_charset();
expect('get_charset() describes utf8', $charset->charset === 'utf8' && $charset->collation === 'utf8_general_ci'
    && $charset->number === 33 && $charset->max_length === 3);
$row = $link->query('SELECT @@character_set_connection, @@character_set_client, @@character_set_results')->fetch_row();
expect('the server was told: SET NAMES utf8', $row === array('utf8', 'utf8', 'utf8'));

if (!@$link->select_db('probe')) {
    $link->query('CREATE DATABASE probe');
    $link->select_db('probe');
}
$link->query('DROP TABLE IF EXISTS t');
expect('CREATE TABLE with ENGINE=InnoDB', $link->query("CREATE TABLE t (uid int(11) unsigned NOT NULL auto_increment, title varchar(40) DEFAULT '' NOT NULL, data mediumtext, ratio double, PRIMARY KEY (uid)) ENGINE=InnoDB") === true);

expect('real_escape_string() escapes quote, backslash, double quote and NUL',
    $link->real_escape_string("O'Reilly \\ \"quoted\" \x00 end") === "O\\'Reilly \\\\ \\\"quoted\\\" \\0 end");
expect('an INSERT through query()', $link->query("INSERT INTO t (title, data) VALUES ('first', '" . $link->real_escape_string($tricky) . "')") === true);
expect('insert_id and affected_rows', $link->insert_id === 1 && $link->affected_rows === 1);
$link->query("INSERT INTO t (title, ratio) VALUES ('second', 0.5), ('" . $link->real_escape_string($utf8Text) . "', NULL)");
expect('affected_rows after a two-row insert', $link->affected_rows === 2);

$result = $link->query('SELECT uid, title, data FROM t ORDER BY uid');
expect('a SELECT gives a mysqli_result with num_rows and field_count',
    $result instanceof mysqli_result && $result->num_rows === 3 && $result->field_count === 3 && $link->field_count === 3);
$row = $result->fetch_assoc();
expect('fetch_assoc(): the escaped string round-trips byte for byte, NUL included',
    $row === array('uid' => '1', 'title' => 'first', 'data' => $tricky));
expect('lengths', $result->lengths === array(1, 5, strlen($tricky)));
$row = $result->fetch_row();
expect('fetch_row(), with NULL as null', $row === array('2', 'second', null));
$row = $result->fetch_object();
expect('fetch_object(): UTF-8 outside latin1 round-trips', $row->title === $utf8Text);
expect('fetch_assoc() past the end is null', $result->fetch_assoc() === null);
$result->data_seek(1);
$row = $result->fetch_row();
expect('data_seek()', $row[1] === 'second');
$fields = $result->fetch_fields();
expect('fetch_fields(): names, table, database, catalog', count($fields) === 3 && $fields[1]->name === 'title'
    && $fields[1]->orgname === 'title' && $fields[1]->table === 't' && $fields[1]->orgtable === 't'
    && $fields[1]->db === 'probe' && $fields[1]->catalog === 'def');
expect('fetch_fields(): types, flags and charsets as a 5.5 server reports them',
    $fields[0]->type === MYSQLI_TYPE_LONG && ($fields[0]->flags & MYSQLI_UNSIGNED_FLAG) && ($fields[0]->flags & MYSQLI_PRI_KEY_FLAG)
    && $fields[0]->charsetnr === 63 && $fields[1]->type === MYSQLI_TYPE_VAR_STRING && $fields[1]->charsetnr === 33);
expect('fetch_field_direct()', $result->fetch_field_direct(2)->name === 'data');
$result->free();

$bad = $link->query('SELECT nope FROM t');
expect('a bad column is false, errno 1054, SQLSTATE 42S22, with its message', $bad === false
    && $link->errno === 1054 && $link->sqlstate === '42S22' && strpos($link->error, "Unknown column 'nope'") !== false);
expect('the next good query clears the error', $link->query('SELECT 1') instanceof mysqli_result
    && $link->errno === 0 && $link->sqlstate === '00000' && $link->error === '');

// 6.2/provision.php: its connection and its first queries.
$provision = @new mysqli('db', 'typo3', 'typo3', 'probe');
expect('new mysqli() with a database, as 6.2/provision.php connects', $provision->connect_errno === 0
    && $provision->set_charset('utf8') === true);
$value = $provision->query('SELECT @@character_set_server')->fetch_row();
expect('provision.php reads @@character_set_server', $value[0] === $serverCharset);
$value = $provision->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '"
    . $provision->real_escape_string('probe') . "'")->fetch_row();
expect('provision.php counts the tables in information_schema', $value[0] === '1');
$provision->close();

// Prepared statements, in the order 6.2's PreparedStatement::execute() and
// fetch() use them: stmt_init(), prepare(), bind_param() through
// call_user_func_array() with references, execute(), store_result(),
// result_metadata(), bind_result(), fetch().
$stmt = $link->stmt_init();
expect('stmt_init() gives a mysqli_stmt', $stmt instanceof mysqli_stmt);
expect('prepare() a SELECT with two placeholders', $stmt->prepare('SELECT uid, title, data, ratio FROM t WHERE uid > ? AND title <> ? ORDER BY uid') === true);
expect('param_count, and field_count already known after prepare(), as a server says',
    $stmt->param_count === 2 && $stmt->field_count === 4);
$values = array(0, 'nothing');
$bindParamArguments = array('is');
for ($i = 0; $i < count($values); $i++) {
    $bindParamArguments[] = &$values[$i];
}
expect('bind_param() through call_user_func_array(), with references', call_user_func_array(array($stmt, 'bind_param'), $bindParamArguments) === true);
expect('execute()', $stmt->execute() === true);
expect('store_result()', $stmt->store_result() === true);
expect('num_rows', $stmt->num_rows === 3);
$metadata = $stmt->result_metadata();
$names = array();
foreach ($metadata->fetch_fields() as $field) {
    $names[] = $field->name;
}
$metadata->close();
expect('result_metadata()->fetch_fields() names the columns', $names === array('uid', 'title', 'data', 'ratio'));
$buffer = array();
$variables = array();
foreach ($names as $name) {
    $buffer[$name] = null;
    $variables[] = &$buffer[$name];
}
expect('bind_result() through call_user_func_array(), with references', call_user_func_array(array($stmt, 'bind_result'), $variables) === true);
expect('fetch(): an int column comes as int, NUL bytes and all intact', $stmt->fetch() === true
    && $buffer['uid'] === 1 && $buffer['title'] === 'first' && $buffer['data'] === $tricky && $buffer['ratio'] === null);
expect('fetch(): a double column comes as float', $stmt->fetch() === true && $buffer['ratio'] === 0.5 && $buffer['data'] === null);
expect('fetch(): UTF-8 outside latin1', $stmt->fetch() === true && $buffer['title'] === $utf8Text);
expect('fetch() past the end is null', $stmt->fetch() === null);
$stmt->data_seek(1);
expect('data_seek(), as PreparedStatement::seek() uses it', $stmt->fetch() === true && $buffer['title'] === 'second');

// PreparedStatement::execute() again: reset() keeps the statement.
expect('reset()', $stmt->reset() === true);
$values[0] = 1;
$values[1] = 'second';
expect('execute() again with new values, through the same references', $stmt->execute() === true && $stmt->store_result() === true
    && $stmt->num_rows === 1 && $stmt->fetch() === true && $buffer['uid'] === 3 && $buffer['title'] === $utf8Text);
$stmt->free_result();
$stmt->close();

$stmt = $link->prepare("SELECT '?' AS q, ? AS p, ? AS n");
$text = $tricky;
$null = null;
$stmt->bind_param('ss', $text, $null);
$stmt->execute();
$stmt->bind_result($q, $p, $n);
expect('a ? in a quoted string is no placeholder; strings with quotes and NUL, and NULL, go in as values',
    $stmt->param_count === 2 && $stmt->fetch() === true && $q === '?' && $p === $tricky && $n === null);
$stmt->close();

// 6.2/provision.php's prepared INSERT, with the insert id from the link.
$stmt = $link->prepare('INSERT INTO t (uid, title, data) VALUES (?, ?, ?)');
$uid = 10;
$title = $utf8Text;
$data = "a\x00b";
$stmt->bind_param('iss', $uid, $title, $data);
expect('a prepared INSERT', $stmt->execute() === true && $stmt->affected_rows === 1 && $stmt->insert_id === 10
    && $link->insert_id === 10);
$row = $link->query('SELECT title, data FROM t WHERE uid = 10')->fetch_row();
expect('what it wrote reads back byte for byte', $row === array($utf8Text, "a\x00b"));
expect('a duplicate key fails the execute: errno 1062, SQLSTATE 23000 on the statement',
    $stmt->execute() === false && $stmt->errno === 1062 && $stmt->sqlstate === '23000'
    && strpos($stmt->error, 'Duplicate entry') !== false);
$stmt->close();

$link->query('DELETE FROM t WHERE uid = 10');
$stmt = $link->prepare('UPDATE t SET ratio = ? WHERE uid = ?');
$ratio = 0.25;
$uid = 1;
$stmt->bind_param('di', $ratio, $uid);
expect('a prepared UPDATE with a double', $stmt->execute() === true && $stmt->affected_rows === 1);
$row = $link->query('SELECT ratio FROM t WHERE uid = 1')->fetch_row();
expect('the double reads back', (float) $row[0] === 0.25);
$stmt->close();

$stmt = $link->prepare('INSERT INTO t (title, data) VALUES (?, ?)');
$title = 'long';
$none = null;
$stmt->bind_param('sb', $title, $none);
$stmt->send_long_data(1, str_repeat('x', 1000));
$stmt->send_long_data(1, "\x00end");
expect('send_long_data() in two pieces', $stmt->execute() === true);
$row = $link->query("SELECT LENGTH(data), RIGHT(data, 4) FROM t WHERE title = 'long'")->fetch_row();
expect('the long data arrives whole', $row === array('1004', "\x00end"));
$stmt->close();

expect('prepare() of an unknown column fails, errno 1054, as on a server',
    $link->prepare('SELECT nope FROM t WHERE uid = ?') === false && $link->errno === 1054);
expect('prepare() of an unknown table fails, errno 1146',
    $link->prepare('SELECT * FROM missing WHERE uid = ?') === false && $link->errno === 1146);
$stmt = $link->prepare('SELECT uid FROM t ORDER BY uid LIMIT ?');
$limit = 2;
$stmt->bind_param('i', $limit);
expect('LIMIT ?, which NULL cannot fill at prepare(), gets its columns at execute()',
    $stmt->field_count === 0 && $stmt->execute() === true && $stmt->field_count === 1
    && $stmt->store_result() === true && $stmt->num_rows === 2);
$stmt->close();
$stmt = $link->prepare('SELECT uid FROM t WHERE uid = ?');
expect('execute() without bind_param() is errno 2031', $stmt->execute() === false && $stmt->errno === 2031);
$stmt->close();

expect('autocommit() sends SET autocommit', $link->autocommit(true) === true);
expect('ping()', $link->ping() === true);
expect('more_results() is false: one statement per query', $link->more_results() === false);
expect('close()', $link->close() === true);

echo $failures ? "MYSQLI FAIL\n" : "MYSQLI OK\n";
