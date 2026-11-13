// TYPO3 3.3.0 as a site: HTTP requests in, responses out. What the 3.3
// Docker image does at build and boot, and what php4-base/nginx.conf does per
// request, on top of php4-runtime.js and mysql-sqlite.js:
//
//   unpack the release archive and make 3.3/Dockerfile's two source edits,
//     with the same assertions
//   assemble the document root from the same symlinks
//   provision with 3.3/provision.php on first boot, or restore a snapshot
//   serve files and PHP with nginx.conf's rules, and keep the cookies
//
// It touches nothing but the runtime's FS and request(), so it runs in a
// browser worker and in Node alike.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Typo3Site = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const SOURCE = '/opt/typo3_src-3.3.0';
  const WEB_ROOT = '/var/www';
  const PROVISION_SCRIPT = '/opt/provision/provision.php';
  const UPLOAD_DIR = '/tmp/uploads';
  // The directories TYPO3 writes to, kept across visits as a container's
  // volume keeps them. typo3temp is a cache, but not one that rebuilds itself:
  // the page cache in the database names the GIFBUILDER images in it, and
  // serves those names until the page is edited.
  const PERSISTED_DIRECTORIES = ['typo3conf', 'fileadmin', 'uploads', 'typo3temp'];
  // 2: GD is on. A version 1 snapshot holds a localconf.php with image
  // processing off and a template that still asks for niceText, so it is
  // provisioned afresh instead of restored.
  const SNAPSHOT_VERSION = 2;

  const CONTENT_TYPES = {
    html: 'text/html', htm: 'text/html', txt: 'text/plain', css: 'text/css',
    js: 'application/x-javascript', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', ico: 'image/x-icon', swf: 'application/x-shockwave-flash',
    pdf: 'application/pdf', xml: 'text/xml', tmpl: 'text/plain', ttf: 'application/x-font-ttf',
  };

  // php4-base/nginx.conf: source files that must never be served.
  const DENIED = [
    /^(\/typo3)?\/t3lib\/.*\.(php|sql|inc)$/,
    /^\/(typo3conf|typo3temp|uploads|fileadmin)\/.*\.(php|sql|inc)$/,
  ];

  const encoder = { encode: text => Uint8Array.from(text, char => char.charCodeAt(0) & 0xff) };

  function plainResponse(status, text, headers = []) {
    return {
      status,
      headers: [['Content-Type', 'text/html'], ...headers],
      body: encoder.encode(`<html><head><title>${status} ${text}</title></head><body><center><h1>${status} ${text}</h1></center></body></html>\n`),
    };
  }

  // Applies one of 3.3/Dockerfile's edits and checks it took, as the
  // Dockerfile's own assertions do.
  function editSource(FS, path, edit) {
    FS.writeFile(path, encoder.encode(edit(readText(FS, path))));
  }

  function readText(FS, path) {
    const bytes = FS.readFile(path);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return text;
  }

  class CookieJar {
    constructor() {
      this.cookies = new Map();
    }

    // Set-Cookie as PHP 4's setcookie() writes it.
    store(header, requestPath) {
      const [pair, ...attributes] = header.split(';').map(part => part.trim());
      const equals = pair.indexOf('=');
      if (equals <= 0) {
        return;
      }
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      let path = requestPath.replace(/[^/]*$/, '') || '/';
      let expires = null;
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split('=');
        if (key.toLowerCase() === 'path') {
          path = rest.join('=') || '/';
        } else if (key.toLowerCase() === 'expires') {
          expires = Date.parse(rest.join('=').replace(/-/g, ' '));
        }
      }
      const key = `${name};${path}`;
      if (value === 'deleted' || value === '' || (expires !== null && !Number.isNaN(expires) && expires < Date.now())) {
        this.cookies.delete(key);
      } else {
        this.cookies.set(key, { name, value, path });
      }
    }

    header(requestPath) {
      return [...this.cookies.values()]
        .filter(cookie => requestPath.startsWith(cookie.path))
        .sort((a, b) => b.path.length - a.path.length)
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
    }
  }

  // MysqlOnSqlite.handle()'s operations, as libmysql/libmysql.c sends them.
  const MYSQL_OP = { connect: 1, close: 2, selectDb: 3, query: 4 };

  class Typo3Site {
    // GREEN's GMENU draws its titles with niceText = 1: GD writes the text at
    // twice the size, and ImageMagick scales it down. Without ImageMagick the
    // titles are simply missing. A 2002 site on a GD-only server turned
    // niceText off in its own template's constants, which 3.3.0 reads after
    // the static templates it includes; this does the same to the root
    // template provision.php seeds. Its constants are empty until then.
    static drawMenuTextWithGd(mysql) {
      const { link } = mysql.handle(MYSQL_OP.connect, 0, 'db', 'typo3', 'typo3');
      mysql.handle(MYSQL_OP.selectDb, link, 'typo3');
      const result = mysql.handle(MYSQL_OP.query, link,
        "UPDATE sys_template SET constants = 'styles.gmenu_layer.green.niceText = 0' WHERE root = 1 AND deleted = 0 AND constants = ''");
      mysql.handle(MYSQL_OP.close, link);
      if (result.kind !== 'ok' || result.affectedRows !== 1) {
        throw new Error(`could not turn off niceText in the root template: ${JSON.stringify(result)}`);
      }
    }

    // options:
    //   Php4Runtime, createPhp4: the runtime and the request-loop build
    //   MysqlOnSqlite, SQL: the server and an initialized sql.js
    //   readTar: runtime/tar.js
    //   tarball: typo3_src-3.3.0.tar, already gunzipped, as bytes
    //   provisionScript, legacyIni: 3.3/provision.php and php4-base/php-legacy.ini, as bytes
    //   urlPrefix: the URL path the site is served under, such as "/site"
    //   clockStartMs: where PHP's and the server's clock start, in
    //     milliseconds since the epoch, or null for today
    //   snapshot: what snapshot() returned on an earlier visit, or null
    //   onProgress: called with a line of text per boot step, and how far
    //     boot has come, 0 to 1
    static async boot(options) {
      const site = new Typo3Site(options);
      await site.start(options);
      return site;
    }

    constructor({ urlPrefix, onProgress = () => {} }) {
      this.urlPrefix = urlPrefix.replace(/\/+$/, '');
      this.docroot = WEB_ROOT + this.urlPrefix;
      this.progress = onProgress;
      this.cookies = new CookieJar();
      this.savedWrites = 0;
      this.restored = false;
    }

    async start({ Php4Runtime, createPhp4, MysqlOnSqlite, SQL, readTar, tarball, provisionScript, legacyIni, snapshot, clockStartMs = null }) {
      const restorable = snapshot && snapshot.version === SNAPSHOT_VERSION;
      const clock = clockStartMs === null ? null : Php4Runtime.clockStartingAt(clockStartMs);
      this.mysql = new MysqlOnSqlite(SQL, { users: { typo3: 'typo3' }, ...(clock ? { now: clock } : {}) });
      if (restorable) {
        this.mysql.addDatabase('typo3', snapshot.database);
      }
      // The stack's own ini, with the log routed to the SAPI and uploads to /tmp.
      const extra = encoder.encode(`\nerror_log =\nupload_tmp_dir = ${UPLOAD_DIR}\n`);
      const ini = new Uint8Array(legacyIni.length + extra.length);
      ini.set(legacyIni);
      ini.set(extra, legacyIni.length);
      this.progress('starting PHP 4.4.9', 0);
      this.php = await Php4Runtime.create(createPhp4, { iniText: ini, mysql: this.mysql, clock });
      const FS = this.php.FS;
      FS.mkdirTree(UPLOAD_DIR);

      this.progress('unpacking typo3_src-3.3.0', 0.3);
      this.unpack(FS, readTar(tarball));
      this.editSourceAsTheDockerfileDoes(FS);
      this.assembleDocroot(FS);

      if (restorable) {
        for (const [path, bytes] of snapshot.files) {
          FS.mkdirTree(`${this.docroot}/${path}`.replace(/\/[^/]*$/, ''));
          FS.writeFile(`${this.docroot}/${path}`, bytes);
        }
        this.restored = true;
        this.progress('restored the database and files from the last visit', 1);
      } else {
        this.progress('provisioning with 3.3/provision.php', 0.6);
        FS.mkdirTree(PROVISION_SCRIPT.replace(/\/[^/]*$/, ''));
        FS.writeFile(PROVISION_SCRIPT, provisionScript);
        const response = this.php.request({
          scriptFilename: PROVISION_SCRIPT,
          scriptName: '/provision.php',
          server: { TYPO3_SRC: SOURCE, TYPO3_PROVISION: 'auto' },
        });
        this.provisionOutput = response.text;
        if (!/\[provision\] done\n$/.test(response.text)) {
          throw new Error(`provision.php did not finish:\n${response.text}\n${response.log.join('\n')}`);
        }
        Typo3Site.drawMenuTextWithGd(this.mysql);
      }
      this.savedWrites = this.mysql.writes;
    }

    unpack(FS, entries) {
      const prefix = 'typo3_src-3.3.0';
      for (const entry of entries) {
        if (entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) {
          throw new Error(`unexpected entry ${entry.path} in the archive`);
        }
        const path = `/opt/${entry.path}`;
        if (entry.type === 'directory') {
          FS.mkdirTree(path);
        } else {
          FS.mkdirTree(path.replace(/\/[^/]*$/, ''));
          if (entry.type === 'file') {
            FS.writeFile(path, entry.data);
          } else {
            FS.symlink(entry.target.replace(/\/+$/, ''), path);
          }
        }
      }
    }

    editSourceAsTheDockerfileDoes(FS) {
      // The Install Tool's die(), commented out (3.3/Dockerfile).
      const install = `${SOURCE}/typo3/install/index.php`;
      editSource(FS, install, text => text.replace(/^(\s*)die\("In the main source distribution/m, '$1// die("In the main source distribution'));
      if (/^\s*die\("In the main source distribution/m.test(readText(FS, install))) {
        throw new Error('the Install Tool die() edit did not apply');
      }
      // The second TS_tmplParts_rte(), commented out (§2.5 of the 3.3 doc).
      const parser = `${SOURCE}/t3lib/class.t3lib_parsehtml_proc.php`;
      editSource(FS, parser, text => {
        const lines = text.split('\n');
        if (lines[1024] !== '\tfunction TS_tmplParts_rte($value)\t{') {
          throw new Error('line 1025 of class.t3lib_parsehtml_proc.php is not the duplicate declaration');
        }
        for (let i = 1024; i <= 1044; i++) {
          lines[i] = `//${lines[i]}`;
        }
        return lines.join('\n');
      });
      if ((readText(FS, parser).match(/^\s*function TS_tmplParts_rte/gm) || []).length !== 1) {
        throw new Error('the duplicate TS_tmplParts_rte() edit did not apply');
      }
    }

    assembleDocroot(FS) {
      const root = this.docroot;
      FS.mkdirTree(root);
      for (const [link, target] of [
        ['typo3', `${SOURCE}/typo3`],
        ['t3lib', `${SOURCE}/t3lib`],
        ['tslib', `${SOURCE}/tslib`],
        ['index.php', 'tslib/index_ts.php'],
        ['media', 'tslib/media'],
        ['clear.gif', 't3lib/gfx/clear.gif'],
      ]) {
        FS.symlink(target, `${root}/${link}`);
      }
      for (const dir of ['typo3conf', 'typo3temp', 'fileadmin/_temp_', 'uploads/pics', 'uploads/media', 'uploads/tf']) {
        FS.mkdirTree(`${root}/${dir}`);
      }
      // 3.3/entrypoint.sh's auto-mode localconf.php, but for ImageMagick,
      // which cannot run in a browser. [GFX][im] = 0 is 3.3.0's own way of
      // saying so (t3lib/config_default.php): GD alone draws GIFBUILDER's
      // menus and text, and TYPO3 limits images to gif, jpg and png.
      FS.writeFile(`${root}/typo3conf/localconf.php`, encoder.encode([
        '<?php',
        "$typo_db_username = 'typo3';",
        "$typo_db_password = 'typo3';",
        "$typo_db_host     = 'db';",
        "$typo_db          = 'typo3';",
        '',
        "$TYPO3_CONF_VARS['SYS']['sitename'] = 'TYPO3 3.3.0';",
        // md5('joh316'), the historical default the 3.3 stack uses.
        "$TYPO3_CONF_VARS['BE']['installToolPassword'] = 'bacb98acf97e0b6112b1d1b650b84971';",
        "$TYPO3_CONF_VARS['GFX']['image_processing'] = 1;",
        "$TYPO3_CONF_VARS['GFX']['im'] = 0;",
        "$TYPO3_CONF_VARS['GFX']['gdlib'] = 1;",
        "$TYPO3_CONF_VARS['GFX']['gdlib_png'] = 0;",
        // No processes either: file operations such as moving an upload into
        // fileadmin/ use PHP's functions instead of exec('mv ...'), as 3.3.0
        // does on Windows (t3lib/class.t3lib_extfilefunc.php:116).
        "$TYPO3_CONF_VARS['BE']['disable_exec_function'] = 1;",
        '?>',
        '',
      ].join('\n')));
    }

    // request: { method, path, query, headers: { name: value }, body: Uint8Array | null }
    // path is the URL path, query the part after "?" without it.
    handle({ method = 'GET', path, query = '', headers = {}, body = null }) {
      if (path === this.urlPrefix) {
        // The site root is a directory: without its slash, relative URLs such
        // as clear.gif would resolve one level up.
        return { status: 301, headers: [['Location', `${path}/${query ? `?${query}` : ''}`]], body: new Uint8Array(0) };
      }
      if (!path.startsWith(`${this.urlPrefix}/`)) {
        return plainResponse(404, 'Not Found');
      }
      let relative;
      try {
        relative = decodeURIComponent(path.slice(this.urlPrefix.length)) || '/';
      } catch (error) {
        return plainResponse(400, 'Bad Request');
      }
      const segments = relative.split('/');
      if (segments.includes('..') || relative.includes('\0')) {
        return plainResponse(400, 'Bad Request');
      }
      if (DENIED.some(rule => rule.test(relative))) {
        return plainResponse(403, 'Forbidden');
      }

      const FS = this.php.FS;
      const file = `${this.docroot}${relative}`;
      const stat = this.stat(file);
      if (stat && FS.isDir(stat.mode)) {
        // nginx: a directory without its slash redirects; with it, try the index.
        if (!relative.endsWith('/')) {
          return { status: 301, headers: [['Location', `${path}/${query ? `?${query}` : ''}`]], body: new Uint8Array(0) };
        }
        for (const index of ['index.php', 'index.html']) {
          const candidate = this.stat(`${file}${index}`);
          if (candidate && !FS.isDir(candidate.mode)) {
            return this.serve(`${relative}${index}`, { method, query, headers, body });
          }
        }
        return plainResponse(403, 'Forbidden');
      }
      if (!stat) {
        return plainResponse(404, 'Not Found');
      }
      return this.serve(relative, { method, query, headers, body });
    }

    stat(path) {
      try {
        return this.php.FS.stat(path);
      } catch (error) {
        return null;
      }
    }

    serve(relative, { method, query, headers, body }) {
      const file = `${this.docroot}${relative}`;
      if (!relative.endsWith('.php')) {
        const extension = (relative.match(/\.([a-z0-9]+)$/i) || [])[1];
        return {
          status: 200,
          headers: [['Content-Type', CONTENT_TYPES[(extension || '').toLowerCase()] || 'application/octet-stream']],
          body: method === 'HEAD' ? new Uint8Array(0) : this.php.FS.readFile(file),
        };
      }
      const scriptName = `${this.urlPrefix}${relative}`;
      const cookie = this.cookies.header(scriptName);
      const response = this.php.request({
        method,
        scriptFilename: file,
        scriptName,
        queryString: query,
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
        body,
        server: { DOCUMENT_ROOT: WEB_ROOT },
      });
      const out = [];
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() === 'set-cookie') {
          this.cookies.store(value, scriptName);
        } else {
          out.push([name, value]);
        }
      }
      return { status: response.status, headers: out, body: response.body, log: response.log };
    }

    // True when the database changed since the last snapshot.
    get changed() {
      return this.mysql.writes !== this.savedWrites;
    }

    snapshot() {
      const FS = this.php.FS;
      const files = [];
      const walk = relative => {
        for (const name of FS.readdir(`${this.docroot}/${relative}`)) {
          if (name === '.' || name === '..') {
            continue;
          }
          const child = `${relative}/${name}`;
          const stat = FS.lstat(`${this.docroot}/${child}`);
          if (FS.isDir(stat.mode)) {
            walk(child);
          } else if (FS.isFile(stat.mode)) {
            files.push([child, FS.readFile(`${this.docroot}/${child}`)]);
          }
        }
      };
      for (const directory of PERSISTED_DIRECTORIES) {
        walk(directory);
      }
      this.savedWrites = this.mysql.writes;
      return { version: SNAPSHOT_VERSION, database: this.mysql.exportDatabase('typo3'), files };
    }
  }

  return Typo3Site;
});
