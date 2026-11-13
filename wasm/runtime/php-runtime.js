// Drives the request-loop SAPI (sapi/php_wasm_sapi.c) from JS, in Node or a
// browser. One instance, module startup once, then any number of requests.
//
// Strings cross the boundary as ISO-8859-1 bytes, which is what PHP 4 and
// TYPO3 3.x work in. TextDecoder('latin1') is not used for that: the WHATWG
// encoding standard maps the label to windows-1252, which changes 0x80-0x9F.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PhpRuntime = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function encodeLatin1(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0xff) {
        throw new RangeError(`Not representable in ISO-8859-1: ${JSON.stringify(text)}`);
      }
      bytes[i] = code;
    }
    return bytes;
  }

  function decodeLatin1(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return text;
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  function newCollector() {
    return { status: 200, headers: [], body: [], log: [] };
  }

  function encodeEnvBlock(env) {
    const chunks = [];
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (name.includes('=') || name.includes('\0') || String(value).includes('\0')) {
        throw new RangeError(`Invalid environment entry: ${name}`);
      }
      chunks.push(encodeLatin1(`${name}=${value}`), new Uint8Array(1));
    }
    chunks.push(new Uint8Array(1));
    return concatBytes(chunks);
  }

  function copyIn(module, bytes) {
    const pointer = module._malloc(Math.max(bytes.length, 1));
    module.HEAPU8.set(bytes, pointer);
    return pointer;
  }

  // The response buffer libmysql/libmysql.c reads; its header comment has
  // the layout. Returned as a pointer the C side frees.
  const MYSQL_KIND = { error: 0, ok: 1, result: 2, link: 3 };
  const NULL_CELL = 0xffffffff;

  function encodeMysqlResponse(module, response) {
    const strings = [];
    let size = 0;
    const str = text => {
      const bytes = encodeLatin1(text === null || text === undefined ? '' : String(text));
      strings.push(bytes);
      size += 4 + bytes.length + 1;
    };
    const u32 = () => {
      size += 4;
    };
    // First pass: sizes. Second pass: bytes, in the same order.
    const walk = (writeU32, writeStr, writeCell) => {
      writeU32(MYSQL_KIND[response.kind]);
      if (response.kind === 'error') {
        writeU32(response.errno);
        writeStr(response.message);
      } else if (response.kind === 'ok') {
        for (const value of [response.affectedRows || 0, response.insertId || 0]) {
          writeU32(value % 0x100000000);
          writeU32(Math.floor(value / 0x100000000));
        }
        writeStr('');
      } else if (response.kind === 'link') {
        writeU32(response.link);
        writeStr(response.serverVersion);
        writeStr(response.hostInfo);
      } else {
        writeU32(response.fields.length);
        writeU32(response.rows.length);
        for (const field of response.fields) {
          writeStr(field.name);
          writeStr(field.table);
          writeStr(field.def);
          for (const value of [field.type, field.length, field.maxLength, field.flags, field.decimals]) {
            writeU32(value >>> 0);
          }
        }
        for (const row of response.rows) {
          for (const cell of row) {
            writeCell(cell);
          }
        }
      }
    };
    walk(() => u32(), text => str(text), cell => {
      if (cell === null) {
        size += 4;
      } else {
        str(cell);
      }
    });

    const pointer = module._malloc(size);
    const heap = module.HEAPU8;
    const view = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
    let offset = pointer;
    let next = 0;
    const writeU32 = value => {
      view.setUint32(offset, value, true);
      offset += 4;
    };
    const writeStr = () => {
      const bytes = strings[next++];
      writeU32(bytes.length);
      heap.set(bytes, offset);
      offset += bytes.length;
      heap[offset++] = 0;
    };
    walk(writeU32, writeStr, cell => (cell === null ? writeU32(NULL_CELL) : writeStr()));
    return pointer;
  }

  class PhpRuntime {
    // moduleFactory: the MODULARIZE'd factory build.sh emits.
    // iniSearchPath: where PHP looks for php.ini (a directory list).
    // iniText: written to <iniSearchPath>/php.ini first, when given. A
    // Uint8Array is written as is; pass file contents that way, since an ini
    // file read as text may hold characters ISO-8859-1 cannot (UTF-8 comments).
    // mysql: the server ext/mysql talks to, such as runtime/mysql-sqlite.js;
    // without one, every mysql_connect() fails as if no server were running.
    // clock: a function returning the time in milliseconds since the epoch,
    // such as PhpRuntime.clockStartingAt() returns. PHP's clock reads what
    // it returns now and runs on from there. Give the server the same
    // function, so NOW() agrees with time(). Without one, PHP reads today.
    static async create(moduleFactory, { iniSearchPath = '/etc/php', iniText = null, moduleOptions = {}, mysql = null, clock = null } = {}) {
      const module = await moduleFactory(moduleOptions);
      if (clock) {
        module._php_wasm_set_clock_start(clock());
      }
      if (mysql) {
        module.phpMysqlCall = (op, link, a, b, c) => {
          const text = bytes => (bytes === null ? null : decodeLatin1(bytes));
          return encodeMysqlResponse(module, mysql.handle(op, link, text(a), text(b), text(c)));
        };
      }
      if (iniText !== null) {
        module.FS.mkdirTree(iniSearchPath);
        module.FS.writeFile(`${iniSearchPath}/php.ini`,
          iniText instanceof Uint8Array ? iniText : encodeLatin1(iniText));
      }
      module.phpResponse = newCollector();
      const path = copyIn(module, concatBytes([encodeLatin1(iniSearchPath), new Uint8Array(1)]));
      let failed;
      try {
        failed = module._php_wasm_startup(path);
      } finally {
        module._free(path);
      }
      const startupLog = module.phpResponse.log.map(decodeLatin1);
      module.phpResponse = null;
      if (failed) {
        throw new Error(`PHP module startup failed: ${startupLog.join('\n')}`);
      }
      return new PhpRuntime(module, startupLog);
    }

    constructor(module, startupLog) {
      this.module = module;
      this.startupLog = startupLog;
      this.busy = false;
      this.broken = null;
    }

    get FS() {
      return this.module.FS;
    }

    get memoryBytes() {
      return this.module.HEAPU8.length;
    }

    // headers: request headers by name. server: extra or overriding CGI
    // variables. body: a string (ISO-8859-1) or a Uint8Array.
    request({
      method = 'GET',
      scriptFilename,
      scriptName,
      queryString = '',
      headers = {},
      body = null,
      server = {},
    }) {
      if (this.busy) {
        throw new Error('A request is already running on this instance');
      }
      // A trap leaves PHP's memory in whatever state the trap found it.
      if (this.broken) {
        throw new Error(`This instance stopped at a WebAssembly trap and cannot serve more requests: ${this.broken.message}`);
      }
      const bodyBytes = body === null ? new Uint8Array(0)
        : typeof body === 'string' ? encodeLatin1(body) : body;

      const env = {
        GATEWAY_INTERFACE: 'CGI/1.1',
        SERVER_SOFTWARE: 'php-wasm',
        SERVER_PROTOCOL: 'HTTP/1.1',
        SERVER_NAME: 'localhost',
        SERVER_PORT: '80',
        REMOTE_ADDR: '127.0.0.1',
        REQUEST_METHOD: method,
        SCRIPT_FILENAME: scriptFilename,
        // TYPO3 3.3 reads PATH_site from $HTTP_SERVER_VARS["PATH_TRANSLATED"]
        // on every SAPI but "cgi" (docs/how-it-works.md, 3.3.0).
        PATH_TRANSLATED: scriptFilename,
        SCRIPT_NAME: scriptName,
        QUERY_STRING: queryString,
        REQUEST_URI: scriptName + (queryString ? `?${queryString}` : ''),
      };
      if (bodyBytes.length > 0 || method === 'POST') {
        env.CONTENT_LENGTH = String(bodyBytes.length);
      }
      for (const [name, value] of Object.entries(headers)) {
        const key = name.toUpperCase().replace(/-/g, '_');
        if (key === 'CONTENT_TYPE') {
          env.CONTENT_TYPE = value;
        } else if (key !== 'CONTENT_LENGTH') {
          env[`HTTP_${key}`] = value;
        }
      }
      Object.assign(env, server);

      const module = this.module;
      const envBytes = encodeEnvBlock(env);
      const envPointer = copyIn(module, envBytes);
      const bodyPointer = copyIn(module, bodyBytes);
      module.phpResponse = newCollector();
      this.busy = true;
      // PHP chdir()s to the script's directory on every request. Under
      // NODERAWFS that moves the Node process itself, so it is put back.
      // PHP does not rely on it surviving: the next request chdir()s again.
      const nodeCwd = typeof process === 'object' && typeof process.cwd === 'function' ? process.cwd() : null;
      let failed;
      let collected;
      try {
        failed = module._php_wasm_request(envPointer, envBytes.length, bodyPointer, bodyBytes.length);
      } catch (error) {
        this.broken = error;
        throw error;
      } finally {
        if (nodeCwd !== null && process.cwd() !== nodeCwd) {
          process.chdir(nodeCwd);
        }
        collected = module.phpResponse;
        module.phpResponse = null;
        this.busy = false;
        module._free(envPointer);
        module._free(bodyPointer);
      }

      let status = collected.status;
      const responseHeaders = [];
      for (const line of collected.headers.map(decodeLatin1)) {
        const colon = line.indexOf(':');
        if (colon < 0) {
          continue;
        }
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        // A CGI server turns a "Status:" header into the status line.
        if (name.toLowerCase() === 'status') {
          status = parseInt(value, 10) || status;
          continue;
        }
        responseHeaders.push([name, value]);
      }
      const responseBody = concatBytes(collected.body);
      return {
        failed: failed !== 0,
        status,
        headers: responseHeaders,
        header(name) {
          const found = responseHeaders.find(([key]) => key.toLowerCase() === name.toLowerCase());
          return found ? found[1] : null;
        },
        body: responseBody,
        text: decodeLatin1(responseBody),
        log: collected.log.map(decodeLatin1),
      };
    }
  }

  // A clock that reads startMs now and runs on from there, as libfaketime's
  // "@2002-06-03 12:00:00" does for the Docker stacks. It follows
  // performance.now(), as wasm_clock.c does, so the two do not drift apart.
  PhpRuntime.clockStartingAt = startMs => {
    const startedAt = performance.now();
    return () => startMs + (performance.now() - startedAt);
  };
  PhpRuntime.encodeLatin1 = encodeLatin1;
  PhpRuntime.decodeLatin1 = decodeLatin1;
  return PhpRuntime;
});
