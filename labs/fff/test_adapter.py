"""Unit checks of export completeness, independent of optional native dependency."""

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from adapter import complete_snapshot


class SnapshotTests(unittest.TestCase):
    def finder(self, count, matched=None, total=None, returned=None):
        result = SimpleNamespace(
            items=[
                SimpleNamespace(relative_path=f"file{i}")
                for i in range(count if returned is None else returned)
            ],
            total_matched=count if matched is None else matched,
            total_files=count if total is None else total,
        )

        class Finder:
            def glob(self, pattern, **kwargs):
                assert pattern == "**"
                assert kwargs == {"page_index": 0, "page_size": 10001}
                return result

        return Finder()

    def test_all_files_beyond_default_page(self):
        self.assertEqual(len(complete_snapshot(self.finder(150))), 150)

    def test_empty_is_valid(self):
        self.assertEqual(complete_snapshot(self.finder(0)), [])

    def test_truncation_limit_and_filtered_glob_are_errors(self):
        for finder in (
            self.finder(10001),
            self.finder(150, returned=100),
            self.finder(1, total=2),
        ):
            with self.assertRaises(RuntimeError):
                complete_snapshot(finder)

    def test_query_exception_is_not_absence(self):
        class Finder:
            def glob(self, *_args, **_kwargs):
                raise RuntimeError("SDK failure")

        with self.assertRaisesRegex(RuntimeError, "SDK failure"):
            complete_snapshot(Finder())

    @unittest.skipUnless(
        os.environ.get("FFF_NATIVE_TESTS") == "1", "Optional native FFF test"
    )
    def test_real_static_index_more_than_default_page_and_no_snapshot_repair(self):
        from fff import FileFinder

        with tempfile.TemporaryDirectory(prefix="watchconverge-fff-native-") as d:
            root = Path(d)
            for i in range(150):
                (root / f"file{i}").write_text("fixture")
            with FileFinder(
                root,
                watch=False,
                enable_content_indexing=False,
                enable_mmap_cache=False,
            ) as finder:
                self.assertTrue(finder.wait_for_scan_blocking(timeout_ms=5000))
                before = complete_snapshot(finder)
                self.assertEqual(len(before), 150)
                (root / "file0").unlink()
                (root / "added").write_text("new")
                self.assertEqual(complete_snapshot(finder), before)


if __name__ == "__main__":
    unittest.main()
