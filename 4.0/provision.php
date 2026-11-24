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
 * The character set is 3.8's, latin1, and asserted at the layers 4.5 asserts
 * UTF-8 at: the server, the connection, the database and the columns the tests
 * write to. Why 4.0 sides with 3.8 here is in docs/how-it-works.md. What a stored
 * value looks like is for the tests to prove, through the record editor, as an
 * editor would store it.
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

$siteName = env('TYPO3_SITENAME', 'TYPO3 4.0.13');
$welcomeText = 'A text element, stored in tt_content and rendered by css_styled_content.';

/**
 * The extensions a fresh 4.0.13 loads, in the order t3lib_extMgm loads them:
 * requiredExt, then extList (t3lib/config_default.php:105, :107), concatenated in
 * that order by t3lib_extMgm::typo3_loadExtensions()
 * (t3lib/class.t3lib_extmgm.php:925). The generated localconf.php overrides
 * extList only to append css_styled_content (see entrypoint.sh), which is why it
 * is the last entry below.
 *
 * Only cms, tsconfig_help and impexp carry an ext_tables.sql, and only cms and
 * tsconfig_help carry static data. The rest are listed anyway so this array can be
 * compared with the source line for line.
 */
$loadedExtensions = array(
    'cms', 'version', 'lang', 'sv',
    'tsconfig_help', 'context_help', 'extra_page_cm_options', 'impexp',
    'belog', 'aboutmodules', 'setup', 'install', 'css_styled_content',
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
//
// fileoper_perms is 7, as 4.0.13's own Install Tool sets it when it creates an
// admin (typo3/sysext/install/mod/class.tx_install.php:3620). admin = 1 does not
// cover file operations: tce_file.php:144 hands this field alone to
// t3lib_extFileFunctions::init_actionPerms(), and at its default of 0 even an
// admin gets "You are not allowed to upload files!". 1 is files (upload, copy,
// move, delete, rename), 2 is unzip, 4 is folders. 4.5 needs none of this: its
// getFileoperationPermissions() gives an admin every bit.
$now = time();
$sql = "INSERT INTO be_users (pid, tstamp, crdate, username, password, admin, disable, deleted, realName, fileoper_perms)"
     . " VALUES (0, " . $now . ", " . $now . ", '" . mysql_real_escape_string($adminUser, $link) . "', '"
     . md5($adminPass) . "', 1, 0, 0, 'Administrator', 7)";
mysql_query($sql, $link) or fail('creating admin user: ' . mysql_error($link));
out('created backend admin "' . $adminUser . '"');

// --- seed a rendering frontend --------------------------------------------
// A root page with one text element on it, rendered by css_styled_content, as a
// site of the time was set up. The tests write their own text into both records
// through the record editor, and read it back from the frontend.
$sql = "INSERT INTO pages (pid, tstamp, crdate, sorting, title, doktype, hidden, deleted, perms_userid, perms_user, perms_group, perms_everybody)"
     . " VALUES (0, " . $now . ", " . $now . ", 256, '" . mysql_real_escape_string($siteName, $link) . "', 1, 0, 0, 1, 31, 31, 31)";
mysql_query($sql, $link) or fail('creating root page: ' . mysql_error($link));
$rootPageUid = mysql_insert_id($link);
out('created root page (uid ' . $rootPageUid . ')');

$sql = "INSERT INTO tt_content (pid, tstamp, crdate, sorting, CType, header, bodytext, colPos, hidden, deleted)"
     . " VALUES (" . $rootPageUid . ", " . $now . ", " . $now . ", 256, 'text', '"
     . mysql_real_escape_string($siteName, $link) . "', '"
     . mysql_real_escape_string($welcomeText, $link) . "', 0, 0, 0)";
mysql_query($sql, $link) or fail('creating content element: ' . mysql_error($link));
out('created content element (uid ' . mysql_insert_id($link) . ')');

// The columns the record editor writes the tests' text into. A column that is not
// latin1 would store what 4.0 sends as something else.
foreach (array('pages.title', 'tt_content.header', 'tt_content.bodytext') as $column) {
    $parts = explode('.', $column);
    rejectUnlessLatin1($column . ' charset', readSingleValue($link,
        "SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS"
        . " WHERE TABLE_SCHEMA = '" . mysql_real_escape_string($dbName, $link) . "'"
        . " AND TABLE_NAME = '" . $parts[0] . "' AND COLUMN_NAME = '" . $parts[1] . "'"));
}

// css_styled_content's own template, included as the template record's "Include
// static (from extensions)" field stores it, renders the page's content.
$typoScript = 'page = PAGE' . chr(10)
    . 'page.typeNum = 0' . chr(10)
    . 'page.10 < styles.content.get' . chr(10)
    . 'page.20 = TEXT' . chr(10)
    . 'page.20.value = Rendered by TypoScript on PHP ' . phpversion() . chr(10)
    . 'page.20.wrap = <p>|</p>' . chr(10)
    . 'page.30 = TEXT' . chr(10)
    . 'page.30.data = date:U' . chr(10)
    . 'page.30.strftime = %Y-%m-%d %H:%M:%S' . chr(10)
    . 'page.30.wrap = <p>Page generated&nbsp;|</p>' . chr(10);

$sql = "INSERT INTO sys_template (pid, tstamp, crdate, sorting, title, root, clear, include_static_file, config, deleted, hidden)"
     . " VALUES (" . $rootPageUid . ", " . $now . ", " . $now . ", 256, 'Main template', 1, 3, 'EXT:css_styled_content/static/', '"
     . mysql_real_escape_string($typoScript, $link) . "', 0, 0)";
mysql_query($sql, $link) or fail('creating root template: ' . mysql_error($link));
out('created root TypoScript template');

out('done');
exit(0);
