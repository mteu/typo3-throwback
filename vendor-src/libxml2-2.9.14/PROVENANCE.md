# libxml2 2.9.14 — source archive provenance

**The last libxml2 2.9 release** (2022-05-02). `wasm/php-5.6.40/build.sh`
compiles it to WebAssembly for PHP 5.6.40's XML extensions: libxml, xml, dom
and SimpleXML. PHP 5.6 bundles no XML parser, and TYPO3 4.5.40 reads its
labels through `xml_parser_create()`.

| Field | Value |
| --- | --- |
| Version | 2.9.14 |
| Release date | 2022-05-02 |
| Archive | `libxml2-2.9.14.tar.xz` (3,129,968 bytes) |
| Source URL | https://download.gnome.org/sources/libxml2/2.9/libxml2-2.9.14.tar.xz |
| Retrieved | 2026-11-18 |
| Licence | MIT, in the archive's `Copyright` file |

## Checksum verification

The SHA-256 GNOME publishes beside the archive was verified and **matched
exactly**:

| Algorithm | Published | Downloaded | Match |
| --- | --- | --- | --- |
| SHA-256 | `60d74a257d1ccec0475e749cba2f21559e48139efba6ff28224357c7c798dfee` | `60d74a257d1ccec0475e749cba2f21559e48139efba6ff28224357c7c798dfee` | yes |

`libxml2-2.9.14.sha256sum` in this directory is GNOME's published file,
as retrieved, so the claim can be checked without the network. It also lists
the release's `.news` file.

Recorded locally (GNOME publishes neither):

| Algorithm | Value |
| --- | --- |
| SHA-1 | `4a46f37be1aaa33daac49b4dfb51eebe85d805a8` |
| MD5 | `b7b3029ac6beb32a7925225515f83ca3` |

`build.sh` checks `SHA256SUMS` before it unpacks anything.

## Why 2.9.14 specifically

PHP 5.6.40 needs libxml2 2.6.11 or newer (`acinclude.m4:2574`). 2.9.14 is the
newest release of the 2.9 line, the one current when PHP 5.6 was. Later
lines change the API that PHP 5.6's extensions were written against.

## How it is built

Static, with threads, HTTP, FTP, iconv, ICU, zlib, lzma, modules and the
Python bindings off. UTF-8, UTF-16 and ISO-8859-1 are built in, and TYPO3
4.5.40 needs no other encoding. `build.sh` checks that each feature is off in
the installed `xmlversion.h`.

## Re-fetching

```sh
curl -fsSLO https://download.gnome.org/sources/libxml2/2.9/libxml2-2.9.14.tar.xz
curl -fsSLO https://download.gnome.org/sources/libxml2/2.9/libxml2-2.9.14.sha256sum
sha256sum -c --ignore-missing libxml2-2.9.14.sha256sum
```

A network allowlist needs `download.gnome.org`.

## Security

libxml2 2.9.14 carries the fixes released up to 2022-05. Here it parses XML
that TYPO3's own source and its visitors' saved sites hold, inside a browser
tab, and fetches nothing: HTTP and FTP are compiled out.
