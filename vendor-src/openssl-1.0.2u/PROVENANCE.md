# OpenSSL 1.0.2u — source archive provenance

**The last public OpenSSL 1.0.2 release** (2019-12-20).
`wasm/php-5.6.40/build.sh` compiles its libcrypto and libssl to WebAssembly
for PHP 5.6.40's ext/openssl. TYPO3 6.2.31 needs it: its rsaauth login
encrypts the password with an RSA key that `openssl_pkey_new()` makes, its
Install Tool requires the extension, and its random bytes come from
`openssl_random_pseudo_bytes()`.

| Field | Value |
| --- | --- |
| Version | 1.0.2u |
| Release date | 2019-12-20 |
| Archive | `openssl-1.0.2u.tar.gz` (5,355,412 bytes) |
| Source URL | https://github.com/openssl/openssl/releases/download/OpenSSL_1_0_2u/openssl-1.0.2u.tar.gz |
| Retrieved | 2026-11-20 |
| Licence | the OpenSSL License and the original SSLeay License, both in the archive's `LICENSE` file |

The archive is OpenSSL's own release tarball, as the project publishes it
among the assets of its `OpenSSL_1_0_2u` release on GitHub, with its
checksums and its signature.

## Checksum verification

The SHA-256 and SHA-1 OpenSSL publishes beside the archive were verified and
**matched exactly**:

| Algorithm | Published | Downloaded | Match |
| --- | --- | --- | --- |
| SHA-256 | `ecd0c6ffb493dd06707d38b14bb4d8c2288bb7033735606569d8f90f89669d16` | `ecd0c6ffb493dd06707d38b14bb4d8c2288bb7033735606569d8f90f89669d16` | yes |
| SHA-1 | `740916d79ab0d209d2775277b1c6c3ec2f6502b2` | `740916d79ab0d209d2775277b1c6c3ec2f6502b2` | yes |

`openssl-1.0.2u.tar.gz.sha256` and `openssl-1.0.2u.tar.gz.sha1` in this
directory are OpenSSL's published files, as retrieved, so the claim can be
checked without the network.

Recorded locally (OpenSSL publishes none):

| Algorithm | Value |
| --- | --- |
| MD5 | `cdc2638f789ecc2db2c91488265686c1` |

`build.sh` checks `SHA256SUMS` before it unpacks anything.

## Signature

`openssl-1.0.2u.tar.gz.asc` is the detached signature OpenSSL published with
the release, made on 2019-12-20 by the key with the fingerprint
`8657 ABB2 60F0 56B1 E519 0839 D9C4 D26D 0E60 4491` (Matt Caswell, an
OpenSSL release signer). It was not checked here: the environment that
vendored the archive could not reach a keyserver. With that key imported:

```sh
gpg --verify openssl-1.0.2u.tar.gz.asc openssl-1.0.2u.tar.gz
```

## Why 1.0.2u specifically

PHP 5.6 does not build against OpenSSL 1.1, whose structures are opaque.
1.0.2u is the last release of 1.0.2, the line PHP 5.6 was written for.

## How it is built

Static, as `linux-generic32` with C only: no assembly, threads, shared
objects, DSO loading, engines, hardware support or zlib. The algorithms are
OpenSSL's defaults. Only libcrypto and libssl are built, not the `openssl`
command or the tests. `build.sh` checks the version string and each option.

## Re-fetching

```sh
base=https://github.com/openssl/openssl/releases/download/OpenSSL_1_0_2u
curl -fsSLO "$base/openssl-1.0.2u.tar.gz"
curl -fsSLO "$base/openssl-1.0.2u.tar.gz.sha256"
curl -fsSLO "$base/openssl-1.0.2u.tar.gz.asc"
echo "$(cat openssl-1.0.2u.tar.gz.sha256)  openssl-1.0.2u.tar.gz" | sha256sum -c
```

A network allowlist needs `github.com` and
`release-assets.githubusercontent.com`.

## Security

OpenSSL 1.0.2 reached its public end of life on 2019-12-31, and later issues
were fixed only for paying support customers. Here it runs inside a browser
tab, where it generates and uses RSA keys for a login to a site that lives
only in that tab, and gives PHP its random bytes. It opens no connection:
the tab has no sockets, so libssl's TLS code is linked but never reached.
