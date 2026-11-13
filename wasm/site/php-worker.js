// Runs a TYPO3 release on its PHP for a release's shell page (index.html):
// boots the site, answers the requests sw.js relays, and keeps the database
// and the writable directories in IndexedDB, so the next visit picks up where
// this one left off. One worker serves every release: the shell names its
// release and its site path in the worker's URL, as ?release=3.3.0&site=/3.3/site.
//
// PHP handles one request at a time, and a worker runs one message handler
// at a time, so requests queue here in the order they arrive.
'use strict';

// assemble.sh fills this in: each file's logical name, such as
// "runtime/tar.js" or "php-4.4.9/php.wasm", and its published name next to
// this worker, which carries a hash of its content. Pages lets browsers cache
// files for ten minutes, so right after a deploy a fixed name could give a
// new php.js and an old php.wasm. With hashed names, a stale shell asks for
// old names, which are gone, and fails with a 404 instead.
const FILES = {};
function published(name) {
  if (!Object.prototype.hasOwnProperty.call(FILES, name)) {
    throw new Error(`${name} is not part of this site`);
  }
  return FILES[name];
}

// Only a release the site was assembled with, and only a site path a shell's
// directory can have, both checked before anything loads.
const params = new URL(self.location.href).searchParams;
const releaseName = params.get('release') || '';
const urlPrefix = params.get('site') || '';
if (!/^\d+\.\d+\.\d+$/.test(releaseName) || !/^(\/[\w.-]+)*\/site$/.test(urlPrefix)) {
  throw new Error('the shell must name a release and its site path');
}
importScripts(...['runtime/php-runtime.js', 'runtime/mysql-sqlite.js', 'runtime/tar.js', 'runtime/typo3-site.js',
  'sql.js/sql-wasm.js', `releases/${releaseName}.js`].map(published));
const release = self.Typo3Releases[releaseName];
const inPhpBuild = file => published(`php-${release.php}/${file}`);
importScripts(inPhpBuild('php.js'));

const STORE = 'state';
const SAVE_DELAY_MS = 400;

let site = null;
let saveTimer = null;
let saving = Promise.resolve();
let resetting = false;

// fraction is how far boot has come, 0 to 1, for the shell's progress bar.
// Without one, the shell keeps the bar where it is and only shows the text.
function progress(text, fraction) {
  postMessage({ type: 'progress', text, fraction });
}

// The bar's share of each stage. PHP, provisioning and the unpacking run
// synchronously and cannot report from inside, so they get fixed steps; the
// archive download is the one stage that reports real bytes.
const DOWNLOAD_END = 0.4;
const GUNZIP_END = 0.45;
const BOOT_SHARE = 0.53;

async function fetchBytes(name, onBytes) {
  const response = await fetch(name);
  if (!response.ok) {
    throw new Error(`${name}: ${response.status}`);
  }
  if (!onBytes || !response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  // Content-Length is the encoded size. A server that compresses on the fly
  // sends more bytes than that through the reader, so the ratio is capped.
  const total = Number(response.headers.get('Content-Length')) || 0;
  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;
    if (total) {
      onBytes(Math.min(received / total, 1));
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
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
    const open = indexedDB.open(`typo3-throwback-${release.release}`, 1);
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
  progress(`loading PHP ${release.php}, SQLite and the TYPO3 ${release.release} archive`, 0.02);
  // One message per percent is plenty for a bar.
  let reported = 0;
  const reportDownload = ratio => {
    const fraction = 0.02 + (DOWNLOAD_END - 0.02) * ratio;
    if (fraction - reported >= 0.01) {
      reported = fraction;
      progress(`downloading the TYPO3 ${release.release} archive`, fraction);
    }
  };
  const [tarGz, provisionScript, legacyIni, SQL, snapshot] = await Promise.all([
    fetchBytes(published(release.archive), reportDownload),
    fetchBytes(published(release.provisionScript)),
    fetchBytes(published(release.ini)),
    initSqlJs({ locateFile: file => published(`sql.js/${file}`) }),
    loadSnapshot().catch(() => null),
  ]);
  progress('unpacking the archive', DOWNLOAD_END);
  const tarball = await gunzip(tarGz);
  site = await Typo3Site.boot({
    release,
    PhpRuntime,
    createPhp: options => createPhp({ ...options, locateFile: inPhpBuild }),
    MysqlOnSqlite,
    SQL,
    readTar,
    tarball,
    provisionScript,
    legacyIni,
    urlPrefix,
    snapshot: snapshot || null,
    onProgress: (text, share) => progress(text, share === undefined ? undefined : GUNZIP_END + BOOT_SHARE * share),
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
