<?php
/**
 * First-boot provisioning for the TYPO3 4.0.13 container.
 *
 * Same contract as 3.8/provision.php and 4.5/provision.php, and
 * written against ext/mysql for their reason: it is the extension t3lib_db uses,
 * so a successful import here proves the runtime the application will use.
 *
 * Idempotent: it detects an already-populated database and exits early.
 *
 * TYPO3_PROVISION=auto   (default) build the schema and seed an admin user, a
 *                        root page and a root TypoScript template.
 * TYPO3_PROVISION=wizard create the empty database and stop, for the 1-2-3
 *                        install wizard at typo3/install/index.php?mode=123.
 *
 * The character set is 3.8's, latin1, and asserted at every layer 4.5 asserts
 * UTF-8 at: the server, the connection, the database, a column, and a stored value
 * read back byte for byte. Why 4.0 sides with 3.8 here is in docs/how-it-works.md.
 *
 * The probe below is written as escape sequences rather than typed, so no editor
 * or checkout can re-encode the bytes it is there to prove.
 */

function out($msg) {
    echo '[provision] ' . $msg . "\n";
    flush();
}

function fail($msg) {
    echo '[provision] ERROR: ' . $msg . "\n";
    exit(1);
}

function env($name, $default = '') {
    $v = getenv($name);
    return ($v === false || $v === '') ? $default : $v;
}

$dbHost = env('TYPO3_DB_HOST', 'db');
$dbName = env('TYPO3_DB_NAME', 'typo3');
$dbUser = env('TYPO3_DB_USER', 'typo3');
$dbPass = env('TYPO3_DB_PASSWORD', 'typo3');

$adminUser = env('TYPO3_ADMIN_USER', 'admin');
$adminPass = env('TYPO3_ADMIN_PASSWORD', 'password');

$mode    = env('TYPO3_PROVISION', 'auto');
$docRoot = env('TYPO3_DOCROOT', '/var/www/html');

/**
 * 4.5's probe, "Skaarhøj · Gödöllő · 日本語", stored the way 4.0 itself would
 * store it if an editor typed it into the backend.
 *
 * The backend is an ISO-8859-1 page, so the browser submits the form in
 * ISO-8859-1. Whatever that charset cannot carry, the browser sends as a decimal
 * numeric character reference: that is what HTML form submission does with an
 * unencodable character. So the ø, the ö and the middle dots arrive as single
 * latin1 bytes (F8, F6, B7), and the ő and the Japanese arrive as the ASCII text
 * "&#337;", "&#26085;", "&#26412;", "&#35486;". TYPO3 stores that unchanged.
 *
 * Every part of it still earns its place. The latin1 bytes are what a UTF-8 server
 * would destroy, because they are not valid UTF-8. The references are what
 * a visitor sees as ő and 日本語, because the frontend passes them through and the
 * browser decodes them; and they are what the record editor shows as literal
 * "&#337;", because TCEforms escapes the ampersand.
 *
 * The typo3-4-0 job computes the same bytes independently, with Python's
 * encode('latin-1', 'xmlcharrefreplace'), and compares.
 */
$charsetProbe = "Skaarh\xF8j \xB7 G\xF6d\xF6ll&#337; \xB7 &#26085;&#26412;&#35486;";

/**
 * The extensions a fresh 4.0.13 loads, in the order t3lib_extMgm loads them:
 * requiredExt, then extList (t3lib/config_default.php:105, :107), concatenated in
 * that order by t3lib_extMgm::typo3_loadExtensions()
 * (t3lib/class.t3lib_extmgm.php:925). The generated localconf.php overrides
 * neither.
 *
 * Only cms, tsconfig_help and impexp carry an ext_tables.sql, and only cms and
 * tsconfig_help carry static data. The rest are listed anyway so this array can be
 * compared with the source line for line.
 */
$loadedExtensions = array(
    'cms', 'version', 'lang', 'sv',
    'tsconfig_help', 'context_help', 'extra_page_cm_options', 'impexp',
    'belog', 'aboutmodules', 'setup', 'install',
);

/**
 * Split a TYPO3 SQL dump into statements.
 *
 * t3lib_install::getStatementArray() (t3lib/class.t3lib_install.php:644-673) is
 * 3.8's algorithm, still written with eregi_replace(), so this is 3.8's
 * splitSql() unchanged: a statement ends where a *line* ends in a semicolon, and
 * " default '0'" is stripped from auto_increment lines, which MySQL 5.5 would
 * otherwise reject.
 */
function splitSql($sqlcode) {
    $lines = explode(chr(10), $sqlcode);
    $statements = array();
    $p = 0;

    foreach ($lines as $line) {
        if (stristr($line, 'auto_increment')) {
            $line = preg_replace("/ default '0'/i", '', $line);
        }

        $trimmed = trim($line);
        $isSet = 0;

        if ($trimmed !== '' && substr($trimmed, 0, 1) != '#' && substr($trimmed, 0, 2) != '--') {
            if (!isset($statements[$p])) {
                $statements[$p] = '';
            }
            $statements[$p] .= $line;
            $isSet = 1;
        }

        if (substr($trimmed, -1) == ';') {
            $p++;
        } elseif ($isSet) {
            $statements[$p] .= chr(10);
        }
    }

    $result = array();
    foreach ($statements as $statement) {
        $statement = trim($statement);
        if (substr($statement, -1) == ';') {
            $statement = trim(substr($statement, 0, -1));
        }
        if ($statement !== '') {
            $result[] = $statement;
        }
    }

    return $result;
}

/**
 * Merge CREATE TABLE definitions across files, field by field and key by key.
 *
 * A port of 4.0's t3lib_install::getFieldDefinitions_sqlContent()
 * (t3lib/class.t3lib_install.php:293-351). It sits between 3.8's parser and 4.5's,
 * and the differences from 3.8's that reach the database are kept:
 *
 *   - backticks are stripped from table, field and key names
 *   - "UNIQUE KEY" is normalised to "UNIQUE", so two files declaring one key
 *     differently still merge into one
 *   - " DEFAULT " is lower-cased and moved after NOT NULL / NULL, and doubled
 *     blanks are collapsed. MySQL reads both orders the same; kept so the DDL is
 *     the DDL the Install Tool would have sent
 *   - the table options line is read for ENGINE or TYPE
 *
 * The last one is where this port has to differ from its source. 4.0's emitter
 * writes the engine back as "TYPE=" (:605), and MySQL 5.5 no longer accepts TYPE=
 * at all. No table a fresh 4.0 loads names an engine, so the question does not
 * arise for this stack, and this function fails loudly rather than guess if one
 * ever does. An extension that ships "TYPE=MyISAM" would hit the same wall in 4.0's
 * own Install Tool against this server.
 *
 * The multiplyDBfieldSize pass (:362) is not ported, because its default, 1,
 * makes it a no-op (config_default.php:87).
 *
 * @return array<string, array{fields: array<string,string>, keys: array<string,string>}>
 */
function parseTableDefinitions($sqlContent, $definitions, $source) {
    $table = '';

    foreach (explode(chr(10), $sqlContent) as $value) {
        $value = trim($value);
        if ($value === '' || substr($value, 0, 1) == '#') {
            continue;
        }

        if ($table === '') {
            $parts = explode(' ', $value);
            if (count($parts) > 2 && $parts[0] == 'CREATE' && $parts[1] == 'TABLE') {
                $table = str_replace('`', '', $parts[2]);
                if (!isset($definitions[$table])) {
                    $definitions[$table] = array('fields' => array(), 'keys' => array());
                }
            }
            continue;
        }

        if (substr($value, 0, 1) == ')' && substr($value, -1) == ';') {
            if (preg_match('/(ENGINE|TYPE)=([a-zA-Z]*)/', $value, $engine) && $engine[2] !== '') {
                fail('table ' . $table . ' in ' . $source . ' names ' . $engine[0] . ', which 4.0 would emit as TYPE= and MySQL 5.5 refuses');
            }
            $table = '';
            continue;
        }

        $line = preg_replace('/,$/', '', $value);
        $line = str_replace('UNIQUE KEY', 'UNIQUE', $line);
        $parts = explode(' ', $line, 2);
        $definition = isset($parts[1]) ? $parts[1] : '';

        if (stristr($definition, 'auto_increment')) {
            $definition = preg_replace("/ default '0'/i", '', $definition);
        }
        if (strstr($definition, ' DEFAULT ')) {
            $definition = str_replace(' DEFAULT ', ' default ', $definition);
        }
        $definition = preg_replace('/(.*) (default .*) (NOT NULL)/', '$1 $3 $2', $definition);
        $definition = preg_replace('/(.*) (default .*) (NULL)/', '$1 $3 $2', $definition);
        $definition = preg_replace('/([^ ]+)[ ]+([^ ]+)/', '$1 $2', $definition);

        if ($parts[0] != 'PRIMARY' && $parts[0] != 'KEY' && $parts[0] != 'UNIQUE') {
            $definitions[$table]['fields'][str_replace('`', '', $parts[0])] = $definition;
            continue;
        }

        $keyParts = explode(' ', $definition, 2);
        $keyName = str_replace('`', '', $parts[0] == 'PRIMARY' ? $parts[0] : $keyParts[0]);
        $definitions[$table]['keys'][$keyName] = str_replace('`', '', $line);
    }

    return $definitions;
}

/**
 * The statement 4.0's t3lib_install::getUpdateSuggestions() emits for a table that
 * does not exist yet (t3lib/class.t3lib_install.php:604-605): fields, then keys,
 * and no table options, since none of the loaded tables has any.
 */
function buildCreateStatement($table, $definition) {
    $lines = array();
    foreach ($definition['fields'] as $name => $type) {
        $lines[] = $name . ' ' . $type;
    }
    foreach ($definition['keys'] as $key) {
        $lines[] = $key;
    }

    return 'CREATE TABLE ' . $table . " (\n" . implode(",\n", $lines) . "\n)";
}

function readSqlFile($path) {
    if (!@is_file($path)) {
        fail('SQL file not found: ' . $path);
    }

    return file_get_contents($path);
}

function runStatements($link, $statements, $what) {
    foreach ($statements as $statement) {
        if (!mysql_query($statement, $link)) {
            fail('while importing ' . $what . ': ' . mysql_error($link)
                . "\nstatement: " . substr($statement, 0, 200));
        }
    }

    out('imported ' . count($statements) . ' statements from ' . $what);
}

function readSingleValue($link, $query) {
    $result = mysql_query($query, $link);
    if (!$result) {
        fail('query failed: ' . $query . ': ' . mysql_error($link));
    }
    $row = mysql_fetch_row($result);

    return $row ? $row[0] : null;
}

function rejectUnlessLatin1($what, $actual) {
    out($what . ': ' . $actual);
    if ($actual !== 'latin1') {
        fail('expected latin1 for ' . $what . ', got ' . $actual
            . ' - 4.0 sends ISO-8859-1 bytes and no SET NAMES, so a utf8 server refuses every'
            . ' umlaut as an invalid UTF-8 sequence. Check --character-set-server in compose.yaml.');
    }
}

// --- wait for the database -------------------------------------------------
$link = 0;
for ($i = 1; $i <= 60; $i++) {
    $link = @mysql_connect($dbHost, $dbUser, $dbPass);
    if ($link) {
        break;
    }
    if ($i == 1) {
        out('waiting for ' . $dbHost . ' ...');
    }
    sleep(2);
}

if (!$link) {
    fail('could not connect to ' . $dbHost . ' as ' . $dbUser . ': ' . mysql_error());
}

out('connected to MySQL ' . mysql_get_server_info($link)
    . ' (client ' . mysql_get_client_info() . ')');

// Nothing is sent before these reads, because t3lib_db sends nothing: setDBinit is
// empty by default and the generated localconf.php leaves it so
// (t3lib/class.t3lib_db.php:897-903). The connection is whatever the server hands
// out, which is what the application will get too.
rejectUnlessLatin1('server charset', readSingleValue($link, 'SELECT @@character_set_server'));
rejectUnlessLatin1('connection charset', readSingleValue($link, 'SELECT @@character_set_connection'));

if (!@mysql_select_db($dbName, $link)) {
    out('database ' . $dbName . ' missing, creating it');
    // No CHARACTER SET clause, because 4.0's Install Tool names none
    // (typo3/sysext/install/mod/class.tx_install.php:2076).
    if (!mysql_query('CREATE DATABASE ' . $dbName, $link)) {
        fail('cannot create database ' . $dbName . ': ' . mysql_error($link));
    }
    mysql_select_db($dbName, $link) or fail('cannot select ' . $dbName);
}

// The official image creates MYSQL_DATABASE itself, before this script runs, so
// the server default alone does not prove what this database was created with.
rejectUnlessLatin1('database charset', readSingleValue($link, 'SELECT @@character_set_database'));

if ($mode == 'wizard') {
    out('wizard mode: leaving ' . $dbName . ' empty for the 1-2-3 install wizard');
    exit(0);
}

$existing = mysql_query("SHOW TABLES LIKE 'be_users'", $link);
if ($existing && mysql_num_rows($existing)) {
    out('schema already present, nothing to do');
    exit(0);
}

// --- build the schema the Install Tool would build --------------------------
out('empty database, building the TYPO3 4.0.13 schema');

$definitions = parseTableDefinitions(readSqlFile($docRoot . '/t3lib/stddb/tables.sql'), array(), 't3lib/stddb/tables.sql');
$sources = array('t3lib/stddb/tables.sql');

foreach ($loadedExtensions as $extension) {
    $relative = 'sysext/' . $extension . '/ext_tables.sql';
    $path = $docRoot . '/typo3/' . $relative;
    if (@is_file($path)) {
        $definitions = parseTableDefinitions(readSqlFile($path), $definitions, $relative);
        $sources[] = $relative;
    }
}

out('merged ' . count($definitions) . ' tables from ' . count($sources) . ' files: ' . implode(', ', $sources));

foreach ($definitions as $table => $definition) {
    $statement = buildCreateStatement($table, $definition);
    if (!mysql_query($statement, $link)) {
        fail('creating table ' . $table . ': ' . mysql_error($link)
            . "\nstatement: " . substr($statement, 0, 300));
    }
}

out('created ' . count($definitions) . ' tables');

// --- static data ------------------------------------------------------------
// Run verbatim after the merged schema, as 3.8 and 4.5 do and as the Install
// Tool's separate import action does: these dumps drop and recreate their own
// tables. They are latin1 bytes, written for a latin1 connection, which is the
// one asserted above.
foreach ($loadedExtensions as $extension) {
    $path = $docRoot . '/typo3/sysext/' . $extension . '/ext_tables_static+adt.sql';
    if (@is_file($path)) {
        runStatements($link, splitSql(readSqlFile($path)), 'sysext/' . $extension . '/ext_tables_static+adt.sql');
    }
}

// --- seed a backend administrator -----------------------------------------
// A plain md5, because 4.0 predates saltedpasswords. The login form hashes it again
// with the username and a challenge the server kept in the PHP session
// (t3lib/class.t3lib_userauth.php:1045-1058, "superchallenged"; the session check
// is on because t3lib_beuserauth sets challengeStoredInCookie, :108).
//
// time() is frozen by libfaketime, so tstamp/crdate are identical on every run.
$now = time();
$sql = "INSERT INTO be_users (pid, tstamp, crdate, username, password, admin, disable, deleted, realName)"
     . " VALUES (0, " . $now . ", " . $now . ", '" . mysql_real_escape_string($adminUser, $link) . "', '"
     . md5($adminPass) . "', 1, 0, 0, 'Administrator')";
mysql_query($sql, $link) or fail('creating admin user: ' . mysql_error($link));
out('created backend admin "' . $adminUser . '"');

// --- seed a rendering frontend --------------------------------------------
$sql = "INSERT INTO pages (pid, tstamp, crdate, sorting, title, doktype, hidden, deleted, perms_userid, perms_user, perms_group, perms_everybody)"
     . " VALUES (0, " . $now . ", " . $now . ", 256, '" . mysql_real_escape_string($charsetProbe, $link) . "', 1, 0, 0, 1, 31, 31, 31)";
mysql_query($sql, $link) or fail('creating root page: ' . mysql_error($link));
$rootPageUid = mysql_insert_id($link);
out('created root page (uid ' . $rootPageUid . ')');

// The round trip, before anything depends on it, in the same two halves 4.5
// checks: a column that is not latin1 is the cause, a stored value that differs is
// the symptom. Compared as hex, so that the message says which bytes came back.
rejectUnlessLatin1('pages.title charset', readSingleValue($link,
    "SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS"
    . " WHERE TABLE_SCHEMA = '" . mysql_real_escape_string($dbName, $link) . "'"
    . " AND TABLE_NAME = 'pages' AND COLUMN_NAME = 'title'"));

$storedHex = readSingleValue($link, 'SELECT HEX(title) FROM pages WHERE uid = ' . (int) $rootPageUid);
if ($storedHex !== strtoupper(bin2hex($charsetProbe))) {
    fail('the root page title did not survive the database: wrote 0x' . strtoupper(bin2hex($charsetProbe))
        . ', stored 0x' . $storedHex);
}
out('latin1 round trip through pages.title: ok, ' . strlen($charsetProbe) . ' bytes back unchanged');

// Plain, as in 3.8 and 4.5, and rendered through the real TypoScript pipeline.
// page.40 reads the page title back out of the database, so the frontend's HTML
// carries the round trip. TEXT does not escape what it is given, so the numeric
// references in the probe reach the browser as references, and it decodes them.
$typoScript = 'page = PAGE' . chr(10)
    . 'page.typeNum = 0' . chr(10)
    . 'page.10 = TEXT' . chr(10)
    . 'page.10.value = TYPO3 4.0.13' . chr(10)
    . 'page.10.wrap = <h1>|</h1>' . chr(10)
    . 'page.20 = TEXT' . chr(10)
    . 'page.20.value = Rendered by TypoScript on PHP ' . phpversion() . chr(10)
    . 'page.20.wrap = <p>|</p>' . chr(10)
    . 'page.30 = TEXT' . chr(10)
    . 'page.30.data = date:U' . chr(10)
    . 'page.30.strftime = %Y-%m-%d %H:%M:%S' . chr(10)
    . 'page.30.wrap = <p>Page generated&nbsp;|</p>' . chr(10)
    . 'page.40 = TEXT' . chr(10)
    . 'page.40.data = page:title' . chr(10)
    . 'page.40.wrap = <p id="charset-probe">|</p>' . chr(10);

$sql = "INSERT INTO sys_template (pid, tstamp, crdate, sorting, title, root, clear, config, deleted, hidden)"
     . " VALUES (" . $rootPageUid . ", " . $now . ", " . $now . ", 256, 'Main template', 1, 3, '"
     . mysql_real_escape_string($typoScript, $link) . "', 0, 0)";
mysql_query($sql, $link) or fail('creating root template: ' . mysql_error($link));
out('created root TypoScript template');

out('done');
exit(0);
