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
// This release's shell, index.html, and nothing else: every page of the
// origin is a window client, LICENSES.txt and the other releases' shells
// included, and none of those would ever answer.
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

// The shell's colors, so these pages read as part of the museum.
const PAGE_STYLE = `
  :root { --bg: #f4f1ea; --bar: #ffffff; --text: #23211d; --muted: #6b665c; --line: #ddd7ca; --accent: #c8501e; --on-accent: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1b1a18; --bar: #252320; --text: #ece8df; --muted: #a39d90; --line: #3a3732; --accent: #f07a45; --on-accent: #1b1a18; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px 16px; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(560px, 100%); padding: 28px; background: var(--bar); border: 1px solid var(--line); border-radius: 10px; }
  .eyebrow { margin: 0 0 6px; color: var(--muted); font-size: 12px; }
  h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.25; }
  h2 { margin: 0 0 6px; font-size: 15px; }
  p { margin: 0 0 12px; }
  a { color: var(--accent); }
  .action { display: inline-block; margin: 4px 0 18px; padding: 9px 16px; border-radius: 6px; background: var(--accent); color: var(--on-accent); font-weight: 600; text-decoration: none; }
  .action:hover, .action:focus-visible { filter: brightness(1.08); }
  ul.options { margin: 0 0 4px; padding-left: 20px; }
  ul.options li { margin-bottom: 8px; }
  details { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; color: var(--muted); font-size: 14px; }
  details[open] summary { margin-bottom: 12px; }
  summary { color: var(--text); font-weight: 600; cursor: pointer; }
  details h2 { color: var(--text); font-size: 14px; margin-top: 14px; }
  kbd { padding: 0 5px; border: 1px solid var(--line); border-radius: 4px; font: inherit; font-size: 13px; white-space: nowrap; }
`;

function page(status, title, body) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style><main><p class="eyebrow">TYPO3 Throwback · v${scopePath.split('/').filter(Boolean).pop()}</p>${body}</main></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const OUTSIDE_LINK_PAGE = `
<h1>Open TYPO3 from its start page</h1>
<p>You reached a page inside this TYPO3 site directly, through a bookmark, a typed address, or a link from somewhere else. This site only answers its own pages, so it stopped here.</p>
<a class="action" href="${scopePath}">Go to the start page</a>
<ul class="options">
  <li>Looking for the backend? On the start page, click <kbd>Backend ↗</kbd>. It opens in a tab of its own. Keep the start page open next to it.</li>
  <li>Did you come from the start page? Then your browser did not say where the click came from. A privacy setting or an extension that strips the referrer does that. Allow referrers for this site, or try a window without extensions.</li>
</ul>
<details>
  <summary>Why does this happen?</summary>
  <h2>PHP runs in the start page</h2>
  <p>There is no server behind this site. PHP runs inside your browser, in the start page's tab. Every page of TYPO3, the backend included, is answered by that tab. A tab without the start page has nothing to answer it.</p>
  <h2>The backend needs a whole window</h2>
  <p>The start page shows TYPO3's frontend in a frame. The backend cannot live there. TYPO3 built it for the whole browser window: up to 4.0 it is a set of frames, and every release reaches for the top window to find its own parts. Inside the frame, the top window is the start page, so the backend breaks. That is why it opens in a separate tab, which still asks the start page for every request.</p>
  <h2>Why direct links stop here</h2>
  <p>This is old TYPO3 code, with the security holes of its time. If any link could reach it, another website could make your browser send requests in your name, for example a forged form to the backend. So the site only answers requests from its own pages.</p>
</details>
`;

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
    return page(403, 'Open TYPO3 from its start page', OUTSIDE_LINK_PAGE);
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
  const headers = {};
  for (const [name, value] of request.headers) {
    headers[name] = value;
  }
  headers.Host = url.host;
  headers['User-Agent'] = self.navigator.userAgent;
  headers.Referer = request.referrer;

  const message = { method: request.method, path: url.pathname, query: url.search.slice(1), headers, body, https: url.protocol === 'https:' };
  const deadline = Date.now() + LEADER_WAIT_MS;
  let response = null;
  for (;;) {
    const clients = await shells();
    if (clients.length === 0) {
      return page(503, 'Not running', `<h1>Not running</h1><p>This site runs inside its <a href="${scopePath}">start page</a>. Open that first.</p>`);
    }
    response = await askShells(clients, message);
    if (response) {
      break;
    }
    if (Date.now() > deadline) {
      return page(503, 'Not running', `<h1>Not running</h1><p>No tab runs PHP yet. Reload this site's <a href="${scopePath}">start page</a>.</p>`);
    }
    await sleep(LEADER_POLL_MS);
  }
  if (response.error) {
    return page(500, 'PHP worker error', `<h1>PHP worker error</h1><p>${response.error.replace(/</g, '&lt;')}</p>`);
  }
  const status = response.status >= 200 && response.status <= 599 ? response.status : 500;
  const withoutBody = [204, 205, 304].includes(status) || request.method === 'HEAD';
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return new Response(withoutBody ? null : response.body, { status, headers: responseHeaders });
}
