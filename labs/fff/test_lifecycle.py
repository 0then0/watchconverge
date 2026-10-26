"""Optional subprocess lifecycle checks against the pinned native FFF SDK."""

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path

ADAPTER = Path(__file__).with_name("adapter.py").resolve()
WRAPPER = """import fff,json,runpy,sys
from types import SimpleNamespace
real = fff.FileFinder
phase = sys.argv[2]
if phase in ("input-os-error", "input-unicode-error"):
    class BrokenInput:
        def __iter__(self):
            if phase == "input-os-error":
                raise OSError("Injected stdin failure")
            raise UnicodeDecodeError("utf-8", b"\\xff", 0, 1, "injected invalid UTF-8")
    sys.stdin = BrokenInput()
class PendingFinder:
    def __init__(self, finder):
        self.finder = finder
    @property
    def scan_progress(self):
        p = self.finder.scan_progress
        if phase == "snapshot-error":
            return p
        return SimpleNamespace(
            is_scanning=True if phase == "scanning" else p.is_scanning,
            is_watcher_ready=False,
            is_warmup_complete=p.is_warmup_complete,
            scanned_files_count=p.scanned_files_count,
        )
    def close(self):
        self.finder.close()
    def glob(self, *args, **kwargs):
        raise fff.FFFException("Injected snapshot failure")
def create(*args, **kwargs):
    if phase in ("scanning", "watcher"):
        kwargs["watch"] = False
    finder = real(*args, **kwargs)
    return finder if phase == "ready" else PendingFinder(finder)
fff.FileFinder = create
sys.argv = [sys.argv[1]]
runpy.run_path(sys.argv[0], run_name="__main__")
"""


@unittest.skipUnless(
    os.environ.get("FFF_NATIVE_TESTS") == "1", "Optional native FFF tests"
)
class LifecycleTests(unittest.TestCase):
    @contextmanager
    def adapter(self, phase="ready", initialize=True):
        with tempfile.TemporaryDirectory(
            prefix="watchconverge-fff-lifecycle-"
        ) as directory:
            parent = Path(directory)
            tree, resources = parent / "tree", parent / "resources"
            tree.mkdir()
            resources.mkdir()
            (tree / "a.txt").write_text("fixture")
            child = subprocess.Popen(
                [sys.executable, "-u", "-B", "-c", WRAPPER, str(ADAPTER), phase],
                cwd=tree,
                env={**os.environ, "TMPDIR": str(resources)},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            messages = queue.Queue()

            def read():
                for line in child.stdout:
                    messages.put(json.loads(line))
                messages.put(None)

            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            try:
                if initialize:
                    child.stdin.write(
                        json.dumps(
                            {"v": 1, "type": "init", "id": "r1", "root": str(tree)}
                        )
                        + "\n"
                    )
                    child.stdin.flush()
                yield child, messages, resources
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)
                if not child.stdin.closed:
                    child.stdin.close()
                reader.join(timeout=1)
                child.stdout.close()
                child.stderr.close()

    def wait_for(self, messages, predicate):
        # Bound the complete observation wait, including intervening diagnostics.
        import time

        deadline = time.monotonic() + 5
        while True:
            message = messages.get(timeout=max(0, deadline - time.monotonic()))
            self.assertIsNotNone(message, "Adapter exited before expected observation")
            self.assertNotEqual(message.get("level"), "error", message)
            if predicate(message):
                return message

    def assert_clean_exit(self, child, resources, expected_code=0):
        child.wait(timeout=2)
        self.assertEqual(child.returncode, expected_code, child.stderr.read())
        self.assertEqual(
            list(resources.iterdir()),
            [],
            "FFF database/log directories survived shutdown",
        )

    def test_eof_during_readiness(self):
        # The actual native index is retained; only startup progress is controlled.
        for phase in ("scanning", "watcher"):
            with (
                self.subTest(phase=phase),
                self.adapter(phase) as (child, messages, resources),
            ):
                self.wait_for(
                    messages,
                    lambda m, phase=phase: (
                        "progress" in m
                        and m["progress"]["is_scanning"] == (phase == "scanning")
                        and not m["progress"]["is_watcher_ready"]
                    ),
                )
                self.assertTrue(
                    list(resources.iterdir()), "Native FFF resources were not created"
                )
                child.stdin.close()
                self.assert_clean_exit(child, resources)

    def test_eof_before_init(self):
        with self.adapter(initialize=False) as (child, _messages, resources):
            child.stdin.close()
            self.assert_clean_exit(child, resources)

    def test_eof_after_ready(self):
        with self.adapter() as (child, messages, resources):
            self.wait_for(messages, lambda m: m["type"] == "ready")
            child.stdin.close()
            self.assert_clean_exit(child, resources)

    def test_stop_after_ready(self):
        with self.adapter() as (child, messages, resources):
            self.wait_for(messages, lambda m: m["type"] == "ready")
            child.stdin.write(json.dumps({"v": 1, "type": "stop", "id": "r2"}) + "\n")
            child.stdin.flush()
            stopped = self.wait_for(messages, lambda m: m["type"] == "stopped")
            self.assertEqual(stopped["id"], "r2")
            self.assert_clean_exit(child, resources)

    def test_sigterm_during_readiness(self):
        with self.adapter("watcher") as (child, messages, resources):
            self.wait_for(
                messages, lambda m: "progress" in m and not m["progress"]["is_scanning"]
            )
            child.terminate()
            self.assert_clean_exit(child, resources)

    def test_input_stream_errors_are_fatal_not_clean_eof(self):
        for phase, error_type in (
            ("input-os-error", "OSError"),
            ("input-unicode-error", "UnicodeDecodeError"),
        ):
            with (
                self.subTest(phase=phase),
                self.adapter(phase, initialize=False) as (child, messages, resources),
            ):
                error = messages.get(timeout=5)
                self.assertIsNotNone(error)
                self.assertEqual(error["type"], "diagnostic")
                self.assertEqual(error["level"], "error")
                self.assertIn(error_type, error["message"])
                self.assert_clean_exit(child, resources, expected_code=1)

    def test_sdk_snapshot_error_is_fatal_not_absence(self):
        with self.adapter("snapshot-error") as (child, messages, resources):
            self.wait_for(messages, lambda m: m["type"] == "ready")
            child.stdin.write(json.dumps({"v": 1, "type": "snapshot", "id": "r2"}) + "\n")
            child.stdin.flush()
            error = messages.get(timeout=5)
            self.assertIsNotNone(error)
            self.assertEqual(error["type"], "diagnostic")
            self.assertEqual(error["level"], "error")
            self.assertIn("FFFException: Injected snapshot failure", error["message"])
            self.assertNotIn("entries", error)
            self.assert_clean_exit(child, resources, expected_code=1)


if __name__ == "__main__":
    unittest.main()
