# PHP 5.6.40 — source archive provenance

**The last PHP 5 release ever made** (2019-01-10). `wasm/php-5.6.40/build.sh`
compiles it to WebAssembly, the runtime TYPO3 4.5.40 needs in the browser. The
Docker stacks from 3.8 on run the same release, from the upstream
`php:5.6-apache` image. That image is pinned by digest, but it is not built
from here.

| Field | Value |
| --- | --- |
| Version | 5.6.40 (final release of the PHP 5 line) |
| Release date | 2019-01-10 |
| Archive | `php-5.6.40.tar.gz` (19,305,795 bytes) |
| Source URL | https://www.php.net/distributions/php-5.6.40.tar.gz |
| Retrieved | 2026-11-17 |
| Licence | PHP License 3.01, with the Zend Engine under the Zend Engine License 2.00 |

## Checksum verification

The SHA-256 published by php.net was verified and **matched exactly**:

| Algorithm | Published | Downloaded | Match |
| --- | --- | --- | --- |
| SHA-256 | `56fb9878d12fdd921f6a0897e919f4e980d930160e154cbde2cc6d9206a27cac` | `56fb9878d12fdd921f6a0897e919f4e980d930160e154cbde2cc6d9206a27cac` | yes |

Recorded locally (php.net publishes neither for this release):

| Algorithm | Value |
| --- | --- |
| SHA-1 | `08e399b93748c183eccc7e5847503970b4f32c38` |
| MD5 | `0f0e1372510dbcda1cb671c72d17c009` |

The published SHA-256 comes from php.net's release feed for the PHP 5 line,
snapshotted beside this directory as `../php.net-releases-v5-2026-11-17.json`.
So the claim above can be checked without the network, as
`../php.net-releases-v4-2026-08-14.json` does for PHP 4.4.9.

Unlike PHP 4.4.9's MD5, this is a checksum worth checking against: the
SHA-256 is what upstream published, and it is what `build.sh` enforces before
it unpacks anything.

## Why this is vendored

`wasm/php-5.6.40/build.sh` reads this tarball instead of fetching it. PHP 5
has been end of life since 2019, and php.net may move or drop the download.
A build that needs it from the network would break when it does. It is the
same reason `php-4.4.9/` is here.

php.net remains the authority. This is a copy, verified against what
upstream published, not a fork.

## Why 5.6.40 specifically

TYPO3 4.5.40 refuses PHP older than 5.2.0 (`typo3/init.php:63`). It needs the
`mysql` extension, which PHP 7.0 removed. So PHP 5.6.40, the final PHP 5, is
the newest, most-patched runtime it can run on, and the one its Docker stack
runs.

## Re-fetching

```sh
curl -fsSLo php-5.6.40.tar.gz https://www.php.net/distributions/php-5.6.40.tar.gz
sha256sum -c SHA256SUMS
```

`php.net/distributions/` redirects to `www.php.net`, so a network allowlist
needs both hosts.

## Security

PHP 5.6.40 has been end of life since 2019-01 and carries years of unpatched
vulnerabilities. Here it is compiled to WebAssembly and runs inside a browser
tab, against a database in the same tab. It is never a server.
