# TYPO3 4.0.13 — source archive provenance

| Field | Value |
| --- | --- |
| Version | 4.0.13, the final release of the 4.0 branch, and the only 4.0 release the feed lists |
| Release date | 2009-07-02 22:00:22 UTC |
| Release type | regular |
| Archive | `typo3_src-4.0.13.tar.gz` (7,661,136 bytes) |
| Source URL | https://downloads.sourceforge.net/project/typo3/TYPO3%20Source%20and%20Dummy/TYPO3%204.0.13/typo3_src-4.0.13.tar.gz |
| Checksums published at | https://get.typo3.org/json, snapshot in `../get.typo3.org-releases-2026-08-13.json` |
| Retrieved | 2026-11-06 |
| Licence | GPL-2.0-or-later (`GPL.txt`, `LICENSE.txt` inside the archive) |

## Why SourceForge, and why that does not weaken anything

Same reason as `typo3-4.5.40/`. The session that vendored this archive could not
reach get.typo3.org: its egress proxy refused it and the CDN it redirects to.
SourceForge carried TYPO3's source releases throughout the 4.x era, and it could be
reached.

The mirror is not the trust anchor. The checksums are, and they come from
get.typo3.org's own release feed, retrieved months earlier and committed beside this
directory. A file from any host that matches both is the file upstream published.

## Why 4.0.13

It is the only 4.0 release the feed carries. `get.typo3.org` lists no 4.0.0 to
4.0.12, so "the last of the branch", the rule 4.5.40 followed, and "the only one
there is" give the same answer here.

## Checksum verification

Both checksums published by get.typo3.org were verified against the downloaded
file and **matched exactly**:

| Algorithm | Published by get.typo3.org | Downloaded file | Match |
| --- | --- | --- | --- |
| SHA-1 | `27d410298254c326fd28d74c7ab6eee297876882` | `27d410298254c326fd28d74c7ab6eee297876882` | yes |
| MD5 | `89b27c180bc603f802205996bc3bacd3` | `89b27c180bc603f802205996bc3bacd3` | yes |

SHA-256 is not published upstream; it is recorded here so future re-downloads can
be diffed against this exact byte sequence:

```
f46c2b238464abadfc908b3268d511dec1b4951105cefab656af65fac8bbc256
```

Re-verify with:

```sh
sha256sum -c SHA256SUMS
sha1sum   -c SHA1SUMS
md5sum    -c MD5SUMS
```

## What the archive is, against the Git tag

The archive was compared file by file with TYPO3's Git tag `TYPO3_4-0-13`
(commit `5059b04f68520e5d7572d818bdb96e04abc72640`).

The code is the same. Every difference is one of three kinds:

- **Subversion keywords.** 4.0 was released from Subversion, and the tarball
  carries expanded keywords (`$Id: class.t3lib_db.php 1761 2006-10-14 … $`,
  `$Revision: 128 $`, `$Author: … $`) where the Git import has them collapsed
  (`$Id$`). Compared with those lines ignored, every file both sides carry is
  identical.
- **Three files only the archive has:** `INSTALL.txt`, `README.txt` and
  `RELEASE_NOTES.txt`.
- **One directory only the tag has:** `t3lib/fonts/src/`.

## Why the tarball and not the zip

Same reason as the other archives here: the `.tar.gz` preserves POSIX permissions
and symlinks; the `.zip` does not. The zip checksums from the same feed, for
completeness:

- zip SHA-1: `09acd4869b05ba866fd6825b39c7f9de1b83fd52`
- zip MD5: `b4ec45a80d5ef92bc83179004c82d6d8`

## Security

This is a 2009 codebase from a branch that has had no release since this one. It
must only ever be executed inside the network-isolated container described in
`4.0/`.
