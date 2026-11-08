# TYPO3 6.2.31 — source archive provenance

| Field | Value |
| --- | --- |
| Version | 6.2.31, the last public release of the 6.2 LTS branch |
| Release date | 2017-04-18 16:26:13 UTC |
| Release type | regular |
| Archive | `typo3_src-6.2.31.tar.gz` (20,959,472 bytes) |
| Source URL | https://downloads.sourceforge.net/project/typo3/TYPO3%20Source%20and%20Dummy/TYPO3%206.2.31/typo3_src-6.2.31.tar.gz |
| Checksums published at | https://get.typo3.org/json, snapshot in `../get.typo3.org-releases-2026-08-13.json` |
| Retrieved | 2026-11-06 |
| Licence | GPL-2.0-or-later (`LICENSE.txt` inside the archive) |

## Why SourceForge, and why that does not weaken anything

Same reason as `typo3-4.5.40/` and `typo3-4.0.13/`. The session that vendored this
archive could not reach get.typo3.org: its egress proxy refused it and its CDN.
SourceForge carried TYPO3's source releases through the 6.x era.

The mirror is not the trust anchor. The checksums are, and they come from
get.typo3.org's own release feed, committed beside this directory months earlier.

The download is slow, at over 20 MB from one mirror. It was fetched with
`curl -L -C -` and no short timeout, after an earlier attempt with a 240-second
timeout had truncated it.

## Why 6.2.31

It is the last 6.2 release the public feed lists, and the rule 4.5.40 followed
("the last of the branch") picks it. Later 6.2 releases exist only as paid
extended support, outside the feed and outside this repository.

## Checksum verification

Both checksums published by get.typo3.org were verified against the downloaded
file and **matched exactly**:

| Algorithm | Published by get.typo3.org | Downloaded file | Match |
| --- | --- | --- | --- |
| SHA-1 | `3bbace592a8e9c313971e7952a074b93ee846568` | `3bbace592a8e9c313971e7952a074b93ee846568` | yes |
| MD5 | `de09600286499411fbd3ac746983e514` | `de09600286499411fbd3ac746983e514` | yes |

SHA-256 is not published upstream; it is recorded here so future re-downloads can
be diffed against this exact byte sequence:

```
f4f8c16f0ea68ad04da35ae57e22f44e1db1528c7cb213978bffba7384f75d2b
```

Re-verify with:

```sh
sha256sum -c SHA256SUMS
sha1sum   -c SHA1SUMS
md5sum    -c MD5SUMS
```

## What the archive is, against the Git tag

The archive was compared file by file with TYPO3's Git tag `TYPO3_6-2-31`. That
name is an annotated tag, object `058104cdfba8574a38b8da27a955473f6b2aee42`, and
it points at commit `824790147e24707ca500c4c4f9b8657e20434685`.

Every file the archive contains is byte-identical to the tag. The archive only
leaves things out, and almost all of them are Git's own files: `.editorconfig`, `.gitignore`
files (one at the top and seventeen under extensions' documentation and vendor
directories), `.travis.yml`, and `typo3/contrib/vendor/doctrine/instantiator/tests/`.
Unlike 4.5.40, the core's own `Tests/` directories ship in the archive.

`.travis.yml` is the one omission with content that matters here: it runs the
tests on PHP 5.3, 5.4, 5.5 and 5.6. `INSTALL.md` in the same commit still says "up
to 5.5". The stack runs on 5.6 regardless.

## Why the tarball and not the zip

Same reason as the other archives here. The zip checksums from the same feed,
for completeness:

- zip SHA-1: `8a65e699bd86d5b14077f2fc0b0f25179e8aa9c8`
- zip MD5: `0768342ab8792f846718119f8be046d8`

## Repository size note

At 21.0 MB this is now the largest archive here, by a little. It is still plain
Git, for the reason `typo3-3.8.1/PROVENANCE.md` gives: a frozen upstream tarball
never produces a second revision.

## Security

This is a 2017 codebase from a branch whose public support has ended. It must
only ever be executed inside the network-isolated container described in `6.2/`.
