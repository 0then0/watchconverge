"""FFF 0.11.0 cached file paths over WatchConverge JSONL. No disk reads in snapshot."""

import argparse
import json
import queue
import signal
import sys
import tempfile
import threading
from contextlib import ExitStack
from importlib.metadata import version
from pathlib import Path

MAX_ENTRIES = 10000
PROJECTION = {
    "paths": "relative-posix",
    "types": ["file"],
    "hash": "none",
    "excludes": [],
}


def complete_snapshot(finder):
    # This is FFF's in-memory index glob, not pathlib.glob / an OS tree walk.
    # One native call holds the picker read lock across selection + conversion.
    # Asking for cap+1 avoids torn multi-page exports. Never treat top-k as complete.
    result = finder.glob("**", page_index=0, page_size=MAX_ENTRIES + 1)
    if not (
        len(result.items) == result.total_matched == result.total_files <= MAX_ENTRIES
    ):
        raise RuntimeError(
            "FFF snapshot incomplete or exceeds 10000 entries; refusing truncation"
        )
    entries = [{"path": item.relative_path, "type": "file"} for item in result.items]
    if len({entry["path"] for entry in entries}) != len(entries):
        raise RuntimeError("FFF snapshot contains duplicate paths")
    return entries


def send(message):
    print(json.dumps({"v": 1, **message}, ensure_ascii=False), flush=True)


def diagnostic(message, level="info", **fields):
    send({"type": "diagnostic", "level": level, "message": message, **fields})


def progress_data(finder):
    p = finder.scan_progress
    return {
        key: getattr(p, key)
        for key in (
            "is_scanning",
            "is_watcher_ready",
            "is_warmup_complete",
            "scanned_files_count",
        )
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-watch",
        action="store_true",
        help="Intentional static-index negative control",
    )
    args = parser.parse_args()
    if version("fff-search") != "0.11.0":
        raise RuntimeError("This adapter requires exactly fff-search 0.11.0")
    from fff import FileFinder

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    lines = queue.Queue()
    input_closed = threading.Event()
    input_errors = []

    def read_input():
        # The main thread owns FFF and cleanup. This reader only delivers input,
        # making EOF observable even while the main thread waits for readiness.
        try:
            for line in sys.stdin:
                lines.put(line)
        except (OSError, ValueError) as error:
            input_errors.append(error)
        finally:
            lines.put(None)
            input_closed.set()

    threading.Thread(target=read_input, daemon=True).start()
    finder = None
    with ExitStack() as stack:
        try:
            while True:
                line = lines.get()
                if input_errors:
                    raise input_errors[0]
                if line is None:
                    return
                m = json.loads(line)
                if m.get("v") != 1 or not isinstance(m.get("id"), str):
                    raise RuntimeError("Invalid WatchConverge request")
                if m["type"] == "init" and finder is None:
                    # Separate owned tree (runner), database and logs. Never use user caches.
                    db = Path(
                        stack.enter_context(
                            tempfile.TemporaryDirectory(prefix="watchconverge-fff-db-")
                        )
                    )
                    logs = Path(
                        stack.enter_context(
                            tempfile.TemporaryDirectory(
                                prefix="watchconverge-fff-logs-"
                            )
                        )
                    )
                    finder = FileFinder(
                        m["root"],
                        frecency_db_path=db / "frecency",
                        history_db_path=db / "history",
                        log_file_path=logs / "fff.log",
                        log_level="info",
                        enable_content_indexing=False,
                        enable_mmap_cache=False,
                        follow_symlinks=False,
                        watch=not args.no_watch,
                    )
                    last = None
                    while True:
                        if input_closed.is_set():
                            if input_errors:
                                raise input_errors[0]
                            return
                        progress = progress_data(finder)
                        if progress != last:
                            diagnostic("FFF readiness progress", progress=progress)
                            last = progress
                        if not progress["is_scanning"] and (
                            args.no_watch or progress["is_watcher_ready"]
                        ):
                            break
                        # Poll readiness flags, waking immediately on EOF. Elapsed
                        # time alone never establishes readiness.
                        input_closed.wait(0.02)
                    diagnostic(
                        "INTENTIONAL NEGATIVE CONTROL: watch=False; static FFF index, revision 0"
                        if args.no_watch
                        else "FFF watcher ready; SDK has no index revision or processing-queue signal. No idle/PASS assertion."
                    )
                    send(
                        {
                            "type": "ready",
                            "id": m["id"],
                            "projection": PROJECTION,
                            "snapshotSignals": "reported"
                            if args.no_watch
                            else "unavailable",
                        }
                    )
                elif m["type"] == "snapshot" and finder is not None:
                    entries = complete_snapshot(finder)
                    # With watch=False and both content features disabled, the completed
                    # initial index is static: no update queue and no subsequent revisions.
                    # A watched finder does NOT expose these signals. Never equate
                    # is_scanning=False, a callback count or a snapshot count with idle/revision.
                    send(
                        {
                            "type": "snapshot",
                            "id": m["id"],
                            "entries": entries,
                            "revision": 0 if args.no_watch else None,
                            "processing": False if args.no_watch else None,
                        }
                    )
                elif m["type"] == "stop":
                    if finder is not None:
                        finder.close()
                        finder = None
                    send({"type": "stopped", "id": m["id"]})
                    return
                else:
                    raise RuntimeError("Unexpected request or lifecycle order")
        finally:
            # Runs before ExitStack removes the separate database/log directories.
            if finder is not None:
                finder.close()


if __name__ == "__main__":
    from fff import FFFException

    try:
        main()
    except (FFFException, OSError, ValueError, RuntimeError) as error:
        diagnostic(f"FFF adapter error: {type(error).__name__}: {error}", "error")
        sys.exit(1)
