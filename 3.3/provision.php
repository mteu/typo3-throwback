<?php
/**
 * First-boot provisioning for the TYPO3 3.3.0 container.
 *
 * Deliberately written in PHP 4 and run with the PHP 4 CLI, because the client
 * library compiled into this PHP (libmysqlclient 3.23) is the only one in the
 * image that can authenticate against the database at all — every modern mysql
 * client refuses the pre-4.1 password hashes this stack relies on.
 *
 * Idempotent: it detects an already-populated database and exits early, so it is
 * safe to run on every container start.
 *
 * TYPO3_PROVISION=auto   (default) import the schema and seed an admin user, a
 *                        root page and a root TypoScript template built on the
 *                        shipped "template; GREEN", so the stack boots straight
 *                        to a rendering site: a deterministic starting state
 *                        that needs no interaction.
 * TYPO3_PROVISION=wizard create the empty database and stop, so the
 *                        period-authentic 1-2-3 install wizard at
 *                        typo3/install/index.php?mode=123 can be walked as a
 *                        2002 administrator would have seen it.
 * TYPO3_PROVISION=preprovisioned
 *                        import nothing: the database's datadir already carries
 *                        the end state of an auto run, baked ahead of time. For
 *                        callers who cannot afford the import on every boot.
 *
 * preprovisioned is not auto-with-a-shortcut, and the difference is the whole
 * reason it exists. auto reaches the same place from an empty database by
 * importing, so against a datadir that failed to bake it would quietly spend
 * minutes doing the work again and the stack would look merely slow. This mode
 * refuses instead, and says which half of the pairing is missing: a datadir the
 * image was supposed to carry, or credentials localconf.php and the baked grants
 * no longer agree on.
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

$mode   = env('TYPO3_PROVISION', 'auto');
$srcDir = env('TYPO3_SRC', '/opt/typo3_src-3.3.0');

/**
 * Split a TYPO3 SQL dump into statements.
 *
 * Mirrors t3lib_install::getStatementArray(): a statement ends when a *line*
 * ends with a semicolon. Splitting naively on ";" corrupts the import, because
 * static+adt.sql stores TypoScript in single-line INSERTs whose data contains
 * semicolons (e.g. 'frameset; top-left-page').
 */
function splitSql($sqlcode) {
    $lines = explode(chr(10), $sqlcode);
    $statements = array();
    $p = 0;

    foreach ($lines as $line) {
        $trimmed = trim($line);
        $isSet = 0;

        if (strcmp($trimmed, '') && substr($trimmed, 0, 1) != '#') {
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
        if (strcmp($statement, '')) {
            $result[] = $statement;
        }
    }

    return $result;
}

/**
 * Bring 2002-era DDL up to something MySQL 5.5 will accept.
 *
 * TYPO3 3.3's dumps were written for MySQL 3.23, which tolerated a DEFAULT on an
 * AUTO_INCREMENT column:
 *
 *   uid int(11) unsigned DEFAULT '0' NOT NULL auto_increment
 *
 * Every MySQL from 5.5 on rejects that outright with "Invalid default value for
 * 'uid'", regardless of sql_mode — which is why 3.8's trick of relaxing
 * sql_mode is not enough here. The redundant DEFAULT is dropped instead. It is
 * the only incompatibility in the shipped dumps: there are no TYPE=MyISAM engine
 * clauses and no display-width timestamp columns to rewrite.
 */
function modernizeDdl($statement) {
    return preg_replace(
        "/DEFAULT\s+'[^']*'\s+(NOT\s+NULL\s+auto_increment)/i",
        '\\1',
        $statement
    );
}

function importSqlFile($link, $path) {
    if (!@is_file($path)) {
        fail('SQL file not found: ' . $path);
    }

    $statements = splitSql(file_get_contents($path));
    $count = 0;

    foreach ($statements as $statement) {
        $statement = modernizeDdl($statement);
        if (!mysql_query($statement, $link)) {
            fail('while importing ' . basename($path) . ': ' . mysql_error($link)
                . "\nstatement: " . substr($statement, 0, 200));
        }
        $count++;
    }

    out('imported ' . $count . ' statements from ' . basename($path));
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

if (!@mysql_select_db($dbName, $link)) {
    if ($mode == 'preprovisioned') {
        fail('database ' . $dbName . ' does not exist on a server whose datadir was'
            . ' supposed to carry it. The database image is not a pre-provisioned one,'
            . ' or its /var/lib/mysql was masked by a mount.');
    }

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

// --- what the datadir already carries --------------------------------------
$existing = mysql_query("SHOW TABLES LIKE 'be_users'", $link);
$hasSchema = $existing && mysql_num_rows($existing);

// --- the baked datadir, checked rather than trusted -------------------------
// Two things have to hold for the stack to be worth handing to anyone, and both are
// cheap to ask. A stack that comes up without them serves "No template found" or
// a login nobody has an account for, which reads as a broken TYPO3 and is really
// a broken build.
if ($mode == 'preprovisioned') {
    if (!$hasSchema) {
        fail('no be_users table in ' . $dbName . '. This server\'s datadir was not'
            . ' pre-provisioned, so there is nothing here to serve. Use'
            . ' TYPO3_PROVISION=auto against a plain mysql:5.5.');
    }

    $seeded = mysql_query('SELECT uid FROM pages WHERE pid = 0 AND deleted = 0 LIMIT 1', $link);
    if (!$seeded || !mysql_num_rows($seeded)) {
        fail('the schema is present but no root page is. The bake imported the 2002'
            . ' dumps and then failed before seeding, which would serve'
            . ' "No template found".');
    }

    out('pre-provisioned datadir: schema and seed content present, importing nothing');
    exit(0);
}

// --- bail out if this database is already provisioned ----------------------
if ($hasSchema) {
    out('schema already present, nothing to do');
    exit(0);
}

// --- import the schema TYPO3's own Install Tool would import ---------------
out('empty database, importing TYPO3 ' . basename($srcDir) . ' schema');
importSqlFile($link, $srcDir . '/t3lib/install/tables.sql');
importSqlFile($link, $srcDir . '/t3lib/install/static+adt.sql');

// --- seed a backend administrator -----------------------------------------
// TYPO3 3.3 predates salted passwords: be_users.password is a plain md5 of the
// cleartext, which the login form challenge-hashes again in JavaScript.
//
// time() comes from libfaketime, set by the caller (compose.yaml starts it at the
// release date and lets it run), so the seeded tstamp/crdate say 2002-06-03.
//
// fileoper_perms is 7, as 3.3.0's own Install Tool sets it when it creates an
// admin (t3lib/class.t3lib_install.php:3009). admin = 1 does not cover file
// operations: tce_file.php reads this field alone (t3lib_extFileFunctions::
// init_actionPerms), and at its default of 0 even an admin gets "You are not
// allowed to upload files!". 1 is files (upload, copy, move, delete, rename),
// 2 is unzip, 4 is folders.
$now = time();
$sql = "INSERT INTO be_users (pid, tstamp, crdate, username, password, admin, disable, deleted, realName, uc, TSconfig, usergroup, userMods, db_mountpoints, file_mountpoints, fileoper_perms)"
     . " VALUES (0, " . $now . ", " . $now . ", '" . addslashes($adminUser) . "', '" . md5($adminPass) . "', 1, 0, 0, 'Administrator', '', '', '', '', '', '', 7)";
mysql_query($sql, $link) or fail('creating admin user: ' . mysql_error($link));
out('created backend admin "' . $adminUser . '"');

// --- seed a rendering frontend --------------------------------------------
// Without a root page and a root template the frontend can only answer "No
// template found", which makes it impossible to tell a broken stack from an
// empty one.
$sql = "INSERT INTO pages (pid, tstamp, crdate, sorting, title, doktype, hidden, deleted, perms_userid, perms_user, perms_group, perms_everybody)"
     . " VALUES (0, " . $now . ", " . $now . ", 256, 'TYPO3 3.3.0', 1, 0, 0, 1, 31, 31, 31)";
mysql_query($sql, $link) or fail('creating root page: ' . mysql_error($link));
$rootPageUid = mysql_insert_id($link);
out('created root page (uid ' . $rootPageUid . ')');

// The site is "template; GREEN", one of the standard templates static+adt.sql
// imported above, included the way a 2002 administrator would have: by uid, from
// the template record's include_static field. Nothing is dressed up that the
// release did not ship: the design, its HTML file and its images are all 3.3.0's
// own, and the stack looks like a TYPO3 site rather than a probe.
//
// GREEN is a single page built from an HTML file rather than a frameset. It also
// puts a good deal of the frontend on one page: TEMPLATE, IMAGE,
// styles.content.get, and a GMENU_LAYERS menu, which, with one page in the tree
// and no subpages, has nothing to list and renders empty.
//
// By uid rather than by title, because that is what include_static holds; the uid
// is fixed by the INSERT in static+adt.sql, which is frozen. GREEN's own
// include_static pulls in 75, 43 and 68 (its menu, content (default) and
// plugin.meta), and t3lib_tstemplate resolves that recursively.
$greenStaticTemplateUid = 74;
$green = mysql_query('SELECT title FROM static_template WHERE uid = ' . $greenStaticTemplateUid, $link);
$greenRow = $green ? mysql_fetch_row($green) : false;
if (!$greenRow || $greenRow[0] != 'template; GREEN') {
    fail('static_template uid ' . $greenStaticTemplateUid . ' is not "template; GREEN".'
        . ' static+adt.sql is not the dump this seed was written against.');
}

// Appended to GREEN's page object rather than replacing it, because 3.3 processes
// a record's static templates before its own setup. These two lines are the
// evidence the smoke test reads: that PHP 4.4.9 rendered the page, and that the
// clock is frozen. GREEN's own page title is what proves the template itself
// rendered.
$typoScript = 'page.20 = TEXT' . chr(10)
    . 'page.20.value = Rendered by TypoScript on PHP ' . phpversion() . chr(10)
    . 'page.20.wrap = <p>|</p>' . chr(10)
    . 'page.30 = TEXT' . chr(10)
    . 'page.30.data = date:U' . chr(10)
    . 'page.30.strftime = %Y-%m-%d %H:%M:%S' . chr(10)
    // TypoScript trims whitespace around the "|" in a wrap, hence the entity.
    . 'page.30.wrap = <p>Page generated&nbsp;|</p>' . chr(10);

$sql = "INSERT INTO sys_template (pid, tstamp, crdate, sorting, title, root, clear, include_static, config, deleted, hidden)"
     . " VALUES (" . $rootPageUid . ", " . $now . ", " . $now . ", 256, 'Main template', 1, 3, '" . $greenStaticTemplateUid . "', '" . addslashes($typoScript) . "', 0, 0)";
mysql_query($sql, $link) or fail('creating root template: ' . mysql_error($link));
out('created root TypoScript template, including "template; GREEN"');

out('done');
exit(0);
