# TYPO3 3.3.0 — source archive provenance

**This is the oldest publicly available TYPO3 source release.** Nothing older is
distributed as code by any channel (see "Search coverage" below).

| Field | Value |
| --- | --- |
| Version | 3.3.0 (only release on the 3.3 branch) |
| Release date | 2002-06-03 12:01:07 UTC |
| Release type | release |
| Archive | `typo3_src-3.3.0.tar.gz` (5,804,089 bytes) |
| Source URL | https://get.typo3.org/3.3.0 |
| Retrieved | 2026-08-13 |
| Licence | GPL-2.0-or-later |

## Checksum verification

Both checksums published by get.typo3.org were verified and **matched exactly**:

| Algorithm | Published | Downloaded | Match |
| --- | --- | --- | --- |
| SHA-1 | `41f70b4928c17da625efeb1ddce80c968bf6c24d` | `41f70b4928c17da625efeb1ddce80c968bf6c24d` | yes |
| MD5 | `ab23120ad091d7414fb53e7a74e9cce1` | `ab23120ad091d7414fb53e7a74e9cce1` | yes |

SHA-256 recorded locally (not published upstream):
`0fd61b5452e7eb0d8bac6929b29fefa3235ac958e8a4c68790f1abae07644960`

Upstream publishes **no zip checksums** for this release — the `checksums.zip.sha1`
and `.md5` fields are empty strings in the release feed. The tarball is the only
integrity-verifiable artefact for 3.3.0, which is reason enough to prefer it.

## Why 3.3.0 is the floor

3.3.0 is not an arbitrary archival cutoff. The archive's own `misc/` directory
contains the upgrade folders for every preceding milestone, and their timestamps
reconstruct the release lineage:

```
2000-11-10  mod_rewrite.htaccess      first public beta era (August 2000)
2001-04-12  31b2, 31b3, 31rc1         3.1 beta2, beta3, release candidate 1
2001-08-07  32b1                      3.2 beta1
2001-09-13  32b2                      3.2 beta2
2001-11-02  32b3                      3.2 beta3
2002-02-26  33b1.3                    3.3 beta1.3
2002-05-24  33RC                      3.3 release candidate
2002-06-03  ------------------------- 3.3.0 final
```

**3.1 and 3.2 never had stable releases.** They exist only as beta and RC lines
through 2001. That is why the published version sequence jumps 3.3 → 3.5 → 3.6:
3.4 was skipped and 3.1/3.2 never left beta. TYPO3 3.0 left the beta stage but was
never archived to a public download.

Note: typo3.com's history page dates the 3.0 release to "May 24th" 2002. The
archive's own timestamps place 3.3 RC on 2002-05-24 and the 3.1/3.2 betas
throughout 2001, so that date belongs to 3.3 RC, not 3.0. Where the two disagree,
the archive is the better authority.

## Runtime requirements

Same shape as 3.8.1, one minor version lower at the floor:

| Bound | Version | Authority |
| --- | --- | --- |
| Hard floor | **PHP 4.0.3** | `typo3/init.php:166` |
| Hard ceiling | **PHP 5.6** | `mysql_pconnect()` in `t3lib/class.t3lib_install.php`; `ext/mysql` removed in PHP 7.0 |

The floor is stated verbatim in the bootstrap, with period-correct branding:

```php
if ((double)phpversion()<4 || (intval(substr(phpversion(),4))<3 && intval(substr(phpversion(),2))<1))	die ("Typo3 runs with PHP4.0.3+ only");
```

### The important difference from 3.8.1

**3.3.0 contains no PHP 5 awareness whatsoever.** Grepping the core for
`phpversion()>=5`, `PHP5` or `php5` returns nothing. 3.8.1 by contrast ships a
hand-written "PHP5 fix of charset awareness" in `t3lib_div`.

That distinction is the whole risk story. 3.8.1 was written *against* PHP 5, so
running it on 5.6 is a documented accommodation. 3.3.0 predates PHP 5 by two years
(June 2002 vs July 2004), so PHP 5's changed object semantics — objects assigned by
handle rather than copied — are an untested unknown rather than something the
authors accounted for. Running 3.3.0 needs PHP 4; see
`docs/how-it-works.md`.

The 3.8.1 container is not a shortcut for it. 3.3.0 has its own, in `3.3/`.

## Search coverage

Channels checked for anything older, 2026-08-13:

| Source | Oldest source release found |
| --- | --- |
| get.typo3.org release feed | 3.3.0 (3.0/3.1/3.2/3.4 all 404) |
| SourceForge "TYPO3 Source and Dummy" | 3.3.0 |
| SourceForge `OldFiles` | documentation only — no source |
| GitHub `TYPO3/typo3` tags | 6.2.0 |
| GitHub `TYPO3/TYPO3.CMS` tags | 6.2.0 |
| GitHub `TYPO3-typo3org/TYPO3.CMS-legacy` | no tags |
| Software Heritage | indexes `git.typo3.org/typo3/typo3.git`, same 6.2 limit |

SourceForge `OldFiles` does preserve pre-3.3 *documentation* — `Inside_Typo3_0_9.pdf`
and TSref/Inside editions for 3.2b1, 3.2b2 and 3.3b1. Useful as
reference material, but not runnable code.

## Security

A 2002 codebase with unpatched remote code execution issues, older than 3.8.1 and
correspondingly worse. Network-isolated container only.
