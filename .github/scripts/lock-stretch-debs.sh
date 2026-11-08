#!/bin/bash
# Prints the lock for one stretch image: every .deb its build installs, as
# "<sha256>  <url>", each checked against Debian's own signature chain.
#
#   lock-stretch-debs.sh <stack>/stretch-debs.lock
#
# Runs as root inside the image's base, php:5.6-apache at the digest every
# stretch Dockerfile pins, because what apt has to fetch depends on what that
# image already has installed. .github/workflows/stretch-debs.yml runs it and
# compares the output with the committed lock. Not used by any image.
#
# The packages to resolve are named once, in the lock's own "# packages:" line.
#
# Why this exists: stretch's signing keys have expired, and apt has no way to
# accept an expired signature. It reports EXPKEYSIG and refuses, so the
# Dockerfiles used to install with [trusted=yes], over an index nobody had
# authenticated. An expired key still makes a valid signature, though. It only
# says the key should no longer be used for new ones, and these were made while
# it was current. So the chain is checked here, once, by hand:
#
#   Release       signed by a key in the image's debian-archive-keyring
#   Packages.gz   whose SHA-256 the signed Release lists
#   each .deb     whose SHA-256 that Packages.gz lists
#
# Only a .deb that passes all three gets a line. The Dockerfile then trusts
# nothing but those lines.
set -euo pipefail

lock="$1"
packages=$(sed -n 's/^# packages: //p' "$lock")
if [ -z "$packages" ]; then
    echo "$lock has no '# packages:' line" >&2
    exit 1
fi

ARCHIVE=http://archive.debian.org
KEYRING=/usr/share/keyrings/debian-archive-keyring.gpg
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- What apt would fetch ----------------------------------------------------
# trusted=yes here only lets apt *resolve*. Nothing it says is believed: every
# URL it names is checked against the signed chain below before it is printed.
printf '%s\n' \
    "deb [trusted=yes] $ARCHIVE/debian stretch main" \
    "deb [trusted=yes] $ARCHIVE/debian-security stretch/updates main" \
    > /etc/apt/sources.list
printf '%s\n' 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/10-archived-suite
apt-get update -qq >/dev/null
# shellcheck disable=SC2086 # the package list is meant to split
apt-get install -qq -y --no-install-recommends --print-uris $packages \
    | sed -n "s/^'\([^']*\)'.*/\1/p" > "$work/urls"
if [ ! -s "$work/urls" ]; then
    echo "apt resolved nothing to fetch for: $packages" >&2
    exit 1
fi

# --- The signed chain, one suite at a time ------------------------------------
# verify_suite <base URL> <dists path> <name>
#
# Leaves <name>.index: "<Filename> <SHA256>" for every package in the suite's
# main/binary-amd64, read from a Packages.gz the signed Release vouches for.
verify_suite() {
    local base="$1" dists="$2" name="$3"
    curl -fsS -o "$work/$name.Release" "$base/$dists/Release"
    curl -fsS -o "$work/$name.Release.gpg" "$base/$dists/Release.gpg"

    # gpgv's exit status is no use: it fails on an expired key even when the
    # signature itself is good. The status lines are what to read. VALIDSIG is
    # only written for a signature that verifies, and GOODSIG or EXPKEYSIG says
    # which kind of key made it. A bad signature writes BADSIG and neither.
    gpgv --status-fd 1 --keyring "$KEYRING" \
        "$work/$name.Release.gpg" "$work/$name.Release" > "$work/$name.status" 2>/dev/null || true
    if grep -q '^\[GNUPG:\] BADSIG' "$work/$name.status" \
        || ! grep -q '^\[GNUPG:\] VALIDSIG' "$work/$name.status" \
        || ! grep -qE '^\[GNUPG:\] (GOODSIG|EXPKEYSIG)' "$work/$name.status"; then
        echo "$base/$dists/Release: no valid signature from $KEYRING" >&2
        cat "$work/$name.status" >&2
        exit 1
    fi
    grep -E '^\[GNUPG:\] VALIDSIG' "$work/$name.status" | awk '{print "signed by " $3}' \
        | sed "s|^|# $dists: |" >&2

    local want
    want=$(awk '/^SHA256:/{s=1; next} /^[^ ]/{s=0} s && $3 == "main/binary-amd64/Packages.gz" {print $1}' \
        "$work/$name.Release")
    if [ -z "$want" ]; then
        echo "$base/$dists/Release lists no SHA-256 for main/binary-amd64/Packages.gz" >&2
        exit 1
    fi
    curl -fsS -o "$work/$name.Packages.gz" "$base/$dists/main/binary-amd64/Packages.gz"
    echo "$want  $work/$name.Packages.gz" | sha256sum -c --quiet -

    gzip -dc "$work/$name.Packages.gz" \
        | awk '/^Filename: /{f=$2} /^SHA256: /{h=$2} /^$/{if (f && h) print f, h; f=h=""} END{if (f && h) print f, h}' \
        > "$work/$name.index"
}

verify_suite "$ARCHIVE/debian" dists/stretch main
verify_suite "$ARCHIVE/debian-security" dists/stretch/updates security

# --- Every .deb against its index -------------------------------------------
while read -r url; do
    case "$url" in
        "$ARCHIVE/debian/"*)          suite=main;     path="${url#"$ARCHIVE/debian/"}" ;;
        "$ARCHIVE/debian-security/"*) suite=security; path="${url#"$ARCHIVE/debian-security/"}" ;;
        *) echo "apt named a URL outside the two suites: $url" >&2; exit 1 ;;
    esac
    # apt percent-encodes the URL ("+" in a Debian version becomes %2b), and the
    # index's Filename is not encoded.
    path=$(printf '%b' "${path//%/\\x}")
    want=$(awk -v p="$path" '$1 == p {print $2; exit}' "$work/$suite.index")
    if [ -z "$want" ]; then
        echo "$path is not in the signed $suite index" >&2
        exit 1
    fi
    curl -fsS -o "$work/deb" "$url"
    got=$(sha256sum "$work/deb" | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then
        echo "$url: SHA-256 $got, the signed index says $want" >&2
        exit 1
    fi
    echo "$want  $url"
done < "$work/urls" | sort -k2
