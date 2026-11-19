// MySQL 3.23 behaviour of runtime/mysql-sqlite.js, without PHP: the parts
// TYPO3 relies on, and the parts the stack probes (probe/stack-<release>.cjs)
// do not reach, such as the ALTER TABLE the Install Tool's database compare
// sends. Then what the 5.5 server answers on top, for 4.0/provision.php, and
// that 3.23 refuses each of those with its own error. Then a 5.5 server's
// character set, latin1 and utf8 side by side: SET NAMES, the charset
// variables, characters against bytes, case and accents in =, LIKE and
// ORDER BY, and the SHOW statements 4.5's Install Tool sends.
// Usage: node mysql-sqlite.cjs
'use strict';

const assert = require('assert');
const path = require('path');
const MysqlOnSqlite = require('../runtime/mysql-sqlite.js');
const initSqlJs = require(path.join(__dirname, '..', 'node_modules', 'sql.js'));

let failures = 0;
function check(label, test) {
  try {
    test();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}`);
  }
}

function connect(server) {
  const { link } = server.handle(1, 0, 'db', 'typo3', 'typo3');
  const query = sql => server.handle(4, link, sql);
  const rows = sql => {
    const response = query(sql);
    assert.strictEqual(response.kind, 'result', JSON.stringify(response));
    return response.rows;
  };
  const ok = sql => {
    const response = query(sql);
    assert.strictEqual(response.kind, 'ok', JSON.stringify(response));
    return response;
  };
  return { link, query, rows, ok };
}

// What 4.0/provision.php reads, as it sends it.
const PROVISION_COLUMN_CHARSET = "SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS"
  + " WHERE TABLE_SCHEMA = 'typo3' AND TABLE_NAME = 'pages' AND COLUMN_NAME = 'title'";
const CHARSET_VARIABLES = ['character_set_server', 'character_set_connection', 'character_set_database'];

(async () => {
  const SQL = await initSqlJs();
  const now = () => Date.UTC(2002, 5, 3, 12, 0, 0);
  const server = new MysqlOnSqlite(SQL, { users: { typo3: 'typo3' }, now });
  const { link, query, rows, ok } = connect(server);

  check('a wrong password is refused with 3.23\'s message', () => {
    const response = server.handle(1, 0, 'db', 'typo3', 'wrong');
    assert.strictEqual(response.errno, 1045);
    assert.strictEqual(response.message, "Access denied for user: 'typo3@db' (Using password: YES)");
  });

  check('no database selected, then an unknown one', () => {
    assert.strictEqual(query('SELECT * FROM pages').errno, 1046);
    assert.strictEqual(server.handle(3, link, 'nope').errno, 1049);
    ok('CREATE DATABASE typo3');
    assert.strictEqual(query('CREATE DATABASE typo3').errno, 1007);
    assert.strictEqual(server.handle(3, link, 'typo3').kind, 'ok');
  });

  ok(`CREATE TABLE pages (
    uid int(11) unsigned DEFAULT '0' NOT NULL auto_increment,
    pid int(11) unsigned DEFAULT '0' NOT NULL,
    title tinytext NOT NULL,
    alias varchar(10) DEFAULT '' NOT NULL,
    hidden tinyint(4) unsigned DEFAULT '0' NOT NULL,
    price double(16,4) DEFAULT '0.0000' NOT NULL,
    uc blob NOT NULL,
    PRIMARY KEY (uid),
    KEY parent (pid)
  )`);

  check('backslash escapes, both quote styles and a "#" comment', () => {
    ok(`INSERT INTO pages (title) VALUES ('It\\'s a "test"\\r\\nline two') # trailing comment`);
    ok('INSERT INTO pages (title) VALUES ("double \\"quoted\\" and \'single\'")');
    assert.deepStrictEqual(rows('SELECT title FROM pages ORDER BY uid').map(row => row[0]),
      ['It\'s a "test"\r\nline two', 'double "quoted" and \'single\'']);
  });

  check("non-strict writes: '' and '7x' into ints, NULL into NOT NULL, varchar(10) truncates", () => {
    ok("INSERT INTO pages (pid, title, alias, hidden, uc) VALUES ('', NULL, 'longer than ten', '7x', NULL)");
    assert.deepStrictEqual(rows('SELECT pid, title, alias, hidden, uc FROM pages WHERE uid = 3'),
      [['0', '', 'longer tha', '7', '']]);
  });

  check('unsigned columns clamp, tinyint clamps to 255', () => {
    ok("UPDATE pages SET pid = -5, hidden = 300 WHERE uid = 3");
    assert.deepStrictEqual(rows('SELECT pid, hidden FROM pages WHERE uid = 3'), [['0', '255']]);
  });

  check('0 and NULL into auto_increment take the next id; insert id reports it', () => {
    assert.strictEqual(ok("INSERT INTO pages (uid, title) VALUES (0, 'zero')").insertId, 4);
    assert.strictEqual(ok("INSERT INTO pages (uid, title) VALUES (NULL, 'null')").insertId, 5);
    assert.strictEqual(ok("INSERT INTO pages (uid, title) VALUES (20, 'explicit')").insertId, 20);
    assert.strictEqual(ok("INSERT INTO pages (title) VALUES ('after')").insertId, 21);
  });

  check('INSERT without a column list, and INSERT ... SET', () => {
    ok("INSERT INTO pages VALUES (30, 1, 'positional', '', 0, 1.5, '')");
    ok("INSERT INTO pages SET pid = 2, title = 'set form'");
    assert.deepStrictEqual(rows('SELECT uid, pid, title FROM pages WHERE uid >= 30 ORDER BY uid'),
      [['30', '1', 'positional'], ['31', '2', 'set form']]);
  });

  check('double(16,4) comes back with four decimals, as MySQL formats it', () => {
    assert.deepStrictEqual(rows('SELECT price FROM pages WHERE uid = 30'), [['1.5000']]);
  });

  check('text compares case-insensitively; blob does not', () => {
    ok("UPDATE pages SET uc = 'CaseSensitive' WHERE uid = 30");
    assert.strictEqual(rows("SELECT uid FROM pages WHERE title = 'POSITIONAL'").length, 1);
    assert.strictEqual(rows("SELECT uid FROM pages WHERE uc = 'casesensitive'").length, 0);
  });

  check("LIKE escapes with a backslash, as MySQL's does by default", () => {
    ok("INSERT INTO pages (title) VALUES ('be_users'), ('beXusers')");
    assert.deepStrictEqual(rows("SELECT title FROM pages WHERE title LIKE 'be\\_users'"), [['be_users']]);
    assert.strictEqual(rows("SELECT title FROM pages WHERE title LIKE 'be_users'").length, 2);
  });

  check('unaliased expressions are named as written; aliases as given', () => {
    const response = query('SELECT count(*), max(uid), uid+1, pages.title, title AS t FROM pages WHERE uid = 30 GROUP BY uid');
    assert.deepStrictEqual(response.fields.map(field => field.name), ['count(*)', 'max(uid)', 'uid+1', 'title', 't']);
  });

  check('field metadata: types, lengths and flags as 3.23 reports them', () => {
    const response = query('SELECT uid, alias, title, uc, price FROM pages LIMIT 1');
    assert.deepStrictEqual(response.fields.map(field => [field.name, field.table, field.type, field.length, field.flags]), [
      ['uid', 'pages', 3, 11, 1 | 2 | 32 | 512 | 32768],
      ['alias', 'pages', 253, 10, 1],
      ['title', 'pages', 252, 255, 1 | 16],
      ['uc', 'pages', 252, 65535, 1 | 16 | 128],
      ['price', 'pages', 5, 16, 1 | 32768],
    ]);
  });

  check('MySQL functions: IF, CONCAT with NULL, FIND_IN_SET, NOW, UNIX_TIMESTAMP, PASSWORD', () => {
    assert.deepStrictEqual(rows("SELECT IF(1, 'y', 'n'), CONCAT('a', NULL), CONCAT('a', 1), FIND_IN_SET('b', 'a,b,c'), NOW(), UNIX_TIMESTAMP(), PASSWORD('password')"),
      [['y', null, 'a1', '2', '2002-06-03 12:00:00', '1023105600', '5d2e19393cc5ef67']]);
  });

  check('functions with a variable argument count take each count they allow', () => {
    assert.deepStrictEqual(rows("SELECT CONCAT('a'), CONCAT('a', 'b', 'c'), CONCAT_WS('-', 'a', NULL, 'b'), UNIX_TIMESTAMP('2002-06-03 12:00:00'), LOCATE('b', 'abcb'), LOCATE('b', 'abcb', 3), GREATEST(1, 5, 3), LEAST(4, 2)"),
      [['a', 'abc', 'a-b', '1023105600', '2', '4', '5', '2']]);
  });

  check('UPDATE and DELETE with ORDER BY and LIMIT', () => {
    assert.strictEqual(ok("UPDATE pages SET alias = 'first' ORDER BY uid LIMIT 1").affectedRows, 1);
    assert.deepStrictEqual(rows("SELECT uid FROM pages WHERE alias = 'first'"), [['1']]);
    assert.strictEqual(ok('DELETE FROM pages WHERE uid > 30 ORDER BY uid DESC LIMIT 2').affectedRows, 2);
  });

  check('SHOW TABLES, SHOW COLUMNS, SHOW INDEX', () => {
    assert.deepStrictEqual(rows("SHOW TABLES LIKE 'pag%'"), [['pages']]);
    assert.strictEqual(query("SHOW TABLES LIKE 'pag%'").fields[0].name, 'Tables_in_typo3 (pag%)');
    assert.deepStrictEqual(rows('SHOW COLUMNS FROM pages').slice(0, 2), [
      ['uid', 'int(11) unsigned', '', 'PRI', null, 'auto_increment'],
      ['pid', 'int(11) unsigned', '', 'MUL', '0', ''],
    ]);
    assert.deepStrictEqual(rows('SHOW INDEX FROM pages').map(row => [row[2], row[4]]), [['PRIMARY', 'uid'], ['parent', 'pid']]);
  });

  check('ALTER TABLE: add, change, drop a column and a key, keeping the data', () => {
    ok("ALTER TABLE pages ADD subtitle varchar(30) DEFAULT 'none' NOT NULL AFTER title");
    ok("ALTER TABLE pages CHANGE alias nav_alias varchar(5) DEFAULT '' NOT NULL");
    ok('ALTER TABLE pages DROP uc');
    ok('ALTER TABLE pages ADD KEY by_title (title(20))');
    ok('ALTER TABLE pages DROP KEY parent');
    assert.deepStrictEqual(rows('SHOW COLUMNS FROM pages').map(row => row[0]),
      ['uid', 'pid', 'title', 'subtitle', 'nav_alias', 'hidden', 'price']);
    assert.deepStrictEqual(rows('SELECT title, subtitle, nav_alias FROM pages WHERE uid = 1'), [['It\'s a "test"\r\nline two', 'none', 'first']]);
    assert.deepStrictEqual(rows('SHOW INDEX FROM pages').map(row => row[2]), ['PRIMARY', 'by_title']);
    // 32 and 33 were deleted above. MyISAM does not reuse them, and ALTER
    // TABLE keeps its counter.
    assert.strictEqual(ok("INSERT INTO pages (title) VALUES ('after alter')").insertId, 34);
  });

  check('errors: unknown table, unknown column, syntax', () => {
    assert.deepStrictEqual([query('SELECT * FROM nope').errno, query('SELECT nope FROM pages').errno, query('SELEKT 1').errno],
      [1146, 1054, 1064]);
    assert.strictEqual(query('').errno, 1065);
  });

  check('DROP TABLE, and the table is gone from SHOW TABLES', () => {
    ok('CREATE TABLE gone (a int(11) DEFAULT \'0\' NOT NULL)');
    ok('DROP TABLE gone');
    assert.strictEqual(query('DROP TABLE gone').errno, 1051);
    ok('DROP TABLE IF EXISTS gone');
    assert.deepStrictEqual(rows('SHOW TABLES'), [['pages']]);
  });

  check('3.23 refuses the character set variables with 1193, as MySQL 4.1 brought them', () => {
    for (const name of CHARSET_VARIABLES) {
      const response = query(`SELECT @@${name}`);
      assert.deepStrictEqual([response.errno, response.message], [1193, `Unknown system variable '${name}'`]);
    }
  });

  check('3.23 has no information_schema: 1146', () => {
    const response = query(PROVISION_COLUMN_CHARSET);
    assert.deepStrictEqual([response.errno, response.message], [1146, "Table 'information_schema.COLUMNS' doesn't exist"]);
  });

  check("3.23's HEX() is CONV(N,10,16): a string is read as a number", () => {
    assert.deepStrictEqual(rows("SELECT HEX(255), HEX('255'), HEX('abc'), HEX(' 12abc'), HEX(-1), HEX(1.5), HEX(NULL)"),
      [['FF', 'FF', '0', 'C', 'FFFFFFFFFFFFFFFF', '1', null]]);
  });

  check("3.23's SHOW VARIABLES names its one character set variable", () => {
    assert.deepStrictEqual(rows("SHOW VARIABLES LIKE 'character_set%'"), [['character_set', 'latin1']]);
  });

  check('only 3.23.49 and 5.5.62 are imitated', () => {
    assert.throws(() => new MysqlOnSqlite(SQL, { serverVersion: '4.1.22' }), /MySQL 4\.1\.22 is not imitated/);
  });

  const server55 = new MysqlOnSqlite(SQL, { serverVersion: '5.5.62', users: { typo3: 'typo3' }, now });
  const mysql55 = connect(server55);

  check('5.5 tells libmysql its version', () => {
    assert.strictEqual(server55.handle(1, 0, 'db', 'typo3', 'typo3').serverVersion, '5.5.62');
  });

  check('5.5 answers the character set variables with latin1, before and after a database is selected', () => {
    const read = name => {
      const response = mysql55.query(`SELECT @@${name}`);
      assert.strictEqual(response.kind, 'result', JSON.stringify(response));
      assert.strictEqual(response.fields[0].name, `@@${name}`);
      return response.rows;
    };
    for (const name of CHARSET_VARIABLES) {
      assert.deepStrictEqual(read(name), [['latin1']]);
    }
    mysql55.ok('CREATE DATABASE typo3');
    assert.strictEqual(server55.handle(3, mysql55.link, 'typo3').kind, 'ok');
    for (const name of CHARSET_VARIABLES) {
      assert.deepStrictEqual(read(name), [['latin1']]);
    }
    assert.deepStrictEqual(mysql55.rows('SELECT @@CHARACTER_SET_SERVER AS charset'), [['latin1']]);
  });

  mysql55.ok(`CREATE TABLE pages (
    uid int(11) unsigned DEFAULT '0' NOT NULL auto_increment,
    title varchar(255) DEFAULT '' NOT NULL,
    alias varchar(32) binary DEFAULT '' NOT NULL,
    bodytext text,
    tstamp int(11) DEFAULT '0' NOT NULL,
    uc blob NOT NULL,
    PRIMARY KEY (uid)
  )`);

  // t3lib_db::setSqlMode() asks for the session's sql_mode on every connection.
  check('5.5 answers @@SESSION., @@LOCAL. and @@GLOBAL. variables, each column named as asked', () => {
    const scoped = connect(server55);
    scoped.ok('SET NAMES utf8');
    const response = scoped.query('SELECT @@SESSION.sql_mode, @@session.character_set_connection, @@LOCAL.character_set_client, @@GLOBAL.character_set_connection');
    assert.deepStrictEqual(response.rows, [['', 'utf8', 'utf8', 'latin1']]);
    assert.deepStrictEqual(response.fields.map(field => field.name),
      ['@@SESSION.sql_mode', '@@session.character_set_connection', '@@LOCAL.character_set_client', '@@GLOBAL.character_set_connection']);
  });

  check('5.5 answers information_schema.COLUMNS from the table definitions', () => {
    assert.deepStrictEqual(mysql55.rows(PROVISION_COLUMN_CHARSET), [['latin1']]);
    assert.deepStrictEqual(mysql55.rows(`SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT, IS_NULLABLE,
        CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_TYPE
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'typo3' AND TABLE_NAME = 'pages' ORDER BY ORDINAL_POSITION`), [
      ['uid', '1', null, 'NO', null, null, 'int(11) unsigned'],
      ['title', '2', '', 'NO', 'latin1', 'latin1_swedish_ci', 'varchar(255)'],
      ['alias', '3', '', 'NO', 'latin1', 'latin1_bin', 'varchar(32) binary'],
      ['bodytext', '4', null, 'YES', 'latin1', 'latin1_swedish_ci', 'text'],
      ['tstamp', '5', '0', 'NO', null, null, 'int(11)'],
      ['uc', '6', null, 'NO', null, null, 'blob'],
    ]);
  });

  check('5.5 reads information_schema without a database selected, and only COLUMNS', () => {
    const fresh = connect(server55);
    assert.deepStrictEqual(fresh.rows(PROVISION_COLUMN_CHARSET), [['latin1']]);
    assert.strictEqual(fresh.query('SELECT * FROM information_schema.TABLES').errno, 1105);
  });

  check("5.5's HEX(): a string's bytes, so latin1 comes back byte for byte", () => {
    const title = 'Gr\u00fc\u00dfe \u00e0 \u00a9';
    const { insertId } = mysql55.ok(`INSERT INTO pages (title) VALUES ('${title}')`);
    assert.deepStrictEqual(mysql55.rows(`SELECT HEX(title) FROM pages WHERE uid = ${insertId}`),
      [[Buffer.from(title, 'latin1').toString('hex').toUpperCase()]]);
    assert.deepStrictEqual(mysql55.rows("SELECT HEX(255), HEX('255'), HEX(-1), HEX(1.5), HEX(NULL)"),
      [['FF', '323535', 'FFFFFFFFFFFFFFFF', '2', null]]);
  });

  check("5.5's SHOW VARIABLES lists the character set variables", () => {
    assert.deepStrictEqual(mysql55.rows("SHOW VARIABLES LIKE 'character_set%'"), [
      ['character_set_client', 'latin1'], ['character_set_connection', 'latin1'], ['character_set_database', 'latin1'],
      ['character_set_results', 'latin1'], ['character_set_server', 'latin1'], ['character_set_system', 'utf8'],
    ]);
  });

  // --- the character set of a 5.5 server ---------------------------------
  //
  // The same checks against a latin1 server, as the 4.0.13 stack runs, and a
  // utf8 one, as the 4.5.40 stack runs. Strings travel as bytes, one JS char
  // each: utf8() gives the bytes PHP sends for a UTF-8 string.
  const utf8 = text => Buffer.from(text, 'utf8').toString('latin1');
  const latin1 = text => Buffer.from(text, 'latin1').toString('latin1');
  const servers = {};
  for (const [charset, bytes] of [['latin1', latin1], ['utf8', utf8]]) {
    const charsetServer = new MysqlOnSqlite(SQL, { serverVersion: '5.5.62', charset, users: { typo3: 'typo3' }, now });
    const client = connect(charsetServer);
    client.ok('CREATE DATABASE typo3');
    assert.strictEqual(charsetServer.handle(3, client.link, 'typo3').kind, 'ok');
    servers[charset] = { server: charsetServer, client, bytes };
  }

  check('a charset is 5.5 only, and latin1 or utf8', () => {
    assert.strictEqual(new MysqlOnSqlite(SQL).charset, 'latin1');
    assert.throws(() => new MysqlOnSqlite(SQL, { charset: 'utf8' }), /MySQL 3\.23\.49 has one character set, latin1/);
    assert.throws(() => new MysqlOnSqlite(SQL, { serverVersion: '5.5.62', charset: 'utf8mb4' }),
      /The character set utf8mb4 is not imitated, only latin1 and utf8/);
  });

  check("3.23 accepts SET NAMES and SET CHARACTER SET, and they change nothing", () => {
    ok('SET NAMES utf8');
    ok('SET CHARACTER SET utf8');
    assert.deepStrictEqual(rows("SHOW VARIABLES LIKE 'character_set%'"), [['character_set', 'latin1']]);
  });

  check('3.23 has no SHOW CHARACTER SET, and its SHOW TABLE STATUS has 3.23\'s columns', () => {
    assert.strictEqual(query('SHOW CHARACTER SET').errno, 1064);
    const response = query('SHOW TABLE STATUS');
    assert.deepStrictEqual(response.fields.map(field => field.name).slice(0, 3), ['Name', 'Type', 'Row_format']);
    assert.deepStrictEqual(rows('SHOW CREATE TABLE pages')[0][1].split('\n').pop(), ') TYPE=MyISAM');
  });

  for (const [charset, { server: charsetServer, client, bytes }] of Object.entries(servers)) {
    const collation = charset === 'utf8' ? 'utf8_general_ci' : 'latin1_swedish_ci';
    const prefix = `5.5 with ${charset}:`;
    client.ok(`CREATE TABLE pages (
      uid int(11) unsigned NOT NULL auto_increment,
      title varchar(255) DEFAULT '' NOT NULL,
      nav_title varchar(5) DEFAULT '' NOT NULL,
      code char(3) DEFAULT '' NOT NULL,
      alias varchar(32) binary DEFAULT '' NOT NULL,
      tstamp int(11) DEFAULT '0' NOT NULL,
      PRIMARY KEY (uid),
      KEY parent (tstamp, alias)
    ) ENGINE=InnoDB`);
    client.ok("CREATE TABLE old_style (uid int(11) NOT NULL, note varchar(10), PRIMARY KEY (uid)) TYPE=MyISAM DEFAULT CHARSET=latin1");

    check(`${prefix} SET NAMES and SET CHARACTER SET change the connection's variables, and only its own`, () => {
      const other = charset === 'utf8' ? 'latin1' : 'utf8';
      const read = names => client.rows(`SELECT ${names.map(name => `@@character_set_${name}`).join(', ')}`)[0];
      assert.deepStrictEqual(read(['client', 'connection', 'results', 'server', 'database']), Array(5).fill(charset));
      client.ok(`SET NAMES ${other}`);
      assert.deepStrictEqual(read(['client', 'connection', 'results', 'server', 'database']),
        [other, other, other, charset, charset]);
      assert.deepStrictEqual(client.rows('SELECT @@collation_connection, @@collation_server'),
        [[other === 'utf8' ? 'utf8_general_ci' : 'latin1_swedish_ci', collation]]);
      assert.deepStrictEqual(connect(charsetServer).rows('SELECT @@character_set_connection'), [[charset]]);
      client.ok(`SET CHARACTER SET '${other}'`);
      assert.deepStrictEqual(read(['client', 'connection', 'results']), [other, charset, other]);
      client.ok(`SET NAMES ${charset} COLLATE ${collation}`);
      client.ok('SET NAMES DEFAULT');
      assert.deepStrictEqual(read(['client', 'connection', 'results']), [charset, charset, charset]);
      const unknown = client.query('SET NAMES klingon');
      assert.deepStrictEqual([unknown.errno, unknown.message], [1115, "Unknown character set: 'klingon'"]);
    });

    check(`${prefix} the server, the database and information_schema answer ${charset}`, () => {
      assert.deepStrictEqual(client.rows('SELECT @@character_set_server, @@character_set_database'), [[charset, charset]]);
      assert.deepStrictEqual(client.rows(PROVISION_COLUMN_CHARSET), [[charset]]);
      assert.deepStrictEqual(client.rows(`SELECT COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'typo3' AND TABLE_NAME = 'pages' ORDER BY ORDINAL_POSITION`), [
        ['uid', null, null], ['title', charset, collation], ['nav_title', charset, collation], ['code', charset, collation],
        ['alias', charset, `${charset}_bin`], ['tstamp', null, null],
      ]);
      // A table that names its charset keeps it, whatever the server's.
      assert.deepStrictEqual(client.rows(`SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = 'typo3' AND TABLE_NAME = 'old_style' AND COLUMN_NAME = 'note'`), [['latin1', 'latin1_swedish_ci']]);
    });

    // "ő" is not in latin1.
    const town = charset === 'utf8' ? 'Gödöllő' : 'Gödöllö';
    const word = bytes(town);
    check(`${prefix} varchar(n) and char(n) keep n ${charset === 'utf8' ? 'characters' : 'bytes'}`, () => {
      const { insertId } = client.ok(`INSERT INTO pages (title, nav_title, code) VALUES ('${word}', '${word}', '${word}')`);
      const [title, navTitle, code] = client.rows(`SELECT title, nav_title, code FROM pages WHERE uid = ${insertId}`)[0];
      assert.strictEqual(title, word);
      if (charset === 'utf8') {
        assert.strictEqual(navTitle, utf8('Gödöl'));
        assert.strictEqual(code, utf8('Göd'));
      } else {
        assert.strictEqual(navTitle, word.slice(0, 5));
        assert.strictEqual(code, word.slice(0, 3));
      }
      // The latin1 table on any server counts bytes.
      client.ok(`INSERT INTO old_style (uid, note) VALUES (1, '${utf8('ő').repeat(10)}')`);
      assert.deepStrictEqual(client.rows('SELECT LENGTH(note) FROM old_style WHERE uid = 1'), [['10']]);
    });

    check(`${prefix} CHAR_LENGTH() counts ${charset === 'utf8' ? 'characters' : 'bytes'}, LENGTH() bytes`, () => {
      const expected = charset === 'utf8' ? '7' : String(word.length);
      assert.deepStrictEqual(client.rows(`SELECT CHAR_LENGTH('${word}'), LENGTH('${word}')`), [[expected, String(word.length)]]);
      assert.deepStrictEqual(client.rows(`SELECT CHAR_LENGTH(title), LENGTH(title) FROM pages WHERE title = '${word}'`),
        [[expected, String(word.length)]]);
    });

    check(`${prefix} LOWER() and UPPER()`, () => {
      assert.deepStrictEqual(client.rows("SELECT LOWER('Skaarhoj ABC'), UPPER('abc'), LCASE('ABC'), UCASE('abc')"),
        [['skaarhoj abc', 'ABC', 'abc', 'ABC']]);
      if (charset === 'utf8') {
        assert.deepStrictEqual(client.rows(`SELECT LOWER('${utf8('GÖDÖLLŐ')}'), UPPER('${word}'), LCASE('${utf8('Ő')}')`),
          [[utf8('gödöllő'), utf8('GÖDÖLLŐ'), utf8('ő')]]);
      }
    });

    check(`${prefix} =, LIKE and ORDER BY`, () => {
      client.ok('DELETE FROM pages');
      for (const title of ['Zürich', 'Öhringen', 'ober', 'Apfel', town]) {
        client.ok(`INSERT INTO pages (title) VALUES ('${bytes(title)}')`);
      }
      const titles = sql => client.rows(sql).map(row => Buffer.from(row[0], 'latin1').toString(charset === 'utf8' ? 'utf8' : 'latin1'));
      // ASCII is compared without case in both, as SQLite's NOCASE does.
      assert.deepStrictEqual(titles("SELECT title FROM pages WHERE title = 'OBER'"), ['ober']);
      assert.deepStrictEqual(titles("SELECT title FROM pages WHERE title LIKE 'APF%'"), ['Apfel']);
      if (charset === 'utf8') {
        // utf8_general_ci: case and accents do not count.
        assert.deepStrictEqual(titles(`SELECT title FROM pages WHERE title = '${utf8('GÖDÖLLŐ')}'`), ['Gödöllő']);
        assert.deepStrictEqual(titles(`SELECT title FROM pages WHERE pages.title <> '${utf8('GÖDÖLLŐ')}' AND title LIKE '%${utf8('ÜR')}%'`), ['Zürich']);
        assert.deepStrictEqual(titles(`SELECT title FROM pages WHERE '${utf8('göDöllő')}' = title`), ['Gödöllő']);
        assert.deepStrictEqual(titles("SELECT title FROM pages WHERE title LIKE 'g_d_ll_'"), ['Gödöllő']);
        assert.deepStrictEqual(titles("SELECT title FROM pages WHERE title LIKE 'godollo'"), ['Gödöllő']);
        assert.deepStrictEqual(titles("SELECT title FROM pages WHERE title LIKE 'Z\\_rich' OR title LIKE '\\%%'"), []);
        assert.deepStrictEqual(titles('SELECT title FROM pages ORDER BY title'), ['Apfel', 'Gödöllő', 'ober', 'Öhringen', 'Zürich']);
        assert.deepStrictEqual(titles('SELECT title AS t FROM pages ORDER BY t DESC LIMIT 2'), ['Zürich', 'Öhringen']);
        // An UPDATE's SET is left alone; its WHERE compares by weight.
        assert.strictEqual(client.ok(`UPDATE pages SET title = '${utf8('Gödöllő!')}' WHERE title = '${utf8('GODOLLŐ')}'`).affectedRows, 1);
        assert.strictEqual(client.ok(`DELETE FROM pages WHERE title LIKE '${utf8('ÖH%')}' ORDER BY title LIMIT 1`).affectedRows, 1);
        assert.deepStrictEqual(titles('SELECT title FROM pages ORDER BY 1'), ['Apfel', 'Gödöllő!', 'ober', 'Zürich']);
      } else {
        // latin1_swedish_ci sorts Ö after Z; SQLite's NOCASE, byte order,
        // does too. Non-ASCII case is not folded.
        assert.deepStrictEqual(titles('SELECT title FROM pages ORDER BY title'), ['Apfel', town, 'ober', 'Zürich', 'Öhringen']);
        assert.deepStrictEqual(titles(`SELECT title FROM pages WHERE title = '${word}'`), [town]);
      }
    });

    check(`${prefix} SHOW CHARACTER SET`, () => {
      assert.deepStrictEqual(client.rows('SHOW CHARACTER SET'), [
        ['latin1', 'cp1252 West European', 'latin1_swedish_ci', '1'],
        ['utf8', 'UTF-8 Unicode', 'utf8_general_ci', '3'],
      ]);
      assert.deepStrictEqual(client.rows("SHOW CHARSET LIKE 'utf8'"), [['utf8', 'UTF-8 Unicode', 'utf8_general_ci', '3']]);
    });

    check(`${prefix} SHOW TABLE STATUS FROM the database, with 5.5's columns`, () => {
      const response = client.query('SHOW TABLE STATUS FROM `typo3`');
      assert.deepStrictEqual(response.fields.map(field => field.name), ['Name', 'Engine', 'Version', 'Row_format', 'Rows',
        'Avg_row_length', 'Data_length', 'Max_data_length', 'Index_length', 'Data_free', 'Auto_increment', 'Create_time',
        'Update_time', 'Check_time', 'Collation', 'Checksum', 'Create_options', 'Comment']);
      assert.deepStrictEqual(response.rows.map(row => [row[0], row[1], row[3], row[14]]), [
        ['old_style', 'MyISAM', 'Dynamic', 'latin1_swedish_ci'],
        ['pages', 'InnoDB', 'Compact', collation],
      ]);
      assert.deepStrictEqual(client.rows("SHOW TABLE STATUS LIKE 'pages'").map(row => row[0]), ['pages']);
      assert.strictEqual(client.query('SHOW TABLE STATUS FROM nope').errno, 1049);
    });

    check(`${prefix} SHOW KEYS and SHOW INDEX, with 5.5's columns`, () => {
      const response = client.query('SHOW KEYS FROM `pages`');
      assert.deepStrictEqual(response.fields.map(field => field.name), ['Table', 'Non_unique', 'Key_name', 'Seq_in_index',
        'Column_name', 'Collation', 'Cardinality', 'Sub_part', 'Packed', 'Null', 'Index_type', 'Comment', 'Index_comment']);
      assert.deepStrictEqual(response.rows.map(row => [row[2], row[3], row[4], row[9], row[10]]), [
        ['PRIMARY', '1', 'uid', '', 'BTREE'], ['parent', '1', 'tstamp', '', 'BTREE'], ['parent', '2', 'alias', '', 'BTREE'],
      ]);
      assert.deepStrictEqual(client.rows('SHOW INDEX FROM pages'), response.rows);
    });

    check(`${prefix} ENGINE and DEFAULT CHARSET are kept, and ALTER TABLE ENGINE changes the engine`, () => {
      assert.strictEqual(client.rows('SHOW CREATE TABLE pages')[0][1].split('\n').pop(), `) ENGINE=InnoDB DEFAULT CHARSET=${charset}`);
      assert.strictEqual(client.rows('SHOW CREATE TABLE old_style')[0][1].split('\n').pop(), ') ENGINE=MyISAM DEFAULT CHARSET=latin1');
      client.ok('ALTER TABLE old_style ENGINE=InnoDB');
      assert.strictEqual(client.rows('SHOW CREATE TABLE old_style')[0][1].split('\n').pop(), ') ENGINE=InnoDB DEFAULT CHARSET=latin1');
      client.ok('ALTER TABLE pages ADD subtitle varchar(3) DEFAULT \'\' NOT NULL');
      assert.deepStrictEqual(client.rows(`SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS
        WHERE TABLE_NAME = 'pages' AND COLUMN_NAME = 'subtitle'`), [[charset]]);
    });

    check(`${prefix} a restored database keeps each table's charset`, () => {
      const restored = new MysqlOnSqlite(SQL, { serverVersion: '5.5.62', charset, users: { typo3: 'typo3' }, now });
      restored.addDatabase('typo3', charsetServer.exportDatabase('typo3'));
      const again = connect(restored);
      assert.strictEqual(restored.handle(3, again.link, 'typo3').kind, 'ok');
      const { insertId } = again.ok(`INSERT INTO pages (nav_title) VALUES ('${word}')`);
      assert.strictEqual(again.rows(`SELECT nav_title FROM pages WHERE uid = ${insertId}`)[0][0],
        charset === 'utf8' ? utf8('Gödöl') : word.slice(0, 5));
      assert.strictEqual(again.rows('SHOW CREATE TABLE old_style')[0][1].split('\n').pop(), ') ENGINE=InnoDB DEFAULT CHARSET=latin1');
    });
  }

  // --- strings with a NUL byte ----------------------------------------------
  //
  // serialize() writes one on each side of a protected property's name, and
  // TYPO3 stores serialized objects in its sessions, be_users.uc and its
  // caches. PHP's mysql_real_escape_string() sends the byte as \0. Every
  // server mode keeps such a string byte for byte.
  const OBJECT = 'O:4:"Demo":2:{s:7:"\0*\0name";s:3:"x\xe4y";s:10:"\0Demo\0uid";i:7;}';
  const sqlString = text => `'${text.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/'/g, "\\'")}'`;
  for (const [serverVersion, charset] of [['3.23.49', 'latin1'], ['5.5.62', 'latin1'], ['5.5.62', 'utf8']]) {
    const prefix = `${serverVersion} ${charset}, NUL bytes:`;
    const nulServer = new MysqlOnSqlite(SQL, { serverVersion, ...(serverVersion === '5.5.62' ? { charset } : {}), users: { typo3: 'typo3' }, now });
    const client = connect(nulServer);
    client.ok('CREATE DATABASE typo3');
    assert.strictEqual(nulServer.handle(3, client.link, 'typo3').kind, 'ok');
    client.ok(`CREATE TABLE sessions (
      uid int(11) unsigned NOT NULL auto_increment,
      title varchar(20) DEFAULT '' NOT NULL,
      data mediumtext,
      uc blob,
      PRIMARY KEY (uid)
    )`);

    check(`${prefix} INSERT keeps a serialized object byte for byte, in text and blob columns`, () => {
      const { insertId } = client.ok(`INSERT INTO sessions (title, data, uc) VALUES ('a\\0b', ${sqlString(OBJECT)}, ${sqlString(OBJECT)})`);
      assert.deepStrictEqual(client.rows(`SELECT title, data, uc FROM sessions WHERE uid = ${insertId}`), [['a\0b', OBJECT, OBJECT]]);
      const response = client.query(`SELECT data FROM sessions WHERE uid = ${insertId}`);
      assert.strictEqual(response.fields[0].maxLength, OBJECT.length);
    });

    check(`${prefix} LENGTH() counts bytes and CHAR_LENGTH() characters`, () => {
      assert.deepStrictEqual(client.rows("SELECT LENGTH(title), CHAR_LENGTH(title), LENGTH(data) FROM sessions WHERE uid = 1"),
        [['3', '3', String(OBJECT.length)]]);
    });

    check(`${prefix} UPDATE writes one, and = finds the row by its bytes`, () => {
      client.ok("INSERT INTO sessions (title) VALUES ('plain')");
      assert.strictEqual(client.ok(`UPDATE sessions SET data = ${sqlString(`${OBJECT}\0`)} WHERE title = 'plain'`).affectedRows, 1);
      assert.deepStrictEqual(client.rows(`SELECT title FROM sessions WHERE data = ${sqlString(`${OBJECT}\0`)}`), [['plain']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title = 'a\\0b'"), [['1']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title = 'a\\0c'"), []);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title = 'PLAIN'"), [['2']]);
    });

    check(`${prefix} LIKE matches past the NUL byte, and ASCII letters without case`, () => {
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title LIKE '%B'"), [['1']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title LIKE 'a_b'"), [['1']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title LIKE 'a\\0%'"), [['1']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE data LIKE '%\\0Demo\\0uid%' ORDER BY uid"), [['1'], ['2']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title LIKE 'P_A%'"), [['2']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title NOT LIKE '%a%'"), []);
    });

    check(`${prefix} functions keep the byte: CONCAT, LEFT, SUBSTRING, UCASE, HEX`, () => {
      assert.deepStrictEqual(client.rows("SELECT CONCAT(title, '!'), LEFT(title, 2), SUBSTRING(title, 2), UCASE(title) FROM sessions WHERE uid = 1"),
        [['a\0b!', 'a\0', '\0b', 'A\0B']]);
      assert.deepStrictEqual(client.rows("SELECT CONCAT('x\\0', 'y')"), [['x\0y']]);
      if (serverVersion === '5.5.62') {
        assert.deepStrictEqual(client.rows("SELECT HEX(title) FROM sessions WHERE uid = 1"), [['610062']]);
      }
    });

    check(`${prefix} ORDER BY puts a string with one after every string without`, () => {
      client.ok("INSERT INTO sessions (title) VALUES ('zzz'), ('a\\0a')");
      assert.deepStrictEqual(client.rows('SELECT title FROM sessions ORDER BY title'), [['plain'], ['zzz'], ['a\0a'], ['a\0b']]);
    });

    // The site exports its database after every write, and goes on serving.
    check(`${serverVersion} ${charset}: after an export, the server's own functions still answer`, () => {
      nulServer.exportDatabase('typo3');
      assert.deepStrictEqual(client.rows("SELECT FIND_IN_SET('b', 'a,b'), CONCAT('x', 'y'), UNIX_TIMESTAMP(), CHAR_LENGTH('abc')"),
        [['2', 'xy', String(now() / 1000), '3']]);
      assert.deepStrictEqual(client.rows("SELECT uid FROM sessions WHERE title LIKE '%B'"), [['1']]);
    });

    check(`${prefix} a restored database keeps it`, () => {
      const restored = new MysqlOnSqlite(SQL, { serverVersion, ...(serverVersion === '5.5.62' ? { charset } : {}), users: { typo3: 'typo3' }, now });
      restored.addDatabase('typo3', nulServer.exportDatabase('typo3'));
      const again = connect(restored);
      assert.strictEqual(restored.handle(3, again.link, 'typo3').kind, 'ok');
      assert.deepStrictEqual(again.rows('SELECT data FROM sessions WHERE uid = 1'), [[OBJECT]]);
    });
  }

  console.log(failures === 0 ? 'mysql on sqlite: all checks passed' : `mysql on sqlite: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
