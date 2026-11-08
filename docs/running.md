# Running the stacks

Everything beyond the quick start in the [README](../README.md).

You need Docker with Compose 2.23.1 or newer. Each compose file inlines its proxy
config, and that is the feature that needs the newer Compose.

## Options

All optional. Set them in your shell or in a `.env` file next to the compose file.

| Variable | Default | Effect |
| --- | --- | --- |
| `TYPO3_PROVISION` | `auto` | `auto` seeds an admin, a root page and a TypoScript template, so the site renders immediately. `wizard` leaves the database empty so you can walk the period-authentic 1-2-3 install wizard at `/typo3/install/index.php?mode=123&step=1`. 6.2 ignores it: its own step installer always runs on first boot, which takes most of a minute. |
| `TYPO3_ADMIN_PASSWORD` | `password` | Backend password for `admin`. Only read on the first boot of a fresh database. |
| `THROWBACK_PORT_33` / `_38` / `_40` / `_45` / `_62` | `8033` / `8038` / `8040` / `8045` / `8062` | Loopback port of each stack. |
| `TYPO3_BEHIND_TLS` | `0` | 4.0, 4.5 and 6.2. `1` tells TYPO3 it sits behind a TLS-terminating proxy, so its absolute redirects say `https://`. Leave it off on plain loopback, where `https://` leads nowhere. |
| `THROWBACK_MIRROR` | `ghcr.io/mteu/typo3-throwback` | Where `mysql` and `nginx` come from. Set it to `docker.io/library` to use Docker Hub. The digests are pinned, so this picks a host, never a different image. |

```sh
TYPO3_PROVISION=wizard docker compose -f 3.3/compose.yaml up -d
```

## The clock

The clock inside each stack is set back to noon on its release date: 2002-06-03
for 3.3.0, 2005-11-14 for 3.8.1, 2009-07-02 for 4.0.13, 2015-02-19 for 4.5.40 and
2017-04-18 for 6.2.31. That is deliberate. The backend's "last login", every
rendered timestamp and the wizard's own comments in `localconf.php` carry the
release date.

In 4.0.13, 4.5.40 and 6.2.31 the clock stands still at noon, so two runs render
identical pages. In 3.3.0 and 3.8.1 it starts at noon and runs. Those two make a
session id from the clock, and a clock that stands still gave every new session
the same id: a second browser arrived logged in as the first. Their pages still
carry the release date, but the seconds differ between runs.

## Stopping, and why `-v` matters

```sh
docker compose -f 3.3/compose.yaml down -v
```

The mysql image declares its own anonymous volume, so a plain `down` leaves the
database behind and the next `up` silently reuses it. The seeding step then finds a
populated database and skips the import, so you are not starting from scratch even
though it looks like you are. Use `down -v` between runs, or `up -d -V` to force a
fresh database in place.

To keep a site on purpose, add named volumes for `db:/var/lib/mysql` and
`web:/var/www/html/typo3conf`. The seeding step is idempotent and skips the import.
The closing comment in each compose file says more. That setup is not exercised by
the CI smoke test.

## Running from a single file

Each compose file is self-contained, so you do not need the clone just to run a
stack. Save each one under its own name, because they are all called
`compose.yaml`:

```sh
curl -fsSL -o typo3-3.3.yaml https://raw.githubusercontent.com/mteu/typo3-throwback/main/3.3/compose.yaml
docker compose -f typo3-3.3.yaml up -d
```

The options above work the same way. Put them in your shell or in a `.env` file next
to the downloaded file. Only `--build` needs a clone, because it reads `vendor-src/`.

## Use a real browser for the 3.3 backend

TYPO3 3.3 sniffs the User-Agent and answers "You must use 4+ browsers with Typo3!"
to anything it does not recognise, `curl` included. The frontend has no such check,
and the later releases have none at all.

## On Apple Silicon and other arm64 hosts

It works, under emulation, slowly. `mysql:5.5` was never published for arm64, and
the TYPO3 images are built for amd64 only. The compose files declare
`platform: linux/amd64`, so there is nothing to pass on the command line.

If `db` dies with `exited (2)` and `fatal error: newosproc`, your copy of the
compose file is missing `user: "999:999"` on `db`. The mysql entrypoint's `gosu`
is a 2017 Go binary that cannot start threads under amd64 emulation. Starting the
container as uid 999 skips it. `3.3/compose.yaml` explains it in full.

## When something fails

`docker compose` needs `-f` on **every** subcommand, not just `up`. Without it you
get `no configuration file provided: not found`, which looks like a broken stack
and is only a dropped flag. Either `cd` into the version directory, or:

```sh
export COMPOSE_FILE=3.3/compose.yaml
```

`up -d` prints only a summary. A container that dies during startup has its real
error in `docker compose logs`.

A pull that fails with `EOF`, `i/o timeout` or a TLS error is your network path,
not the pins. Check with `docker pull hello-world`. If that fails too, nothing in
this project is involved.
