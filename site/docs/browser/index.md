---
icon: lucide/app-window
---

# In your browser

TYPO3 runs in your own tab. PHP is compiled to WebAssembly, the database
lives in the tab with it, and nothing runs on a server. There is nothing to
install.

| TYPO3 | In your browser |
| --- | --- |
| ![](../assets/marks/mark1-blue-2002.png){ .mark } [3.3.0](3.3.md) | [open it](../../3.3/) |
| ![](../assets/marks/mark2-sheets-2003.png){ .mark } [3.8.1](3.8.md) | [open it](../../3.8/) |
| ![](../assets/marks/mark3-orange-green-4x.png){ .mark } [4.0.13](4.0.md) | [open it](../../4.0/) |
| ![](../assets/marks/mark4-orange-2012.png){ .mark } [4.5.40](4.5.md) | [open it](../../4.5/) |
| ![](../assets/marks/mark4-orange-2012.png){ .mark } [6.2.31](6.2.md) | [open it](../../6.2/) |

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

- **PHP is the original interpreter.** PHP 4.4.9 and PHP 5.6.40 are compiled
  from unmodified upstream source to WebAssembly, with Emscripten. The
  PHP-in-WebAssembly builds we know of start at PHP 7.4, so these are built
  here. Each release runs on one of them, and your browser downloads only
  that one.
- **The database is SQLite, answering as the MySQL each release expects.**
  TYPO3 talks to PHP's own, unmodified `mysql` or `mysqli` extension.
  Underneath, a small client library answers its calls from SQLite, also
  compiled to WebAssembly.

    | TYPO3 | PHP | Answers as |
    | --- | --- | --- |
    | 3.3.0 | 4.4.9 | MySQL 3.23.49 |
    | 3.8.1 | 4.4.9 | MySQL 3.23.49 |
    | 4.0.13 | 4.4.9 | MySQL 5.5.62, latin1, the server of its Docker stack |
    | 4.5.40 | 5.6.40 | MySQL 5.5.62, UTF-8, the server of its Docker stack |
    | 6.2.31 | 5.6.40 | MySQL 5.5.62, UTF-8, the server of its Docker stack |

- **A service worker carries each request to PHP.** Your browser asks for a
  page as usual. The service worker hands the request to PHP, running in a
  worker of your tab, and returns its answer.
- **Your site is saved in your browser.** After each change, the site's files,
  database and cookies are stored in the browser's own storage, and a reload
  carries on from there. A backend login stays logged in. "Reset site" throws
  it away and starts fresh.
- **One PHP for the whole browser.** Open the site in a second tab, and that tab
  uses the first tab's PHP. Close the first, and another tab takes over from
  the saved site, backend login included.
- **The clock is set back.** It starts at noon on the release day, UTC, and
  runs from there, as in the Docker stacks.

## What works, and what does not

- **Images: GD, yes. ImageMagick, no.** PHP's bundled GD draws the menus, with
  FreeType for text, and writes GIF, PNG and JPEG. ImageMagick is a separate
  program, and a page cannot start programs. Up to 4.5, TYPO3 has a setting
  for a server without it, and the site uses it. Images are served at their
  own size, because scaling needs ImageMagick. 6.2 keeps ImageMagick on, as
  its Docker stack does, and what needs it fails here as it fails there.
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
