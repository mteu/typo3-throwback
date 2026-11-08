# TYPO3 3.3.0 container
#
# Why each pin is what it is: docs/how-it-works.md. Short
# version: 3.3.0 is the oldest publicly available TYPO3 release (2002-06-03) and
# has no PHP 5 awareness anywhere in its source, so unlike 3.8.1 it cannot use an
# official php image. PHP 4.4.9 is compiled in php4-base/, which also
# carries the nginx/FastCGI wiring every pre-PHP-5 stack needs.
#
# Everything below this line is version-level: the source tree, the document root
# and the first-boot provisioning.
#
# The base image is published to GHCR by .github/workflows/images.yml so
# the PHP compile happens once in CI rather than on every machine. To build it
# locally instead (no registry access needed):
#
#   docker build -f php4-base/Dockerfile -t ghcr.io/mteu/typo3-throwback/php4-base:4.4.9 .
#
# BASE_IMAGE exists for CI, not for you. A branch build pushes php4-base under an
# immutable sha- tag only, and builds this image against that, so a branch never
# moves the :4.4.9 tag that published images are built from.
ARG BASE_IMAGE=ghcr.io/mteu/typo3-throwback/php4-base:4.4.9
FROM ${BASE_IMAGE}

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------
# From vendor-src/, not from get.typo3.org — the archive is already frozen and
# checksum-attested there (see its PROVENANCE.md), and re-fetching at build time
# would reintroduce exactly the drift vendor-src/ exists to prevent.
#
# The checksum is re-verified here, same as 3.8: if the archive is ever
# swapped, the build fails rather than silently building a different version.
# This is the upstream-published SHA-1 from get.typo3.org, so it is a genuine
# integrity check rather than a self-consistency one.
# The tree below ships unmodified, with every licence file the release bundles.
# LICENCES.md is the index to them, generated from the same archive by
# .github/scripts/licence_inventory.py.
COPY 3.3/LICENCES.md /usr/share/doc/typo3-3.3.0/LICENCES.md
COPY vendor-src/typo3-3.3.0/typo3_src-3.3.0.tar.gz /tmp/
RUN set -eux; \
    echo "41f70b4928c17da625efeb1ddce80c968bf6c24d  /tmp/typo3_src-3.3.0.tar.gz" | sha1sum -c -; \
    tar -xzf /tmp/typo3_src-3.3.0.tar.gz -C /opt; \
    rm /tmp/typo3_src-3.3.0.tar.gz

# The Install Tool ships behind a die() that the source distribution expects you
# to comment out by hand (typo3/install/index.php:41). Do it here so
# typo3/install/ is reachable; it stays behind
# TYPO3_CONF_VARS[BE][installToolPassword]. The grep asserts the edit actually
# applied rather than silently leaving the tool disabled — without it a future
# source swap would fail open into an unreachable Install Tool.
#
# This and the edit below are the only modifications made to TYPO3 source anywhere
# in this stack. The four compatibility problems that remain are all solved in
# configuration, which is what keeps the rendered pixels genuine.
RUN set -eux; \
    sed -i 's|^\(\s*\)die("In the main source distribution|\1// die("In the main source distribution|' \
        /opt/typo3_src-3.3.0/typo3/install/index.php; \
    ! grep -qE '^[[:space:]]*die\("In the main source distribution' \
        /opt/typo3_src-3.3.0/typo3/install/index.php

# 3.3.0 declares t3lib_parsehtml_proc::TS_tmplParts_rte() twice, back to back
# (lines 1000 and 1025). PHP 4.4.9 refuses a class with a duplicate method at
# compile time — Zend/zend_compile.c:771-781, "Cannot redeclare" — so the whole
# file fails to load. Every record edit includes it via t3lib_transferdata, which
# made alt_doc.php, and with it every "edit page"/"edit content" action, a blank
# 200: the fatal lands in the log, and display_errors is off.
#
# The second copy is commented out rather than deleted, the same way as the die()
# above. Which copy survives changes nothing: the method's only call site in the
# whole tree is itself commented out (line 1133), so both are dead code that only
# has to compile. Duplicate *properties*, which this tree also has, are harmless —
# PHP 4 overwrites those with zend_hash_update — and a sweep of every class found
# no other duplicate method.
#
# The first assertion pins the line range to the declaration it is meant to hit,
# so a different archive fails here instead of commenting out the wrong 21 lines.
# The last one asks the compiler that rejected the file whether it accepts it.
RUN set -eux; \
    f=/opt/typo3_src-3.3.0/t3lib/class.t3lib_parsehtml_proc.php; \
    sed -n '1025p' "$f" | grep -aqx "$(printf '\tfunction TS_tmplParts_rte($value)\t{')"; \
    sed -i '1025,1045s|^|//|' "$f"; \
    test "$(grep -ac '^[[:space:]]*function TS_tmplParts_rte' "$f")" = 1; \
    /opt/php4/bin/php-cli -c /opt/php4/lib/php.ini -l "$f" | grep -q '^No syntax errors'

# ---------------------------------------------------------------------------
# Document root
# ---------------------------------------------------------------------------
# The classic TYPO3 site root: the source tree stays immutable under /opt and the
# document root is assembled from symlinks into it. This is exactly how TYPO3
# installations were laid out at the time — it is what the "dummy" package
# shipped — so it matches the relative include paths the code expects, and it
# keeps the frozen source verifiably unmodified at runtime.
#
# 3.8 copies its tree in flat instead, because 3.8.1's dummy package is
# still on the CDN. 3.3.0's is not, so the document root is reconstructed here.
#
# media and clear.gif are the two entries the source tarball does not imply and
# the frontend cannot do without. The static templates name their files as
# media/uploads/..., and t3lib_tstemplate::getFileName() resolves that against
# the site root and checks it against allowedPaths, whose first entry is
# "media/" (class.t3lib_tstemplate.php:50, :571). TSref-33_0.pdf says it in as
# many words: the standard templates' media "are situated in the folder 'media/'
# relative to the root of the Typo3-website". Without the link a template such
# as "template; GREEN" renders an empty body and logs nothing, because TEMPLATE
# only substitutes its markers once it has read a file
# (class.tslib_content.php:1580).
#
# clear.gif is the spacer every CLEARGIF and every imgtext table points at
# (class.tslib_content.php:317, :649 and on), always as absRefPrefix.'clear.gif'
# — the site root again. TS_by_example-32b2.pdf: "the clear.gif file which are
# found in the root of the site". t3lib/gfx/ carries the copy the source ships.
RUN set -eux; \
    mkdir -p /var/www/html; \
    cd /var/www/html; \
    ln -s /opt/typo3_src-3.3.0/typo3 typo3; \
    ln -s /opt/typo3_src-3.3.0/t3lib t3lib; \
    ln -s /opt/typo3_src-3.3.0/tslib tslib; \
    ln -s tslib/index_ts.php index.php; \
    ln -s tslib/media media; \
    ln -s t3lib/gfx/clear.gif clear.gif; \
    test -f media/uploads/green/template.tmpl; \
    test -f clear.gif; \
    mkdir -p typo3conf typo3temp fileadmin/_temp_ uploads/pics uploads/media uploads/tf; \
    chown -R www-data:www-data /var/www/html

# typo3/temp/ is the one directory *inside* the source tree that TYPO3 writes to:
# the backend renders its own chrome (buttons, pane tabs, click-menu items) into
# it with GD at runtime. The 2002 tarball carries uid 501 from the machine that
# packed it, so without this the Install Tool reports a fatal "typo3/temp/
# directory not writeable" and the backend UI cannot regenerate — which would
# show up as missing interface graphics.
RUN chown -R www-data:www-data /opt/typo3_src-3.3.0/typo3/temp

# A pristine copy of that directory, kept outside it.
#
# Running this image with a read-only root filesystem means typo3/temp/ has to be
# a tmpfs — and a tmpfs starts empty, hiding the 717 GIFs the 2002 tarball ships
# there. entrypoint.sh restores them from here when it finds the directory empty.
# 3.3/compose.yaml never needs this: its filesystem is writable and the files are
# already in place.
RUN cp -a /opt/typo3_src-3.3.0/typo3/temp /opt/typo3-temp-seed

COPY 3.3/provision.php /usr/local/share/typo3/provision.php
COPY 3.3/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /var/www/html
EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
