<?php
/**
 * Database checks and seed content for the TYPO3 6.2.31 container.
 *
 * Unlike the provision.php of 3.8, 4.0 and 4.5, this one builds no schema. 6.2's
 * own installer does that, driven by install.php, for the reasons that file's
 * docblock gives. What is left here is what the installer does not do: refuse a
 * database that is not UTF-8, and seed the root page, its template and the probe.
 *
 * Written against mysqli, because that is what 6.2 uses
 * (typo3/sysext/core/Classes/Database/DatabaseConnection.php:1190), and ext/mysql
 * is not installed in this image at all.
 *
 *   php provision.php preflight   before the installer: the server and database
 *                                 must be utf8, and the database empty
 *   php provision.php seed        after it: root page, template, round trip
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
$siteName = env('TYPO3_SITENAME', 'TYPO3 6.2.31');

$mode = isset($argv[1]) ? $argv[1] : '';
if ($mode !== 'preflight' && $mode !== 'seed') {
    fail('usage: provision.php preflight|seed');
}

/**
 * 4.5's probe, unchanged and stored as UTF-8, because 6.2 is UTF-8 end to end.
 * The ø and ö are inside latin1; the ő and the Japanese are not, so they only
 * survive a database that really stores UTF-8.
 */
$charsetProbe = 'Skaarhøj · Gödöllő · 日本語';

function readSingleValue(mysqli $link, $query) {
    $result = $link->query($query);
    if (!$result) {
        fail('query failed: ' . $query . ': ' . $link->error);
    }
    $row = $result->fetch_row();

    return $row ? $row[0] : null;
}

function rejectUnlessUtf8($what, $actual) {
    out($what . ': ' . $actual);
    if ($actual !== 'utf8') {
        fail('expected utf8 for ' . $what . ', got ' . $actual
            . ' - 6.2 connects as utf8 and its installer names no charset on the tables it'
            . ' creates in an existing database, so anything else stores characters outside'
            . ' it as "?". Check --character-set-server in compose.yaml.');
    }
}

// --- wait for the database -------------------------------------------------
mysqli_report(MYSQLI_REPORT_OFF);
$link = null;
for ($i = 1; $i <= 60; $i++) {
    $link = @new mysqli($dbHost, $dbUser, $dbPass, $dbName);
    if (!$link->connect_errno) {
        break;
    }
    if ($i == 1) {
        out('waiting for ' . $dbHost . ' ...');
    }
    $link = null;
    sleep(2);
}
if (!$link) {
    fail('could not connect to ' . $dbHost . ' as ' . $dbUser . ': ' . mysqli_connect_error());
}

// The call 6.2 makes on every connection it opens
// (DatabaseConnection.php:1204, connectionCharset 'utf8', :134), made the same
// way here, so the seed travels the path the application's own writes will.
$link->set_charset('utf8') or fail('set_charset(utf8): ' . $link->error);

out('connected to MySQL ' . $link->server_info . ' (client ' . mysqli_get_client_info() . ')');

rejectUnlessUtf8('server charset', readSingleValue($link, 'SELECT @@character_set_server'));
rejectUnlessUtf8('connection charset', readSingleValue($link, 'SELECT @@character_set_connection'));
// The official mysql image creates MYSQL_DATABASE before anything else runs, and
// the installer is then told to use it as it is, so this is the charset every
// table will take.
rejectUnlessUtf8('database charset', readSingleValue($link, 'SELECT @@character_set_database'));

if ($mode === 'preflight') {
    // The installer only accepts an existing database while it is empty
    // (DatabaseSelect.php, execute()), and silently writes nothing if it is not.
    // Saying so here is kinder than a step that repeats with no reason given.
    $tables = (int) readSingleValue($link, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '"
        . $link->real_escape_string($dbName) . "'");
    if ($tables > 0) {
        fail('database ' . $dbName . ' already has ' . $tables . ' tables but typo3conf/ has no'
            . ' LocalConfiguration.php, so the two are out of step. The installer will not install'
            . ' into a database that is not empty. Start again with `docker compose down -v`.');
    }
    out('database ' . $dbName . ' is empty, ready for the installer');
    exit(0);
}

// --- seed ------------------------------------------------------------------
$existing = (int) readSingleValue($link, 'SELECT COUNT(*) FROM pages WHERE deleted = 0');
if ($existing > 0) {
    out('pages already seeded, nothing to do');
    exit(0);
}

$tableCount = (int) readSingleValue($link, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '"
    . $link->real_escape_string($dbName) . "'");
$cachingTables = (int) readSingleValue($link, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '"
    . $link->real_escape_string($dbName) . "' AND TABLE_NAME LIKE 'cf\\_%'");
out('the installer created ' . $tableCount . ' tables, ' . $cachingTables . ' of them for the caching framework');
if ($cachingTables === 0) {
    fail('no cf_* tables: the caching framework schema, which no SQL file carries, was not created');
}

// time() is frozen by libfaketime, so tstamp/crdate are identical on every run.
$now = time();

$stmt = $link->prepare('INSERT INTO pages (pid, tstamp, crdate, sorting, title, doktype, hidden, deleted,'
    . ' is_siteroot, perms_userid, perms_user, perms_group, perms_everybody) VALUES (0, ?, ?, 256, ?, 1, 0, 0, 1, 1, 31, 31, 31)');
$stmt->bind_param('iis', $now, $now, $charsetProbe);
$stmt->execute() or fail('creating root page: ' . $stmt->error);
$rootPageUid = $link->insert_id;
out('created root page (uid ' . $rootPageUid . ')');

rejectUnlessUtf8('pages.title charset', readSingleValue($link,
    "SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS"
    . " WHERE TABLE_SCHEMA = '" . $link->real_escape_string($dbName) . "'"
    . " AND TABLE_NAME = 'pages' AND COLUMN_NAME = 'title'"));

$storedTitle = readSingleValue($link, 'SELECT title FROM pages WHERE uid = ' . (int) $rootPageUid);
if ($storedTitle !== $charsetProbe) {
    fail('the root page title did not survive the database: wrote "' . $charsetProbe
        . '", read back "' . $storedTitle . '"');
}
out('UTF-8 round trip through pages.title: ok');

// The same template 4.5's stack seeds, so the two frontends can be compared line
// for line. page.40 reads the title back out of the database.
$typoScript = 'page = PAGE' . chr(10)
    . 'page.typeNum = 0' . chr(10)
    . 'page.10 = TEXT' . chr(10)
    . 'page.10.value = ' . $siteName . chr(10)
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

$stmt = $link->prepare('INSERT INTO sys_template (pid, tstamp, crdate, sorting, title, root, clear, config, deleted, hidden)'
    . " VALUES (?, ?, ?, 256, 'Main template', 1, 3, ?, 0, 0)");
$stmt->bind_param('iiis', $rootPageUid, $now, $now, $typoScript);
$stmt->execute() or fail('creating root template: ' . $stmt->error);
out('created root TypoScript template');

out('done');
exit(0);
