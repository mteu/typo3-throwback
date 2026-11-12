// TYPO3 3.3.0 on the WebAssembly stack, held to the 3.3 assertions in
// .github/workflows/images.yml. One PHP instance, one MySQL-on-SQLite server:
//
//   3.3/provision.php, unchanged, imports the schema and seeds the site
//   the frontend renders "template; GREEN" with the seeded page
//   the backend serves its login form, and the Install Tool answers
//   the 2002 challenge-response login works, and alt_doc.php edits a record
//   a client with no cookie gets a session of its own
//   the database exports and reloads, and the reloaded site renders the same
//   GD draws GREEN's GIFBUILDER menu, titles in TrueType text, once the site
//   has subpages
//   the Install Tool's GD tests pass, and its ImageMagick tests say they are
//   skipped
//   every clock PHP and the server read starts at noon on the release day,
//   in UTC, whatever the host's time zone
//
// Usage: node typo3-stack.cjs <sapi-node-build-dir> <prepared-3.3.0-tree> <scratch-dir>
// The tree must carry 3.3/Dockerfile's two source edits; check.sh makes it.
'use strict';

// Far from UTC on purpose: the stack runs in UTC, as the container does, and
// must not take the host's zone from the JS Date. Node applies a TZ set here.
process.env.TZ = 'Asia/Tokyo';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Php4Runtime = require('../runtime/php4-runtime.js');
const MysqlOnSqlite = require('../runtime/mysql-sqlite.js');
const Typo3Site = require('../runtime/typo3-site.js');
const { buildDocroot } = require('./docroot.cjs');

const [buildDir, typo3Src, scratch] = process.argv.slice(2).map(p => path.resolve(p));
const repoRoot = path.resolve(__dirname, '..', '..');
const initSqlJs = require(path.join(__dirname, '..', 'node_modules', 'sql.js'));
// The User-Agent CI sends: 3.3 refuses anything it does not take for a "4+ browser".
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
// Noon on the release day, UTC, where 3.3/compose.yaml starts libfaketime.
const RELEASE_NOON_MS = Date.UTC(2002, 5, 3, 12, 0, 0);
const md5 = text => crypto.createHash('md5').update(text, 'latin1').digest('hex');

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

function cookiesFrom(response) {
  return response.headers
    .filter(([name]) => name.toLowerCase() === 'set-cookie')
    .map(([, value]) => value.split(';')[0]);
}

async function startSite(createPhp4, iniText, docroot, databaseBytes) {
  const SQL = await initSqlJs();
  const clock = Php4Runtime.clockStartingAt(RELEASE_NOON_MS);
  const mysql = new MysqlOnSqlite(SQL, { users: { typo3: 'typo3' }, now: clock });
  if (databaseBytes) {
    mysql.addDatabase('typo3', databaseBytes);
  }
  const php = await Php4Runtime.create(createPhp4, {
    iniSearchPath: path.join(scratch, `ini-${databaseBytes ? 'reloaded' : 'first'}`),
    iniText,
    mysql,
    clock,
  });
  const get = (urlPath, { query = '', headers = {}, method = 'GET', body = null } = {}) => php.request({
    method,
    scriptFilename: path.join(docroot, urlPath),
    scriptName: `/${urlPath}`,
    queryString: query,
    headers: { Host: 'localhost', 'User-Agent': USER_AGENT, ...headers },
    body,
  });
  return { mysql, php, get };
}

(async () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  const docroot = buildDocroot(path.join(scratch, 'docroot'), typo3Src, [
    // 3.3/entrypoint.sh's auto-mode localconf.php, but for ImageMagick, which
    // WebAssembly cannot run: GD alone, as runtime/typo3-site.js configures it.
    "$typo_db_username = 'typo3';",
    "$typo_db_password = 'typo3';",
    "$typo_db_host     = 'db';",
    "$typo_db          = 'typo3';",
    "$TYPO3_CONF_VARS['SYS']['sitename'] = 'TYPO3 3.3.0 in WebAssembly';",
    `$TYPO3_CONF_VARS['BE']['installToolPassword'] = '${md5('joh316')}';`,
    "$TYPO3_CONF_VARS['GFX']['image_processing'] = 1;",
    "$TYPO3_CONF_VARS['GFX']['im'] = 0;",
    "$TYPO3_CONF_VARS['GFX']['gdlib'] = 1;",
    "$TYPO3_CONF_VARS['GFX']['gdlib_png'] = 0;",
    // No processes either: file operations such as moving an upload into
    // fileadmin/ use PHP's functions instead of exec('mv ...'), as 3.3.0
    // does on Windows (t3lib/class.t3lib_extfilefunc.php:116).
    "$TYPO3_CONF_VARS['BE']['disable_exec_function'] = 1;",
  ]);
  // The stack's own ini, with the log routed to the SAPI so the probe sees it.
  const iniText = Buffer.concat([
    fs.readFileSync(path.join(repoRoot, 'php4-base', 'php-legacy.ini')),
    Buffer.from('\nerror_log =\n', 'latin1'),
  ]);
  const createPhp4 = require(path.join(buildDir, 'php4.js'));
  const site = await startSite(createPhp4, iniText, docroot, null);

  const provision = () => site.php.request({
    scriptFilename: path.join(repoRoot, '3.3', 'provision.php'),
    scriptName: '/provision.php',
    server: { TYPO3_SRC: typo3Src, TYPO3_PROVISION: 'auto' },
  });

  check('3.3/provision.php, unchanged, imports the schema and seeds the site', () => {
    const started = Date.now();
    const response = provision();
    console.log(response.text.trim().split('\n').map(line => `     ${line}`).join('\n'));
    console.log(`     (${Date.now() - started} ms)${response.log.length ? `, log: ${response.log.join(' | ')}` : ''}`);
    assert.match(response.text, /\[provision\] imported 71 statements from tables\.sql/);
    assert.match(response.text, /\[provision\] imported 190 statements from static\+adt\.sql/);
    assert.match(response.text, /\[provision\] created root page \(uid 1\)/);
    assert.match(response.text, /\[provision\] done\n$/);
  });

  check('every clock starts at noon on the release day, in UTC: time(), date(), mktime(), strftime(), microtime(), uniqid(), NOW()', () => {
    const script = path.join(scratch, 'clock.php');
    fs.writeFileSync(script, [
      '<?php',
      "$link = mysql_connect('db', 'typo3', 'typo3');",
      "$row = mysql_fetch_row(mysql_query('SELECT UNIX_TIMESTAMP(), NOW()', $link));",
      "$micro = explode(' ', microtime());",
      "echo implode('|', array(time(), date('Y-m-d H:i:s T Z'), mktime(12, 0, 0, 6, 3, 2002), strftime('%H %Z', time()),",
      "    $micro[1], hexdec(substr(uniqid(''), 0, 8)), $row[0], $row[1]));",
    ].join('\n'));
    const response = site.php.request({ scriptFilename: script, scriptName: '/clock.php' });
    assert.deepStrictEqual(response.log, []);
    console.log(`     ${response.text}`);
    const [time, date, mktime, strftime, microtime, uniqid, unixTimestamp, now] = response.text.split('|');
    const noon = RELEASE_NOON_MS / 1000;
    assert.ok(Number(time) >= noon && Number(time) < noon + 3600, `time() is ${time}`);
    assert.match(date, /^2002-06-03 12:\d{2}:\d{2} UTC 0$/);
    assert.strictEqual(Number(mktime), noon);
    assert.strictEqual(strftime, '12 UTC');
    for (const [name, value] of [['microtime()', microtime], ['uniqid()', uniqid], ['UNIX_TIMESTAMP()', unixTimestamp]]) {
      assert.ok(Math.abs(Number(value) - Number(time)) <= 2, `${name} is ${value}, time() is ${time}`);
    }
    assert.match(now, /^2002-06-03 12:\d{2}:\d{2}$/);
  });

  check('the root template turns off niceText, which needs ImageMagick, as the site does after provisioning', () => {
    Typo3Site.drawMenuTextWithGd(site.mysql);
  });

  check('a second provision run finds the schema and does nothing, as on a container restart', () => {
    assert.match(provision().text, /\[provision\] schema already present, nothing to do/);
  });

  const frontendChecks = (label, get) => check(label, () => {
    const started = Date.now();
    const response = get('index.php');
    const elapsed = Date.now() - started;
    if (!response.text.includes('<b>TYPO3 3.3.0</b>')) {
      console.log(`     ${response.status}, ${response.body.length} bytes, log: ${response.log.join(' | ')}`);
      console.log(response.text.slice(0, 1500));
    }
    console.log(`     ${response.status}, ${response.body.length} bytes in ${elapsed} ms`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.includes('<font face="verdana" color="white"><b>TYPO3 3.3.0</b></font>'), 'GREEN title missing');
    assert.match(response.text, /Rendered by TypoScript on PHP 4\.4\.9/);
    // The release day, within its first hour, as CI asserts for the image.
    assert.match(response.text, /Page generated&nbsp;2002-06-03 12:[0-9]{2}:[0-9]{2}/);
    assert.deepStrictEqual(response.log, []);
  });

  frontendChecks('the frontend renders "template; GREEN" with the seeded page', site.get);

  // GREEN's level-1 menu is a GMENU: GIFBUILDER draws every item as a GIF,
  // the page title in TrueType text on GREEN's background tile. The seeded
  // site has no subpages, so the menu is empty until two are added. no_cache
  // stands in for the cache clearing TYPO3's own editing forms would do.
  const subpages = ['Products', 'About the company'];
  check("GD draws GREEN's GIFBUILDER menu: one GIF per subpage, its title in TrueType text", () => {
    const seed = path.join(scratch, 'subpages.php');
    fs.writeFileSync(seed, [
      '<?php',
      "$link = mysql_connect('db', 'typo3', 'typo3');",
      "mysql_select_db('typo3', $link);",
      ...subpages.map((title, i) => `mysql_query("INSERT INTO pages (pid, tstamp, crdate, sorting, title, doktype, hidden, deleted, perms_userid, perms_user, perms_group, perms_everybody) VALUES (1, " . time() . ", " . time() . ", ${(i + 1) * 256}, '${title}', 1, 0, 0, 1, 31, 31, 31)", $link) or die(mysql_error($link));`),
      "echo 'seeded';",
    ].join('\n'));
    assert.strictEqual(site.php.request({ scriptFilename: seed, scriptName: '/subpages.php' }).text, 'seeded');

    const response = site.get('index.php', { query: 'no_cache=1' });
    assert.deepStrictEqual(response.log, []);
    const gifs = [...new Set(response.text.match(/typo3temp\/[^"' ]+\.gif/g) || [])];
    console.log(`     menu images: ${gifs.join(', ')}`);

    // Each image as GD reads it back: size, and how many of its pixels differ
    // from the top-left one, the background. A title drawn in white on the
    // tile is what makes them differ.
    const inspect = path.join(scratch, 'inspect.php');
    fs.writeFileSync(inspect, [
      '<?php',
      "foreach (explode(',', $HTTP_GET_VARS['files']) as $file) {",
      "  $bytes = implode('', file($HTTP_GET_VARS['root'] . '/' . $file));",
      "  $im = imagecreatefromgif($HTTP_GET_VARS['root'] . '/' . $file);",
      "  $w = imagesx($im); $h = imagesy($im); $bg = imagecolorat($im, 0, 0); $differ = 0;",
      "  for ($x = 0; $x < $w; $x++) for ($y = 0; $y < $h; $y++) if (imagecolorat($im, $x, $y) != $bg) $differ++;",
      "  echo $file, ' ', substr($bytes, 0, 6), ' ', $w, 'x', $h, ' ', $differ, \"\\n\";",
      '}',
    ].join('\n'));
    const report = site.php.request({
      scriptFilename: inspect,
      scriptName: '/inspect.php',
      queryString: `root=${encodeURIComponent(docroot)}&files=${encodeURIComponent(gifs.join(','))}`,
    });
    assert.deepStrictEqual(report.log, []);
    console.log(report.text.trim().split('\n').map(line => `     ${line}`).join('\n'));
    const images = report.text.trim().split('\n').map(line => {
      const [, magic, width, height, differ] = line.match(/^\S+ (GIF8[79]a) (\d+)x(\d+) (\d+)$/) || [];
      assert.ok(magic, `not a GIF: ${line}`);
      return { width: Number(width), height: Number(height), differ: Number(differ) };
    });
    assert.strictEqual(images.length, subpages.length, 'one image per menu item');
    for (const image of images) {
      // GREEN's menu height, and more than the bullet images' pixels: without
      // the text, as with niceText under GD alone, about 20 pixels differ.
      assert.strictEqual(image.height, 19);
      assert.ok(image.differ > 150, `only ${image.differ} pixels besides the background: no title drawn`);
    }
    // XY is the text's width plus the bullets', so the longer title is wider.
    assert.ok(images[1].width > images[0].width + 50, 'the item widths do not follow the titles');
  });

  // ImageMagick cannot run in WebAssembly. With [GFX][im] = 0, 3.3.0's own
  // Install Tool skips its ImageMagick tests and says why, and runs its GD
  // tests against the reference images it ships.
  check("the Install Tool's image tests: GD's pass, ImageMagick's are skipped as 3.3.0 intends", () => {
    // Its session: a key cookie, and the password hash tied to that key
    // (t3lib/class.t3lib_install.php:146-154).
    const key = 'probe';
    const cookie = `Typo3InstallTool_key=${key}; Typo3InstallTool=${md5(`${md5('joh316')}|${key}`)}`;
    const imageTest = type => {
      const response = site.get('typo3/install/index.php', {
        query: `TYPO3_INSTALL[type]=images&TYPO3_INSTALL[images_type]=${type}`,
        headers: { Cookie: cookie },
      });
      assert.strictEqual(response.status, 200);
      // The Install Tool looks for ImageMagick in the usual places whatever
      // [GFX][im] says, and exec() cannot start a process here. PHP logs it;
      // display_errors is off, so the page does not show it.
      for (const line of response.log) {
        assert.match(line, /exec\(\).*Unable to fork \[\/usr\/bin\/(convert|composite|identify)\]/);
      }
      return { html: response.text, text: response.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
    };

    const gd = imageTest('gdlib');
    assert.match(gd.text, /ImageMagick enabled: 0 .* GDLib enabled: 1 GDLib using PNG: 0/);
    // Each test shows the server's image beside 3.3.0's reference, with sizes.
    assert.match(gd.text, /Create simple image (\d+)&nbsp;&nbsp;, 170x136 pixels \1&nbsp;&nbsp;, 170x136 pixels/);
    assert.match(gd.text, /Create image from file ([\d.]+ K), 170x136 pixels \1, 170x136 pixels/);
    // FreeType 2 draws the text with other pixels than 2002's did, so the
    // size differs from the reference.
    assert.match(gd.text, /Render text with TrueType font \d+&nbsp;&nbsp;, 170x136 pixels/);
    assert.match(gd.text, /ImageMagick is needed to generate text with the niceText option/);
    assert.match(gd.text, /Your GDLib appears to have LZW compression!/);
    const images = gd.html.match(/typo3temp\/install_[0-9a-f]+\.gif/g) || [];
    assert.strictEqual(images.length, 3);
    for (const image of images) {
      assert.strictEqual(fs.readFileSync(path.join(docroot, image)).subarray(0, 4).toString('latin1'), 'GIF8');
    }

    for (const type of ['read', 'write', 'scaling', 'combining']) {
      assert.match(imageTest(type).text, /Use of ImageMagick has been disabled in the configuration/, type);
    }
  });

  check('the backend serves its challenge-response login form', () => {
    const response = site.get('typo3/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /name="userident"/);
    assert.doesNotMatch(response.text, /sitepath not specified/i);
  });

  check('the Install Tool answers', () => {
    assert.match(site.get('typo3/install/index.php').text, /<title>Typo3 Install Tool<\/title>/);
  });

  let sessionCookies = [];
  check('the 2002 challenge-response login works', () => {
    const challenge = md5(String(Math.random()));
    const userident = md5(`admin:${md5('password')}:${challenge}`);
    const response = site.get('typo3/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Not optional: without a Referer on this host the login dies before checking.
        Referer: 'http://localhost/typo3/index.php',
      },
      body: `login_status=login&username=admin&userident=${userident}&challenge=${challenge}`,
    });
    sessionCookies = cookiesFrom(response);
    console.log(`     ${response.status}, cookies: ${sessionCookies.join('; ')}, Location: ${response.header('Location')}`);
    assert.ok(sessionCookies.some(cookie => cookie.startsWith('be_typo_user=')), 'no backend session cookie');
    assert.doesNotMatch(response.text, /name="userident"/, 'the login form came back');
  });

  check('alt_doc.php renders the seeded page header for editing', () => {
    const response = site.get('typo3/alt_doc.php', {
      query: 'returnUrl=db_layout.php%3Fid%3D1&edit%5Bpages%5D%5B1%5D=edit',
      headers: { Cookie: sessionCookies.join('; ') },
    });
    if (!/name="data\[pages\]\[1\]\[title\]"/.test(response.text)) {
      console.log(`     ${response.status}, ${response.body.length} bytes, log: ${response.log.join(' | ')}`);
    }
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /name="data\[pages\]\[1\]\[title\]"/);
  });

  check('a client with no cookie gets a fresh session, not the logged-in one', () => {
    const challenges = new Set();
    for (let i = 0; i < 12; i++) {
      const response = site.get('typo3/index.php');
      assert.strictEqual(response.status, 200, 'answered with a redirect into the backend');
      assert.match(response.text, /name="userident"/);
      const challenge = response.text.match(/name="challenge" value="([0-9a-f]+)"/);
      assert.ok(challenge, 'no challenge in the login form');
      challenges.add(challenge[1]);
    }
    assert.strictEqual(challenges.size, 12);
  });

  const exported = site.mysql.exportDatabase('typo3');
  console.log(`     exported database: ${exported.length} bytes`);
  const reloaded = await startSite(createPhp4, iniText, docroot, exported);
  frontendChecks('the exported database reloads into a new instance, which renders the same site', reloaded.get);

  console.log(failures === 0 ? 'typo3 stack: all checks passed' : `typo3 stack: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
