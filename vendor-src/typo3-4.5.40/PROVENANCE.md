# TYPO3 4.5.40 — source archive provenance

| Field | Value |
| --- | --- |
| Version | 4.5.40, the final release of the 4.5 LTS branch |
| Release date | 2015-02-19 09:10:26 UTC |
| Release type | security |
| Archive | `typo3_src-4.5.40.tar.gz` (20,721,996 bytes) |
| Source URL | https://downloads.sourceforge.net/project/typo3/TYPO3%20Source%20and%20Dummy/TYPO3%204.5.40/typo3_src-4.5.40.tar.gz |
| Checksums published at | https://get.typo3.org/json, snapshot in `../get.typo3.org-releases-2026-08-13.json` |
| Retrieved | 2026-11-06 |
| Licence | GPL-2.0-or-later (`GPL.txt`, `LICENSE.txt` inside the archive) |

## Why SourceForge, and why that does not weaken anything

The other archives here came from get.typo3.org. The session that vendored this one
could not reach it: its egress proxy refused get.typo3.org and the CDN it redirects
to. SourceForge carried TYPO3's source releases throughout the 4.x era, and it could
be reached.

The mirror is not the trust anchor. The checksums are, and they come from
get.typo3.org's own release feed, retrieved months earlier and committed beside this
directory. A file from any host that matches both is the file upstream published.

## Checksum verification

Both checksums published by get.typo3.org were verified against the downloaded
file and **matched exactly**:

| Algorithm | Published by get.typo3.org | Downloaded file | Match |
| --- | --- | --- | --- |
| SHA-1 | `290acdeac2dc1937ce0cfb1d7ea982cd1b0b7398` | `290acdeac2dc1937ce0cfb1d7ea982cd1b0b7398` | yes |
| MD5 | `75dc19184abfec84c384f31a7b353b6a` | `75dc19184abfec84c384f31a7b353b6a` | yes |

SHA-256 is not published upstream; it is recorded here so future re-downloads can
be diffed against this exact byte sequence:

```
d2f4f89ddbf095bd9096db93601f9a3c1736801f393a057a4fbfe152075baee1
```

Re-verify with:

```sh
sha256sum -c SHA256SUMS
sha1sum   -c SHA1SUMS
md5sum    -c MD5SUMS
```

## What the archive is, against the Git tag

The analysis behind the 4.5 stack was first written from TYPO3's Git tag
`TYPO3_4-5-40` (commit `375ce4db1322e94482b2afc4fbbc40ca6b554283`), before this
archive could be fetched. The two were compared file by file afterwards.

Every file the archive contains is byte-identical to the tag. The archive only
leaves things out: `.gitignore`, `.travis.yml`, every `tests/` directory, and the
`src/` trees under `t3lib/fonts/` and `typo3/contrib/flashmedia/`. So every line
reference in that document holds for this archive, except the one to
`.travis.yml`, which exists only in the tag.

## Why the tarball and not the zip

Same reason as `typo3-3.8.1/`: the `.tar.gz` preserves POSIX permissions and
symlinks; the `.zip` does not. The zip checksums from the same feed, for
completeness:

- zip SHA-1: `d92dd3ccde15ccb64357bbb20fdcffb987d273d4`
- zip MD5: `03bf82bfe10f13022af80f038d75fe4e`

## Repository size note

At 20.7 MB this is the largest archive here, and it is still plain Git for the
reason `typo3-3.8.1/PROVENANCE.md` gives: a frozen upstream tarball never produces
a second revision, so LFS would add a fetch dependency and buy nothing.

## Security

This is a 2015 codebase whose branch has had no security release since this one.
It must only ever be executed inside the network-isolated container described in
`4.5/`.
