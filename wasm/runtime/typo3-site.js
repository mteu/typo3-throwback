// A TYPO3 release as a site: HTTP requests in, responses out. What a Docker
// image does at build and boot, and what its web server does per request, on
// top of php-runtime.js and mysql-sqlite.js. Everything that differs between
// releases comes from a release file, releases/<release>.js:
//
//   unpack the release archive and make the Dockerfile's source edits, with
//     the same assertions
//   assemble the document root the way the Dockerfile does
//   provision with the stack's own provision.php on first boot, or restore a
//     snapshot
//   serve files and PHP with the web server's rules, and keep the cookies
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
  const WEB_ROOT = '/var/www';
  const PROVISION_SCRIPT = '/opt/provision/provision.php';
  const UPLOAD_DIR = '/tmp/uploads';

  const CONTENT_TYPES = {
    html: 'text/html', htm: 'text/html', txt: 'text/plain', css: 'text/css',
    js: 'application/x-javascript', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', ico: 'image/x-icon', swf: 'application/x-shockwave-flash',
    pdf: 'application/pdf', xml: 'text/xml', tmpl: 'text/plain', ttf: 'application/x-font-ttf',
  };

  const encoder = { encode: text => Uint8Array.from(text, char => char.charCodeAt(0) & 0xff) };

  function plainResponse(status, text, headers = []) {
    return {
      status,
      headers: [['Content-Type', 'text/html'], ...headers],
      body: encoder.encode(`<html><head><title>${status} ${text}</title></head><body><center><h1>${status} ${text}</h1></center></body></html>\n`),
    };
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
    // options:
    //   release: a releases/<release>.js object
    //   PhpRuntime, createPhp: the runtime and the request-loop build of the
    //     PHP the release names
    //   MysqlOnSqlite, SQL: the server and an initialized sql.js
    //   readTar: runtime/tar.js
    //   tarball: the release archive, already gunzipped, as bytes
    //   provisionScript, legacyIni: the files release.provisionScript and
    //     release.ini name, as bytes
    //   urlPrefix: the URL path the site is served under, such as "/3.3/site"
    //   clockStartMs: where PHP's and the server's clock start, in
    //     milliseconds since the epoch, or null for today. Defaults to the
    //     release's own.
    //   database: false starts PHP with no MySQL server, and neither
    //     provisions nor restores. TYPO3 then stops at its database
    //     connection, which is what a probe of the bootstrap wants.
    //   snapshot: what snapshot() returned on an earlier visit, or null
    //   onProgress: called with a line of text per boot step, and how far
    //     boot has come, 0 to 1
    static async boot(options) {
      const site = new Typo3Site(options);
      await site.start(options);
      return site;
    }

    constructor({ release, urlPrefix, onProgress = () => {} }) {
      this.release = release;
      this.urlPrefix = urlPrefix.replace(/\/+$/, '');
      this.docroot = WEB_ROOT + this.urlPrefix;
      // Where the archive's top directory lands: next to the document root
      // when the root links into it, else the document root itself.
      this.source = release.docrootLinks ? `/opt/${release.archiveRoot}` : this.docroot;
      this.progress = onProgress;
      this.cookies = new CookieJar();
      this.mysql = null;
      this.savedWrites = 0;
      this.restored = false;
    }

    async start({ PhpRuntime, createPhp, MysqlOnSqlite, SQL, readTar, tarball, provisionScript, legacyIni, snapshot = null, clockStartMs = this.release.clockStartMs, database = true }) {
      const release = this.release;
      const restorable = database && snapshot && snapshot.version === release.snapshotVersion;
      const clock = clockStartMs === null ? null : PhpRuntime.clockStartingAt(clockStartMs);
      if (database) {
        this.mysql = new MysqlOnSqlite(SQL, { users: { typo3: 'typo3' }, ...(clock ? { now: clock } : {}) });
        if (restorable) {
          this.mysql.addDatabase('typo3', snapshot.database);
        }
      }
      // The stack's own ini, with the log routed to the SAPI and uploads to /tmp.
      const extra = encoder.encode(`\nerror_log =\nupload_tmp_dir = ${UPLOAD_DIR}\n`);
      const ini = new Uint8Array(legacyIni.length + extra.length);
      ini.set(legacyIni);
      ini.set(extra, legacyIni.length);
      this.progress(`starting PHP ${release.php}`, 0);
      this.php = await PhpRuntime.create(createPhp, { iniText: ini, mysql: this.mysql, clock });
      const FS = this.php.FS;
      FS.mkdirTree(UPLOAD_DIR);

      this.progress(`unpacking ${release.archiveRoot}`, 0.3);
      this.unpack(FS, readTar(tarball));
      release.editSource({
        read: path => readText(FS, `${this.source}/${path}`),
        write: (path, text) => FS.writeFile(`${this.source}/${path}`, encoder.encode(text)),
      });
      this.assembleDocroot(FS);

      if (restorable) {
        for (const [path, bytes] of snapshot.files) {
          FS.mkdirTree(`${this.docroot}/${path}`.replace(/\/[^/]*$/, ''));
          FS.writeFile(`${this.docroot}/${path}`, bytes);
        }
        this.restored = true;
        this.progress('restored the database and files from the last visit', 1);
      } else if (database) {
        if (!release.provisionScript) {
          throw new Error(`TYPO3 ${release.release} cannot provision a site in the browser yet`);
        }
        this.progress(`provisioning with ${release.provisionScript}`, 0.6);
        FS.mkdirTree(PROVISION_SCRIPT.replace(/\/[^/]*$/, ''));
        FS.writeFile(PROVISION_SCRIPT, provisionScript);
        const response = this.provision();
        this.provisionOutput = response.text;
        if (!/\[provision\] done\n$/.test(response.text)) {
          throw new Error(`provision.php did not finish:\n${response.text}\n${response.log.join('\n')}`);
        }
        if (release.afterProvision) {
          release.afterProvision(sql => this.query(sql));
        }
      }
      this.savedWrites = this.mysql ? this.mysql.writes : 0;
    }

    // Runs the stack's provision.php, as its entrypoint does on every boot.
    provision() {
      return this.php.request({
        scriptFilename: PROVISION_SCRIPT,
        scriptName: '/provision.php',
        server: this.release.provisionEnv({ source: this.source, docroot: this.docroot }),
      });
    }

    // One statement on the site's database, past PHP, as a client would
    // send it. Returns MysqlOnSqlite's answer.
    query(sql) {
      const { link } = this.mysql.handle(MYSQL_OP.connect, 0, 'db', 'typo3', 'typo3');
      this.mysql.handle(MYSQL_OP.selectDb, link, 'typo3');
      const result = this.mysql.handle(MYSQL_OP.query, link, sql);
      this.mysql.handle(MYSQL_OP.close, link);
      return result;
    }

    unpack(FS, entries) {
      const prefix = this.release.archiveRoot;
      for (const entry of entries) {
        if (entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) {
          throw new Error(`unexpected entry ${entry.path} in the archive`);
        }
        const path = this.source + entry.path.slice(prefix.length);
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

    assembleDocroot(FS) {
      const root = this.docroot;
      FS.mkdirTree(root);
      for (const [link, target] of this.release.docrootLinks || []) {
        FS.symlink(target.startsWith('/') ? this.source + target : target, `${root}/${link}`);
      }
      for (const dir of this.release.writableDirs) {
        FS.mkdirTree(`${root}/${dir}`);
      }
      FS.writeFile(`${root}/typo3conf/localconf.php`, encoder.encode(['<?php', ...this.release.localconf, '?>', ''].join('\n')));
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
      if (this.release.denied.some(rule => rule.test(relative))) {
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
      return this.mysql !== null && this.mysql.writes !== this.savedWrites;
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
      for (const directory of this.release.persistedDirs) {
        walk(directory);
      }
      this.savedWrites = this.mysql.writes;
      return { version: this.release.snapshotVersion, database: this.mysql.exportDatabase('typo3'), files };
    }
  }

  return Typo3Site;
});
