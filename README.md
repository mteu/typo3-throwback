<div align="center">

![TYPO3 3.3 supported](https://badgen.net/badge/TYPO3/v3.3/FF8700?icon=typo3)
![TYPO3 3.8 supported](https://badgen.net/badge/TYPO3/v3.8/FF8700?icon=typo3)
![TYPO3 4.0 supported](https://badgen.net/badge/TYPO3/v4.0/FF8700?icon=typo3)
![TYPO3 4.5 supported](https://badgen.net/badge/TYPO3/v4.5/FF8700?icon=typo3)
![TYPO3 6.2 supported](https://badgen.net/badge/TYPO3/v6.2/FF8700?icon=typo3)

  <hr />

  <img src="docs/assets/typo3-3.3-mark.png" width="128" alt="The TYPO3 mark as it shipped with release 3.3.0 in 2002">
</div>

<h1 align="center">typo3-throwback</h1>

<p align="center">
  <b>Run TYPO3 as it was in 2002. For realsies.</b>
</p>

typo3-throwback runs historic TYPO3 releases, from 3.3.0 to 6.2.31, in Docker
containers. Each release is its own stack: TYPO3, the PHP it was written for,
and MySQL.

> [!CAUTION]
> **These stacks are insecure by design. Run them only on your own machine and never expose them.**
>
> TYPO3 3.3.0 to 6.2.31 and the PHP they run on have years of known,
> unpatched remote code execution vulnerabilities. Treat everything inside the
> containers as hostile.
>
> - Never publish a port beyond `127.0.0.1`.
> - Never put real data in them.
> - Never run them on a server that is reachable from the internet or from a
    >   network you do not trust.
>
> The compose files already bind to loopback and cut the application containers
> off from the network. Do not undo that. You have been warned.

## What you get

Each stack includes:

- the TYPO3 backend and TypoScript frontend
- the Install Tool
- record editing
- the original 1-2-3 install wizard

This is not a mockup. These are the original release archives, checksum-verified,
running on the PHP each one was written for. PHP 4.4.9 is compiled from
unmodified upstream source. Even the clock is set back to the release date.

| Version | Released | Runs on | Port |
| --- | --- | --- | --- |
| **3.3.0**, the oldest publicly available TYPO3 | 2002-06-03 | PHP 4.4.9, MySQL 5.5 | 8033 |
| **3.8.1**, the last release before 4.0 | 2005-11-14 | PHP 5.6.40, MySQL 5.5 | 8038 |
| **4.0.13**, the last 4.0 release | 2009-07-02 | PHP 5.6.40, MySQL 5.5 | 8040 |
| **4.5.40**, the last release of the first LTS | 2015-02-19 | PHP 5.6.40, MySQL 5.5 | 8045 |
| **6.2.31**, the last public release of the second LTS | 2017-04-18 | PHP 5.6.40, MySQL 5.5 | 8062 |

## Quick start

You need Docker with Compose 2.23.1 or newer. You do not need to clone this
repository. Each compose file is self-contained and pulls its images from the
GitHub Container Registry (GHCR).

```sh
curl -fsSL -o typo3-3.3.yaml https://raw.githubusercontent.com/mteu/typo3-throwback/main/3.3/compose.yaml
docker compose -f typo3-3.3.yaml up -d
```

Then open <http://127.0.0.1:8033/>.

| Service | URL | Login |
| --- | --- | --- |
| Frontend | <http://127.0.0.1:8033/> | none |
| Backend | <http://127.0.0.1:8033/typo3/> | `admin` / `password` |
| Install Tool | <http://127.0.0.1:8033/typo3/install/> | password `joh316` |

The other stacks work the same way. Download `<version>/compose.yaml` and use the
port from the table above. The logins are the same for every version.

To stop a stack and delete its data:

```sh
docker compose -f typo3-3.3.yaml down -v
```

Clone the repository only if you want to read the sources or build the images
yourself:

```sh
git clone https://github.com/mteu/typo3-throwback.git
```

The guides below show paths as they appear inside a clone, such as
`3.3/compose.yaml`. If you downloaded the file instead, use its name.

> [!NOTE]
> Use a real browser for the 3.3 backend. TYPO3 3.3 rejects any User-Agent it
> does not recognize, including `curl`.

## Documentation

- [Running the stacks](docs/running.md): options, the install wizard, arm64, troubleshooting
- [The images](docs/images.md): what is published, and how to build on it
- [Building from source](docs/building.md): how to build the images yourself
- [How the stacks work](docs/how-it-works.md): why each release runs the way it does

## Reporting problems

To report a problem in this project, see [SECURITY.md](SECURITY.md).

## Licenses

The files written for this project are MIT-licensed: the Dockerfiles, compose
files, scripts, and documentation. See [LICENSE](LICENSE).

Everything this project builds on keeps its own license. [NOTICE](NOTICE) lists
each one.

## Trademark

This project is not affiliated with or endorsed by the TYPO3 Association. "TYPO3"
is a registered trademark of the TYPO3 Association.

The mark at the top is the logo as it shipped in the 3.3.0 release archive. It is
not covered by the MIT license.

## AI disclosure

Large language models were used in the making of this project.