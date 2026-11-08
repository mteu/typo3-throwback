# vendor-src

Frozen upstream source archives and the release metadata that attests them.

## Archives

| Directory       | Version                                                 | Released   | Size    | Checksums verified                                                          |
|-----------------|---------------------------------------------------------|------------|---------|-----------------------------------------------------------------------------|
| `typo3-3.3.0/`  | 3.3.0 — oldest public release                           | 2002-06-03 | 5.8 MB  | sha1 + md5, both matched                                                    |
| `typo3-3.8.1/`  | 3.8.1                                                   | 2005-11-14 | 11.6 MB | sha1 + md5, both matched                                                    |
| `typo3-4.0.13/` | 4.0.13 — final 4.0 release, the only one the feed lists | 2009-07-02 | 7.7 MB  | sha1 + md5, both matched; fetched from SourceForge, see its `PROVENANCE.md` |
| `typo3-4.5.40/` | 4.5.40 — final 4.5 LTS release                          | 2015-02-19 | 20.7 MB | sha1 + md5, both matched; fetched from SourceForge, see its `PROVENANCE.md` |
| `typo3-6.2.31/` | 6.2.31 — last public 6.2 LTS release                    | 2017-04-18 | 21.0 MB | sha1 + md5, both matched; fetched from SourceForge, see its `PROVENANCE.md` |
| `php-4.4.9/`    | PHP 4.4.9 — final PHP 4 release                         | 2008-08-07 | 5.6 MB  | md5, matched                                                                |

`php-4.4.9/` is the one entry that is not a TYPO3 release. It is here because
`php4-base/` compiles it into the only PHP 4 runtime in this repository.
Fetching it from `museum.php.net` at build time would make a 2008 end-of-life
archive on a single unmirrored host a hard dependency of the build. An archive the
build cannot proceed without belongs under the same guarantee as the sources it
compiles for.

Each directory carries its own `PROVENANCE.md` plus `SHA256SUMS`, `SHA1SUMS` and
`MD5SUMS`. Re-verify from inside the directory:

```sh
sha1sum -c SHA1SUMS
md5sum  -c MD5SUMS
sha256sum -c SHA256SUMS
```

The SHA-1 and MD5 sums are **upstream-published** values from get.typo3.org, so
`-c` against them is a genuine integrity check, not just a self-consistency check.
SHA-256 is recorded locally because upstream publishes none.

## `get.typo3.org-releases-2026-08-13.json`

A verbatim snapshot of the get.typo3.org release feed, retrieved 2026-08-13.

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| Source URL | https://get.typo3.org/json                                         |
| Retrieved  | 2026-08-13                                                         |
| Size       | 263,701 bytes                                                      |
| Coverage   | 24 version branches, 568 releases                                  |
| SHA-256    | `2b2d76e756adf9eadb481ce484c65708dac114cf6effa729909a93a3982f26bc` |

This is the authority behind every release date and checksum cited in this
repository. It is committed rather than re-fetched for three reasons:

1. **It is a live endpoint.** New patch releases change it. Pinning a snapshot
   means the checksums quoted in `PROVENANCE.md` files can be audited against
   what upstream actually said on the day, rather than against a feed that has
   since moved.
2. **It documents the version matrix.** It carries the start date of every
   branch, all at once.
3. **It records the pre-4.0 floor.** The feed carries branches `3.3`, `3.5`,
   `3.6`, `3.7` and `3.8` — the evidence that 3.3.0 is the oldest published
   release. The 3.3.0 `PROVENANCE.md` has the rest of that search.

Query it without a network round-trip:

```sh
python3 -c "
import json
d = json.load(open('vendor-src/get.typo3.org-releases-2026-08-13.json'))
for v, i in sorted(d['3.3']['releases'].items()):
    print(v, i['date'], i['checksums']['tar']['sha1'])
"
```

Note the feed's top-level keys include non-version aliases — `latest_stable`,
`latest_old_stable`, `latest_lts`, `latest_old_lts` — alongside the 24 numeric
branch keys. Filter on `k[0].isdigit()` when enumerating branches, or the aliases
will be double-counted.

## Re-fetching

Every archive here is reproducible from upstream:

```sh
curl -L -o typo3_src-<version>.tar.gz https://get.typo3.org/<version>
curl -L -o php-4.4.9.tar.gz https://museum.php.net/php4/php-4.4.9.tar.gz
```

Checksums to verify against are in each `PROVENANCE.md` and in the feed snapshot.
Note that 3.3.0 publishes **no zip checksums** upstream — those fields are empty
strings — so the tarball is its only integrity-verifiable form.

## `php.net-releases-v4-2026-08-14.json`

The same role for `php-4.4.9/` that the get.typo3.org snapshot plays for the TYPO3
archives: a verbatim copy of php.net's release feed for the PHP 4 line,
retrieved 2026-08-14, covering 36 releases. It is the authority behind the
published MD5 quoted in `php-4.4.9/PROVENANCE.md`, so that claim can be audited
without a network round-trip.

```sh
python3 -c "
import json
d = json.load(open('vendor-src/php.net-releases-v4-2026-08-14.json'))
for s in d['4.4.9']['source']:
    print(s['filename'], s.get('md5', '-'))
"
```

## Security

These are 2002 to 2017 codebases with unpatched remote code execution issues.
They exist here to be compiled and run inside a network-isolated container, never
to be served. See the compose file in each version's directory.
