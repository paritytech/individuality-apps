"""Offline DIM2 workflow contracts and its fixture-only validation entry point."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
BASE = ".claude/skills/dim2-sentry/"
REPORT = ROOT / BASE / "scripts"
WORKFLOW = ".github/workflows/dim2-report.yml"
CONTRACT = ".github/tests/test_dim2_report_ci.py"
REPORT_PATHS = {
    BASE + path for path in (
        "SKILL.md", "page/game-reports.html",
        "references/game-report.md", "references/example-report-g160.json",
        "scripts/local_report_preview.py", "scripts/report-lint.py",
        "scripts/test_report_lint.py", "scripts/test_game_report.py",
        "scripts/game-report.py", "scripts/game-links.py", "scripts/test_game_links.py",
        "scripts/agg.py", "scripts/test_agg.py", "scripts/codec-map.py",
        "scripts/test_codec_map.py", "scripts/chat-coverage.py",
        "scripts/test_chat_coverage.py", "scripts/seed-usernames.py",
        "scripts/fixtures/game-251-one-sided-log-gap.json",
        "scripts/fixtures/game-259-player-coverage.json",
        "scripts/fixtures/game-263-clock-lines.json",
        "scripts/fixtures/away-facts-g260-g263-g264.json",
        "scripts/fixtures/logs-g999.json", "scripts/fixtures/logs-task6-golden.json",
        "scripts/fixtures/page-lives-g259-g835.json",
    )
}
ISOLATED = REPORT_PATHS | {WORKFLOW, CONTRACT}
# Shared helpers every report path depends on: admitted so their tests run (R9).
HELPERS = {
    BASE + f"scripts/{name}" for name in (
        "sentry.py", "sentry_logs.py", "game-report-pull.py", "store.py",
        "store_paths.py", "store_write.py", "store_dump.py", "store_source.py",
        "store_golden.py", "store_views.sql", "test_sentry.py",
        "test_sentry_logs_reader.py", "test_store.py", "test_store_dump.py",
        "test_store_golden.py", "test_store_paths.py", "test_store_source.py",
        "test_store_write.py",
    )
} | {
    BASE + "requirements-store.txt",
    "scripts/game-chain-report.mts",
    "scripts/game-chain-report.test.mts",
    "scripts/fixtures/game170-block1319690.json.gz",
}
REPORT_TESTS = (
    "test_game_report.py", "test_game_links.py", "test_agg.py",
    "test_codec_map.py", "test_chat_coverage.py", "test_report_lint.py",
    "test_game_report_pull.py", "test_sentry_logs_reader.py", "test_store_paths.py",
)


def paths(text, event, key):
    """Read literal double-quoted paths in these workflows; refuse other syntax.

    A YAML anchor (`paths: &name`) on one event and its alias (`*name`) on the
    other read as the SAME literal list, which the contract below requires.
    """
    lines = text.splitlines()
    start = lines.index(f"  {event}:") + 1
    section = []
    for line in lines[start:]:
        if line and not line.startswith("   "):
            break
        section.append(line)
    anchor_line = f"    {key}:"
    idx = next(i for i, l in enumerate(section) if l.startswith(anchor_line))
    rest = section[idx].strip()[len(anchor_line):].strip()
    if rest.startswith("&"):
        result = []
        for line in section[idx + 1:]:
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line.startswith("      - "):
                break
            value = json.loads(line.removeprefix("      - "))
            if not isinstance(value, str):
                raise ValueError("workflow paths must be literal strings")
            result.append(value)
        return result
    if rest.startswith("*"):
        name = rest[1:]
        for i, l in enumerate(lines):
            if l.strip() == f"{key}: &{name}":
                sub = []
                for line in lines[i + 1:]:
                    if not line.strip() or line.lstrip().startswith("#"):
                        continue
                    if not line.startswith("      - "):
                        break
                    sub.append(json.loads(line.removeprefix("      - ")))
                return sub
        raise ValueError(f"unresolved alias *{name}")
    raise ValueError("workflow paths must be a literal list or an anchor/alias pair")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkflowContract(unittest.TestCase):
    def test_exact_report_paths_are_paired_with_focused_admission(self):
        focused = (ROOT / WORKFLOW).read_text()
        for event in ("pull_request", "push"):
            admitted = paths(focused, event, "paths")
            self.assertCountEqual(admitted, ISOLATED | HELPERS)
            self.assertTrue(all("*" not in path for path in admitted))

    def test_app_workflows_carry_no_paths_ignore_that_could_skip_helpers(self):
        # This repo's ci.yml and deploy.yml run on every PR/push: no paths-ignore at all.
        for workflow in ("ci.yml", "deploy.yml"):
            text = (ROOT / ".github/workflows" / workflow).read_text()
            self.assertNotIn("paths-ignore", text, workflow)
            self.assertNotIn("paths:", text, workflow)

    def test_shared_helpers_are_in_the_focused_workflow_so_their_tests_run(self):
        # R9: a change to a shared helper must run the Python tests, so the helpers are
        # admitted into dim2-report.yml's exact path list (ci.yml already runs on every PR).
        focused = (ROOT / WORKFLOW).read_text()
        for event in ("pull_request", "push"):
            admitted = paths(focused, event, "paths")
            for path in HELPERS:
                self.assertIn(path, admitted)

    def test_focus_is_read_only_network_isolated_and_self_validating(self):
        workflow = (ROOT / WORKFLOW).read_text()
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("sudo unshare --net -- python3 -B " + CONTRACT, workflow)
        self.assertIn("branches: [main]", workflow)
        for forbidden in ("secrets.", "write", "npm ", "npx ", "pip ", "curl ", "workflow_dispatch", "workflow_run", "deploy-pages", "upload-artifact", "game-report.py "):
            self.assertNotIn(forbidden, workflow)

    def test_compile_report_sources_without_running_collection(self):
        for path in sorted(REPORT_PATHS | HELPERS):
            if path.endswith(".py"):
                compile((ROOT / path).read_bytes(), path, "exec")

    def test_seed_usernames_merges_saved_names_and_latest_log_fixture(self):
        sys.path.insert(0, str(REPORT))
        report = load("ci_seed_report", REPORT / "game-report.py")
        seed = load("ci_seed", REPORT / "seed-usernames.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "names.json"
            original = {"retained": "Existing", "updated": "Old"}
            target.write_text(json.dumps(original))
            for game, name in ((1, "Earlier"), (2, "Latest")):
                folder = root / f"game-{game}"
                folder.mkdir()
                (folder / "phone.json").write_text(json.dumps({"meta": {"address": "updated", "username": name}}))
            (root / "game-2/new.json").write_text(json.dumps({"meta": {"address": "new", "username": "Added"}}))
            read_names = report.load_usernames
            with mock.patch.object(seed, "_load", return_value=report), \
                    mock.patch.object(report, "USERNAMES", str(target)), \
                    mock.patch.object(report, "load_usernames", side_effect=lambda: read_names(str(target))), \
                    mock.patch.object(sys, "argv", ["seed-usernames.py", "--logs-root", str(root)]), \
                    contextlib.redirect_stdout(io.StringIO()):
                seed.main()
            self.assertEqual(json.loads(target.read_text()), {"retained": "Existing", "updated": "Latest", "new": "Added"})
            self.assertEqual(target.read_text(), json.dumps({"new": "Added", "retained": "Existing", "updated": "Latest"}, indent=1, ensure_ascii=False) + "\n")


def check():
    # Defence in depth inside the workflow's OS network namespace. Fail even if
    # a collector catches the network exception and otherwise claims success.
    attempts = []

    def offline(*args, **kwargs):
        attempts.append(True)
        raise AssertionError("DIM2 CI cannot query the network")

    sys.dont_write_bytecode = True
    sys.path.insert(0, str(REPORT))
    with mock.patch.object(socket.socket, "connect", offline), \
            mock.patch.object(socket.socket, "connect_ex", offline), \
            mock.patch.object(socket, "getaddrinfo", offline):
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(WorkflowContract)
        for pattern in REPORT_TESTS:
            suite.addTests(unittest.TestLoader().discover(str(REPORT), pattern=pattern))
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    if result.skipped:
        print("Required report/consumer tests must not skip:", result.skipped, file=sys.stderr)
    if attempts:
        print("Forbidden network attempts:", len(attempts), file=sys.stderr)
    return not result.wasSuccessful() or bool(result.skipped) or bool(attempts)


if __name__ == "__main__":
    raise SystemExit(check())
