#!/usr/bin/env python3
"""Writes the licence inventory of every published image from the vendored archives.

  write   regenerate php4-base/NOTICES.txt and <stack>/LICENCES.md
  check   fail if any of them differs from what the archives say

Two kinds of output, because the images redistribute two kinds of code.

The TYPO3 images ship each release's tree unmodified, as source. Every licence
file and every licence header in it is in the image already. What is missing is
an index, so <stack>/LICENCES.md lists the separate licence files a release
bundles. A licence stated only in a source file's own header is not listed: it
ships with the file.

php4-base ships PHP 4.4.9 as a binary. A binary carries none of its sources'
headers, and the PHP, Zend Engine and bundled-library licences all require their
notices to travel with binary copies. So php4-base/NOTICES.txt carries the full
text of every licence file in the parts that are compiled, and every third-party
copyright notice those parts state only in a header.

Which parts are compiled is read from the configure flags in php4-base/Dockerfile.
A flag this script does not know stops it, so a new extension cannot ship without
its notices.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import re
import sys
import tarfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

REPOSITORY = Path(__file__).resolve().parents[2]
SCRIPT = ".github/scripts/licence_inventory.py"


class InventoryError(ValueError):
    def __init__(self, source: str, problem: str) -> None:
        super().__init__(f"{source}: {problem}")
        self.source = source
        self.problem = problem


@dataclass(frozen=True)
class Typo3Release:
    version: str
    stack: str
    # Where the Dockerfile puts the unpacked tree. 3.3 keeps it under /opt and
    # links it into the document root; the others copy it flat into the root.
    tree_in_image: str

    @property
    def archive(self) -> str:
        return f"vendor-src/typo3-{self.version}/typo3_src-{self.version}.tar.gz"

    @property
    def output(self) -> str:
        return f"{self.stack}/LICENCES.md"

    @property
    def path_in_image(self) -> str:
        return f"/usr/share/doc/typo3-{self.version}/LICENCES.md"


TYPO3_RELEASES = (
    Typo3Release("3.3.0", "3.3", "/opt/typo3_src-3.3.0"),
    Typo3Release("3.8.1", "3.8", "/var/www/html"),
    Typo3Release("4.0.13", "4.0", "/var/www/html"),
    Typo3Release("4.5.40", "4.5", "/var/www/html"),
    Typo3Release("6.2.31", "6.2", "/var/www/html"),
)

PHP_VERSION = "4.4.9"
PHP_ARCHIVE = f"vendor-src/php-{PHP_VERSION}/php-{PHP_VERSION}.tar.gz"
PHP_DOCKERFILE = "php4-base/Dockerfile"
PHP_OUTPUT = "php4-base/NOTICES.txt"
PHP_NOTICES_IN_IMAGE = f"/usr/share/doc/php-{PHP_VERSION}/NOTICES.txt"

# Compiled whatever the flags say. regex/ is PHP's bundled Henry Spencer library,
# which ext/standard uses because --with-regex defaults to "php"
# (ext/standard/config.m4).
PHP_CORE_DIRECTORIES = ("main", "Zend", "TSRM", "ext/standard", "regex")

# Every configure flag php4-base/Dockerfile may pass, and the source directories
# it adds to the binary. A flag that only selects a system library adds none of
# PHP's: zlib, libpng, libjpeg and FreeType come from Debian, with Debian's
# copyright files.
PHP_FLAG_DIRECTORIES: dict[str, tuple[str, ...]] = {
    "--prefix": (),
    "--disable-all": (),
    "--enable-cgi": ("sapi/cgi",),
    "--enable-fastcgi": ("sapi/cgi",),
    "--with-mysql": ("ext/mysql",),
    "--with-pcre-regex": ("ext/pcre",),
    "--enable-session": ("ext/session",),
    "--with-zlib": ("ext/zlib",),
    "--with-gd": ("ext/gd",),
    "--with-jpeg-dir": (),
    "--with-png-dir": (),
    "--with-freetype-dir": (),
    "--enable-gd-native-ttf": (),
}

# GD's terms are in its README rather than in a file named for a licence.
PHP_EXTRA_LICENCE_FILES = ("ext/gd/libgd/README",)

PHP_ACKNOWLEDGEMENTS = (
    # PHP License 3.01, clause 6.
    "This product includes PHP software, freely available from\n<http://www.php.net/software/>.",
    # Zend Engine License 2.00, clause 5.
    "This product includes the Zend Engine, freely available at\nhttp://www.zend.com",
)

LICENCE_FILE_NAME = re.compile(
    r"(?i)^(?:licen[cs]e|copying|copyright|gpl|mit-license|notice"
    r"|licen[cs]e[-_][\w.-]*|[\w-]+[-_]licen[cs]e)"
    r"(?:\.(?:txt|md|markdown|html?|terms|lib))?$"
)

# Each pattern names what a licence text looks like, never what it legally is:
# a file can quote one licence and grant another.
LICENCE_SIGNATURES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("GPL-3.0 text", re.compile(r"GNU GENERAL PUBLIC LICENSE\s+Version 3", re.I)),
    ("GPL-2.0 text", re.compile(r"GNU GENERAL PUBLIC LICENSE\s+Version 2", re.I)),
    ("LGPL-3.0 text", re.compile(r"GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3", re.I)),
    ("LGPL-2.1 text", re.compile(r"GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1", re.I)),
    ("LGPL-2.0 text", re.compile(r"GNU LIBRARY GENERAL PUBLIC LICENSE\s+Version 2", re.I)),
    ("Apache-2.0 text", re.compile(r"Apache License\s+Version 2\.0", re.I)),
    ("MPL text", re.compile(r"Mozilla Public License", re.I)),
    ("PHP License text", re.compile(r"The PHP License, version 3", re.I)),
    ("Zend Engine License text", re.compile(r"The Zend Engine License", re.I)),
    ("Creative Commons", re.compile(r"Creative Commons", re.I)),
    ("MIT-style", re.compile(r"Permission is hereby granted, free of charge, to any person", re.I)),
    ("BSD-style", re.compile(r"Redistribution and use (?:of this software )?in source and binary forms", re.I)),
    ("commercial licence text", re.compile(r"COMMERCIAL LICEN[CS]E", re.I)),
    ("permissive notice", re.compile(r"Permission to use, copy, modify,? and(?:/or)? distribute this software", re.I)),
    ("zlib-style", re.compile(r"This software is provided 'as-is', without any express or implied\s+warranty", re.I)),
    ("public domain", re.compile(r"public domain|Copyright Abandoned", re.I)),
    # Statements that name a licence without quoting it, as most bundled
    # JavaScript libraries do. Only reported when no full text was recognised.
    ("names the GPL", re.compile(
        r"GNU\s+(?:General Public License|GPL|PGL)|GPLv\d|GPL\s*v?\d(?:\.\d)?\s+licen[cs]e"
        r"|licen[cs]ed under the (?:terms of the )?(?:Open Source )?GPL", re.I)),
    ("names the MIT licence", re.compile(r"\bMIT Licen[cs]e", re.I)),
)
FULL_TEXT_LABELS = {"GPL-3.0 text", "GPL-2.0 text", "LGPL-3.0 text", "LGPL-2.1 text", "LGPL-2.0 text"}

NOTICE_LINE = re.compile(r"(?i)copyright|\(c\)\s*\d|public domain")
PHP_OWN_NOTICE = re.compile(r"(?i)the php group|zend technologies|php development team|zend engine")
COMMENT_DECORATION = re.compile(r"^\s*(?:/\*+|\*+/|\*+|//+|\|)?|(?:\*+/|\|)\s*$")
HEADER_LINES = 150


def is_licence_file(name: str) -> bool:
    return LICENCE_FILE_NAME.match(name) is not None


def recognise_licence(text: str) -> tuple[str, ...]:
    found = tuple(label for label, pattern in LICENCE_SIGNATURES if pattern.search(text))
    if FULL_TEXT_LABELS.intersection(found):
        # A GNU licence's own text says "public domain" in its preamble and
        # names itself throughout. Neither is a second licence.
        found = tuple(label for label in found if label not in ("public domain", "names the GPL"))
    return found or ("not recognised, read the file",)


def comment_blocks(source: str) -> list[str]:
    """The comment blocks that start a line within a file's first lines, as written."""
    lines = source.splitlines()[:HEADER_LINES]
    blocks: list[str] = []
    index = 0
    while index < len(lines):
        stripped = lines[index].lstrip()
        if stripped.startswith("/*"):
            start = index
            while "*/" not in lines[index][lines[index].find("/*") + 2 if index == start else 0:]:
                index += 1
                if index == len(lines):
                    break
            blocks.append("\n".join(lines[start:index + 1]))
        elif stripped.startswith("//"):
            start = index
            while index + 1 < len(lines) and lines[index + 1].lstrip().startswith("//"):
                index += 1
            blocks.append("\n".join(lines[start:index + 1]))
        index += 1
    return blocks


def is_third_party_notice(block: str) -> bool:
    return any(
        NOTICE_LINE.search(line) and not PHP_OWN_NOTICE.search(line)
        for line in block.splitlines()
    )


def normalise_block(block: str) -> str:
    words = " ".join(COMMENT_DECORATION.sub("", line) for line in block.splitlines())
    return re.sub(r"\s+", " ", words).strip()


def dedent_block(block: str) -> str:
    lines = block.splitlines()
    indents = [len(line) - len(line.lstrip()) for line in lines if line.strip()]
    cut = min(indents, default=0)
    return "\n".join(line[cut:].rstrip() for line in lines)


def read_archive(path: str) -> dict[str, bytes]:
    """Every regular file in a release archive, keyed by its path below the top directory."""
    try:
        with tarfile.open(REPOSITORY / path, "r:gz") as archive:
            files: dict[str, bytes] = {}
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                parts = PurePosixPath(member.name).parts
                handle = archive.extractfile(member)
                if len(parts) < 2 or handle is None:
                    continue
                files[str(PurePosixPath(*parts[1:]))] = handle.read()
            return files
    except (OSError, tarfile.TarError) as error:
        raise InventoryError(path, f"cannot read the archive: {error}") from error


def archive_sha256(path: str) -> str:
    try:
        return hashlib.sha256((REPOSITORY / path).read_bytes()).hexdigest()
    except OSError as error:
        raise InventoryError(path, f"cannot read the archive: {error}") from error


def decode(content: bytes) -> str:
    return content.decode("utf-8", "replace") if b"\0" not in content[:4096] else ""


def configure_flags(dockerfile: str) -> list[str]:
    """The flags of the one `./configure` call in php4-base/Dockerfile, without their values."""
    match = re.search(r"\./configure((?:[ \t]*\\\n[ \t]*--[\w-]+(?:=\S+)?)+)", dockerfile)
    if match is None:
        raise InventoryError(PHP_DOCKERFILE, "no ./configure call with one flag per line")
    return [flag.split("=")[0] for flag in re.findall(r"--[\w-]+(?:=\S+)?", match.group(1))]


def compiled_directories(flags: list[str]) -> tuple[str, ...]:
    unknown = sorted(set(flags) - PHP_FLAG_DIRECTORIES.keys())
    if unknown:
        raise InventoryError(
            PHP_DOCKERFILE,
            f"configure flags this inventory does not know: {', '.join(unknown)}. Add each to "
            f"PHP_FLAG_DIRECTORIES in {SCRIPT} with the source directories it compiles in.",
        )
    directories = list(PHP_CORE_DIRECTORIES)
    for flag in flags:
        directories.extend(d for d in PHP_FLAG_DIRECTORIES[flag] if d not in directories)
    return tuple(directories)


def within(path: str, directories: tuple[str, ...]) -> bool:
    return any(path == d or path.startswith(d + "/") for d in directories)


def describe_locations(paths: list[str]) -> str:
    by_directory: dict[str, list[str]] = defaultdict(list)
    for path in paths:
        by_directory[str(PurePosixPath(path).parent)].append(path)
    parts = []
    for directory in sorted(by_directory):
        files = sorted(by_directory[directory])
        parts.append(files[0] if len(files) == 1 else f"{directory}/ ({len(files)} files)")
    return ", ".join(parts)


def render_php_notices(files: dict[str, bytes], sha256: str, flags: list[str]) -> str:
    directories = compiled_directories(flags)
    licence_paths = sorted(
        path for path, content in files.items()
        if (path == "LICENSE" or within(path, directories))
        and (is_licence_file(PurePosixPath(path).name) or path in PHP_EXTRA_LICENCE_FILES)
    )
    for extra in PHP_EXTRA_LICENCE_FILES:
        if extra not in files:
            raise InventoryError(PHP_ARCHIVE, f"{extra} is missing from the archive")

    notices: dict[str, tuple[str, list[str]]] = {}
    for path in sorted(files):
        if not path.endswith((".c", ".h")) or not within(path, directories):
            continue
        for block in comment_blocks(decode(files[path])):
            if not is_third_party_notice(block):
                continue
            key = normalise_block(block)
            notices.setdefault(key, (dedent_block(block), []))[1].append(path)

    rule = "=" * 78
    out = [
        f"PHP {PHP_VERSION} in this image: licences and notices",
        rule,
        "",
        f"Generated by {SCRIPT} from",
        f"{PHP_ARCHIVE} (SHA-256 {sha256}).",
        "Do not edit by hand.",
        "",
        *[part for acknowledgement in PHP_ACKNOWLEDGEMENTS for part in (acknowledgement, "")],
        f"PHP {PHP_VERSION} is compiled from that archive, unmodified, with",
        "",
        *[f"  {flag}" for flag in flags],
        "",
        "That compiles in PHP's own core and these parts of the archive:",
        "",
        *[f"  {directory}/" for directory in directories],
        "",
        "Part 1 holds the full text of every licence file in those parts. Part 2 holds",
        "every third-party copyright notice they state only in a source header, because",
        "a binary does not carry its sources' headers. Libraries linked from Debian",
        "(zlib, libpng, libjpeg, FreeType) are in neither part. Their Debian packages",
        "carry their own copyright files.",
        "",
        "",
        "PART 1: LICENCE FILES",
        rule,
    ]
    for path in licence_paths:
        out += ["", f"---- {path} ----", "", decode(files[path]).rstrip(), ""]
    out += ["", "PART 2: NOTICES IN SOURCE HEADERS", rule]
    for _, (block, paths) in sorted(notices.items(), key=lambda item: sorted(item[1][1])[0]):
        out += ["", f"---- {describe_locations(paths)} ----", "", block, ""]
    return "\n".join(out).rstrip() + "\n"


def render_typo3_inventory(release: Typo3Release, files: dict[str, bytes], sha256: str) -> str:
    licence_paths = sorted(path for path in files if is_licence_file(PurePosixPath(path).name))
    rows = []
    for path in licence_paths:
        directory = str(PurePosixPath(path).parent)
        name = PurePosixPath(path).name
        looks_like = ", ".join(recognise_licence(decode(files[path])))
        rows.append(f"| `{'(root)' if directory == '.' else directory}` | `{name}` | {looks_like} |")
    return "\n".join([
        f"# Licences in TYPO3 {release.version}",
        "",
        f"<!-- Generated by {SCRIPT} from {release.archive}.",
        "     Do not edit by hand. -->",
        "",
        f"TYPO3 {release.version} is GPL-2.0-or-later. The release also bundles third-party",
        "code, each part under its own licence. This is every separate licence file in",
        f"the release archive, found by its name. The `typo3:{release.version}` image ships the",
        f"tree unmodified, so each file is in the image below `{release.tree_in_image}`,",
        f"and this list is at `{release.path_in_image}`.",
        "",
        "A licence stated only in a source file's own header is not listed. That code ships",
        "as source, so the header ships with it. The last column says what a file's text",
        "looks like, not which licence applies: read the file for that.",
        "",
        f"Archive: `{release.archive}`, SHA-256 `{sha256}`.",
        "",
        "| Directory | File | What the text looks like |",
        "| --- | --- | --- |",
        *rows,
        "",
    ])


def expected_outputs() -> dict[str, str]:
    try:
        dockerfile = (REPOSITORY / PHP_DOCKERFILE).read_text()
    except OSError as error:
        raise InventoryError(PHP_DOCKERFILE, f"cannot read it: {error}") from error
    outputs = {
        PHP_OUTPUT: render_php_notices(
            read_archive(PHP_ARCHIVE), archive_sha256(PHP_ARCHIVE), configure_flags(dockerfile)
        )
    }
    for release in TYPO3_RELEASES:
        outputs[release.output] = render_typo3_inventory(
            release, read_archive(release.archive), archive_sha256(release.archive)
        )
    return outputs


def stale_outputs(outputs: dict[str, str]) -> list[str]:
    stale = []
    for path, expected in outputs.items():
        target = REPOSITORY / path
        current = target.read_text() if target.exists() else ""
        if current != expected:
            stale.append(path)
            sys.stdout.writelines(difflib.unified_diff(
                current.splitlines(keepends=True), expected.splitlines(keepends=True),
                f"{path} (committed)", f"{path} (from the archives)", n=1,
            ))
    return stale


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("write", "check"))
    arguments = parser.parse_args(argv)
    try:
        outputs = expected_outputs()
        match arguments.command:
            case "write":
                for path, content in outputs.items():
                    (REPOSITORY / path).write_text(content)
                    print(f"wrote {path}")
                return 0
            case "check":
                stale = stale_outputs(outputs)
                for path in stale:
                    print(f"::error file={path}::out of date. Run: python3 {SCRIPT} write")
                return 1 if stale else 0
    except InventoryError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
