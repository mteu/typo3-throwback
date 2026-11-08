# TYPO3 4.0.13 container
#
# Why each pin is what it is: docs/how-it-works.md.
# Short version: 4.0.13 requires PHP >= 4.1.0 (typo3/init.php:226) and cannot
# exceed PHP 5.6, because t3lib_db calls mysql_pconnect()/mysql_connect() directly
# (t3lib/class.t3lib_db.php:889-893) and ext/mysql was removed in PHP 7.0. That is
# 3.8's window exactly, so 4.0 takes 3.8's image.
#
# The same digest as 3.8/, deliberately: one end-of-life PHP image to keep alive
# rather than two. mirror-upstream-images.yml keeps a
# byte-identical copy in this repository's GHCR namespace, and BASE_REGISTRY
# selects the source, never the content.
ARG BASE_REGISTRY=docker.io/library

FROM ${BASE_REGISTRY}/php@sha256:0a40fd273961b99d8afe69a61a68c73c04bc0caa9de384d3b2dd9e7986eec86d

# ---------------------------------------------------------------------------
# Debian stretch packages, each pinned by SHA-256
# ---------------------------------------------------------------------------
# Installed the way 3.8/Dockerfile installs them, from this directory's
# stretch-debs.lock, and 3.8's comment carries the argument. Not restated here so
# the copies cannot drift apart in prose while staying identical in code.
#
# The extension set is 3.8's, not 4.5's, and leaving out 4.5's soap is a decision
# rather than an economy. 4.0's Extension Manager talks to the TER through a
# bundled nusoap, which declares `class soapclient`
# (typo3/mod/tools/em/class.nusoap.php:5348). PHP class names are case-blind and
# ext/soap declares SoapClient, so with soap loaded the EM's upload path dies with
# "Cannot redeclare class" the moment it includes that file. Nothing 4.0 runs by
# default needs ext/soap.
COPY 4.0/stretch-debs.lock /tmp/stretch-debs.lock
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
# Frozen clock
# ---------------------------------------------------------------------------
# Same mechanism as 3.8. The date is 4.0.13's release day, so anything
# made in the stack is dated the day the last 4.0 shipped.
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1
ENV FAKETIME="2009-07-02 12:00:00"

COPY 4.0/php-legacy.ini /usr/local/etc/php/conf.d/zz-legacy.ini
COPY 4.0/apache-typo3.conf /etc/apache2/conf-enabled/zz-typo3.conf

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------
# Both upstream checksums are re-verified at build time, so a swapped archive fails
# the build rather than building a different version. Both, because this archive
# came from a mirror rather than get.typo3.org (vendor-src/typo3-4.0.13/
# PROVENANCE.md), and the published SHA-1 and MD5 are what make that safe.
#
# Copied in flat, as 3.8 and 4.5 do: the tarball carries index.php, t3lib/ and
# typo3/ at its top, which is the document root less the four trees TYPO3 writes
# to.
# The tree below ships unmodified, with every licence file the release bundles.
# LICENCES.md is the index to them, generated from the same archive by
# .github/scripts/licence_inventory.py.
COPY 4.0/LICENCES.md /usr/share/doc/typo3-4.0.13/LICENCES.md
COPY vendor-src/typo3-4.0.13/typo3_src-4.0.13.tar.gz /tmp/
RUN set -eux; \
    echo "27d410298254c326fd28d74c7ab6eee297876882  /tmp/typo3_src-4.0.13.tar.gz" | sha1sum -c -; \
    echo "89b27c180bc603f802205996bc3bacd3  /tmp/typo3_src-4.0.13.tar.gz" | md5sum -c -; \
    mkdir -p /var/www/html; \
    tar -xzf /tmp/typo3_src-4.0.13.tar.gz -C /tmp; \
    cp -a /tmp/typo3_src-4.0.13/. /var/www/html/; \
    rm -rf /tmp/typo3_src-4.0.13 /tmp/typo3_src-4.0.13.tar.gz; \
    mkdir -p /var/www/html/typo3conf /var/www/html/typo3temp /var/www/html/uploads /var/www/html/fileadmin; \
    chown -R www-data:www-data /var/www/html

# The Install Tool, as in 3.8 and not as in 4.5: 4.0 still ships it behind a die()
# that the source distribution expects you to comment out by hand
# (typo3/install/index.php:44-45). 4.5's typo3conf/ENABLE_INSTALL_TOOL does not
# exist yet. It stays behind TYPO3_CONF_VARS[BE][installToolPassword].
#
# The die() is guarded by the same REMOTE_ADDR test as 3.8's: anything but
# 127.0.0.1 or a 192.168 address is refused. The stack is reached through the
# loopback proxy, so REMOTE_ADDR is that proxy's address on the internal network
# and the guard would refuse every request no matter where the browser is.
#
# The greps assert the edit applied rather than silently leaving the tool
# disabled. The negative one is an if/exit rather than 3.8's `! grep`, because a
# negated command is exempt from errexit: `! grep` only fails a build while it is
# the last command of its RUN, and stops failing the day anything is appended
# after it (.github/scripts/ci-assert.sh carries the long version). The positive
# grep then proves the sed matched at all. This is the only modification made to TYPO3
# source anywhere in this stack.
RUN set -eux; \
    sed -i 's|^\(\s*\)die("In the source distribution|\1// die("In the source distribution|' \
        /var/www/html/typo3/install/index.php; \
    if grep -qE '^[[:space:]]*die\("In the source distribution' /var/www/html/typo3/install/index.php; then \
        echo 'the Install Tool die() is still in place' >&2; \
        exit 1; \
    fi; \
    grep -qE '^[[:space:]]*// die\("In the source distribution' /var/www/html/typo3/install/index.php

COPY 4.0/provision.php /usr/local/share/typo3/provision.php
COPY 4.0/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html
EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
