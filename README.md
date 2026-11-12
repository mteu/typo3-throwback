<p align="center">
  <img src="docs/assets/typo3-3.3-mark.png" width="128" alt="The TYPO3 mark as it shipped with release 3.3.0 in 2002">
</p>

<h1 align="center">typo3-throwback</h1>

<p align="center">
  <b>Run TYPO3 as it was in 2002. For realsies.</b><br>
</p>

> [!CAUTION]
> **These stacks are insecure by design. Run them on your own machine, and never expose them.**
>
> TYPO3 3.3.0 to 6.2.31 and the PHP they run on carry years of known,
> unpatched remote code execution vulnerabilities. Treat everything inside as
> hostile. Never publish a port beyond `127.0.0.1`, never put real data in them,
> and never run them on a server that is reachable from the internet or from a
> network you do not trust. You have been warned.
>
> The compose files already bind to loopback and cut the application containers
> off from the network. Do not undo that.

## What you get

The TYPO3 backend and TypoScript frontend, the Install Tool, record editing and the
original 1-2-3 install wizard. This is not a mock-up: it is the original
release archives, checksum-verified, on the PHP each one was written for. PHP 4.4.9
is compiled from unmodified upstream source. Even the clock is set back to the
release date.

| Version | Released | Runs on | Port |
| --- | --- | --- | --- |
| **3.3.0**, the oldest publicly available TYPO3 | 2002-06-03 | PHP 4.4.9, MySQL 5.5 | 8033 |
| **3.8.1**, the last release before 4.0 | 2005-11-14 | PHP 5.6.40, MySQL 5.5 | 8038 |
| **4.0.13**, the last 4.0 release | 2009-07-02 | PHP 5.6.40, MySQL 5.5 | 8040 |
| **4.5.40**, the last release of the first LTS | 2015-02-19 | PHP 5.6.40, MySQL 5.5 | 8045 |
| **6.2.31**, the last public release of the second LTS | 2017-04-18 | PHP 5.6.40, MySQL 5.5 | 8062 |

## Quick start

You need Docker with Compose 2.23.1 or newer. You do not need to clone this
repository. Each compose file is self-contained and pulls its images from GHCR.

```sh
curl -fsSL -o typo3-3.3.yaml https://raw.githubusercontent.com/mteu/typo3-throwback/main/3.3/compose.yaml
docker compose -f typo3-3.3.yaml up -d
```

Then open <http://127.0.0.1:8033/>.

| What | Where | Credentials |
| --- | --- | --- |
| Frontend | <http://127.0.0.1:8033/> | none |
| Backend | <http://127.0.0.1:8033/typo3/> | `admin` / `password` |
| Install Tool | <http://127.0.0.1:8033/typo3/install/> | `joh316` |

The other stacks work the same way: download `<version>/compose.yaml` and use the
port in the table above. The credentials are the same.

Stop it and throw everything away:

```sh
docker compose -f typo3-3.3.yaml down -v
```

Clone the repository only to read the sources or build the images yourself:
`git clone https://github.com/mteu/typo3-throwback.git`. The commands in the other
guides use the path inside a clone, such as `3.3/compose.yaml`. If you downloaded
the file, use its name instead.

> [!NOTE]
> Use a real browser for the 3.3 backend. TYPO3 3.3 turns away any User-Agent it
> does not recognise, `curl` included.

## Or try 3.3.0 in your browser

No Docker needed: <https://throwback.mteu.cc/3.3> runs TYPO3 3.3.0
on PHP 4.4.9, compiled to WebAssembly, in your own tab. Nothing runs on a server,
and nothing you do there leaves your browser. The credentials are the ones
above.

## Behind the scenes

- [Running the stacks](docs/running.md): options, the install wizard, arm64, troubleshooting
- [The images](docs/images.md): what is published, and how to build on it
- [Building from source](docs/building.md)
- [How the stacks work](docs/how-it-works.md): why each release runs the way it does

## Licence(s)

The files this project wrote are MIT-licensed: the Dockerfiles, compose files,
scripts and documentation. See [LICENSE](LICENSE). Everything it builds on keeps
its own licence. [NOTICE](NOTICE) lists each one.

This project is not affiliated with or endorsed by the TYPO3 Association. "TYPO3"
is a registered trademark of the TYPO3 Association. The mark at the top is the
logo as it shipped in the 3.3.0 release archive. It is not covered by the MIT
licence.

To report a problem in this project, see [SECURITY.md](SECURITY.md).

## Disclaimer
Large language models were used in the making of this project.
