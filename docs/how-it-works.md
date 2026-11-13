# How the stacks work

Why each stack is built the way it is. Read this before you change a pin. Most of
the choices look arbitrary until you meet the failure they prevent.

## What every stack shares

The application and database containers have no network egress. Only the proxy in
front of them publishes a port, and it binds to `127.0.0.1`. These releases carry
unpatched remote code execution flaws, so the stacks assume a compromise and contain
it instead of trying to prevent it.

The database is MySQL 5.5, pinned by digest and mirrored. The clock is set back to
noon on the release date with libfaketime. [Running the stacks](running.md#the-clock)
says where it stands still and where it runs.

TYPO3 itself is unpacked unmodified, apart from three small edits. 3.3, 3.8 and 4.0
ship the Install Tool behind a `die()` that the source distribution expects you to
comment out by hand, so their Dockerfiles do it. 3.3 also comments out a second,
duplicate declaration of `TS_tmplParts_rte()` in `t3lib_parsehtml_proc`, because PHP
4.4.9 refuses a class with a duplicate method at compile time. 4.5 and 6.2 need no
edit at all.

| Version | PHP                    | Web server        | Database charset      | Setup                     |
|---------|------------------------|-------------------|-----------------------|---------------------------|
| 3.3.0   | 4.4.9, compiled here   | nginx and FastCGI | latin1, old passwords | seeded by `provision.php` |
| 3.8.1   | 5.6.40, official image | Apache            | latin1                | seeded by `provision.php` |
| 4.0.13  | 5.6.40, official image | Apache            | latin1                | seeded by `provision.php` |
| 4.5.40  | 5.6.40, official image | Apache            | UTF-8                 | seeded by `provision.php` |
| 6.2.31  | 5.6.40, official image | Apache            | UTF-8                 | TYPO3's own installer     |

## 3.3.0

3.3.0 has no PHP 5 awareness anywhere in its source, so PHP has to be PHP 4. That
means compiling PHP 4.4.9 from the vendored archive, on Debian bullseye's gcc 10. gcc
10 defaults to `-fno-common`, which breaks PHP 4's tentative definitions, so the build
passes `-fcommon`. gcc 14 turns several C89-era warnings into hard errors, so a newer
compiler does not work.

`--with-mysql` without a path builds the MySQL client library bundled in PHP 4, which
speaks only the pre-4.1 authentication protocol. The server runs with
`--old-passwords=1` for that reason, and TYPO3 3.3 stores a plain md5 password.

Both entry points find the document root through `PATH_TRANSLATED`, so the FastCGI
wiring has to set it, and `cgi.fix_pathinfo` has to be 0.

The 2002 schema declares a `DEFAULT` on an `AUTO_INCREMENT` column 51 times. MySQL 5.5
rejects that even with a relaxed `sql_mode`, so `provision.php` strips it. It also splits
the SQL files on lines that end in a semicolon, as TYPO3 does, because some inserts
contain semicolons inside the data.

The seeded admin gets `fileoper_perms = 7`, as 3.3.0's own Install Tool gives the
admin it creates (`t3lib/class.t3lib_install.php:3009`). `admin = 1` alone does not
cover file operations: `tce_file.php` reads only this field, and at its default of 0
even an admin is told "You are not allowed to upload files!".

## 3.8.1

3.8.1 needs PHP 4.1 or newer and runs on PHP 5, so no PHP 4 build is needed. 5.6.40 is
the newest release that still has the `mysql_*` extension, which is the database layer
for the whole product and was removed in PHP 7.

3.8 splits its schema across `t3lib/stddb/tables.sql` and one `ext_tables.sql` per
extension, and defines some tables more than once. `provision.php` merges the
definitions the way TYPO3's own installer does.

The clock runs here. 3.8.1 builds a session id from the clock and the process id.
Under a frozen clock every cookieless request that one Apache child served got that
child's one id, so a second browser arrived logged in as the first. The CI job checks
for exactly that.

The seeded admin gets `fileoper_perms = 7`, as 3.8.1's own Install Tool gives the
admin it creates (`typo3/sysext/install/mod/class.tx_install.php:3665`). `admin = 1`
alone does not cover file operations: `tce_file.php:144` hands only this field to
`t3lib_extFileFunctions::init_actionPerms()`, and at its default of 0 even an admin is
told "You are not allowed to upload files!". The CI job uploads a file into
`fileadmin/` and reads it back.

The Debian stretch packages the image adds come from `3.8/stretch-debs.lock`. See
[Building from source](building.md#debian-packages-for-the-stretch-images).

## 4.0.13

4.0.13 is the only 4.0 release the release feed lists. It is a 3.8-era application with
one 4.5 trait, and it runs on the same PHP, Apache and MySQL as 3.8.

It is ISO-8859-1 throughout, so it wants a latin1 server. A UTF-8 server refuses its
bytes. PHP 5.6 also needs `default_charset = ISO-8859-1`, because 4.0 never names a
charset when it calls `htmlspecialchars()`.

It builds every redirect as an absolute URL, so behind a TLS-terminating proxy it has to
be told so with `TYPO3_BEHIND_TLS=1`. Nothing else is needed, because 4.0 predates
`trustedHostsPattern`. It needs the same Install Tool edit as 3.8.

Its seeded admin needs `fileoper_perms = 7` for the same reason as 3.8's, and gets it
as 4.0.13's own Install Tool gives it (`class.tx_install.php:3620`). 4.5 needs none of
this: its `getFileoperationPermissions()` gives an admin every bit.

## 4.5.40

4.5.40 is the last release of its branch. It runs on PHP 5.6, one minor past what
upstream tested. The alternative was a PHP 5.3 image, which is large, unfixed since
2014 and not mirrored.

4.5 is UTF-8 end to end. It connects with `SET NAMES utf8` and names no charset on its
tables, so a latin1 server would store every character outside latin1 as `?`, with only
a warning. `provision.php` refuses to start on anything but UTF-8 and checks the round
trip.

Redirects and some response bodies are absolute, so it needs `TYPO3_BEHIND_TLS=1`
behind TLS. That fix makes TYPO3 believe it is on port 443 while Apache sees port 80,
and every request then fails the `trustedHostsPattern` check. So the entrypoint sets
the pattern to `.*`. That is safe here, because the stack answers on loopback only and
has no egress, so a forged Host header has no one to mislead.

PHP 5.6 warns that automatically populating `$HTTP_RAW_POST_DATA` is deprecated, for
a POST whose body is not a form. The backend's Ext.Direct calls are exactly that. The
warning only reaches a page when three settings are all on, and the image enables none
of them. `php-legacy.ini` sets `always_populate_raw_post_data = -1` as a second guard.

The default extension list leaves out `t3skin`, the backend skin. Without it no skin
stylesheet is registered, and the backend renders as bare HTML. 4.5's own update
wizard warns that the backend may be unusable without it. So the entrypoint enables it,
and `provision.php` lists it with the other extensions. It has no tables of its own.

## 6.2.31

6.2.31 runs on the same stack as 4.5, with the same UTF-8 and TLS findings. The new
problem is setup. 6.2 will not boot without `LocalConfiguration.php` and
`PackageStates.php`, and part of its schema exists only inside a booted 6.2. So
`install.php` drives 6.2's own step installer over HTTP on first boot, which takes most
of a minute.

Its configuration is the installer's output, so `typo3conf/` lives in a volume that
lasts as long as the database. `down -v` removes both. While the installer runs, Apache
answers on loopback only.

The backend login uses rsaauth and saltedpasswords, so the CI script encrypts the
password the way the login form's JavaScript does.
