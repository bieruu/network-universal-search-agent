"""Control experiment: do these SQLi tests actually detect a vulnerability?

A green test suite proves nothing unless it would go red against a broken
implementation. This script temporarily breaks each defense layer in turn,
re-runs the relevant tests, and reports which ones caught it.

It runs against a COPY of the source tree, patches the copy, and never touches
the real working tree. Run from backend/:

    .venv\\Scripts\\python.exe scripts/sqli_control_probe.py
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent

Mutation = tuple[str, str, tuple[tuple[str, str], ...], list[str]]

# (label, file relative to backend/, [(original, vulnerable), ...], tests to run)
#
# Each mutation may carry more than one replacement. The ORM one needs
# `text` imported as well, otherwise the mutated build dies with NameError —
# which pytest reports as a failure, and that would let us "prove" detection
# with a build that never actually ran an injectable query.
MUTATIONS: list[Mutation] = [
    (
        "ORM comparison -> string-concatenated text() (scan.py)",
        "app/routers/scan.py",
        [
            ("from sqlalchemy import select", "from sqlalchemy import select, text"),
            (
                "select(Scan).where(Scan.id == scan_id, Scan.user_id == user_id)",
                'select(Scan).where(text("Scan.id = \'" + scan_id + "\' AND Scan.user_id = \'" + user_id + "\'"))',
            ),
        ],
        [
            "tests/test_sqli.py::test_get_scan_path_param_cannot_exfiltrate_another_users_scan"
        ],
    ),
    (
        "SQLite cache key -> f-string (cache.py)",
        "app/core/cache.py",
        [
            (
                '"SELECT payload, expires_at FROM cache WHERE key=?", (key,)',
                "f\"SELECT payload, expires_at FROM cache WHERE key='{key}'\"",
            ),
        ],
        ["tests/test_sqli.py::test_sqlite_cache_key_is_bound_with_question_mark"],
    ),
    (
        "asyncpg cache key -> inlined (cache.py)",
        "app/core/cache.py",
        [
            (
                '"SELECT payload, expires_at FROM osint_cache WHERE key=$1", key',
                "f\"SELECT payload, expires_at FROM osint_cache WHERE key='{key}'\"",
            ),
        ],
        ["tests/test_sqli.py::test_postgres_cache_path_binds_key_as_argument"],
    ),
]


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, shell=False, check=False
    )
    return proc.returncode, (proc.stdout + proc.stderr)


def main() -> int:
    baseline_code, baseline_out = run(
        [sys.executable, "-m", "pytest", "tests/test_sqli.py", "-q"], BACKEND
    )
    baseline_pass = re.search(r"(\d+) passed", baseline_out)
    baseline_n = baseline_pass.group(1) if baseline_pass else "?"
    print(
        f"[baseline] tests/test_sqli.py on real source: exit {baseline_code}, {baseline_n} passed\n"
    )

    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        for index, (label, rel, edits, tests) in enumerate(MUTATIONS):
            # One directory per mutation, indexed: two mutations share the
            # `cache` module stem and would collide.
            work = Path(tmp) / f"mut{index}"
            shutil.copytree(
                BACKEND,
                work,
                ignore=shutil.ignore_patterns(
                    ".venv",
                    "__pycache__",
                    ".pytest_cache",
                    "node_modules",
                    ".git",
                    "data",
                ),
            )
            target = work / rel
            source = target.read_text(encoding="utf-8")
            missing = [orig for orig, _ in edits if orig not in source]
            if missing:
                failures.append(f"{label}: snippet not found in {rel}: {missing[0]!r}")
                print(f"[ERROR] {label} — snippet not found, mutation not applied")
                shutil.rmtree(work, ignore_errors=True)
                continue
            for orig, vuln in edits:
                source = source.replace(orig, vuln, 1)
            target.write_text(source, encoding="utf-8")

            code, out = run([sys.executable, "-m", "pytest", *tests, "-q"], work)

            # A build that crashes on import is not evidence of detection: the
            # test "caught" a NameError, not an injection. Require the failure
            # to be an assertion, i.e. the query actually ran.
            broke_on_import = "NameError" in out or "SyntaxError" in out
            caught = code != 0 and not broke_on_import
            if broke_on_import:
                verdict = "INVALID"
            elif caught:
                verdict = "CAUGHT"
            else:
                verdict = "MISSED"
            print(f"[{verdict}] {label}")
            print(
                f"         exit {code} — 0 would mean the suite stayed green => blind spot"
            )
            for line in out.splitlines():
                if line.strip().endswith(("passed", "failed", "error")) or (
                    " passed" in line and "failed" in line
                ):
                    print(f"         {line.strip()}")
            assertion_hits = sum(
                1 for line in out.splitlines() if "AssertionError" in line
            )
            db_errors = sum(
                1
                for line in out.splitlines()
                if "OperationalError" in line or "ProgrammingError" in line
            )
            if assertion_hits:
                print(
                    f"         {assertion_hits} assertion failure(s) — the payload was observed as data"
                )
            elif db_errors:
                # Also a real detection: the injected SQL actually reached the
                # database and the driver rejected it. That is the vulnerability
                # firing, not a build problem.
                print(
                    f"         {db_errors} database error(s) — injected SQL reached the driver"
                )
            else:
                print("         no assertion or database error — detection unproven")
            print()
            if not caught:
                failures.append(
                    f"{label}: suite did not fail on an assertion against a vulnerable build"
                )
            shutil.rmtree(work, ignore_errors=True)

    print("=" * 72)
    if failures:
        print("CONTROL FAILED — these defenses are NOT actually verified:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("CONTROL PASSED — every mutation was detected by the suite.")
    print("The tests are sensitive to the vulnerability they claim to cover.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
