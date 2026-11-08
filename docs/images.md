# The images

Six packages. Two are images this project builds, `typo3` and `php4-base`. Four
are copies of other people's images: `mysql`, `nginx`, `debian` and `php`.

All of them live under `ghcr.io/mteu/typo3-throwback/`. They are public, so
pulling them needs no login.

The three images a stack runs, `typo3`, `mysql` and `nginx`, each carry a signed
SBOM. [How to check one](vulnerabilities.md#the-sboms-in-the-registry).

| Package | Tags | Needed to run a stack | Needed to rebuild |
| --- | --- | --- | --- |
| `typo3` | `3.3.0`, `3.8.1`, `4.0.13`, `4.5.40`, `6.2.31`, `<version>-sha-<commit>` | yes | yes |
| `mysql` | `5.5` | yes | no |
| `nginx` | `1.27.5` | yes | no |
| `php4-base` | `4.4.9`, `sha-<commit>` | 3.3 only, inside `typo3:3.3.0` | 3.3 only |
| `debian` | `bullseye`, `bullseye-slim` | no | `php4-base` only |
| `php` | `5.6-apache` | 3.8 to 6.2, inside their `typo3` images | 3.8 to 6.2 only |

The compose files pin `mysql` and `nginx` by digest. The tags above are for humans.

## typo3

The TYPO3 release itself, one tag per version. This is the only image you ever
name yourself. `3.3.0` is TYPO3 3.3.0 on PHP 4.4.9 behind nginx and FastCGI. `3.8.1`
is TYPO3 3.8.1 on PHP 5.6.40 under Apache. `4.0.13`, `4.5.40` and `6.2.31` run on the same
PHP and Apache.

The `<version>-sha-<commit>` tags never move. Use one if you need an image that
cannot change under you.

## mysql

MySQL 5.5, the database for every stack. It is a copy of the upstream
`mysql@sha256:12da85ab…` image, not something this project builds.

5.5 is not a preference. PHP 4 has a MySQL client compiled into it that only
speaks the pre-4.1 password protocol. MySQL 5.7 removed that protocol, and 5.6
turns it off by default. So 3.3 needs 5.5 started with `--old-passwords=1`, and
nothing newer will do. Every later stack runs on it too: it is the closest match to
what each was written against, and 4.5's schema uses `recursive` as a bare column
name, which MySQL 8.0 and MariaDB 10.2 reserve. 3.x and 4.0 run it as latin1, 4.5
and 6.2 as utf8 (each compose file sets the server charset).

It reached end of life in 2018 and was never published for arm64. That is why it
is mirrored, and why the stacks run under emulation on Apple Silicon.

## nginx

nginx 1.27.5, the `edge` container in front of each stack. It is a copy of the
upstream `nginx@sha256:65645c7b…` image.

It is the only container with a published port, bound to `127.0.0.1`. It exists
because Docker cannot give one container both a published port and no network
egress. `web` and `db` sit on an internal network with no route out. `edge` sits
on that network and on a second one, and passes requests through. It runs no
TYPO3 code, so it is safe for it to have a way out.

nginx is still maintained, and this pin could be replaced at any time. It is
mirrored so that the stack runs with Docker Hub unreachable. A proxy that cannot
start stops the stack as surely as a missing database. Unlike `mysql`, it is a
real multi-arch image, so it does not run under emulation.

## php4-base

PHP 4.4.9, built by this project. No TYPO3 is in it. It is the runtime for every
TYPO3 release old enough to need PHP 4, and 3.3.0 is built `FROM` it.

PHP 4 is compiled from the unmodified upstream source in
[`vendor-src/php-4.4.9/`](../vendor-src/php-4.4.9/PROVENANCE.md). It needs gcc 10 with
`-fcommon`, which is why it builds on Debian bullseye. Newer compilers turn
warnings this 2008 code produces into errors. The image also carries nginx, the
FastCGI wiring (PHP 4 has no FPM), ImageMagick, GD, and libfaketime for the
faked clock. The binaries are in `/opt/php4/bin` as `php-cgi` and `php-cli`.

You never run it on its own. It is a separate image so the compile, which is slow,
happens once in CI and not on every machine. Nothing newer than 3.3 uses it.

## debian

Debian 11 "bullseye", in two tags, `bullseye` and `bullseye-slim`. Copies of the
upstream `debian@sha256:99cdf779…` and `debian@sha256:f313b4bd…` images.

They are the two stages of the `php4-base` build. `bullseye` holds the compiler
and `bullseye-slim` is what the finished image runs on. They are not part of any
running stack, and `docker compose up` never touches them. You only need them to
rebuild `php4-base` from source, and only if you want to avoid Docker Hub. Pass
`--build-arg BASE_REGISTRY=ghcr.io/mteu/typo3-throwback` to use them.

Bullseye is end of life, and its packages have left the main Debian servers. The
build fetches them from `archive.debian.org` and a pinned `snapshot.debian.org`
timestamp. The base images are mirrored here for the same reason.

## php

PHP 5.6, the official `php:5.6-apache` image, copied as `php@sha256:0a40fd27…`. It
is the base of every `typo3` image from 3.8.1 to 6.2.31.

5.6 is the newest PHP that 3.8.1 can run on. TYPO3 3.8 calls `mysql_connect()`
directly, and the `mysql` extension was removed in PHP 7.0. It is long past end of
life, and nothing upstream promises to keep it. Losing it would leave 3.8 with no
runtime at all.

It is built on Debian stretch, whose package signing keys have expired. The 3.8
Dockerfile has to switch signature checking off for that one build step. This is
the weakest link in the project, and the 3.8 Dockerfile says so plainly.

## Licences in the images

Each `typo3` image ships its release's tree unmodified, so every licence file the
release bundles is in the image. `/usr/share/doc/typo3-<version>/LICENCES.md` lists
them: [3.3.0](../3.3/LICENCES.md), [3.8.1](../3.8/LICENCES.md),
[4.0.13](../4.0/LICENCES.md), [4.5.40](../4.5/LICENCES.md),
[6.2.31](../6.2/LICENCES.md).

`php4-base`, and so `typo3:3.3.0`, ships PHP 4.4.9 as a binary, which carries none
of its sources' headers. [`NOTICES.txt`](../php4-base/NOTICES.txt), at
`/usr/share/doc/php-4.4.9/NOTICES.txt` in the image, carries the licence files of
every compiled part and every third-party notice those parts state only in a header.

Both are generated from the archives in [`vendor-src/`](../vendor-src/README.md) by
`.github/scripts/licence_inventory.py`, and CI fails when they are stale. The
copied images, `mysql`, `nginx`, `debian` and `php`, carry their upstream notices
([`NOTICE`](../NOTICE)).

## Why the copies are trustworthy

The four copies are byte-identical to upstream. The mirror workflow uses
`skopeo copy --preserve-digests`, which fails rather than rewriting anything, and
then re-derives each digest from the mirrored manifest and compares it with the
pin. So a digest means the same thing on Docker Hub and here. Only the hostname
differs.

Because they are copies, they carry upstream's licences and no changes of ours.

## Using these images from another project

The images are meant to be built on. Each one's interface is its environment and
a few paths:

| | |
| --- | --- |
| `TYPO3_DB_HOST`, `TYPO3_DB_NAME`, `TYPO3_DB_USER`, `TYPO3_DB_PASSWORD` | Database connection. Default `db` / `typo3` / `typo3` / `typo3`. |
| `TYPO3_PROVISION` | 3.3 to 4.5. `auto`, `wizard`, or (3.3 only) `preprovisioned`. That last one imports nothing and refuses to start unless the database's datadir already carries a provisioned site. It is for callers that bake the datadir ahead of time. |
| `LD_PRELOAD`, `FAKETIME` | The clock, set back to the release date. Baked into every image from 3.8 on: 3.8 lets it run from that instant (`@`), 4.0 to 6.2 hold it still. For 3.3, the caller sets them, as `3.3/compose.yaml` does. A caller that holds 3.3's clock still gets one session id for every session, so a cookieless request lands in whichever session is logged in; use `@` for anything a person logs in to. |
| `TYPO3_BEHIND_TLS` | 4.0, 4.5 and 6.2. `1` sets `HTTPS=on` in Apache, so TYPO3's absolute redirects say `https://`. Default `0`. |
| `/var/www/html/typo3conf` | Where `localconf.php` is generated on first boot. Writable. |
| `/opt/typo3_src-3.3.0/typo3/temp` | 3.3 only. Writable. Under a read-only root filesystem, mount a tmpfs here; the entrypoint restores the shipped GIFs from `/opt/typo3-temp-seed`. |

Pin by digest or by a `-sha-` tag if you need an image that never moves.

How they are built and published is in [`building.md`](building.md).
