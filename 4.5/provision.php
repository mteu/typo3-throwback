<?php
/**
 * First-boot provisioning for the TYPO3 4.5.40 container.
 *
 * Same contract as 3.8/provision.php, and written against ext/mysql for
 * the same reason: it is the extension t3lib_db uses, so a successful import here
 * proves the runtime the application will use.
 *
 * Idempotent: it detects an already-populated database and exits early.
 *
 * TYPO3_PROVISION=auto   (default) build the schema and seed an admin user, a
 *                        root page and a root TypoScript template.
 * TYPO3_PROVISION=wizard create the empty database and stop, for the 1-2-3
 *                        install wizard at typo3/install/index.php?mode=123.
 *
 * What is new against 3.8 is the character set. 3.8 asserted latin1; this asserts
 * UTF-8, at the server, the database, a column, and a stored value read back. The
 * reason is that 4.5 connects with
 * SET NAMES utf8 and names no charset on its tables, so a latin1 server would
 * store every character outside latin1 as '?' without an error anywhere.
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
 * Stored as the root page's title and rendered back by the frontend, so the smoke
 * test can check it byte for byte.
 *
 * Every word earns its place. The ø and ö are inside latin1, so on their own they
 * would survive a latin1 server and prove nothing — that is the flaw in a round
 * trip over umlauts alone. The ő (Hungarian, U+0151) and the Japanese are outside
 * latin1 and outside cp1252, so a latin1 column turns them into '?'.
 */
$charsetProbe = 'Skaarhøj · Gödöllő · 日本語';

/**
 * The extensions a fresh 4.5.40 loads, in the order t3lib_extMgm loads them:
 * REQUIRED_EXTENSIONS (t3lib/config_default.php:26) then the default extList
 * (:183), per t3lib_extMgm::getEnabledExtensionList() (t3lib/class.t3lib_extmgm.php:1623).
 * The generated localconf.php overrides neither.
 *
 * Only five of the twenty-two carry an ext_tables.sql — cms, em, tsconfig_help,
 * impexp and felogin — and only em and tsconfig_help carry static data. The rest
 * are listed anyway so this array can be compared with the source line for line.
 */
$loadedExtensions = array(
    'cms', 'lang', 'sv', 'em', 'recordlist',
    'filelist', 'version', 'tsconfig_help', 'context_help', 'extra_page_cm_options',
    'impexp', 'belog', 'about', 'cshmanual', 'aboutmodules', 'setup', 'opendocs',
    'install', 't3editor', 'felogin', 'feedit', 'recycler',
);

/**
 * Split a TYPO3 SQL dump into statements.
 *
 * t3lib_install::getStatementArray() (t3lib/class.t3lib_install.php) is the same
 * algorithm in 4.5 as in 3.8, so this is 3.8's splitSql() unchanged: a
 * statement ends where a *line* ends in a semicolon, and " default '0'" is stripped
 * from auto_increment lines, which MySQL 5.5 would otherwise reject.
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
 * A port of 4.5's t3lib_install::getFieldDefinitions_fileContent()
 * (t3lib/class.t3lib_install.php:466-553), and closer to its source than 3.8's
 * version is to 3.8's, because 4.5's parser does more and the differences reach
 * the database:
 *
 *   - the table options line is read for ENGINE, which every 4.5 core table sets
 *     to InnoDB; MySQL 5.5 defaults to InnoDB anyway, but the DDL should say what
 *     upstream's says
 *   - backticks and doubled blanks are stripped, and "UNIQUE KEY", "FULLTEXT KEY"
 *     and "INDEX" are normalised, so two files declaring one key differently
 *     still merge into one
 *   - COLLATE and CHARSET are read and then discarded, because 4.5's emitter
 *     skips them ("collation support is currently disabled", :924). That is the
 *     half of the UTF-8 problem that lives in TYPO3 rather than in MySQL.
 *
 * @return array<string, array{fields: array<string,string>, keys: array<string,string>, engine: string}>
 */
function parseTableDefinitions($sqlContent, $definitions) {
    $table = '';

    foreach (explode(chr(10), $sqlContent) as $value) {
        $value = trim($value);
        if ($value === '' || substr($value, 0, 1) == '#' || substr($value, 0, 2) == '--') {
            continue;
        }

        if ($table === '') {
            $parts = preg_split('/\s+/', $value);
            if (count($parts) > 2 && strtoupper($parts[0]) === 'CREATE' && strtoupper($parts[1]) === 'TABLE') {
                $table = str_replace('`', '', $parts[2]);
                if (!isset($definitions[$table])) {
                    $definitions[$table] = array('fields' => array(), 'keys' => array(), 'engine' => '');
                }
            }
            continue;
        }

        if (substr($value, 0, 1) == ')' && substr($value, -1) == ';') {
            if (preg_match('/(ENGINE|TYPE)[ ]*=[ ]*([a-zA-Z]*)/', $value, $engine)) {
                $definitions[$table]['engine'] = $engine[2];
            }
            $table = '';
            continue;
        }

        $line = preg_replace('/,$/', '', $value);
        $line = str_replace('`', '', $line);
        $line = str_replace('  ', ' ', $line);
        $parts = explode(' ', $line, 2);

        if (!preg_match('/(PRIMARY|UNIQUE|FULLTEXT|INDEX|KEY)/', $parts[0])) {
            $definition = isset($parts[1]) ? $parts[1] : '';
            if (stristr($definition, 'auto_increment')) {
                $definition = preg_replace("/ default '0'/i", '', $definition);
            }
            $definitions[$table]['fields'][$parts[0]] = $definition;
            continue;
        }

        $line = preg_replace(array('/UNIQUE (INDEX|KEY)/', '/FULLTEXT (INDEX|KEY)/', '/INDEX/'), array('UNIQUE', 'FULLTEXT', 'KEY'), $line);
        $rest = isset($parts[1]) ? $parts[1] : '';
        if (preg_match('/PRIMARY|UNIQUE|FULLTEXT/', $parts[0])) {
            $rest = preg_replace('/^(KEY|INDEX) /', '', $rest);
        }
        $restParts = explode(' ', $rest, 2);
        $keyName = $parts[0] == 'PRIMARY' ? 'PRIMARY' : $restParts[0];
        $definitions[$table]['keys'][$keyName] = $line;
    }

    return $definitions;
}

/**
 * The statement 4.5's t3lib_install::getUpdateSuggestions() emits for a table that
 * does not exist yet (t3lib/class.t3lib_install.php:921-929): fields, then keys,
 * then the options it does not skip — which is ENGINE and nothing else.
 */
function buildCreateStatement($table, $definition) {
    $lines = array();
    foreach ($definition['fields'] as $name => $type) {
        $lines[] = $name . ' ' . $type;
    }
    foreach ($definition['keys'] as $key) {
        $lines[] = $key;
    }

    $statement = 'CREATE TABLE ' . $table . " (\n" . implode(",\n", $lines) . "\n)";
    if ($definition['engine'] !== '') {
        $statement .= ' ENGINE=' . $definition['engine'];
    }

    return $statement;
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

function rejectUnlessUtf8($what, $actual) {
    out($what . ': ' . $actual);
    if ($actual !== 'utf8') {
        fail('expected utf8 for ' . $what . ', got ' . $actual
            . ' — 4.5 speaks UTF-8 to MySQL, so anything else stores characters outside'
            . ' it as "?". Check --character-set-server in compose.yaml.');
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

// The statement TYPO3 sends on every connection it opens, from the setDBinit the
// generated localconf.php writes out. Issued the same way here, as a query rather
// than through mysql_set_charset(), so that the import travels exactly the path
// the application's own writes will.
mysql_query('SET NAMES utf8', $link) or fail('SET NAMES utf8: ' . mysql_error($link));

rejectUnlessUtf8('server charset', readSingleValue($link, 'SELECT @@character_set_server'));
rejectUnlessUtf8('connection charset', readSingleValue($link, 'SELECT @@character_set_connection'));

if (!@mysql_select_db($dbName, $link)) {
    out('database ' . $dbName . ' missing, creating it');
    // No CHARACTER SET clause, because the Install Tool's CREATE DATABASE has none
    // (typo3/sysext/install/mod/class.tx_install.php:3764). The server default is
    // what decides, which is the point of asserting it above.
    if (!mysql_query('CREATE DATABASE ' . $dbName, $link)) {
        fail('cannot create database ' . $dbName . ': ' . mysql_error($link));
    }
    mysql_select_db($dbName, $link) or fail('cannot select ' . $dbName);
}

// The official image creates MYSQL_DATABASE itself, before this script runs, so
// the server default alone does not prove what this database was created with.
rejectUnlessUtf8('database charset', readSingleValue($link, 'SELECT @@character_set_database'));

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
out('empty database, building the TYPO3 4.5.40 schema');

$definitions = parseTableDefinitions(readSqlFile($docRoot . '/t3lib/stddb/tables.sql'), array());
$sources = array('t3lib/stddb/tables.sql');

foreach ($loadedExtensions as $extension) {
    $path = $docRoot . '/typo3/sysext/' . $extension . '/ext_tables.sql';
    if (@is_file($path)) {
        $definitions = parseTableDefinitions(readSqlFile($path), $definitions);
        $sources[] = 'sysext/' . $extension . '/ext_tables.sql';
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
// Run verbatim after the merged schema, as 3.8 does and as the Install Tool's
// separate import action does: these dumps drop and recreate their own tables.
// Both are pure ASCII, so the UTF-8 connection cannot alter a byte of them.
foreach ($loadedExtensions as $extension) {
    $path = $docRoot . '/typo3/sysext/' . $extension . '/ext_tables_static+adt.sql';
    if (@is_file($path)) {
        runStatements($link, splitSql(readSqlFile($path)), 'sysext/' . $extension . '/ext_tables_static+adt.sql');
    }
}

// --- seed a backend administrator -----------------------------------------
// A plain md5, because saltedpasswords is not in the default extList. The login
// form hashes it again with the username and a challenge the server kept in the
// PHP session (t3lib/class.t3lib_userauth.php:1318-1336, "superchallenged").
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

// The UTF-8 round trip, before anything else depends on it. A column that
// is not utf8 is the cause; a stored value that differs is the symptom, and the one
// a visitor would see. Both are checked so a failure says which.
rejectUnlessUtf8('pages.title charset', readSingleValue($link,
    "SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS"
    . " WHERE TABLE_SCHEMA = '" . mysql_real_escape_string($dbName, $link) . "'"
    . " AND TABLE_NAME = 'pages' AND COLUMN_NAME = 'title'"));

$storedTitle = readSingleValue($link, 'SELECT title FROM pages WHERE uid = ' . (int) $rootPageUid);
if ($storedTitle !== $charsetProbe) {
    fail('the root page title did not survive the database: wrote "' . $charsetProbe
        . '", read back "' . $storedTitle . '"');
}
out('UTF-8 round trip through pages.title: ok');

// Plain, as in 3.8, and rendered through the real TypoScript pipeline. page.40 is
// new: it reads the page title back out of the database, so the frontend's HTML
// carries the round trip and the smoke test can see it.
$typoScript = 'page = PAGE' . chr(10)
    . 'page.typeNum = 0' . chr(10)
    . 'page.10 = TEXT' . chr(10)
    . 'page.10.value = TYPO3 4.5.40' . chr(10)
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
