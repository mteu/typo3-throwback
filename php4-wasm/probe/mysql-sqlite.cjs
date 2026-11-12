// MySQL 3.23 behaviour of runtime/mysql-sqlite.js, without PHP: the parts
// TYPO3 relies on, and the parts probe/typo3-stack.cjs does not reach, such
// as the ALTER TABLE the Install Tool's database compare sends.
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

(async () => {
  const server = new MysqlOnSqlite(await initSqlJs(), { users: { typo3: 'typo3' }, now: () => Date.UTC(2002, 5, 3, 12, 0, 0) });
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

  console.log(failures === 0 ? 'mysql on sqlite: all checks passed' : `mysql on sqlite: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
