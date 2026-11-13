// Relays every request for the TYPO3 site (site/ below this worker's scope)
// to the shell page that runs PHP, which hands it to its PHP worker. Several
// shells may be open; the one holding index.html's Web Lock runs PHP, and
// the others decline. Stateless on purpose:
// a browser may stop a service worker whenever it is idle, and PHP's memory,
// filesystem and database live in the page's worker instead.
//
// Cookies stay on the PHP side (runtime/typo3-site.js keeps the jar): a
// service worker cannot read a request's Cookie header, and the browser
// ignores Set-Cookie on a response a service worker makes.
'use strict';

const scopePath = new URL(self.registration.scope).pathname;
const sitePath = `${scopePath}site`;
// The shell, index.html, and nothing else under the scope: a tab showing
// LICENSES.txt is a window client too, and would never answer.
const shellPaths = [scopePath, `${scopePath}index.html`];
// How long a request waits for a shell to hold the PHP lock: while the tab
// that ran PHP closes and another takes over, no shell holds it.
const LEADER_WAIT_MS = 10000;
const LEADER_POLL_MS = 100;

// Sent with every response from site/. 3.3.0 needs inline script, inline
// event handlers and javascript: URLs, so this does not stop an injected
// script from running. It stops it from loading more code from anywhere but
// this site, and from sending data out with fetch, XHR, an image or a form.
// It cannot stop a navigation. The sources name this site's path, not the
// origin, because the origin holds every Pages site of the account. The
// exception is frame-ancestors, which compares only the framing page's
// origin: a path there would refuse the site's own frames.
const scope = self.registration.scope;
const CONTENT_SECURITY_POLICY = [
  `default-src ${scope}`,
  `script-src ${scope} 'unsafe-inline' 'unsafe-eval'`,
  `style-src ${scope} 'unsafe-inline'`,
  `img-src ${scope} data:`,
  "object-src 'none'",
  `base-uri ${scope}`,
  `form-action ${scope}`,
  "frame-ancestors 'self'",
].join('; ');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !(url.pathname === sitePath || url.pathname.startsWith(`${sitePath}/`))) {
    return;
  }
  event.respondWith(relay(event.request, url));
});

// Top-level only: a shell inside a frame refuses to start, so it would
// never answer.
async function shells() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.filter(client => client.frameType === 'top-level' && shellPaths.includes(new URL(client.url).pathname));
}

// Asks every shell; the one that holds the PHP lock answers, the others
// decline. Resolves to the answer, or to null when all of them declined.
// Each shell gets its own copy of the body, as a transfer can go only once.
function askShells(clients, request) {
  return new Promise(resolve => {
    let declined = 0;
    for (const client of clients) {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => {
        if (event.data && event.data.notLeader) {
          declined++;
          if (declined === clients.length) {
            resolve(null);
          }
        } else {
          resolve(event.data);
        }
      };
      const body = request.body ? request.body.slice() : null;
      client.postMessage({ type: 'php-request', request: { ...request, body } }, [channel.port2, ...(body ? [body.buffer] : [])]);
    }
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function page(status, title, text) {
  return new Response(`<!doctype html><title>${title}</title><p>${text}</p>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// Another site could link to site/ or frame it, so that PHP 4 answers a
// request the visitor never meant to make: a reflected XSS in 2002 code, or a
// forged POST to the backend. The shell and the site's own pages send a
// referrer under this scope with every request. A link from elsewhere sends
// a foreign referrer, or none when it asks for no-referrer.
//
// It fails closed. A referrer policy that sends only the origin, or none at
// all, set by a browser setting or an extension, gets the 403 too. The rule
// keeps out other origins only: a page on the same origin, another Pages site
// of the same account, can set any same-origin referrer, and can reach this
// site's storage directly anyway.
function fromThisSite(request) {
  return request.referrer.startsWith(self.registration.scope);
}

async function relay(request, url) {
  if (!fromThisSite(request)) {
    return page(403, 'Open it from the start page', `This site only answers its own pages. Open its <a href="${scopePath}">start page</a> instead. If you came from there, a browser setting or an extension that strips the referrer is in the way.`);
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
  const headers = {};
  for (const [name, value] of request.headers) {
    headers[name] = value;
  }
  headers.Host = url.host;
  headers['User-Agent'] = self.navigator.userAgent;
  headers.Referer = request.referrer;

  const message = { method: request.method, path: url.pathname, query: url.search.slice(1), headers, body };
  const deadline = Date.now() + LEADER_WAIT_MS;
  let response = null;
  for (;;) {
    const clients = await shells();
    if (clients.length === 0) {
      return page(503, 'Not running', `This site runs inside its <a href="${scopePath}">start page</a>. Open that first.`);
    }
    response = await askShells(clients, message);
    if (response) {
      break;
    }
    if (Date.now() > deadline) {
      return page(503, 'Not running', `No tab runs PHP yet. Reload this site's <a href="${scopePath}">start page</a>.`);
    }
    await sleep(LEADER_POLL_MS);
  }
  if (response.error) {
    return page(500, 'PHP worker error', response.error.replace(/</g, '&lt;'));
  }
  const status = response.status >= 200 && response.status <= 599 ? response.status : 500;
  const withoutBody = [204, 205, 304].includes(status) || request.method === 'HEAD';
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return new Response(withoutBody ? null : response.body, { status, headers: responseHeaders });
}
