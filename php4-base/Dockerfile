# PHP 4.4.9 base image for the pre-PHP-5 containers.
#
# This is era-level infrastructure, not a container. It builds the PHP
# runtime, the web server and the FastCGI wiring that *any* TYPO3 release too old
# for PHP 5 needs, so that each such <version>/ directory only has to add
# its own source tree and provisioning.
#
# Why each pin is what it is: docs/how-it-works.md.
# Short version: 3.3.0 has no PHP 5 awareness anywhere in its source, so unlike
# 3.8.1 it cannot use an official php:5.6 image and PHP has to be compiled. 3.5.0 (2003-02) and 3.6.2 (2004-07)
# also predate PHP 5 and are expected to reuse this image unchanged.
#
# Build it on its own with:
#   docker build -f php4-base/Dockerfile -t typo3-throwback/php4-base:4.4.9 .
#
# The context is the repository root, not this directory, because the PHP source
# tarball is vendored in vendor-src/php-4.4.9/ and has to be reachable — same
# arrangement 3.3/Dockerfile already uses for the TYPO3 archive. That is
# why the COPY paths below are repo-relative.
#
# Stacks do not need that step — 3.3/compose.yaml declares
# this image as a build context and Compose builds it on demand.

# ---------------------------------------------------------------------------
# Stage 1: compile PHP 4.4.9
# ---------------------------------------------------------------------------
# Debian bullseye ships gcc 10, which is the newest compiler that builds PHP 4
# from unmodified source. Both halves of that matter:
#
#   * gcc >= 10 defaults to -fno-common, which breaks PHP 4's many tentative
#     definitions. Restored explicitly with -fcommon in CFLAGS below.
#   * gcc 14 promotes implicit-function-declaration and int-conversion from
#     warnings to hard errors, and this C89-era source trips over both
#     constantly. On gcc 10 they are still warnings, so no source patching is
#     needed at all — which is what keeps this build auditable.
#
# Pinned by digest, same as 3.8.
#
# BASE_REGISTRY selects *where* the pinned digests are fetched from, never what
# is fetched — .github/workflows/mirror-upstream-images.yml keeps a byte-identical
# copy of both digests below in this repository's GHCR namespace, so either source
# resolves to the same bytes or fails outright. Default is upstream, which keeps
# this file's promise that the build needs no registry credentials. To build with
# Docker Hub unreachable, point it at the mirror:
#
#   docker build --build-arg BASE_REGISTRY=ghcr.io/mteu/typo3-throwback \
#     -f php4-base/Dockerfile \
#     -t ghcr.io/mteu/typo3-throwback/php4-base:4.4.9 .
#
# Declared before the first FROM so it is a global ARG both stages can use.
ARG BASE_REGISTRY=docker.io/library

# Where bullseye's packages come from, and why it takes two hosts.
#
# Bullseye is end of life and its packages have left deb.debian.org. The Release
# files are still served there and still list versions, so apt resolves happily
# and then fails on a 404 per .deb — a confusing way to find out a suite is gone.
#
# main and bullseye-updates moved to archive.debian.org, which is their permanent
# home. bullseye-security did not: that archive's dists/ stops at buster. The
# base images below ship packages *from* bullseye-security — libc6
# 2.31-13+deb11u14 among them — and a -dev package pins its runtime's exact
# version, so main alone cannot satisfy one. That is the "held broken packages"
# dead end, and dropping the suite is not a workaround for it.
#
# snapshot.debian.org keeps every pool file, addressed by timestamp, so it is
# where bullseye-security still exists. It carries main as well, and this build
# deliberately does not take it from there: snapshot answers 503 for main's pool
# often enough to break a build, while the security pool it is the only source
# for answers reliably. Each host does the part it is good at.
#
# The timestamp is the apt equivalent of the digests above — the security
# packages resolve to the same versions on every build rather than to whatever a
# live suite holds. Roll it forward only deliberately, and never past bullseye's
# own end: there is nothing newer to get, and a timestamp from before the base
# images were built puts their security-updated packages out of reach again.
ARG DEBIAN_SNAPSHOT=20260901T000000Z

FROM ${BASE_REGISTRY}/debian@sha256:99cdf7792e25416bd801861ccd8e2fb27fb527b25e8d9a8704ebc3ead2015675 AS php-build

# Both hosts serve Release files signed by keys the base image already trusts, so
# signature verification stays on and only the freshness check is relaxed — an
# archived or snapshotted Release has a Valid-Until in the past by definition.
# This is deliberately not `trusted=yes`, which 3.8 still needs: an expired
# Release is a stale index, an unverified one is no index at all.
ARG DEBIAN_SNAPSHOT
RUN set -eux; \
    { \
        echo "deb http://archive.debian.org/debian bullseye main"; \
        echo "deb http://archive.debian.org/debian bullseye-updates main"; \
        echo "deb http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bullseye-security main"; \
    } > /etc/apt/sources.list; \
    { \
        echo 'Acquire::Check-Valid-Until "false";'; \
        echo 'Acquire::Retries "10";'; \
        echo 'Acquire::http::Timeout "120";'; \
        echo 'Acquire::http::Pipeline-Depth "0";'; \
        echo 'Acquire::Queue-Mode "access";'; \
    } > /etc/apt/apt.conf.d/10archived-suites

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        bison \
        flex \
        libjpeg-dev \
        libpng-dev \
        libfreetype6-dev \
        zlib1g-dev; \
    rm -rf /var/lib/apt/lists/*

# PHP 4 predates Debian multiarch: its configure probes only <prefix>/lib and
# never /usr/lib/x86_64-linux-gnu, so --with-jpeg-dir=/usr fails with
# "libjpeg.(a|so) not found". Point the legacy paths at the real libraries.
RUN set -eux; \
    for lib in libjpeg libpng libfreetype libz; do \
        ln -sf "/usr/lib/x86_64-linux-gnu/${lib}.so" "/usr/lib/${lib}.so"; \
    done

ARG PHP_VERSION=4.4.9
ARG PHP_SHA256=0c86962c27309a82bfc46d954a29a0d896e469c05f4c5bfd731e33d47c10ad84

# From vendor-src/, not from museum.php.net — the same reasoning 3.3's
# Dockerfile applies to the TYPO3 archive. Fetching it would make a 2008
# end-of-life tarball, served by a single host with no mirror, a hard build-time
# dependency of the only PHP 4 runtime here.
# vendor-src/php-4.4.9/PROVENANCE.md records the download and its verification
# against php.net's published MD5.
#
# The sha256 is re-verified here rather than trusted: if the vendored archive is
# ever swapped, the build fails instead of silently compiling a different PHP.
#
# Note this is why the build context is the repository root and not
# php4-base/ — see the header.
COPY vendor-src/php-4.4.9/php-4.4.9.tar.gz /tmp/php.tar.gz
RUN set -eux; \
    echo "${PHP_SHA256}  /tmp/php.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/php.tar.gz -C /usr/src; \
    rm /tmp/php.tar.gz

WORKDIR /usr/src/php-${PHP_VERSION}

# --disable-all keeps the build small and fast; everything TYPO3 3.x actually
# touches is then re-enabled by hand:
#
#   --enable-cgi + --enable-fastcgi  the SAPI nginx talks to. There is no FPM in
#                                    PHP 4, and PHP 4's Apache SAPI targets
#                                    Apache 1.3/2.0 and will not build against a
#                                    current httpd — hence nginx here where
#                                    3.8 uses php:5.6-apache.
#   --with-mysql                     with no path this uses the libmysqlclient
#                                    3.23 bundled *inside* PHP 4, which speaks
#                                    the pre-4.1 auth protocol. That is what
#                                    forces MySQL 5.5 with --old-passwords=1 on
#                                    the database side.
#   --with-pcre-regex                TYPO3 leans on preg_* everywhere.
#   --with-gd ...                    GIFBUILDER (menus, image text) needs GD with
#                                    GIF *write* support, which the GD 2.0.28
#                                    bundled in PHP 4 still has. It also drives
#                                    the Install Tool image checks that render
#                                    the About screen.
RUN set -eux; \
    CFLAGS="-O2 -fcommon -fno-strict-aliasing -Wno-implicit-function-declaration" \
    ./configure \
        --prefix=/opt/php4 \
        --disable-all \
        --enable-cgi \
        --enable-fastcgi \
        --with-mysql \
        --with-pcre-regex \
        --enable-session \
        --with-zlib \
        --with-gd \
        --with-jpeg-dir=/usr \
        --with-png-dir=/usr \
        --with-freetype-dir=/usr \
        --enable-gd-native-ttf; \
    make -j"$(nproc)"; \
    make install

# `make install` only installs the CGI binary (as bin/php) because --enable-cgi
# makes it the default target. The CLI is built anyway and the stacks use
# it to provision their databases, so keep both under unambiguous names.
RUN set -eux; \
    cp sapi/cli/php /opt/php4/bin/php-cli; \
    cp sapi/cgi/php /opt/php4/bin/php-cgi

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
# Same BASE_REGISTRY selector as stage 1. No re-declaration needed: an ARG
# declared before the first FROM is global and in scope for every stage's FROM
# line — it would only need repeating to use it in an instruction *inside* a stage.
FROM ${BASE_REGISTRY}/debian@sha256:f313b4bd62667092a59b3a664d7d3ab8b5e65f41675f48e81455a15dc5abe792 AS runtime

# Same apt pin as the build stage, for the same reason.
ARG DEBIAN_SNAPSHOT
RUN set -eux; \
    { \
        echo "deb http://archive.debian.org/debian bullseye main"; \
        echo "deb http://archive.debian.org/debian bullseye-updates main"; \
        echo "deb http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bullseye-security main"; \
    } > /etc/apt/sources.list; \
    { \
        echo 'Acquire::Check-Valid-Until "false";'; \
        echo 'Acquire::Retries "10";'; \
        echo 'Acquire::http::Timeout "120";'; \
        echo 'Acquire::http::Pipeline-Depth "0";'; \
        echo 'Acquire::Queue-Mode "access";'; \
    } > /etc/apt/apt.conf.d/10archived-suites

# imagemagick supplies convert/composite/identify for TYPO3's image pipeline.
# The lib* packages are the runtime halves of what GD was linked against.
# libfaketime freezes the clock — see the FAKETIME note in each stack.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        nginx \
        imagemagick \
        libfaketime \
        libjpeg62-turbo \
        libpng16-16 \
        libfreetype6 \
        zlib1g; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    ln -sf /dev/stdout /var/log/nginx/access.log; \
    ln -sf /dev/stderr /var/log/nginx/error.log

COPY --from=php-build /opt/php4 /opt/php4

# The PHP, Zend Engine and bundled-library licences each require their notice to
# travel with a binary copy, and a binary carries none of its sources' headers.
# NOTICES.txt holds those licence files and every third-party notice the compiled
# sources state only in a header. It is generated from the vendored archive and
# this file's configure flags by .github/scripts/licence_inventory.py, and the
# licences workflow fails when it is out of date.
COPY php4-base/NOTICES.txt /usr/share/doc/php-4.4.9/NOTICES.txt

ENV PATH="/opt/php4/bin:${PATH}"

# Read at runtime from /opt/php4/lib/php.ini, matching the --prefix the binaries
# were configured with. A stack that needs different settings copies its
# own file over this one.
COPY php4-base/php-legacy.ini /opt/php4/lib/php.ini
COPY php4-base/nginx.conf /etc/nginx/sites-available/default

EXPOSE 80
