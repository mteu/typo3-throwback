#!/usr/bin/env bash
# Build PHP 4.4.9 (from vendor-src/, checksum-verified) to WebAssembly.
#
# Usage: build.sh <repo-root> <work-dir>
# Needs: an activated emsdk (tested with emcc 7.0.0), flex, bison, node.
# Emscripten's ports of zlib, libpng, libjpeg and FreeType are downloaded on
# the first build; emsdk pins each one by version and SHA-512.
# Produces, each as a .js loader plus .wasm:
#   out/node/php.js       the CLI, for Node, with host filesystem access
#   out/web/php4.js       the CLI as a MODULARIZE'd browser module
#   out/sapi-node/php4.js the request loop, for Node, with host filesystem access
#   out/sapi-web/php4.js  the request loop, for a page or a worker
set -euo pipefail

repo=$(realpath "$1")
work=$(realpath -m "$2")
here=$(dirname "$(realpath "$0")")
mkdir -p "$work/out/node" "$work/out/web"

(cd "$repo/vendor-src/php-4.4.9" && sha256sum -c SHA256SUMS)

rm -rf "$work/php-4.4.9"
tar -xzf "$repo/vendor-src/php-4.4.9/php-4.4.9.tar.gz" -C "$work"
cd "$work/php-4.4.9"

# gnu89: PHP 4 and its 2008 configure probes are K&R C (implicit int, implicit
# declarations), which current clang rejects as errors in its default C mode.
# -fcommon: same reason as php4-base/Dockerfile, tentative definitions.
# No --host: 2008 config.sub does not know emscripten; emconfigure runs the
# probes under node, so configure still sees the real 32-bit target.
export CFLAGS="-O1 -std=gnu89 -fcommon -Wno-everything"

# libmysql/: the 3.23 client API, answered by runtime/mysql-sqlite.js. Laid
# out the way ext/mysql/config.m4 searches an external client, so PHP's own,
# unmodified ext/mysql builds against it.
mysql_prefix="$work/mysql-client"
rm -rf "$mysql_prefix"
mkdir -p "$mysql_prefix/include/mysql" "$mysql_prefix/lib"
cp "$here/libmysql/mysql.h" "$mysql_prefix/include/mysql/mysql.h"
emcc -O1 -std=gnu89 -I"$here/libmysql" -c "$here/libmysql/libmysql.c" -o "$work/libmysql.o"
emar rcs "$mysql_prefix/lib/libmysqlclient.a" "$work/libmysql.o"

# GD's libraries: Emscripten's ports, built into its sysroot. PHP 4's
# configure looks for <dir>/lib/lib<name>.a and <dir>/include, so they are laid
# out that way, as php4-base/Dockerfile symlinks Debian's multiarch libraries
# to the paths the 2008 probes know.
embuilder build zlib libpng libjpeg freetype > "$work/ports.out" 2>&1
sysroot="$(em-config CACHE)/sysroot"
gd_prefix="$work/gd-libs"
rm -rf "$gd_prefix"
mkdir -p "$gd_prefix/lib"
ln -s "$sysroot/include" "$gd_prefix/include"
for lib in z png jpeg freetype; do
    ln -s "$sysroot/lib/wasm32-emscripten/lib$lib.a" "$gd_prefix/lib/lib$lib.a"
done

# The extensions php4-base/Dockerfile builds, with the same GD options.
# PCRE, sessions and GD 2.0.28 are bundled C.
emconfigure ./configure \
    --disable-all \
    --disable-cgi \
    --without-pear \
    --with-mysql="$mysql_prefix" \
    --with-pcre-regex \
    --enable-session \
    --with-zlib="$gd_prefix" \
    --with-gd \
    --with-jpeg-dir="$gd_prefix" \
    --with-png-dir="$gd_prefix" \
    --with-freetype-dir="$gd_prefix" \
    --enable-gd-native-ttf \
    --disable-xml > "$work/configure.out" 2>&1
grep -q '^#define SIZEOF_LONG 4$' main/php_config.h
grep -q '^#define HAVE_MYSQL 1$' main/php_config.h
grep -q '^#define HAVE_BUNDLED_PCRE 1$' main/php_config.h
grep -q '^#define HAVE_ZLIB 1$' main/php_config.h
# GIFBUILDER writes GIF, which the GD bundled in PHP 4 still can; TEXT objects
# need FreeType. JPEG and PNG are what GREEN's own images are.
for define in HAVE_GD_BUNDLED HAVE_GD_GIF_CREATE HAVE_GD_PNG HAVE_GD_JPG HAVE_LIBFREETYPE HAVE_GD_STRINGFTEX USE_GD_IMGSTRTTF; do
    grep -q "^#define $define 1$" main/php_config.h
done

emmake make -j"$(nproc)" > "$work/make.out" 2>&1

emcc -O1 -c "$here/wasm_clock.c" -o "$work/wasm_clock.o"
emcc $CFLAGS -I. -Imain -IZend -ITSRM -Iinclude \
    -c "$here/sapi/php4_wasm_sapi.c" -o "$work/php4_wasm_sapi.o"

# Relink the way make did, adding the clock override and the output flags.
#
# The stack is 8 MB, as a Linux process gets, not Emscripten's 64 KB default.
# PHP 4's executor recurses once per user function call and keeps each
# call's temporaries on the C stack: TYPO3 3.3.0's template processing
# overran 64 KB, and an overrun stack silently overwrites the data below it,
# so the crash showed up somewhere else each time the build changed. The
# overflow check (level 2, about 6% on a frontend request) turns any future
# overrun into an abort that says so.
stack_flags="-sSTACK_SIZE=8MB -sSTACK_OVERFLOW_CHECK=2"
link=$(grep -m1 -- '-o sapi/cli/php$' "$work/make.out")
relink() {
    eval "${1/%-lm  -o sapi\/cli\/php/$work/wasm_clock.o -lm $stack_flags $2}"
}

# The CLI: one script per instance. check.sh lints and probes with it.
relink "$link" "-sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -o $work/out/node/php.js"
relink "$link" "-sENVIRONMENT=web -sMODULARIZE=1 -sEXPORT_NAME=createPhp4 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sEXPORTED_RUNTIME_METHODS=callMain,FS -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -o $work/out/web/php4.js"

# The request loop: sapi/php4_wasm_sapi.c in place of the CLI's own objects.
# runtime/php4-runtime.js drives it.
sapi_link=${link/sapi\/cli\/php_cli.lo sapi\/cli\/getopt.lo/$work/php4_wasm_sapi.o}
test "$sapi_link" != "$link"
sapi_flags="-sMODULARIZE=1 -sEXPORT_NAME=createPhp4 -sEXPORTED_FUNCTIONS=_php4_wasm_startup,_php4_wasm_request,_php4_wasm_set_clock_start,_malloc,_free -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB"
mkdir -p "$work/out/sapi-node" "$work/out/sapi-web"
relink "$sapi_link" "$sapi_flags -sENVIRONMENT=node -sNODERAWFS=1 -o $work/out/sapi-node/php4.js"
# In-memory filesystem. Node is listed so probes can run the browser build.
relink "$sapi_link" "$sapi_flags -sENVIRONMENT=web,worker,node -o $work/out/sapi-web/php4.js"

# The licences of what was just linked, for site/assemble.sh to publish with
# the binaries: PHP, the Zend Engine, PCRE and GD from the PHP archive,
# Emscripten's runtime and its musl libc from the emsdk that linked them, and
# zlib, libpng, libjpeg and FreeType from Emscripten's ports.
emscripten=$(em-config EMSCRIPTEN_ROOT)
rm -rf "$work/out/licences"
mkdir -p "$work/out/licences"
cp LICENSE "$work/out/licences/php-4.4.9-LICENSE"
cp Zend/LICENSE "$work/out/licences/zend-engine-LICENSE"
cp ext/pcre/pcrelib/LICENCE "$work/out/licences/pcre-LICENCE"
cp "$emscripten/LICENSE" "$work/out/licences/emscripten-LICENSE"
cp "$emscripten/system/lib/libc/musl/COPYRIGHT" "$work/out/licences/musl-COPYRIGHT"
# GD 2.0.28, bundled in PHP: the original GD package's notice is in its README.
cp ext/gd/libgd/README "$work/out/licences/gd-README"
# The ports GD links, from the sources the ports were built from. Exactly one
# unpacked version of each is there.
ports="$(em-config CACHE)/ports"
port_file() {
    local found
    found=$(compgen -G "$ports/$1")
    test "$(wc -l <<<"$found")" = 1
    cp "$found" "$work/out/licences/$2"
}
port_file 'zlib/zlib-*/LICENSE' zlib-LICENSE
port_file 'libpng/libpng-*/LICENSE' libpng-LICENSE
port_file 'libjpeg/jpeg-*/README' libjpeg-README
port_file 'freetype/freetype-*/docs/FTL.TXT' freetype-FTL.TXT

node "$work/out/node/php.js" -v
