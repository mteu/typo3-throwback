# TYPO3 3.8.1 — source archive provenance

| Field | Value |
| --- | --- |
| Version | 3.8.1 (only release on the 3.8 branch; also `latest` and `stable`) |
| Release date | 2005-11-14 08:33:29 UTC |
| Release type | regular |
| Archive | `typo3_src-3.8.1.tar.gz` (11,594,162 bytes) |
| Source URL | https://get.typo3.org/3.8.1 |
| Retrieved | 2026-08-13 |
| Licence | GPL-2.0-or-later (`GPL.txt`, `LICENSE.txt` inside the archive) |

## Checksum verification

Both checksums published by get.typo3.org were verified against the downloaded
file and **matched exactly**:

| Algorithm | Published by get.typo3.org | Downloaded file | Match |
| --- | --- | --- | --- |
| SHA-1 | `493df2c5ca6078622df8a8bf17a31aec302ce99d` | `493df2c5ca6078622df8a8bf17a31aec302ce99d` | yes |
| MD5 | `9b836657ea48ad92f7a9e84918ebe820` | `9b836657ea48ad92f7a9e84918ebe820` | yes |

SHA-256 is not published upstream; it is recorded here so future re-downloads can
be diffed against this exact byte sequence:

```
f29e8c0fabf9cd095b8ff3a5fca93fe3b54ab1fbaa8348894b518f726e8b227c
```

Re-verify with:

```sh
sha256sum -c SHA256SUMS
sha1sum   -c SHA1SUMS
md5sum    -c MD5SUMS
```

## Why the tarball and not the zip

Both are offered upstream. The `.tar.gz` preserves POSIX permissions and symlinks;
the `.zip` does not. Since this tree is copied into a container that runs Apache
against it, permission bits matter. The zip checksums are recorded
here for completeness in case a Windows contributor needs it:

- zip SHA-1: `da958a9296077bd74dc2f7a89c4509cda82b4b32`
- zip MD5: `0000d029d07ac6396a46b4f6ecdace4d`

## Security

This is a 2005 codebase with known unpatched remote code execution issues. It must
only ever be executed inside the network-isolated container described in
`3.8/compose.yaml`. The missing network egress is not optional for this one.
