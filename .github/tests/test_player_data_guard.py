#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit tests for the player-data guard: plant a real-looking token in a temp tracked
file and assert exit 1 for each pattern; a clean tree exits 0."""
import gzip
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("player_data_guard", os.path.join(HERE, "player_data_guard.py"))
guard = importlib.util.module_from_spec(spec)
sys.modules["player_data_guard"] = guard
spec.loader.exec_module(guard)

# a real-SHAPED SS58 address (well-known dev shape, 48 chars) — the guard matches the
# shape, not any particular account
REAL_SS58 = "5" + "H" * 46 + "GJ"  # 48 chars, valid charset
assert guard.FULL_SS58.search(REAL_SS58), "test fixture must match the full-SS58 pattern"
REAL_HEX = "0x" + "ab" * 32


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        # the guard resolves ROOT from its own location; point it at the temp repo
        self.patcher = mock.patch.object(guard, "ROOT", self.root)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def track(self, name, content, binary=False):
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if binary else "w"
        with open(path, mode) as fh:
            fh.write(content)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        return name

    def findings(self):
        return guard.scan()

    def test_clean_tree_exits_clean(self):
        self.track("README.md", "hello\n")
        self.assertEqual(self.findings(), [])

    def test_full_ss58_fails(self):
        self.track("scripts/leak.py", f'x = "{REAL_SS58}"\n')
        self.assertTrue(any("full SS58" in f for f in self.findings()))

    def test_truncated_ss58_fails(self):
        trunc = REAL_SS58[:6] + "…" + REAL_SS58[-4:]
        self.track("scripts/leak.py", f'x = "{trunc}"\n')
        self.assertTrue(any("truncated SS58" in f for f in self.findings()))

    def test_hex_public_key_fails(self):
        self.track("scripts/leak.py", f'x = "{REAL_HEX}"\n')
        self.assertTrue(any("hex public key" in f for f in self.findings()))

    def test_name_nn_username_fails(self):
        planted = "".join(("somere", "al", ".", "07"))  # assembled so this file stays clean
        self.track("scripts/leak.py", 'names = {"5Addr": "%s"}\n' % planted)
        self.assertTrue(any(planted in f for f in self.findings()))

    def test_allowlisted_made_up_name_passes(self):
        self.track("scripts/leak.py", 'names = {"5Addr": "player-a"}\n')
        self.assertEqual(self.findings(), [])

    def test_json_person_key_off_allowlist_fails(self):
        self.track("fixtures/x.json", json.dumps({"firstName": "Realperson", "device": "secret-device"}))
        f = self.findings()
        self.assertTrue(any("firstName" in x for x in f))
        self.assertTrue(any("device" in x for x in f))

    def test_json_person_key_on_allowlist_passes(self):
        self.track("fixtures/x.json", json.dumps({"device": "fake-device-01"}))
        self.assertEqual(self.findings(), [])

    def test_usernames_file_is_forbidden(self):
        self.track("data/usernames.json", "{}")
        self.assertTrue(any("FORBIDDEN PATH" in f for f in self.findings()))

    def test_enc_file_is_forbidden(self):
        self.track("blob.tar.gz.enc", b"Salted__" + b"\0" * 16, binary=True)
        self.assertTrue(any("FORBIDDEN PATH" in f for f in self.findings()))

    def test_gz_is_scanned_and_ss58_exception_applies(self):
        # the game170 fixture holds full SS58 (public on-chain) and must pass the
        # full-SS58 pattern, but a planted username inside a .gz must still fail
        good = gzip.compress(json.dumps({"block": REAL_SS58}).encode())
        self.track("scripts/fixtures/game170-block1319690.json.gz", good, binary=True)
        self.assertEqual(self.findings(), [])
        planted = "".join(("realus", "er", ".", "09"))  # assembled so this file stays clean
        bad = gzip.compress(json.dumps({"block": REAL_SS58, "name": planted}).encode())
        self.track("scripts/fixtures/other.json.gz", bad, binary=True)
        self.assertTrue(any(planted in f for f in self.findings()))

    def test_address_patterns_scoped_outside_port_trees(self):
        # a well-known dev account in an app test fixture is not player data
        self.track("apps/x.test.ts", f'const A = "{REAL_SS58}"\n')
        self.assertEqual(self.findings(), [])
        # ...but the same address under scripts/ fails
        self.track("scripts/x.mts", f'const A = "{REAL_SS58}"\n')
        self.assertTrue(any("full SS58" in f for f in self.findings()))


if __name__ == "__main__":
    unittest.main()
