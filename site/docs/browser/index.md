# In your browser

TYPO3 runs in your own tab. PHP is compiled to WebAssembly, the database
lives in the tab with it, and nothing runs on a server. There is nothing to
install.

| TYPO3 | In your browser |
| --- | --- |
| [3.3.0](3.3.md) | [open it](../../3.3/) |
| [3.8.1](3.8.md) | [open it](../../3.8/) |
| 4.0.13 | not yet |
| 4.5.40 | not yet |
| 6.2.31 | not yet |

## What WebAssembly does

WebAssembly is a compact binary format that browsers run next to JavaScript.
Programs written in C, such as PHP, can be compiled to it. The browser then runs
them at close to native speed, inside the same sandbox as any web page.

That is the whole trick. PHP is not translated to JavaScript or run through an
emulator. Its C source is compiled once, ahead of time, into a `.wasm` file. Your
browser downloads that file and runs it like a script.

The sandbox is also why some things do not work here. A page cannot read your
files, reach other programs or open network connections of its own. PHP only gets
what the page hands it.

## How it works

- **PHP is the original interpreter.** PHP 4.4.9 is compiled from unmodified
  upstream source to WebAssembly, with Emscripten. The PHP-in-WebAssembly builds we
  know of start at PHP 7.4, so this one is built here.
- **The database is SQLite, answering as MySQL 3.23.** TYPO3 talks to PHP's own,
  unmodified `mysql` extension. Underneath, a small client library answers its
  calls from SQLite, also compiled to WebAssembly.
- **A service worker carries each request to PHP.** Your browser asks for a
  page as usual. The service worker hands the request to PHP, running in a
  worker of your tab, and returns its answer.
- **Your site is saved in your browser.** After each change, the site's files and
  database are stored in the browser's own storage, and a reload carries on
  from there. "Reset site" throws it away and starts fresh.
- **One PHP for the whole browser.** Open the site in a second tab, and that tab
  uses the first tab's PHP. Close the first, and another tab takes over from
  the saved site. A backend login does not survive that hand-over.
- **The clock is set back.** It starts at noon on the release day, UTC, and
  runs from there, as in the Docker stacks.

## What works, and what does not

- **Images: GD, yes. ImageMagick, no.** PHP's bundled GD draws the menus, with
  FreeType for text, and writes GIF, PNG and JPEG. ImageMagick is a separate
  program, and a page cannot start programs. TYPO3 has a setting for a server
  without it, and uses it. Images are served at their own size, because
  scaling needs ImageMagick.
- **Uploads work.** Files go into `fileadmin/` through TYPO3's own file module,
  and are saved with the rest of the site. TYPO3 refuses `.php` files itself.
- **No other programs.** Anything TYPO3 would do by starting a program, such as
  `unzip`, does not work.
- **Chromium is the only browser it is tested in.** Firefox and Safari may work,
  but nothing checks them yet.

## Security

The old releases carry known, unpatched holes. In your browser, that is
contained this way:

- **The site has its own origin.** It runs on `throwback.mteu.cc` and shares its
  storage with no other site.
- **Only your own tab reaches PHP.** Requests from other sites are refused.
- **A Content Security Policy keeps the old pages in.** They can run their own
  scripts, but cannot load from or send to anywhere else.

Every release on this site shares the origin. One release's backend could
read another's saved site, which is only ever your own throwaway data.
