# PHP 4.4.9 — source archive provenance

**The last PHP 4 release ever made** (2008-08-07), and the runtime TYPO3 3.3.0
requires. Unlike the TYPO3 archives beside it this is not a CMS release; it is
here because `php4-base/` compiles it, and a stack whose compiler
input can vanish is not reproducible.

| Field | Value |
| --- | --- |
| Version | 4.4.9 (final release of the PHP 4 line) |
| Release date | 2008-08-07 |
| Archive | `php-4.4.9.tar.gz` (5,638,143 bytes) |
| Source URL | https://museum.php.net/php4/php-4.4.9.tar.gz |
| Retrieved | 2026-08-14 |
| Licence | PHP License 3.01 |

## Checksum verification

The MD5 published by php.net was verified and **matched exactly**:

| Algorithm | Published | Downloaded | Match |
| --- | --- | --- | --- |
| MD5 | `9bcc1aba50be0dfeeea551d018375548` | `9bcc1aba50be0dfeeea551d018375548` | yes |

Recorded locally (php.net publishes neither for this release):

| Algorithm | Value |
| --- | --- |
| SHA-256 | `0c86962c27309a82bfc46d954a29a0d896e469c05f4c5bfd731e33d47c10ad84` |
| SHA-1 | `9aec9c740011c7cf2b0891d544c454775283af04` |

The published MD5 comes from php.net's own release feed, snapshotted alongside
this file as `../php.net-releases-v4-2026-08-14.json` — so the claim above stays
auditable without a network round-trip, exactly as
`get.typo3.org-releases-2026-08-13.json` does for the TYPO3 archives.

MD5 is of course not a defence against a deliberate substitution. It is what
upstream published in 2008 and it is not being re-issued, so it is treated here as
corroboration that this is the same artefact php.net distributed, not as a
security boundary. The SHA-256 is the value `php4-base/Dockerfile`
enforces at build time, and it was recorded from this download.

## Why this is vendored

`php4-base/Dockerfile` copies this tarball instead of fetching it from
museum.php.net on every build. Fetching would make a 2008 end-of-life archive,
served by a single host with no mirror and no promise of continuity, a hard
build-time dependency of the only PHP 4 runtime in this repository.

It is the same failure mode `vendor-src/` prevents for TYPO3 sources, and the one
`.github/workflows/mirror-upstream-images.yml` prevents for container images.

`museum.php.net` remains the authority. This is a copy, verified against what
upstream published, not a fork.

## Why 4.4.9 specifically

The floor is TYPO3 3.3.0's own bootstrap, which refuses anything below PHP 4.0.3
(`typo3/init.php:166`). The ceiling is PHP 4 itself: 3.3.0 contains no PHP 5
awareness anywhere in its source, so 4.4.9 — the final PHP 4 — is the newest,
most-patched runtime the CMS can run on. See
`docs/how-it-works.md`.

It also still compiles from unmodified upstream source on Debian bullseye's
gcc 10, which is what makes the build auditable rather than dependent on an
unaudited community image. gcc 14 promotes the warnings this C89-era source
generates into hard errors; bullseye is pinned for that reason.

## Re-fetching

```sh
curl -fsSLo php-4.4.9.tar.gz https://museum.php.net/php4/php-4.4.9.tar.gz
md5sum -c MD5SUMS
sha256sum -c SHA256SUMS
```

## Security

PHP 4.4.9 has been end of life since 2008 and carries eighteen years of unpatched
vulnerabilities. It exists here to be compiled into a network-isolated
container and nothing else. See `3.3/compose.yaml`.
