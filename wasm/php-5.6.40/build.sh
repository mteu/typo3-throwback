#!/usr/bin/env bash
# Build PHP 5.6.40 (from vendor-src/, checksum-verified) to WebAssembly, with
# the extensions TYPO3 4.5.40 and 6.2.31 need, libxml2 2.9.14 for its XML
# extensions and OpenSSL 1.0.2u for ext/openssl (both from vendor-src/,
# checksum-verified). One build serves both releases.
#
# Usage: wasm/php-5.6.40/build.sh <repo-root> <work-dir>
# Needs: an activated emsdk (tested with emcc 7.0.0), node.
# Emscripten's ports of zlib, libpng, libjpeg and FreeType are downloaded on
# the first build; emsdk pins each one by version and SHA-512.
# Produces, each as a .js loader plus .wasm:
#   out/node/php.js       the CLI, for Node, with host filesystem access
#   out/web/php.js        the CLI as a MODULARIZE'd browser module
#   out/sapi-node/php.js  the request loop, for Node, with host filesystem access
#   out/sapi-web/php.js   the request loop, for a page or a worker
#   out/licences/         the licences of what is linked into them
set -euo pipefail

repo=$(realpath "$1")
work=$(realpath -m "$2")
here=$(dirname "$(realpath "$0")")
native=$(dirname "$here")/native
mkdir -p "$work/out/node" "$work/out/web"

(cd "$repo/vendor-src/php-5.6.40" && sha256sum -c SHA256SUMS)
(cd "$repo/vendor-src/libxml2-2.9.14" && sha256sum -c SHA256SUMS)
(cd "$repo/vendor-src/openssl-1.0.2u" && sha256sum -c SHA256SUMS)

rm -rf "$work/php-5.6.40"
tar -xzf "$repo/vendor-src/php-5.6.40/php-5.6.40.tar.gz" -C "$work"
cd "$work/php-5.6.40"

# gnu99: PHP 5.6 is C99 with GNU extensions, and some of its configure probes
# still declare functions implicitly, which current clang rejects as errors.
# -fcommon: tentative definitions, as for PHP 4.
# Its configure knows no emscripten host either. emconfigure runs the probes
# under node, so configure still sees the real 32-bit target.
export CFLAGS="-O1 -std=gnu99 -fcommon -Wno-everything"

# The bundled PCRE 8.38 turns its JIT on in its own config.h, not through
# configure: PHP 5.6 has no switch for it. The JIT is sljit, which has no
# wasm32 backend, so the line goes. PCRE then interprets, as it did before
# PHP 5.5.
sed -i 's|^#define SUPPORT_JIT$|/* SUPPORT_JIT: sljit has no wasm32 backend */|' ext/pcre/pcrelib/config.h
! grep -q 'SUPPORT_JIT$' ext/pcre/pcrelib/config.h
grep -q '^/\* SUPPORT_JIT: sljit has no wasm32 backend \*/$' ext/pcre/pcrelib/config.h

# WebAssembly calls through a function pointer only with the type the
# function was defined with, and traps otherwise. Native code lets PHP 5.6
# cast between function types that differ in their arguments or return type.
# function-casts.patch fixes the five casts in this build that change the
# WebAssembly type:
#   Zend/zend_qsort.c        zend_qsort() casts the two-argument compare to
#                            zend_qsort_r()'s three-argument one. Every sort()
#                            goes through it.
#   Zend/zend_generators.c   a void function called as an int one, for a
#                            generator made from a closure with static
#                            variables.
#   main/streams/cast.c      the fopencookie() seeker takes its position by
#                            value; musl passes a pointer.
#   ext/libxml/libxml.c      an int function as the destructor of the list of
#                            XML errors libxml_use_internal_errors() collects,
#                            which calls it as void.
#   ext/gd/libgd/gd_jpeg.c   GD's libjpeg message handler returns long;
#                            libjpeg calls it as void, on every JPEG read.
# The scan after make checks that no other such cast is compiled.
patch -p1 --forward --no-backup-if-mismatch < "$here/function-casts.patch" > "$work/patch.out"

# native/libmysql/: the 5.5 client API, prepared statements included,
# answered by runtime/mysql-sqlite.js. The installed header defines
# WASM_LIBMYSQL_API_55, so ext/mysql and mysqli compile against the view of
# it the library was built with. Laid out the way ext/mysql/config.m4
# searches an external client, with a mysql_config for mysqli/config.m4, so
# PHP's own, unmodified extensions build against it, not against mysqlnd:
# mysqlnd speaks MySQL's protocol over a socket, which a browser tab does
# not have.
mysql_prefix="$work/mysql-client"
rm -rf "$mysql_prefix"
mkdir -p "$mysql_prefix/include/mysql" "$mysql_prefix/lib" "$mysql_prefix/bin"
{
    echo '#define WASM_LIBMYSQL_API_55 1'
    cat "$native/libmysql/mysql.h"
} > "$mysql_prefix/include/mysql/mysql.h"
# mysqli includes seven more headers of a real client. Of what they declare
# it uses only CHARSET_INFO, which mysql.h declares.
for header in my_global.h my_sys.h m_ctype.h errmsg.h my_list.h m_string.h mysqld_error.h; do
    echo '/* Included by mysqli, which uses nothing in it; see mysql.h. */' > "$mysql_prefix/include/mysql/$header"
done
emcc -O1 -std=gnu89 -DWASM_LIBMYSQL_API_55 -I"$native/libmysql" -c "$native/libmysql/libmysql.c" -o "$work/libmysql.o"
emar rcs "$mysql_prefix/lib/libmysqlclient.a" "$work/libmysql.o"
printf '%s\n' '#!/bin/sh' \
    'case "$1" in' \
    "    --cflags) echo '-I$mysql_prefix/include/mysql' ;;" \
    "    --libs) echo '-L$mysql_prefix/lib -lmysqlclient' ;;" \
    '    *) exit 1 ;;' \
    'esac' > "$mysql_prefix/bin/mysql_config"
chmod +x "$mysql_prefix/bin/mysql_config"

# zlib: Emscripten's port, built into its sysroot, laid out as
# <dir>/include and <dir>/lib/libz.a for --with-zlib.
embuilder build zlib > "$work/ports.out" 2>&1
sysroot="$(em-config CACHE)/sysroot"
zlib_prefix="$work/zlib"
rm -rf "$zlib_prefix"
mkdir -p "$zlib_prefix/lib"
ln -s "$sysroot/include" "$zlib_prefix/include"
ln -s "$sysroot/lib/wasm32-emscripten/libz.a" "$zlib_prefix/lib/libz.a"

# libxml2, for ext/libxml, ext/xml, dom and SimpleXML: PHP 5.6 bundles no XML
# parser. Only the library is built and installed, static, into a prefix
# whose bin/xml2-config PHP's configure reads. Off: threads (one request at a
# time), HTTP and FTP (no sockets), iconv and ICU (UTF-8, UTF-16 and
# ISO-8859-1 are built in, and 4.5.40 needs no other), zlib and lzma (no
# compressed XML), and the Python bindings.
libxml_prefix="$work/libxml2"
rm -rf "$work/libxml2-2.9.14" "$libxml_prefix"
tar -xJf "$repo/vendor-src/libxml2-2.9.14/libxml2-2.9.14.tar.xz" -C "$work"
(
    cd "$work/libxml2-2.9.14"
    CFLAGS="-O1" emconfigure ./configure --prefix="$libxml_prefix" \
        --disable-shared --enable-static --without-python --without-threads \
        --without-thread-alloc --without-http --without-ftp --without-iconv \
        --without-icu --without-zlib --without-lzma --without-modules \
        --without-debug --without-readline --without-history > "$work/libxml2-configure.out" 2>&1
    emmake make -j"$(nproc)" libxml2.la > "$work/libxml2-make.out" 2>&1
    emmake make install-libLTLIBRARIES install-binSCRIPTS install-pkgconfigDATA > "$work/libxml2-install.out" 2>&1
    emmake make -C include install >> "$work/libxml2-install.out" 2>&1
)
for feature in THREAD HTTP FTP ICONV ICU ZLIB LZMA; do
    sed -n "/^ \* LIBXML_${feature}_ENABLED:/,/^#endif/p" "$libxml_prefix/include/libxml2/libxml/xmlversion.h" | grep -q '^#if 0$'
done
test "$("$libxml_prefix/bin/xml2-config" --version)" = 2.9.14

# OpenSSL 1.0.2u, for ext/openssl: rsaauth logs in with it, the Install Tool
# requires it, and 6.2 takes its random bytes from it. PHP 5.6 does not build
# against OpenSSL 1.1. Only libcrypto and libssl are built, static, and
# installed with their headers into a prefix --with-openssl names; a
# directory there keeps configure from asking pkg-config for the host's.
# Off: assembly (C only, for wasm32), threads, shared objects, DSO loading,
# engines and hardware support, and zlib. The algorithms are OpenSSL's
# defaults. OpenSSL's linux-generic32 target appends -O3 to its flags, and
# it stays: every 6.2 login form generates two RSA keys.
openssl_prefix="$work/openssl"
rm -rf "$work/openssl-1.0.2u" "$openssl_prefix"
tar -xzf "$repo/vendor-src/openssl-1.0.2u/openssl-1.0.2u.tar.gz" -C "$work"
(
    cd "$work/openssl-1.0.2u"
    CC=emcc AR=emar RANLIB=emranlib ./Configure linux-generic32 \
        no-asm no-threads no-shared no-dso no-engine no-hw no-zlib \
        -fcommon -Wno-everything --openssldir=/etc/ssl > "$work/openssl-configure.out" 2>&1
    make depend > "$work/openssl-depend.out" 2>&1
    make -j"$(nproc)" build_libs > "$work/openssl-make.out" 2>&1
)
mkdir -p "$openssl_prefix/include/openssl" "$openssl_prefix/lib"
cp -L "$work/openssl-1.0.2u/include/openssl/"*.h "$openssl_prefix/include/openssl/"
cp "$work/openssl-1.0.2u/libcrypto.a" "$work/openssl-1.0.2u/libssl.a" "$openssl_prefix/lib/"
grep -q '^# *define OPENSSL_VERSION_TEXT *"OpenSSL 1\.0\.2u  20 Dec 2019"$' "$openssl_prefix/include/openssl/opensslv.h"
options=$(sed -n 's/^OPTIONS=//p' "$work/openssl-1.0.2u/Makefile")
for option in no-asm no-threads no-shared no-dso no-engine no-hw no-zlib; do
    grep -qw -- "$option" <<<"$options"
done

# GD's libraries: Emscripten's ports of libpng, libjpeg and FreeType, laid
# out as <dir>/include and <dir>/lib/lib<name>.a, as php-4.4.9/build.sh lays
# them out. PHP 5.6 finds FreeType only through <dir>/bin/freetype-config,
# which the port does not install, so this writes one that names the port.
embuilder build libpng libjpeg freetype >> "$work/ports.out" 2>&1
gd_prefix="$work/gd-libs"
rm -rf "$gd_prefix"
mkdir -p "$gd_prefix/lib" "$gd_prefix/bin"
ln -s "$sysroot/include" "$gd_prefix/include"
for lib in png jpeg freetype; do
    ln -s "$sysroot/lib/wasm32-emscripten/lib$lib.a" "$gd_prefix/lib/lib$lib.a"
done
cat > "$gd_prefix/bin/freetype-config" <<FREETYPE_CONFIG
#!/bin/sh
case "\$1" in
    --cflags) echo "-I$gd_prefix/include/freetype2" ;;
    --libs) echo "-L$gd_prefix/lib -lfreetype" ;;
    *) exit 1 ;;
esac
FREETYPE_CONFIG
chmod +x "$gd_prefix/bin/freetype-config"

# Besides what PHP builds in whatever it is told (Core, date, ereg, pcre,
# Reflection, SPL and standard), the extensions 4.5.40's Install Tool
# requires (typo3/sysext/install/mod/class.tx_install.php:248-259), and those
# its core calls outside contrib/ and tests: ctype, hash and tokenizer. All
# are bundled C, but zlib, gd, mysql and the four XML extensions on libxml2:
# libxml, xml (xml_parser_create() and utf8_encode(), which 4.5.40's
# locallang files and 16 of its files use), dom (DOMDocument, in two core
# files) and SimpleXML.
#
# ext/mysql and mysqli against the 5.5 client: php_mysql.c builds for the
# client version native/libmysql/mysql.h names, 50562. That gives ext/mysql
# mysql_set_charset() (ext/mysql/php_mysql_structs.h:52) and leaves out
# 3.23's mysql_create_db() and mysql_drop_db(), as the official image's
# ext/mysql on mysqlnd does. 4.5.40 calls none of the three: it sends
# "SET NAMES utf8" as a query, from setDBinit. mysqli is 6.2.31's database
# layer (DatabaseConnection.php), prepared statements included. 6.2.31's
# Docker image leaves ext/mysql out; here 4.5.40 needs it, and 6.2's core
# calls none of its functions.
#
# OpenSSL for 6.2.31: its rsaauth login, its Install Tool and its random
# bytes. 4.5.40 takes its random bytes from it too, as in Docker.
#
# The rest of the 15 extensions 6.2.31's Install Tool requires
# (typo3/sysext/install/Classes/SystemEnvironment/Check.php:54), each
# bundled with PHP: fileinfo, with libmagic and its database compiled in as
# C data, 2.9 MB of the 3.3 MB the four add; zip, with its own libzip on
# the zlib port; soap, which nothing in 6.2's core calls; and xmlreader, for
# the Extension Manager's repository lists. 4.5.40's Docker image has
# fileinfo, soap and xmlreader too, and its frontend asks fileinfo for a
# favicon's type.
#
# Left out because neither release needs them: mbstring and iconv (TYPO3's
# charset converter has its own tables), cURL, PDO, sqlite3 and Phar.
# GD is the GD 2.1 bundled in PHP, with the GIF, PNG, JPEG and FreeType
# support TYPO3's GIFBUILDER and the Install Tool's image tests use.
#
# phpdbg is a second SAPI, not wanted.
#
# mail() is always compiled in. Its default sendmail_path is the sendmail
# configure finds, followed by "-t -i". The one mail program here is
# /bin/true, which every Docker stack's sendmail_path names and which
# native/popen.c runs.
#
# configure's "whether libxml build works" runs a program that calls
# xmlInitParser() through an implicit declaration, which returns int.
# libxml2 defines it void, and WebAssembly traps on the call. The answer is
# given here instead; probe/xml-5.php shows the library works.
php_cv_libxml_build_works=yes \
ac_cv_path_PROG_SENDMAIL=/bin/true \
emconfigure ./configure \
    --disable-all \
    --disable-cgi \
    --without-pear \
    --disable-phpdbg \
    --enable-session \
    --enable-filter \
    --enable-json \
    --enable-hash \
    --enable-ctype \
    --enable-tokenizer \
    --with-zlib="$zlib_prefix" \
    --with-gd \
    --with-jpeg-dir="$gd_prefix" \
    --with-png-dir="$gd_prefix" \
    --with-freetype-dir="$gd_prefix" \
    --enable-gd-native-ttf \
    --with-mysql="$mysql_prefix" \
    --with-mysqli="$mysql_prefix/bin/mysql_config" \
    --with-openssl="$openssl_prefix" \
    --enable-libxml \
    --with-libxml-dir="$libxml_prefix" \
    --enable-xml \
    --enable-dom \
    --enable-simplexml \
    --enable-xmlreader \
    --enable-soap \
    --enable-fileinfo \
    --enable-zip \
    --with-zlib-dir="$zlib_prefix" > "$work/configure.out" 2>&1
grep -q '^#define SIZEOF_LONG 4$' main/php_config.h
grep -q '^#define HAVE_BUNDLED_PCRE 1$' main/php_config.h
grep -q '^#define HAVE_MYSQL 1$' main/php_config.h
grep -q '^#define HAVE_MYSQLILIB 1$' main/php_config.h
grep -q '^#define HAVE_OPENSSL_EXT 1$' main/php_config.h
grep -q '^#define HAVE_ZLIB 1$' main/php_config.h
for define in HAVE_LIBXML HAVE_XML HAVE_DOM HAVE_SIMPLEXML HAVE_XMLREADER HAVE_SOAP; do
    grep -q "^#define $define 1$" main/php_config.h
done
# ext/zip on the libzip in PHP's archive, not on a system one. fileinfo has
# no define: its bundled libmagic is all it takes.
grep -q '^#define HAVE_ZIP 1$' main/php_config.h
! grep -q '^#define HAVE_LIBZIP 1$' main/php_config.h
grep -q 'phpext_fileinfo_ptr' main/internal_functions.c
# ext/xml on libxml2, not on an expat.
! grep -q '^#define HAVE_LIBEXPAT 1$' main/php_config.h
# The GD in PHP's archive, with each library configure was given.
for define in HAVE_GD_BUNDLED HAVE_GD_PNG HAVE_GD_JPG HAVE_GD_FREETYPE HAVE_LIBFREETYPE ENABLE_GD_TTF USE_GD_IMGSTRTTF; do
    grep -q "^#define $define 1$" main/php_config.h
done
# The client shim, not mysqlnd, for both.
! grep -q '^#define MYSQL_USE_MYSQLND 1$' main/php_config.h
! grep -q '^#define MYSQLI_USE_MYSQLND 1$' main/php_config.h
# configure's test for the fopencookie() seeker's type uses __off64_t, which
# musl lacks, so it fails. musl passes a pointer to a 64-bit off_t, which is
# what this selects, with the type function-casts.patch gives it.
sed -i 's|^/\* #undef COOKIE_SEEKER_USES_OFF64_T \*/$|#define COOKIE_SEEKER_USES_OFF64_T 1|' main/php_config.h
grep -q '^#define COOKIE_SEEKER_USES_OFF64_T 1$' main/php_config.h
grep -q '^#define PHP_PROG_SENDMAIL[[:space:]]*"/bin/true"$' main/build-defs.h

# getdtablesize() is missing from Emscripten's libc, and php://fd calls it.
# make links the CLI with it, after the library paths configure set.
emcc -O1 -c "$native/getdtablesize.c" -o "$work/wasm_getdtablesize.o"
program_ldflags=$(sed -n 's/^EXTRA_LDFLAGS_PROGRAM = //p' Makefile)
grep -q -- "-L$mysql_prefix/lib" <<<"$program_ldflags"
emmake make -j"$(nproc)" EXTRA_LDFLAGS_PROGRAM="$program_ldflags $work/wasm_getdtablesize.o" > "$work/make.out" 2>&1

# Every object again, with only clang's warnings for casts and assignments
# between incompatible function types. Each hit must be one of these, where
# the WebAssembly type stays the same or the call never happens:
#   Zend/zend_API.c:1096, ext/reflection/php_reflection.c:449,
#   main/php_ini.c:180          an int or a zend_bool argument where the type
#                               has a pointer: all three are i32
#   ext/zlib/zlib.c:1035        the globals constructor takes its own struct
#                               pointer, not void *: both i32
#   ext/dom/dom_iterators.c:94, :115
#                               a hash scanner whose name argument is not
#                               const: the same i32
#   Zend/zend_builtin_functions.c:1944, sapi/cli/php_cli.c:231
#                               int functions applied to the list of Zend
#                               extensions, which stays empty: nothing here
#                               loads one
#   ext/gd/libgd/gd_jpeg.c:726, :846
#                               an int return where libjpeg's type has its
#                               boolean, an int or an enum: i32 either way
grep -- '--mode=compile' "$work/make.out" \
    | sed -E 's#^.*--mode=compile ##; s# -o [^ ]+\.lo *$# -o /dev/null -Wcast-function-type-mismatch -Wincompatible-function-pointer-types#' \
    | xargs -d '\n' -P"$(nproc)" -I{} sh -c '{}' 2> "$work/function-casts.out"
casts=$(grep -oE '^[^ :]+:[0-9]+:[0-9]+: warning' "$work/function-casts.out" | sed -E "s#^$PWD/##; s#:[0-9]+: warning\$##" | LC_ALL=C sort -u)
test "$casts" = "Zend/zend_API.c:1096
Zend/zend_builtin_functions.c:1944
ext/dom/dom_iterators.c:115
ext/dom/dom_iterators.c:94
ext/gd/libgd/gd_jpeg.c:726
ext/gd/libgd/gd_jpeg.c:846
ext/reflection/php_reflection.c:449
ext/zlib/zlib.c:1035
main/php_ini.c:180
sapi/cli/php_cli.c:231"

emcc -O1 -c "$native/clock.c" -o "$work/wasm_clock.o"
emcc -O1 -c "$native/popen.c" -o "$work/wasm_popen.o"
emcc $CFLAGS -I. -Imain -IZend -ITSRM -Iinclude \
    -c "$here/sapi.c" -o "$work/php_wasm_sapi.o"

# Relink the way make did, adding the clock and popen overrides and the
# output flags. The stack is 8 MB, with the overflow check, for the reasons
# php-4.4.9/build.sh gives.
stack_flags="-sSTACK_SIZE=8MB -sSTACK_OVERFLOW_CHECK=2"
link=$(grep -m1 -- '-o sapi/cli/php$' "$work/make.out")
grep -q -- "$work/wasm_getdtablesize.o" <<<"$link"
relink() {
    eval "${1/%-o sapi\/cli\/php/$work/wasm_clock.o $work/wasm_popen.o $stack_flags $2}"
}

# The CLI: one script per instance. check.sh lints and probes with it.
relink "$link" "-sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -o $work/out/node/php.js"
relink "$link" "-sENVIRONMENT=web -sMODULARIZE=1 -sEXPORT_NAME=createPhp -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sEXPORTED_RUNTIME_METHODS=callMain,FS -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -o $work/out/web/php.js"

# The request loop: sapi.c in place of the CLI's own objects, with the
# exports php-4.4.9/build.sh gives its loop, and php_wasm_set_argv() for a
# script written for the CLI. runtime/php-runtime.js drives it.
sapi_link=$(sed -E 's# sapi/cli/[a-z_]+\.lo##g' <<<"$link")
test "$sapi_link" != "$link"
! grep -q 'sapi/cli/.*\.lo' <<<"$sapi_link"
sapi_link=${sapi_link/%-o sapi\/cli\/php/$work/php_wasm_sapi.o -o sapi\/cli\/php}
sapi_flags="-sMODULARIZE=1 -sEXPORT_NAME=createPhp -sEXPORTED_FUNCTIONS=_php_wasm_startup,_php_wasm_request,_php_wasm_set_argv,_php_wasm_set_clock_start,_malloc,_free -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB"
mkdir -p "$work/out/sapi-node" "$work/out/sapi-web"
relink "$sapi_link" "$sapi_flags -sENVIRONMENT=node -sNODERAWFS=1 -o $work/out/sapi-node/php.js"
# In-memory filesystem. Node is listed so probes can run the browser build.
relink "$sapi_link" "$sapi_flags -sENVIRONMENT=web,worker,node -o $work/out/sapi-web/php.js"

# The licences of what was just linked, for site/assemble.sh to publish with
# the binaries: PHP, the Zend Engine, PCRE, GD, libmagic and libzip from the
# PHP archive, libxml2's and OpenSSL's from their archives, Emscripten's
# runtime and its musl libc from the emsdk that linked them, and zlib's,
# libpng's, libjpeg's and FreeType's from the sources Emscripten's ports were
# built from.
emscripten=$(em-config EMSCRIPTEN_ROOT)
rm -rf "$work/out/licences"
mkdir -p "$work/out/licences"
cp LICENSE "$work/out/licences/php-5.6.40-LICENSE"
cp Zend/LICENSE "$work/out/licences/zend-engine-LICENSE"
cp ext/pcre/pcrelib/LICENCE "$work/out/licences/pcre-LICENCE"
cp "$work/libxml2-2.9.14/Copyright" "$work/out/licences/libxml2-Copyright"
cp "$work/openssl-1.0.2u/LICENSE" "$work/out/licences/openssl-LICENSE"
cp "$emscripten/LICENSE" "$work/out/licences/emscripten-LICENSE"
cp "$emscripten/system/lib/libc/musl/COPYRIGHT" "$work/out/licences/musl-COPYRIGHT"
cp ext/gd/libgd/COPYING "$work/out/licences/gd-COPYING"
cp ext/fileinfo/libmagic/LICENSE "$work/out/licences/libmagic-LICENSE"
cp ext/zip/LICENSE_libzip "$work/out/licences/libzip-LICENSE"
# Exactly one unpacked version of each port is there.
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

node "$work/out/node/php.js" -n -v
