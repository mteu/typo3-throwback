# TYPO3 6.2.31 container
#
# Why each pin is what it is: docs/how-it-works.md.
# Short version: 6.2.31 requires PHP >= 5.3.7
# (typo3/sysext/install/Classes/SystemEnvironment/Check.php:281). Its INSTALL.md
# says "up to 5.5", but the same commit's .travis.yml runs the tests on 5.6 too,
# so 5.6.40 is inside what upstream tested, not past it. It talks to MySQL through
# mysqli, so there is no ext/mysql ceiling as there was for every older stack;
# 5.6 is simply the newest PHP upstream ran, and this exact image is already
# pinned and mirrored.
#
# The same digest as 3.8/, 4.0/ and 4.5/, deliberately:
# one end-of-life PHP image to keep alive rather than two. mirror-upstream-images.yml
# keeps a byte-identical copy in this repository's GHCR namespace, and
# BASE_REGISTRY selects the source, never the content.
ARG BASE_REGISTRY=docker.io/library

FROM ${BASE_REGISTRY}/php@sha256:0a40fd273961b99d8afe69a61a68c73c04bc0caa9de384d3b2dd9e7986eec86d

# ---------------------------------------------------------------------------
# Debian stretch packages, each pinned by SHA-256
# ---------------------------------------------------------------------------
# Installed the way 3.8/Dockerfile installs them, from this directory's
# stretch-debs.lock, and 3.8's comment carries the argument. Not restated here so
# the copies cannot drift apart in prose while staying identical in code.
#
# The extension set is the one INSTALL.md lists as required, which is longer than
# any older stack's, and different in kind:
#
#   mysqli   instead of mysql. 6.2's database layer is mysqli throughout
#            (DatabaseConnection.php:1190). mysql_* appears in core only in two
#            docblocks and in the dbal and adodb extensions, which a fresh site
#            does not load. ext/mysql is left out, so nothing can quietly use it.
#   soap     INSTALL.md lists it; libxml2-dev to build it
#   zip      INSTALL.md lists it; the Extension Manager unpacks with it.
#            zlib1g-dev to build it
#   gd       as before
#
# The rest of INSTALL.md's list (fileinfo, filter, hash, json, openssl, pcre,
# session, SPL, standard, xml, zlib) is compiled into the official image. The
# second RUN below asserts all of them rather than trusting that.
COPY 6.2/stretch-debs.lock /tmp/stretch-debs.lock
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
    docker-php-ext-install -j"$(nproc)" gd mysqli soap zip; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Every extension INSTALL.md calls required, checked by name. A missing one would
# otherwise surface as a line in the installer's environment check, which
# install.php logs but does not judge.
RUN set -eux; \
    for ext in fileinfo filter gd hash json mysqli openssl pcre session soap SPL standard xml zip zlib; do \
        php -m | grep -qix "$ext" || { echo "missing PHP extension: $ext" >&2; exit 1; }; \
    done; \
    if php -m | grep -qix mysql; then echo 'ext/mysql is loaded, and nothing in 6.2 should need it' >&2; exit 1; fi

# ---------------------------------------------------------------------------
# Frozen clock
# ---------------------------------------------------------------------------
# Same mechanism as the other PHP 5.6 stacks. The date is 6.2.31's release day,
# so anything made in the stack — the installer's own records included — is dated
# the day the last public 6.2 shipped.
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1
ENV FAKETIME="2017-04-18 12:00:00"

COPY 6.2/php-legacy.ini /usr/local/etc/php/conf.d/zz-legacy.ini
COPY 6.2/apache-typo3.conf /etc/apache2/conf-enabled/zz-typo3.conf

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------
# Both upstream checksums are re-verified at build time. Both, because this
# archive came from a mirror rather than get.typo3.org (vendor-src/typo3-6.2.31/
# PROVENANCE.md).
#
# Copied in flat, as the other stacks do. The tarball carries index.php, typo3/
# and _.htaccess at its top; _.htaccess is left as it is, unrenamed, because
# Apache here reads no .htaccess at all and apache-typo3.conf ports the parts of
# it that protect anything.
#
# Nothing in the TYPO3 source is edited. The Install Tool is gated by
# typo3conf/ENABLE_INSTALL_TOOL, as in 4.5, which the entrypoint writes.
# The tree below ships unmodified, with every licence file the release bundles.
# LICENCES.md is the index to them, generated from the same archive by
# .github/scripts/licence_inventory.py.
COPY 6.2/LICENCES.md /usr/share/doc/typo3-6.2.31/LICENCES.md
COPY vendor-src/typo3-6.2.31/typo3_src-6.2.31.tar.gz /tmp/
RUN set -eux; \
    echo "3bbace592a8e9c313971e7952a074b93ee846568  /tmp/typo3_src-6.2.31.tar.gz" | sha1sum -c -; \
    echo "de09600286499411fbd3ac746983e514  /tmp/typo3_src-6.2.31.tar.gz" | md5sum -c -; \
    mkdir -p /var/www/html; \
    tar -xzf /tmp/typo3_src-6.2.31.tar.gz -C /tmp; \
    cp -a /tmp/typo3_src-6.2.31/. /var/www/html/; \
    rm -rf /tmp/typo3_src-6.2.31 /tmp/typo3_src-6.2.31.tar.gz; \
    mkdir -p /var/www/html/typo3conf /var/www/html/typo3temp /var/www/html/uploads /var/www/html/fileadmin; \
    chown -R www-data:www-data /var/www/html

COPY 6.2/install.php /usr/local/share/typo3/install.php
COPY 6.2/provision.php /usr/local/share/typo3/provision.php
COPY 6.2/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html
EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
