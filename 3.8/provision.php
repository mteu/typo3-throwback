<?php
/**
 * First-boot provisioning for the TYPO3 3.8.1 container.
 *
 * Written against ext/mysql rather than mysqli on purpose. t3lib_db calls
 * mysql_connect() directly (t3lib/class.t3lib_db.php:829) and that extension is
 * the reason PHP 5.6 is the ceiling for this version, so provisioning through the
 * same extension proves the runtime the application will actually use — a
 * successful import here means the backend's database layer will connect too.
 *
 * Idempotent: it detects an already-populated database and exits early, so it is
 * safe to run on every container start.
 *
 * TYPO3_PROVISION=auto   (default) build the schema and seed an admin user, a
 *                        root page and a root TypoScript template, so the stack
 *                        boots straight to a rendering site. This is what the
 *                        stack wants by default: a deterministic starting state
 *                        that needs no interaction.
 * TYPO3_PROVISION=wizard create the empty database and stop, so the
 *                        period-authentic 1-2-3 install wizard at
 *                        typo3/install/index.php?mode=123 can be walked as
 *                        a 2005 administrator would have seen it.
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
 * The extensions TYPO3 3.8.1 loads with no Extension Manager involvement.
 *
 * requiredExt plus extList, in that order, exactly as t3lib_extMgm builds
 * $TYPO3_LOADED_EXT. Both defaults are in t3lib/config_default.php:90-92; the
 * generated localconf.php overrides neither, so this list is what the running
 * site has loaded. Order matters: stddb defines `pages` and cms extends it, so a
 * later definition has to win field by field.
 */
$loadedExtensions = array(
    'cms', 'lang', 'sv',
    'tsconfig_help', 'context_help', 'extra_page_cm_options', 'impexp',
    'belog', 'aboutmodules', 'setup', 'install',
);

/**
 * Split a TYPO3 SQL dump into statements.
 *
 * Mirrors t3lib_install::getStatementArray() (t3lib/class.t3lib_install.php:587),
 * including its two rewrites:
 *
 *   - a statement ends when a *line* ends with a semicolon. Splitting naively on
 *     ";" corrupts the import, because ext_tables_static+adt.sql stores
 *     TypoScript in single-line INSERTs whose data contains semicolons (e.g.
 *     'frameset; top-left-page').
 *   - " default '0'" is stripped from any line mentioning auto_increment. TYPO3's
 *     own importer does this, and it is not cosmetic: the 2005 dumps carry
 *
 *         uid int(11) unsigned DEFAULT '0' NOT NULL auto_increment
 *
 *     which MySQL 5.5 rejects outright with "Invalid default value for 'uid'",
 *     regardless of sql_mode. 19 columns across the loaded extensions hit this.
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

        // '--' is how mysqldump 3.23.49+ writes comments; '#' is the older form.
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
        // mysql_query() takes one statement at a time, without the terminator.
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
 * Merge CREATE TABLE definitions across files, field by field.
 *
 * This is the step 3.3 did not need. 3.3 shipped one complete dump per install;
 * 3.8 splits the schema across t3lib/stddb/tables.sql and one ext_tables.sql per
 * loaded extension, and two tables — `pages` and `cache_imagesizes` — are defined
 * in more than one file. Executing the statements in sequence would therefore try
 * to create `pages` twice, and the cms definition carries only the fields cms
 * adds (url, hidden, keywords, …) without uid, pid or title.
 *
 * TYPO3 resolves this in t3lib_install::getFieldDefinitions_sqlContent()
 * (t3lib/class.t3lib_install.php:273): it reduces every CREATE TABLE to a map of
 * field name to definition, later files overriding earlier ones, and the Install
 * Tool then emits one CREATE TABLE per table from the merged map. This function
 * mirrors that, and keeps insertion order so the generated DDL — and therefore
 * the database — is identical on every run.
 *
 * @return array<string, array{fields: array<string,string>, keys: array<string,string>}>
 */
function parseTableDefinitions($sqlContent, $definitions) {
    $lines = explode(chr(10), $sqlContent);
    $table = '';

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || substr($line, 0, 1) == '#' || substr($line, 0, 2) == '--') {
            continue;
        }

        if (!$table) {
            $parts = explode(' ', $line);
            if (strtoupper($parts[0]) == 'CREATE' && strtoupper($parts[1]) == 'TABLE') {
                $table = trim($parts[2]);
                if (!isset($definitions[$table])) {
                    $definitions[$table] = array('fields' => array(), 'keys' => array());
                }
            }
            continue;
        }

        if (substr($line, 0, 1) == ')') {
            $table = '';
            continue;
        }

        $line = preg_replace('/,$/', '', $line);
        if (stristr($line, 'auto_increment')) {
            $line = preg_replace("/ default '0'/i", '', $line);
        }

        $parts = explode(' ', $line, 2);
        $name = $parts[0];
        $definition = isset($parts[1]) ? $parts[1] : '';
        $upper = strtoupper($name);

        if ($upper == 'PRIMARY' || $upper == 'KEY' || $upper == 'UNIQUE') {
            $keyParts = explode(' ', $definition, 2);
            $keyName = ($upper == 'PRIMARY') ? 'PRIMARY' : $keyParts[0];
            $definitions[$table]['keys'][$keyName] = $line;
        } else {
            $definitions[$table]['fields'][$name] = $definition;
        }
    }

    return $definitions;
}

function buildCreateStatement($table, $definition) {
    $lines = array();
    foreach ($definition['fields'] as $name => $type) {
        $lines[] = '  ' . $name . ' ' . $type;
    }
    foreach ($definition['keys'] as $key) {
        $lines[] = '  ' . $key;
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

// The connection charset is inherited from the server, because t3lib_db issues no
// SET NAMES and never calls mysql_set_charset. 3.8 is an ISO-8859-1 application,
// so this must report latin1 — if it ever reports utf8, the backend renders
// mojibake and the cause is the server flag in compose.yaml, not TYPO3.
$charset = mysql_query('SHOW VARIABLES LIKE "character_set_connection"', $link);
if ($charset && ($row = mysql_fetch_row($charset))) {
    out('connection charset: ' . $row[1]);
    if ($row[1] != 'latin1') {
        fail('expected a latin1 connection, got ' . $row[1]
            . ' — check --character-set-server in compose.yaml');
    }
}

if (!@mysql_select_db($dbName, $link)) {
    out('database ' . $dbName . ' missing, creating it');
    if (!mysql_query('CREATE DATABASE ' . $dbName, $link)) {
        fail('cannot create database ' . $dbName . ': ' . mysql_error($link));
    }
    mysql_select_db($dbName, $link) or fail('cannot select ' . $dbName);
}

// --- wizard mode stops here ------------------------------------------------
// An empty, reachable database is exactly what step 1 of the 1-2-3 wizard wants
// to be handed: it lists the databases the credentials can see and lets you pick
// one to install into.
if ($mode == 'wizard') {
    out('wizard mode: leaving ' . $dbName . ' empty for the 1-2-3 install wizard');
    exit(0);
}

// --- bail out if this database is already provisioned ----------------------
$existing = mysql_query("SHOW TABLES LIKE 'be_users'", $link);
if ($existing && mysql_num_rows($existing)) {
    out('schema already present, nothing to do');
    exit(0);
}

// --- build the schema the Install Tool would build --------------------------
out('empty database, building the TYPO3 3.8.1 schema');

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
// The static templates the frontend offers ("frameset; top-left-page" and the
// rest) and the TSconfig help texts. These dumps drop and recreate their own
// tables, so they are run verbatim after the merged schema rather than folded
// into it — which is also what the Install Tool's separate "import static data"
// action does.
foreach ($loadedExtensions as $extension) {
    $path = $docRoot . '/typo3/sysext/' . $extension . '/ext_tables_static+adt.sql';
    if (@is_file($path)) {
        runStatements($link, splitSql(readSqlFile($path)), 'sysext/' . $extension . '/ext_tables_static+adt.sql');
    }
}

// --- seed a backend administrator -----------------------------------------
// 3.8 predates salted passwords: be_users.password holds a plain md5 of the
// cleartext, which the login form hashes again with the username and a challenge
// (t3lib/class.t3lib_userauth.php:999, "superchallenged").
//
// time() comes from libfaketime (see the Dockerfile), which starts at the release
// date and runs, so the seeded tstamp/crdate say 2005-11-14.
$now = time();
$sql = "INSERT INTO be_users (pid, tstamp, crdate, username, password, admin, disable, deleted, realName, uc, TSconfig, usergroup, userMods, db_mountpoints, file_mountpoints)"
     . " VALUES (0, " . $now . ", " . $now . ", '" . addslashes($adminUser) . "', '" . md5($adminPass) . "', 1, 0, 0, 'Administrator', '', '', '', '', '', '')";
mysql_query($sql, $link) or fail('creating admin user: ' . mysql_error($link));
out('created backend admin "' . $adminUser . '"');

// --- seed a rendering frontend --------------------------------------------
// Without a root page and a root template the frontend can only answer "No
// template found", which makes it impossible to tell a broken stack from an
// empty one.
$sql = "INSERT INTO pages (pid, tstamp, crdate, sorting, title, doktype, hidden, deleted, perms_userid, perms_user, perms_group, perms_everybody)"
     . " VALUES (0, " . $now . ", " . $now . ", 256, 'TYPO3 3.8.1', 1, 0, 0, 1, 31, 31, 31)";
mysql_query($sql, $link) or fail('creating root page: ' . mysql_error($link));
$rootPageUid = mysql_insert_id($link);
out('created root page (uid ' . $rootPageUid . ')');

// Deliberately plain: this renders through the real TypoScript pipeline, so it
// proves the frontend works end to end without dressing up the site with
// content that was never part of the release.
$typoScript = 'page = PAGE' . chr(10)
    . 'page.typeNum = 0' . chr(10)
    . 'page.bodyTag = <body bgcolor="#ffffff">' . chr(10)
    . 'page.10 = TEXT' . chr(10)
    . 'page.10.value = TYPO3 3.8.1' . chr(10)
    . 'page.10.wrap = <h1>|</h1>' . chr(10)
    . 'page.20 = TEXT' . chr(10)
    . 'page.20.value = Rendered by TypoScript on PHP ' . phpversion() . chr(10)
    . 'page.20.wrap = <p>|</p>' . chr(10)
    . 'page.30 = TEXT' . chr(10)
    . 'page.30.data = date:U' . chr(10)
    . 'page.30.strftime = %Y-%m-%d %H:%M:%S' . chr(10)
    // TypoScript trims whitespace around the "|" in a wrap, hence the entity.
    . 'page.30.wrap = <p>Page generated&nbsp;|</p>' . chr(10);

$sql = "INSERT INTO sys_template (pid, tstamp, crdate, sorting, title, root, clear, config, deleted, hidden)"
     . " VALUES (" . $rootPageUid . ", " . $now . ", " . $now . ", 256, 'Main template', 1, 3, '" . addslashes($typoScript) . "', 0, 0)";
mysql_query($sql, $link) or fail('creating root template: ' . mysql_error($link));
out('created root TypoScript template');

out('done');
exit(0);
