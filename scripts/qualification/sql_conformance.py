"""Exercise installed migration 0005 against immutable legacy-writer fixtures.

This is supplemental SQLite evidence, not a substitute for workerd or live D1.
Historical planning artifacts are never rewritten to match new implementation.
"""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASELINE = "6e78bc548c97bbe5194e3f780c717e5519930c1a"
REVIEWS = Path("docs/superpowers/reviews")
CONTRACT = Path("docs/superpowers/plans/2026-09-13-plan-5-contracts.md")


def main():
    """Use actual installed SQL while retaining the exact old writer corpus."""
    with tempfile.TemporaryDirectory(prefix="gmail-recovery-sql-") as directory:
        fixture = Path(directory)
        names = subprocess.check_output(
            ["git", "ls-tree", "-r", "--name-only", BASELINE, "worker/src", "worker/migrations"],
            cwd=ROOT,
            text=True,
        ).splitlines()
        for name in names:
            target = fixture / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(
                subprocess.check_output(["git", "show", f"{BASELINE}:{name}"], cwd=ROOT)
            )
        (fixture / REVIEWS).mkdir(parents=True)
        for source in (ROOT / REVIEWS).glob("2026-09-13-plan-5-*"):
            if source.is_file():
                shutil.copyfile(source, fixture / REVIEWS / source.name)
        installed = (ROOT / "worker/migrations/0005_operation_recovery.sql").read_text()
        appendix = (ROOT / CONTRACT).read_text()
        appendix = re.sub(
            r"```sql\n.*?\n```",
            lambda _: "```sql\n" + installed.rstrip() + "\n```",
            appendix,
            count=1,
            flags=re.S,
        )
        (fixture / CONTRACT).parent.mkdir(parents=True)
        (fixture / CONTRACT).write_text(appendix)
        spec = spec_from_file_location(
            "legacy_recovery_contracts",
            ROOT / REVIEWS / "2026-09-13-plan-5-conformance.py",
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("legacy fixture unavailable")
        module = module_from_spec(spec)
        # Import historical fixtures without writing into the evidence directory.
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
        module.ROOT = fixture
        module.APPENDIX = fixture / CONTRACT
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(module.PlanConformance)
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
