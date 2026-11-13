// TYPO3 3.3.0 on the WebAssembly stack, held to the 3.3 assertions in
// .github/workflows/images.yml (stack.cjs says how):
//
//   3.3/provision.php, unchanged, imports the schema and seeds the site
//   the frontend renders "template; GREEN" with the seeded page
//   the backend serves its login form, and the Install Tool answers
//   the 2002 challenge-response login works, and alt_doc.php edits a record
//   a client with no cookie gets a session of its own
//   the site's snapshot restores into a new instance, which renders the same
//   GD draws GREEN's GIFBUILDER menu, titles in TrueType text, once the site
//   has subpages
//   the Install Tool's GD tests pass, and its ImageMagick tests say they are
//   skipped
//   every clock PHP and the server read starts at noon on the release day,
//   in UTC, whatever the host's time zone
//   source files answer 403
//   the MySQL server rejects nothing TYPO3 sends
//
// Usage: node stack-3.3.0.cjs <work-root>
'use strict';

const {
  md5, check, finish, cookiesFrom, client, runScript, printProvisionOutput,
  watchRejectedStatements, checkNothingRejected, checkClock, checkSecondProvision, checkSourceProtection, checkRestore,
} = require('./stack.cjs');
const assert = require('assert');
const path = require('path');
const { bootRelease } = require('./release-site.cjs');

const workRoot = path.resolve(process.argv[2]);

(async () => {
  const started = Date.now();
  const site = await bootRelease('3.3.0', workRoot);
  const booted = Date.now() - started;
  const get = client(site);
  const rejected = watchRejectedStatements(site);

  check('3.3/provision.php, unchanged, imports the schema and seeds the site', () => {
    const output = site.provisionOutput;
    printProvisionOutput(site, booted);
    assert.match(output, /\[provision\] imported 71 statements from tables\.sql/);
    assert.match(output, /\[provision\] imported 190 statements from static\+adt\.sql/);
    assert.match(output, /\[provision\] created root page \(uid 1\)/);
    assert.match(output, /\[provision\] done\n$/);
  });

  checkClock(site);

  check('after provisioning, the root template turns off niceText, which needs ImageMagick', () => {
    const result = site.query('SELECT constants FROM sys_template WHERE root = 1 AND deleted = 0');
    assert.deepStrictEqual(result.rows, [['styles.gmenu_layer.green.niceText = 0']]);
  });

  checkSecondProvision(site);

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

  frontendChecks('the frontend renders "template; GREEN" with the seeded page', get);

  // GREEN's level-1 menu is a GMENU: GIFBUILDER draws every item as a GIF,
  // the page title in TrueType text on GREEN's background tile. The seeded
  // site has no subpages, so the menu is empty until two are added. no_cache
  // stands in for the cache clearing TYPO3's own editing forms would do.
  const subpages = ['Products', 'About the company'];
  check("GD draws GREEN's GIFBUILDER menu: one GIF per subpage, its title in TrueType text", () => {
    const seeded = runScript(site, 'subpages.php', [
      '<?php',
      "$link = mysql_connect('db', 'typo3', 'typo3');",
      "mysql_select_db('typo3', $link);",
      ...subpages.map((title, i) => `mysql_query("INSERT INTO pages (pid, tstamp, crdate, sorting, title, doktype, hidden, deleted, perms_userid, perms_user, perms_group, perms_everybody) VALUES (1, " . time() . ", " . time() . ", ${(i + 1) * 256}, '${title}', 1, 0, 0, 1, 31, 31, 31)", $link) or die(mysql_error($link));`),
      "echo 'seeded';",
    ]);
    assert.strictEqual(seeded.text, 'seeded');

    const response = get('index.php', { query: 'no_cache=1' });
    assert.deepStrictEqual(response.log, []);
    const gifs = [...new Set(response.text.match(/typo3temp\/[^"' ]+\.gif/g) || [])];
    console.log(`     menu images: ${gifs.join(', ')}`);

    // Each image as GD reads it back: size, and how many of its pixels differ
    // from the top-left one, the background. A title drawn in white on the
    // tile is what makes them differ.
    const report = runScript(site, 'inspect.php', [
      '<?php',
      "foreach (explode(',', $HTTP_GET_VARS['files']) as $file) {",
      "  $bytes = implode('', file($HTTP_GET_VARS['root'] . '/' . $file));",
      "  $im = imagecreatefromgif($HTTP_GET_VARS['root'] . '/' . $file);",
      "  $w = imagesx($im); $h = imagesy($im); $bg = imagecolorat($im, 0, 0); $differ = 0;",
      "  for ($x = 0; $x < $w; $x++) for ($y = 0; $y < $h; $y++) if (imagecolorat($im, $x, $y) != $bg) $differ++;",
      "  echo $file, ' ', substr($bytes, 0, 6), ' ', $w, 'x', $h, ' ', $differ, \"\\n\";",
      '}',
    ], `root=${encodeURIComponent(site.docroot)}&files=${encodeURIComponent(gifs.join(','))}`);
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
      const response = get('typo3/install/index.php', {
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
      assert.strictEqual(Buffer.from(site.php.FS.readFile(`${site.docroot}/${image}`)).subarray(0, 4).toString('latin1'), 'GIF8');
    }

    for (const type of ['read', 'write', 'scaling', 'combining']) {
      assert.match(imageTest(type).text, /Use of ImageMagick has been disabled in the configuration/, type);
    }
  });

  check('the backend serves its challenge-response login form', () => {
    const response = get('typo3/index.php');
    assert.strictEqual(response.status, 200);
    assert.match(response.text, /name="userident"/);
    assert.doesNotMatch(response.text, /sitepath not specified/i);
  });

  check('the Install Tool answers', () => {
    assert.match(get('typo3/install/index.php').text, /<title>Typo3 Install Tool<\/title>/);
  });

  // clear.gif is one of 3.3/Dockerfile's document root links.
  checkSourceProtection(site, '/clear.gif');

  let sessionCookies = [];
  check('the 2002 challenge-response login works', () => {
    const challenge = md5(String(Math.random()));
    const userident = md5(`admin:${md5('password')}:${challenge}`);
    const response = get('typo3/index.php', {
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
    const response = get('typo3/alt_doc.php', {
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
      const response = get('typo3/index.php');
      assert.strictEqual(response.status, 200, 'answered with a redirect into the backend');
      assert.match(response.text, /name="userident"/);
      const challenge = response.text.match(/name="challenge" value="([0-9a-f]+)"/);
      assert.ok(challenge, 'no challenge in the login form');
      challenges.add(challenge[1]);
    }
    assert.strictEqual(challenges.size, 12);
  });

  checkNothingRejected(rejected);

  await checkRestore(site, workRoot, frontendChecks);

  finish('stack 3.3.0');
})();
