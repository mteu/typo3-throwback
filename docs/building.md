# Building from source

You rarely need to. The images are published, and pulling is faster. Build when you
want to audit what goes into them, change something, or cannot reach the registry.

Nothing is fetched from TYPO3's or PHP's servers while building. The tarballs are
in [`vendor-src/`](../vendor-src/README.md), each with its provenance, and every
Dockerfile re-verifies the checksum before it unpacks one.

## 3.8.1, 4.0.13, 4.5.40 and 6.2.31

One step, because each starts from an official `php:5.6-apache` image:

```sh
docker compose -f 3.8/compose.yaml up -d --build
docker compose -f 4.0/compose.yaml up -d --build
docker compose -f 4.5/compose.yaml up -d --build
docker compose -f 6.2/compose.yaml up -d --build
```

## 3.3.0

Two steps. Its Dockerfile starts `FROM` the PHP 4 base image, so build that first,
under the name the Dockerfile expects:

```sh
docker build -f php4-base/Dockerfile -t ghcr.io/mteu/typo3-throwback/php4-base:4.4.9 .
docker compose -f 3.3/compose.yaml up -d --build
```

The first command compiles PHP 4.4.9 from source and takes a while. That is the
work CI exists to do once.

`up --build` on its own is not enough. The Dockerfile's `FROM` would still pull the
published base, because no local image carries that tag yet.

## Without Docker Hub, or without GHCR

The two Debian base images the PHP 4 build uses come from Docker Hub by default.
To take them from this project's mirror instead, add
`--build-arg BASE_REGISTRY=ghcr.io/mteu/typo3-throwback` to the `docker build`.

To take `mysql` and `nginx` from Docker Hub instead of the mirror, set
`THROWBACK_MIRROR=docker.io/library` when you run compose. Both choices pick a
host, never a different image, because every base is pinned by digest.

## What CI does

[`.github/workflows/images.yml`](../.github/workflows/images.yml) builds each image,
boots the stack, and checks the frontend, the backend login form, record editing,
the Install Tool and the web server's source protection. It publishes only after
those pass. The version tags move only from the default branch. A branch build is
tested in full and publishes nothing a compose file points at. The workflow also
runs monthly without publishing, to catch archived Debian suites before you do.

It starts only when a file an image is built from changes, or a compose file or
the workflow itself. Editing the README, `docs/`, a `PROVENANCE.md` or the mirror
workflow starts nothing. Changing only a compose file or the workflow tests the
stack again but pushes nothing, because the image is the same. To rebuild and
republish everything anyway, run the workflow by hand with `force` ticked.

## The vulnerability scan

[`.github/workflows/vulnerability-scan.yml`](../.github/workflows/vulnerability-scan.yml)
builds an SBOM for every image a stack runs on the 1st and 15th of each month and
scans it. Syft lists what is installed. Components that Syft cannot find, because
they were compiled from source or unpacked from an archive, are declared in
[`images.json`](../.github/vulnerability-scan/images.json) and added to the SBOM.
Grype then matches the complete SBOM against Debian, Alpine, GitHub and NVD
advisories. The workflow commits a small summary to
[`vulnerability-scans/`](vulnerability-scans/) and regenerates
[`vulnerabilities.md`](vulnerabilities.md) from all of them. It never fails
because a number went up. The images are vulnerable on purpose, so the scan
is a record, not a gate. Only the default branch publishes. A branch run shows the
page it would write in the run summary and commits nothing.

When an image gains a component that is built from source, add it to
`images.json`. The unit tests the workflow runs first check every declared source
archive against its vendored checksum.

The workflow also attaches each SBOM to its image in GHCR as a signed
attestation, with `actions/attest`. Only an image that is new,
or whose SBOM lists something different, gets a new one. The image's digest does
not change: the attestation is stored next to the image, not inside it, which also
holds for the mirrored `mysql` and `nginx`. In a private fork this step
skips itself, because GitHub offers attestations in private repositories only to
organizations on Enterprise Cloud. How to verify one is in
[`vulnerabilities.md`](vulnerabilities.md#the-sboms-in-the-registry).

## Debian packages for the stretch images

3.8, 4.0, 4.5 and 6.2 start from the official `php:5.6-apache` image, which is
Debian stretch. Their builds add a few packages (gd's headers, libfaketime,
ImageMagick, and for 4.5 and 6.2 libxml2's headers). They do not let apt choose
or check those. Each stack's `stretch-debs.lock` names every file the build
installs, with its SHA-256 and its URL on `archive.debian.org`. The Dockerfile
downloads exactly those files, checks each hash, and installs them with apt's
sources emptied, so a file the lock does not name cannot be fetched.

The hashes come from Debian, not from a download that happened to work. Stretch's
signing keys have expired, and apt refuses an expired signature, but the
signatures are still valid. `.github/scripts/lock-stretch-debs.sh` checks
stretch's Release signature against the image's own keyring, Packages.gz against
the signed Release, and each `.deb` against that Packages.gz. Only then does a
file get a line. [`.github/workflows/stretch-debs.yml`](../.github/workflows/stretch-debs.yml)
re-derives all four locks whenever a lock or the script changes, and monthly, and
fails on any difference.

To change what a stretch image installs, edit the `# packages:` line in its lock
and push. The workflow fails and prints the lock it derived. Read why it differs,
then commit that.

## The mirror

[`.github/workflows/mirror-upstream-images.yml`](../.github/workflows/mirror-upstream-images.yml)
copies the upstream bases into this project's namespace with
`skopeo copy --preserve-digests` and then re-checks each digest. `mysql:5.5` is the
reason it exists. It reached end of life in 2018 and cannot be replaced with
anything newer, because PHP 4's bundled client only speaks the pre-4.1 auth
protocol that MySQL 5.7 removed.
