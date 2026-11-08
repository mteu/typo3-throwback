# TYPO3 4.5.40 container
#
# Why each pin is what it is: docs/how-it-works.md.
# Short version: 4.5.40 requires PHP >= 5.2.0 (typo3/init.php:63) and cannot
# exceed PHP 5.6, because t3lib_db calls mysql_connect() directly and ext/mysql
# was removed in PHP 7.0. Upstream's own CI stopped at 5.5; 5.6.40 is used anyway
# because 4.5.40's core is nearly clean on it and this exact image is already
# pinned for 3.8 and mirrored.
#
# The same digest as 3.8/Dockerfile, deliberately: one end-of-life PHP image
# to keep alive rather than two. mirror-upstream-images.yml keeps a byte-identical
# copy in this repository's GHCR namespace, and BASE_REGISTRY selects the source,
# never the content.
ARG BASE_REGISTRY=docker.io/library

FROM ${BASE_REGISTRY}/php@sha256:0a40fd273961b99d8afe69a61a68c73c04bc0caa9de384d3b2dd9e7986eec86d

# ---------------------------------------------------------------------------
# Debian stretch packages, each pinned by SHA-256
# ---------------------------------------------------------------------------
# Installed the way 3.8/Dockerfile installs them, from this directory's
# stretch-debs.lock, and 3.8's comment carries the argument. Not restated here so
# the copies cannot drift apart in prose while staying identical in code.
#
# One package more in the lock than 3.8's: libxml2-dev, because 4.5's INSTALL.txt lists SOAP
# among the minimum extensions and the official image does not build it.
COPY 4.5/stretch-debs.lock /tmp/stretch-debs.lock
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
    docker-php-ext-install -j"$(nproc)" gd mysql soap; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Frozen clock
# ---------------------------------------------------------------------------
# Same mechanism as 3.8. The date is 4.5.40's release day, so anything made in
# the stack is dated the day the last 4.5 shipped.
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1
ENV FAKETIME="2015-02-19 12:00:00"

COPY 4.5/php-legacy.ini /usr/local/etc/php/conf.d/zz-legacy.ini
COPY 4.5/apache-typo3.conf /etc/apache2/conf-enabled/zz-typo3.conf

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------
# Both upstream checksums are re-verified at build time, so a swapped archive fails
# the build rather than building a different version. Both, because this archive
# came from a mirror rather than get.typo3.org (vendor-src/typo3-4.5.40/
# PROVENANCE.md), and the published SHA-1 and MD5 are what make that safe.
#
# Copied in flat, as 3.8 does: the tarball carries index.php, t3lib/ and typo3/ at
# its top, which is the document root less the four trees TYPO3 writes to.
#
# Unlike both older stacks, nothing in the TYPO3 source is edited. 4.5 replaced
# the Install Tool's die() with the typo3conf/ENABLE_INSTALL_TOOL file, which the
# entrypoint writes, and has no REMOTE_ADDR guard for the proxy hop to fail.
# The tree below ships unmodified, with every licence file the release bundles.
# LICENCES.md is the index to them, generated from the same archive by
# .github/scripts/licence_inventory.py.
COPY 4.5/LICENCES.md /usr/share/doc/typo3-4.5.40/LICENCES.md
COPY vendor-src/typo3-4.5.40/typo3_src-4.5.40.tar.gz /tmp/
RUN set -eux; \
    echo "290acdeac2dc1937ce0cfb1d7ea982cd1b0b7398  /tmp/typo3_src-4.5.40.tar.gz" | sha1sum -c -; \
    echo "75dc19184abfec84c384f31a7b353b6a  /tmp/typo3_src-4.5.40.tar.gz" | md5sum -c -; \
    mkdir -p /var/www/html; \
    tar -xzf /tmp/typo3_src-4.5.40.tar.gz -C /tmp; \
    cp -a /tmp/typo3_src-4.5.40/. /var/www/html/; \
    rm -rf /tmp/typo3_src-4.5.40 /tmp/typo3_src-4.5.40.tar.gz; \
    mkdir -p /var/www/html/typo3conf /var/www/html/typo3temp /var/www/html/uploads /var/www/html/fileadmin; \
    chown -R www-data:www-data /var/www/html

COPY 4.5/provision.php /usr/local/share/typo3/provision.php
COPY 4.5/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html
EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
