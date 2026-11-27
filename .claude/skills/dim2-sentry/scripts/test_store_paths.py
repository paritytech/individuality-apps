# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for store_paths.py: where the local telemetry store lives. Stdlib only."""
import fnmatch
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import store_paths  # noqa: E402


class ArchiveCompleteness(unittest.TestCase):
    def test_pack_refuses_report_ready_store_until_raw_completion(self):
        with tempfile.TemporaryDirectory() as root:
            game = os.path.join(root, "paseo", "g999")
            os.makedirs(game)
            with open(os.path.join(game, "manifest.json"), "w", encoding="utf-8") as fh:
                json.dump({"report_ready": True, "raw_complete": False}, fh)
            repo = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
            result = subprocess.run(
                [os.path.join(repo, "analytics", "store-crypt.sh"), "pack", "999"],
                cwd=repo,
                env={**os.environ, "DIM2_TELEMETRY_STORE": root,
                     "DIM2_STORE_PASSWORD": "not-used-before-refusal"},
                text=True, capture_output=True, check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("raw details incomplete", result.stderr)
        self.assertIn("--complete-raw", result.stderr)

    def test_pack_accepts_a_legacy_manifest_without_raw_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = os.path.join(directory, "repo")
            analytics = os.path.join(repo, "analytics")
            local = os.path.join(directory, "store")
            game = os.path.join(local, "paseo", "g998")
            os.makedirs(analytics)
            os.makedirs(game)
            source = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..",
                                                  "analytics", "store-crypt.sh"))
            script = os.path.join(analytics, "store-crypt.sh")
            shutil.copy(source, script)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            with open(os.path.join(game, "manifest.json"), "w", encoding="utf-8") as fh:
                json.dump({"pass": True, "report_ready": True}, fh)
            result = subprocess.run(
                [script, "pack", "998"], cwd=repo,
                env={**os.environ, "DIM2_TELEMETRY_STORE": local,
                     "DIM2_STORE_PASSWORD": "test-password"},
                text=True, capture_output=True, check=False,
            )
            archive = os.path.join(analytics, "telemetry-store", "paseo",
                                   "g998.tar.gz.enc")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(os.path.exists(archive))

    def test_pack_refuses_an_early_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            game = os.path.join(root, "paseo", "g999")
            os.makedirs(game)
            with open(os.path.join(game, "manifest.json"), "w", encoding="utf-8") as fh:
                json.dump({"report_ready": True, "raw_complete": True, "early": True}, fh)
            repo = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
            result = subprocess.run(
                [os.path.join(repo, "analytics", "store-crypt.sh"), "pack", "999"],
                cwd=repo,
                env={**os.environ, "DIM2_TELEMETRY_STORE": root,
                     "DIM2_STORE_PASSWORD": "not-used-before-refusal"},
                text=True, capture_output=True, check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("early snapshot", result.stderr)
        self.assertIn("--report --refresh", result.stderr)


class StoreRoot(unittest.TestCase):
    def test_env_var_wins(self):
        with mock.patch.dict(os.environ, {"DIM2_TELEMETRY_STORE": "/tmp/some-store"}):
            self.assertEqual(store_paths.store_root(), "/tmp/some-store")

    def test_env_var_goes_through_abspath(self):
        with mock.patch.dict(os.environ, {"DIM2_TELEMETRY_STORE": "/tmp/a/../b"}):
            self.assertEqual(store_paths.store_root(), "/tmp/b")

    def test_default_is_under_the_main_checkout(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DIM2_TELEMETRY_STORE", None)
            self.assertEqual(store_paths.store_root(),
                             os.path.join(store_paths.main_checkout(), "docs-internal", "telemetry-store"))

    def test_game_logs_root_is_always_under_the_main_checkout(self):
        with mock.patch.object(store_paths, "main_checkout", return_value="/main"):
            self.assertEqual(store_paths.game_logs_root(), "/main/docs-internal/game-logs")

    def test_usernames_path_follows_the_shared_store_root(self):
        with mock.patch.dict(os.environ, {"DIM2_TELEMETRY_STORE": "/tmp/shared-store"}):
            self.assertEqual(store_paths.usernames_path(), "/tmp/shared-store/usernames.json")


class MainCheckout(unittest.TestCase):
    """main_checkout() must return the MAIN checkout, from a worktree and from the checkout itself."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="store-paths-")
        self.main = os.path.join(self.tmp, "main")
        os.makedirs(self.main)
        self._git("init", "-q")
        self._git("config", "user.email", "t@example.com")
        self._git("config", "user.name", "T")
        # a throwaway repo must not inherit the machine's commit.gpgsign=true (no key here)
        self._git("config", "commit.gpgsign", "false")
        with open(os.path.join(self.main, "f.txt"), "w") as fh:
            fh.write("x\n")
        self._git("add", "f.txt")
        self._git("commit", "-q", "-m", "init")
        self.wt = os.path.join(self.tmp, "wt")
        self._git("worktree", "add", "-q", self.wt, "-b", "testbranch")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git(self, *args, cwd=None):
        subprocess.run(["git", *args], cwd=cwd or self.main, check=True,
                       capture_output=True, text=True)

    def _checkout_from(self, where):
        """A copy of store_paths.py at `where`, then its main_checkout() from a fresh process."""
        sub = os.path.join(where, ".claude", "skills", "dim2-sentry", "scripts")
        os.makedirs(sub, exist_ok=True)
        shutil.copy(os.path.join(HERE, "store_paths.py"), sub)
        out = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, sys.argv[1]); import store_paths; print(store_paths.main_checkout())",
             sub],
            capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return os.path.realpath(out.stdout.strip())

    def test_main_checkout_from_a_worktree_and_from_the_checkout(self):
        self.assertEqual(self._checkout_from(self.wt), os.path.realpath(self.main))
        self.assertEqual(self._checkout_from(self.main), os.path.realpath(self.main))


class StoreLayout(unittest.TestCase):
    def test_game_dir_ends_in_paseo_g254(self):
        d = store_paths.game_dir(254, root="/tmp/store")
        self.assertEqual(d, os.path.join("/tmp/store", "paseo", "g254"))

    def test_game_dir_defaults_to_the_paseo_network(self):
        self.assertEqual(store_paths.NETWORK, "paseo")
        self.assertTrue(store_paths.game_dir(1, root="/tmp/store").endswith(os.path.join("paseo", "g1")))

    def test_tmp_and_old_basenames_are_hidden_and_not_matched_by_the_g_glob(self):
        for path in (store_paths.tmp_dir(254, root="/tmp/store"), store_paths.old_dir(254, root="/tmp/store")):
            base = os.path.basename(path)
            self.assertTrue(base.startswith("."), base)
            self.assertFalse(fnmatch.fnmatch(base, "g*"), base)
            # and they live inside the network folder, not inside g<N>
            self.assertEqual(os.path.dirname(path), os.path.join("/tmp/store", "paseo"))

    def test_tmp_dir_is_built_from_the_shared_prefix(self):
        base = os.path.basename(store_paths.tmp_dir(7, root="/tmp/store"))
        self.assertTrue(base.startswith(store_paths.TMP_PREFIX), base)
        self.assertTrue(base.startswith(".tmp-g7-%d-" % os.getpid()), base)
        self.assertTrue(base.rsplit("-", 1)[-1].isdigit(), base)

    def test_old_dir_is_built_from_the_shared_prefix(self):
        base = os.path.basename(store_paths.old_dir(7, root="/tmp/store"))
        self.assertTrue(base.startswith(store_paths.OLD_PREFIX), base)
        self.assertTrue(base.startswith(".old-g7-"), base)
        self.assertTrue(base.rsplit("-", 1)[-1].isdigit(), base)


class Recover(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="store-recover-")
        self.base = os.path.join(self.root, "paseo")
        os.makedirs(self.base)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _mk(self, name, age=0):
        p = os.path.join(self.base, name)
        os.makedirs(p)
        if age:
            t = time.time() - age
            os.utime(p, (t, t))
        return p

    def test_old_folder_restored_when_the_final_folder_is_missing(self):
        old = self._mk(".old-g254-1000")
        actions = store_paths.recover(254, root=self.root)
        self.assertTrue(os.path.isdir(os.path.join(self.base, "g254")))
        self.assertFalse(os.path.exists(old))
        self.assertEqual(actions, ["restored .old-g254-1000 -> g254"])

    def test_newest_old_folder_wins_by_epoch_and_the_older_is_deleted(self):
        older = self._mk(".old-g254-999")
        newest = self._mk(".old-g254-1000")
        with open(os.path.join(newest, "marker"), "w") as fh:
            fh.write("newest\n")
        actions = store_paths.recover(254, root=self.root)
        self.assertTrue(os.path.exists(os.path.join(self.base, "g254", "marker")))
        self.assertFalse(os.path.exists(older))
        self.assertFalse(os.path.exists(newest))
        self.assertEqual(actions, ["restored .old-g254-1000 -> g254", "deleted old .old-g254-999 (g254 exists)"])

    def test_stale_tmp_is_deleted_by_its_name_epoch(self):
        tmp = self._mk(".tmp-g254-999-1000", age=7200)  # name epoch is 1000, far in the past
        fresh = self._mk(".tmp-g254-999-%d" % int(time.time()))
        actions = store_paths.recover(254, root=self.root)
        self.assertFalse(os.path.exists(tmp))
        self.assertTrue(os.path.exists(fresh))
        self.assertEqual(len(actions), 1)
        self.assertTrue(actions[0].startswith("deleted stale tmp .tmp-g254-999-1000"), actions)

    def test_stale_tmp_age_comes_from_the_name_not_the_mtime(self):
        # mtime is fresh, but the name epoch is old: it must still be deleted
        tmp = self._mk(".tmp-g254-999-1000", age=0)
        store_paths.recover(254, root=self.root)
        self.assertFalse(os.path.exists(tmp))

    def test_a_tmp_folder_that_vanishes_between_listing_and_removing_is_skipped(self):
        self._mk(".tmp-g254-999-1000")
        real_rmtree = shutil.rmtree
        calls = {"n": 0}

        def flaky(path, *a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                raise FileNotFoundError(path)  # simulate a concurrent removal
            return real_rmtree(path, *a, **k)

        with mock.patch.object(store_paths.shutil, "rmtree", flaky):
            actions = store_paths.recover(254, root=self.root)
        self.assertEqual(actions, [])  # skipped, not raised

    def test_old_folder_deleted_when_the_final_folder_exists(self):
        self._mk("g254")
        old = self._mk(".old-g254-1000")
        actions = store_paths.recover(254, root=self.root)
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.isdir(os.path.join(self.base, "g254")))
        self.assertEqual(actions, ["deleted old .old-g254-1000 (g254 exists)"])

    def test_another_games_prefix_is_untouched(self):
        # .old-g254-* must survive recover(25): "g25-" is not a prefix of "g254-"
        other = self._mk(".old-g254-1000")
        actions = store_paths.recover(25, root=self.root)
        self.assertTrue(os.path.exists(other))
        self.assertEqual(actions, [])


if __name__ == "__main__":
    unittest.main()
