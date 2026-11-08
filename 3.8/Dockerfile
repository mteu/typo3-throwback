# TYPO3 3.8.1 container
#
# Why each pin is what it is: docs/how-it-works.md.
# Short version: 3.8.1 requires PHP >= 4.1.0 (typo3/init.php:198) and cannot
# exceed PHP 5.6, because t3lib_db calls mysql_connect() directly and ext/mysql
# was removed in PHP 7.0. 5.6.40 is the newest version inside that window.
#
# Pinned by digest, not tag. The 5.6 tags are archived
# upstream and no longer move, so this digest is stable.
#
# "Archived and no longer moving" is not the same as "will still be there" —
# php:5.6 is years past end of life and is the last release carrying ext/mysql,
# which t3lib_db requires, so losing it would leave 3.8 with no runtime at all.
# mirror-upstream-images.yml keeps a byte-identical copy of this exact digest in
# this repository's GHCR namespace. BASE_REGISTRY selects the source, never the
# content; same pattern and same rationale as php4-base/Dockerfile.
ARG BASE_REGISTRY=docker.io/library

FROM ${BASE_REGISTRY}/php@sha256:0a40fd273961b99d8afe69a61a68c73c04bc0caa9de384d3b2dd9e7986eec86d

# ---------------------------------------------------------------------------
# Debian stretch packages, each pinned by SHA-256
# ---------------------------------------------------------------------------
# This image is built on Debian stretch (verified from the pinned manifest's own
# config blob, not assumed). Stretch lives on archive.debian.org now, and its
# signing keys have expired. apt reports that as EXPKEYSIG and refuses, with no
# way to accept an expired signature. Until #11, this step answered with
# [trusted=yes], so the Packages index arrived unauthenticated.
#
# Now apt resolves nothing at build time. Every file installed here is named,
# with its SHA-256, in 3.8/stretch-debs.lock. Those hashes were checked against
# stretch's own signed chain: the Release signature (an expired key still makes
# a valid signature), Packages.gz against Release, and each .deb against
# Packages.gz. .github/scripts/lock-stretch-debs.sh does that, and the
# stretch-debs workflow re-derives every lock and fails on a difference. So a
# file is installed only if it is the one Debian signed for.
#
# sources.list is emptied first, so apt cannot fetch anything the lock does not
# name. A dependency missing from the lock fails the build instead of arriving
# unchecked.
#
# The files are fetched, not vendored. A SHA-256 makes the transport and the host
# irrelevant to integrity, and the same files in git would add tens of megabytes
# to every clone. What it costs is that a build needs archive.debian.org, which
# it needed before too.
#
# Package notes, for the list in stretch-debs.lock:
#   libpng-dev    stretch has no libpng12-dev; libpng16 is the only option here
#   libfaketime   installs to /usr/lib/x86_64-linux-gnu/faketime/, which is the
#                 path LD_PRELOAD below depends on
#   imagemagick   drives the Install Tool's image-processing checks, one of the
#                 most visible screens
#
# mysql  - required by t3lib/class.t3lib_db.php (mysql_connect/pconnect/select_db).
#          Deprecated at 5.6, present until 7.0. This is the ceiling constraint.
# gd     - drives the Install Tool image checks (isPNG/ImageTypes) that render the
#          About screen, and the backend's generated interface graphics.
COPY 3.8/stretch-debs.lock /tmp/stretch-debs.lock
RUN set -eux; \
    : > /etc/apt/sources.list; \
    mkdir /tmp/debs; \
    cd /tmp/debs; \
    grep -E '^[0-9a-f]{64}  http://' /tmp/stretch-debs.lock > lock; \
    test -s lock; \
    while read -r sha url; do \
        curl -fsS -o "${url##*/}" "$url"; \
        echo "$sha  ${url##*/}" | sha256sum -c -; \
    done < lock; \
    apt-get install -y --no-install-recommends ./*.deb; \
    cd /; \
    rm -rf /tmp/debs /tmp/stretch-debs.lock; \
    docker-php-ext-configure gd \
        --with-freetype-dir=/usr/include/ \
        --with-jpeg-dir=/usr/include/; \
    docker-php-ext-install -j"$(nproc)" gd mysql; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# The clock
# ---------------------------------------------------------------------------
# Starts at noon on 2005-11-14, the 3.8.1 release date, and runs from there.
# libfaketime is preloaded so Apache, mod_php and the provisioning CLI all see
# that day, which keeps "last login", the seeded rows and every rendered date
# consistent with the version on screen.
#
# The leading @ is what lets it run. Held still, the clock gave every new session
# in one Apache child the same id: 3.8 makes it from uniqid() and the pid
# (t3lib/class.t3lib_userauth.php:231), and a prefork child keeps its pid. So a
# cookieless request could land in someone's logged-in session. CI showed that
# before the @ went in. 4.0 fixed
# the same fault the other way, with one process per connection; a running clock
# fixes it without one, at the price of byte-identical output between runs.
#
# Set after the build steps above on purpose: an LD_PRELOAD in force during
# apt/dpkg buys nothing and only widens what a failure could be blamed on.
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1
ENV FAKETIME="@2005-11-14 12:00:00"

COPY 3.8/php-legacy.ini /usr/local/etc/php/conf.d/zz-legacy.ini
COPY 3.8/apache-typo3.conf /etc/apache2/conf-enabled/zz-typo3.conf

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------
# Checksum is re-verified at build time. If the archive in vendor-src is ever
# swapped, the build fails rather than silently building a different version.
#
# Copied in flat rather than symlinked from an immutable /opt tree the way
# 3.3 does it: 3.8.1's tarball already carries the document root layout,
# including a top-level index.php identical to tslib/index_ts.php, so there is
# nothing to reconstruct.
# The tree below ships unmodified, with every licence file the release bundles.
# LICENCES.md is the index to them, generated from the same archive by
# .github/scripts/licence_inventory.py.
COPY 3.8/LICENCES.md /usr/share/doc/typo3-3.8.1/LICENCES.md
COPY vendor-src/typo3-3.8.1/typo3_src-3.8.1.tar.gz /tmp/
RUN set -eux; \
    echo "493df2c5ca6078622df8a8bf17a31aec302ce99d  /tmp/typo3_src-3.8.1.tar.gz" | sha1sum -c -; \
    mkdir -p /var/www/html; \
    tar -xzf /tmp/typo3_src-3.8.1.tar.gz -C /tmp; \
    cp -a /tmp/typo3_src-3.8.1/. /var/www/html/; \
    rm -rf /tmp/typo3_src-3.8.1 /tmp/typo3_src-3.8.1.tar.gz; \
    mkdir -p /var/www/html/typo3conf /var/www/html/typo3temp /var/www/html/uploads /var/www/html/fileadmin; \
    chown -R www-data:www-data /var/www/html

# The Install Tool ships behind a die() that the source distribution expects you
# to comment out by hand (typo3/install/index.php:45). Do it here so
# typo3/install/ is reachable; it stays behind
# TYPO3_CONF_VARS[BE][installToolPassword].
#
# 3.8's guard is stricter than 3.3's: it dies unless REMOTE_ADDR is 127.0.0.1 or
# a 192.168 address. The stack is reached through the loopback proxy on the edge
# network, so REMOTE_ADDR is that proxy's address on the isolated network and the
# guard would refuse every request no matter where the browser is.
#
# The grep asserts the edit actually applied rather than silently leaving the
# tool disabled — without it a future source swap would fail open into an
# unreachable Install Tool. This is the only modification made to TYPO3 source
# anywhere in this stack.
RUN set -eux; \
    sed -i 's|^\(\s*\)die("In the source distribution|\1// die("In the source distribution|' \
        /var/www/html/typo3/install/index.php; \
    ! grep -qE '^[[:space:]]*die\("In the source distribution' \
        /var/www/html/typo3/install/index.php

COPY 3.8/provision.php /usr/local/share/typo3/provision.php
COPY 3.8/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html
EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
