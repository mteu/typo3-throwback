// Runs TYPO3 3.3.0 on PHP 4.4.9 for the shell page (index.html): boots the
// site, answers the requests sw.js relays, and keeps the database and the
// writable directories in IndexedDB, so the next visit picks up where this
// one left off.
//
// PHP handles one request at a time, and a worker runs one message handler
// at a time, so requests queue here in the order they arrive.
'use strict';

// assemble.sh fills this in: each file's published name, which carries a
// hash of its content. Pages lets browsers cache files for ten minutes, so
// right after a deploy a fixed name could give a new php4.js and an old
// php4.wasm. With hashed names, a stale shell asks for old names, which are
// gone, and fails with a 404 instead.
const FILES = {};
const published = name => FILES[name] || name;

importScripts(...['php4-runtime.js', 'mysql-sqlite.js', 'tar.js', 'typo3-site.js', 'sql-wasm.js', 'php4.js'].map(published));

const urlPrefix = new URL('site', self.location.href).pathname;
const STORE = 'state';
const SAVE_DELAY_MS = 400;
// Noon on the 3.3.0 release day, UTC, where 3.3/compose.yaml starts
// libfaketime. The clock runs on from there, and starts there again on every
// visit, as it does when the container restarts.
const RELEASE_NOON_MS = Date.UTC(2002, 5, 3, 12, 0, 0);

let site = null;
let saveTimer = null;
let saving = Promise.resolve();
let resetting = false;

function progress(text) {
  postMessage({ type: 'progress', text });
}

async function fetchBytes(name) {
  const response = await fetch(name);
  if (!response.ok) {
    throw new Error(`${name}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function gunzip(bytes) {
  // A server that sends the archive with Content-Encoding: gzip has fetch()
  // unpack it already.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return bytes;
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function database() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('typo3-throwback-3.3.0', 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function storage(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

const loadSnapshot = () => storage('readonly', store => store.get('snapshot'));
const saveSnapshot = snapshot => storage('readwrite', store => store.put(snapshot, 'snapshot'));
const clearSnapshot = () => storage('readwrite', store => store.delete('snapshot'));

async function boot() {
  progress('loading PHP 4.4.9, SQLite and the TYPO3 3.3.0 archive');
  const [tarGz, provisionScript, legacyIni, SQL, snapshot] = await Promise.all([
    fetchBytes(published('typo3_src-3.3.0.tar.gz')),
    fetchBytes(published('provision.php')),
    fetchBytes(published('php-legacy.ini')),
    initSqlJs({ locateFile: published }),
    loadSnapshot().catch(() => null),
  ]);
  site = await Typo3Site.boot({
    Php4Runtime,
    createPhp4: options => createPhp4({ ...options, locateFile: published }),
    MysqlOnSqlite,
    SQL,
    readTar,
    tarball: await gunzip(tarGz),
    provisionScript,
    legacyIni,
    urlPrefix,
    clockStartMs: RELEASE_NOON_MS,
    snapshot: snapshot || null,
    onProgress: progress,
  });
  if (!site.restored) {
    await saveSnapshot(site.snapshot());
  }
  postMessage({ type: 'ready', restored: site.restored, provisionOutput: site.provisionOutput || '' });
}

function scheduleSave() {
  if (resetting) {
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saveSnapshot(site.snapshot()).catch(error => progress(`could not save: ${error}`));
  }, SAVE_DELAY_MS);
}

self.onmessage = async event => {
  const message = event.data;
  if (message.type === 'request') {
    const [port] = event.ports;
    try {
      await booted;
      const response = site.handle(message.request);
      // Install Tool edits land in typo3conf/, not the database.
      if (site.changed || message.request.method === 'POST') {
        scheduleSave();
      }
      port.postMessage({ status: response.status, headers: response.headers, body: response.body }, [response.body.buffer]);
    } catch (error) {
      port.postMessage({ error: String(error && error.stack || error) });
    }
  } else if (message.type === 'reset') {
    // No save may land after the delete: none scheduled from now on, and
    // the one in flight, if any, finishes first.
    resetting = true;
    clearTimeout(saveTimer);
    await saving;
    await clearSnapshot();
    postMessage({ type: 'reset-done' });
  }
};

// Last, so every helper above exists when it runs.
const booted = boot().catch(error => {
  postMessage({ type: 'failed', message: String(error && error.stack || error) });
  throw error;
});
