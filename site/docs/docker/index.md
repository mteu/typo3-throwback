# With Docker

You need Docker with Compose 2.23.1 or newer. You do not need to clone the
repository. Each compose file is self-contained and pulls its images from
GHCR.

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

Stop it and throw everything away:

```sh
docker compose -f typo3-3.3.yaml down -v
```

## Each release

The other releases work the same way: download `<version>/compose.yaml` and
use its port. The credentials are the same.

| TYPO3 | Runs on | Port |
| --- | --- | --- |
| [3.3.0](3.3.md) | PHP 4.4.9, MySQL 5.5 | 8033 |
| [3.8.1](3.8.md) | PHP 5.6.40, MySQL 5.5 | 8038 |
| [4.0.13](4.0.md) | PHP 5.6.40, MySQL 5.5 | 8040 |
| [4.5.40](4.5.md) | PHP 5.6.40, MySQL 5.5 | 8045 |
| [6.2.31](6.2.md) | PHP 5.6.40, MySQL 5.5 | 8062 |

## Further reading

The repository's `docs/` folder covers the options, the install wizard,
arm64, the published images and building from source:

- [Running the stacks](https://github.com/mteu/typo3-throwback/blob/main/docs/running.md)
- [The images](https://github.com/mteu/typo3-throwback/blob/main/docs/images.md)
- [Building from source](https://github.com/mteu/typo3-throwback/blob/main/docs/building.md)
