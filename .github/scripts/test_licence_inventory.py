import contextlib
import io
import unittest
from pathlib import Path

import licence_inventory as inventory

REPOSITORY = Path(__file__).resolve().parents[2]

GPL2_EXCERPT = """GNU GENERAL PUBLIC LICENSE
                       Version 2, June 1991
 ... the GNU General Public License ... placed in the public domain ..."""


class LicenceFileNameTest(unittest.TestCase):
    def test_it_accepts_the_names_the_archives_use(self) -> None:
        for name in ("LICENSE", "LICENSE.txt", "license.txt", "GPL.txt", "COPYING.LIB",
                     "LICENSE.TERMS", "COPYRIGHT", "LICENCE", "HTMLAREA_LICENSE.txt",
                     "LICENSE-exception.txt", "MIT-LICENSE.txt"):
            with self.subTest(name=name):
                self.assertTrue(inventory.is_licence_file(name))

    def test_it_rejects_code_and_readmes(self) -> None:
        for name in ("Notice.php", "NoticeStatus.php", "license.php", "README", "LicenseTest.js"):
            with self.subTest(name=name):
                self.assertFalse(inventory.is_licence_file(name))


class RecogniseLicenceTest(unittest.TestCase):
    def test_a_gpl_text_is_not_also_reported_as_public_domain_or_as_naming_the_gpl(self) -> None:
        self.assertEqual(inventory.recognise_licence(GPL2_EXCERPT), ("GPL-2.0 text",))

    def test_it_recognises_a_bsd_grant_worded_for_one_suite(self) -> None:
        text = "Redistribution and use of this software in source and binary forms, with or without"
        self.assertEqual(inventory.recognise_licence(text), ("BSD-style",))

    def test_it_reports_a_statement_that_names_a_licence_without_quoting_it(self) -> None:
        text = "This version of Ext JS is licensed under the terms of the Open Source GPL 3.0 license."
        self.assertEqual(inventory.recognise_licence(text), ("names the GPL",))

    def test_it_says_so_when_it_recognises_nothing(self) -> None:
        self.assertEqual(inventory.recognise_licence("t3editor is written by Tobias Liebig"),
                         ("not recognised, read the file",))


class HeaderNoticeTest(unittest.TestCase):
    def test_the_php_groups_own_header_is_not_a_third_party_notice(self) -> None:
        source = "/*\n   | Copyright (c) 1997-2008 The PHP Group |\n*/\nint x;\n"
        self.assertEqual([inventory.is_third_party_notice(b) for b in inventory.comment_blocks(source)],
                         [False])

    def test_a_third_party_notice_inside_the_php_header_is_kept(self) -> None:
        source = ("/*\n | Copyright (c) 1997-2008 The PHP Group |\n"
                  " * Original code bears the following copyright:\n"
                  " * Copyright (c) 1995-1998 The Apache Group.\n*/\n")
        self.assertTrue(inventory.is_third_party_notice(inventory.comment_blocks(source)[0]))

    def test_code_that_looks_like_a_notice_is_ignored(self) -> None:
        self.assertEqual(inventory.comment_blocks("switch (c) {\n  case 1: break;\n}\n"), [])

    def test_a_run_of_line_comments_is_one_block(self) -> None:
        source = "// Copyright (c) 2000 Tux the Linux Penguin\n// All rights reserved.\nint x;\n"
        self.assertEqual(inventory.comment_blocks(source),
                         ["// Copyright (c) 2000 Tux the Linux Penguin\n// All rights reserved."])

    def test_the_same_notice_in_many_files_is_listed_once_per_directory(self) -> None:
        paths = [f"ext/mysql/libmysql/f{i}.c" for i in range(3)] + ["main/strlcat.c"]
        self.assertEqual(inventory.describe_locations(paths),
                         "ext/mysql/libmysql/ (3 files), main/strlcat.c")


class ConfigureFlagsTest(unittest.TestCase):
    def test_every_flag_the_real_dockerfile_passes_is_known(self) -> None:
        flags = inventory.configure_flags((REPOSITORY / inventory.PHP_DOCKERFILE).read_text())
        self.assertIn("--with-gd", flags)
        self.assertIn("ext/gd", inventory.compiled_directories(flags))

    def test_an_unknown_flag_stops_the_inventory_and_names_the_flag(self) -> None:
        with self.assertRaises(inventory.InventoryError) as raised:
            inventory.compiled_directories(["--disable-all", "--enable-mbstring"])
        self.assertIn("--enable-mbstring", raised.exception.problem)


class RenderPhpNoticesTest(unittest.TestCase):
    FILES = {
        "LICENSE": b"The PHP License, version 3.01",
        "Zend/LICENSE": b"The Zend Engine License, version 2.00",
        "ext/gd/libgd/README": b"Credits and license terms",
        "main/snprintf.c": b"/*\n * Copyright (c) 1995-1998 The Apache Group.\n */\n",
        "main/php.c": b"/*\n | Copyright (c) 1997-2008 The PHP Group |\n */\n",
        "ext/xml/expat/xmlparse.c": b"/* Copyright (c) 1998 James Clark */\n",
    }

    def render(self) -> str:
        return inventory.render_php_notices(self.FILES, "0" * 64, ["--disable-all", "--with-gd"])

    def test_it_carries_both_acknowledgements_the_licences_require(self) -> None:
        notices = self.render()
        self.assertIn("This product includes PHP software", notices)
        self.assertIn("This product includes the Zend Engine", notices)

    def test_it_carries_licence_files_and_header_notices_of_compiled_parts_only(self) -> None:
        notices = self.render()
        self.assertIn("---- ext/gd/libgd/README ----", notices)
        self.assertIn("The Apache Group", notices)
        self.assertNotIn("James Clark", notices)
        self.assertNotIn("---- main/php.c ----", notices)

    def test_a_missing_gd_readme_stops_the_inventory(self) -> None:
        files = {k: v for k, v in self.FILES.items() if k != "ext/gd/libgd/README"}
        with self.assertRaises(inventory.InventoryError):
            inventory.render_php_notices(files, "0" * 64, ["--disable-all"])


class CommittedInventoryTest(unittest.TestCase):
    def test_the_committed_files_match_what_the_archives_say(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()) as diff:
            stale = inventory.stale_outputs(inventory.expected_outputs())
        self.assertEqual(stale, [], diff.getvalue()[:4000])


if __name__ == "__main__":
    unittest.main()
