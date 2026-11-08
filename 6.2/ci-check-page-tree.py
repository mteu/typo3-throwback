"""Checks one Ext.Direct page-tree answer from TYPO3 6.2.31.

Run by the typo3-6-2 job in .github/workflows/images.yml, as
`python3 -I 6.2/ci-check-page-tree.py <response file> <probe title>`.
Not used by the image.

4.5/ci-check-page-tree.py with the site name changed. The page tree came
to 6.2 with its shape intact: the namespaced DataProvider builds the admin's mount
the way 4.5's did (typo3/sysext/backend/Classes/Tree/Pagetree/DataProvider.php,
getTreeMounts()), and ExtDirectNode serialises it with the same editableText and
children keys (Classes/Tree/ExtDirectNode.php:546, :574).

Parsing the body as JSON is the first assertion and the one this file exists
for: anything PHP prints in front of it — the 5.6 raw-POST deprecation among
them — makes it fail. The rest checks that the answer is the page tree the
seeded database implies, so a valid but empty or exceptional reply cannot pass.
"""

import json
import sys

SITE_NAME = "TYPO3 6.2.31"


def fail(message: str) -> None:
    print(f"::error::{message}")
    sys.exit(1)


def main() -> None:
    response_path, probe = sys.argv[1], sys.argv[2]

    with open(response_path, encoding="utf-8") as handle:
        raw = handle.read()

    try:
        replies = json.loads(raw)
    except json.JSONDecodeError as error:
        fail(f"the Ext.Direct reply is not JSON ({error}); it begins: {raw[:300]!r}")

    if not isinstance(replies, list) or len(replies) != 1:
        fail(f"expected one Ext.Direct reply, got: {raw[:300]!r}")

    reply = replies[0]
    # 'exception' is how the router reports a refused token or an unknown
    # endpoint (typo3/sysext/core/Classes/ExtDirect/ExtDirectRouter.php); it is
    # valid JSON.
    if reply.get("type") != "rpc":
        fail(f"the router answered {reply.get('type')!r}: {reply.get('message')!r}")

    mounts = reply.get("result")
    if not isinstance(mounts, list) or len(mounts) != 1:
        fail(f"expected one tree mount for an admin, got: {mounts!r}")

    mount = mounts[0]
    if mount.get("editableText") != SITE_NAME:
        fail(f"the mount is {mount.get('editableText')!r}, not the site {SITE_NAME!r}")

    titles = [child.get("editableText") for child in mount.get("children", [])]
    # The third UTF-8 round trip, after TypoScript and TCEforms: through
    # json_encode, which escapes every non-ASCII character as \\uXXXX.
    if probe not in titles:
        fail(f"the seeded page is not below the mount as {probe!r}; children: {titles!r}")

    print(f"page tree over Ext.Direct: {SITE_NAME} > {probe}")


if __name__ == "__main__":
    main()
