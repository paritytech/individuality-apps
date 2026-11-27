# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for encrypted username-map storage."""
import os
import shutil
import subprocess
import tempfile
import unittest


REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
SCRIPT = os.path.join(REPO, "analytics", "store-crypt.sh")


class UsernameArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = os.path.join(self.temp.name, "repo")
        self.store = os.path.join(self.temp.name, "store")
        os.makedirs(os.path.join(self.repo, "analytics"))
        os.makedirs(self.store)
        shutil.copy(SCRIPT, os.path.join(self.repo, "analytics", "store-crypt.sh"))
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        self.env = {
            **os.environ,
            "DIM2_STORE_PASSWORD": "test-only-password",
            "DIM2_TELEMETRY_STORE": self.store,
        }

    def run_crypt(self, *args):
        return subprocess.run(
            [os.path.join(self.repo, "analytics", "store-crypt.sh"), *args],
            cwd=self.repo,
            env=self.env,
            capture_output=True,
            text=True,
            check=True,
        )

    def test_pack_and_unpack_username_map(self):
        source = os.path.join(self.store, "usernames.json")
        original = b'{"account":"private-name.01"}\n'
        with open(source, "wb") as handle:
            handle.write(original)

        self.run_crypt("pack-usernames")
        archive = os.path.join(self.repo, "analytics", "usernames.tar.gz.enc")
        self.assertTrue(os.path.isfile(archive))
        self.assertNotIn(b"private-name.01", open(archive, "rb").read())

        os.remove(source)
        self.run_crypt("unpack-usernames")
        self.assertEqual(open(source, "rb").read(), original)

    def pack_with_fake_tar(self, version_line):
        """Pack with a fake tar first on PATH that reports `version_line`, records its arguments, then runs the real tar."""
        real = shutil.which("tar")
        fakes = os.path.join(self.temp.name, "fakebin")
        log = os.path.join(self.temp.name, "tar-args.txt")
        os.makedirs(fakes)
        fake = os.path.join(fakes, "tar")
        with open(fake, "w", encoding="utf-8") as handle:
            handle.write(f'#!/bin/bash\n[[ $1 == --version ]] && {{ echo "{version_line}"; exit 0; }}\n'
                         f'echo "$@" >> "{log}"\nargs=()\nfor a in "$@"; do [[ $a == --no-mac-metadata ]] || args+=("$a"); done\n'
                         f'exec "{real}" "${{args[@]}}"\n')
        os.chmod(fake, 0o755)
        with open(os.path.join(self.store, "usernames.json"), "w", encoding="utf-8") as handle:
            handle.write("{}\n")
        self.env["PATH"] = fakes + os.pathsep + os.environ["PATH"]
        self.run_crypt("pack-usernames")
        with open(log, encoding="utf-8") as handle:
            return handle.read()

    def test_pack_passes_no_mac_metadata_only_to_bsdtar(self):
        self.assertNotIn("--no-mac-metadata", self.pack_with_fake_tar("tar (GNU tar) 1.35"))

    def test_pack_passes_no_mac_metadata_to_bsdtar(self):
        self.assertIn("--no-mac-metadata", self.pack_with_fake_tar("bsdtar 3.5.3 - libarchive 3.5.3"))

    def test_unpack_keeps_existing_master_without_force(self):
        source = os.path.join(self.store, "usernames.json")
        with open(source, "w", encoding="utf-8") as handle:
            handle.write("archive value\n")
        self.run_crypt("pack-usernames")
        with open(source, "w", encoding="utf-8") as handle:
            handle.write("local value\n")

        result = self.run_crypt("unpack-usernames")
        self.assertIn("kept", result.stdout)
        self.assertEqual(open(source, encoding="utf-8").read(), "local value\n")

        self.run_crypt("unpack-usernames", "--force")
        self.assertEqual(open(source, encoding="utf-8").read(), "archive value\n")

    def test_pack_keeps_existing_archive_without_force(self):
        source = os.path.join(self.store, "usernames.json")
        with open(source, "w", encoding="utf-8") as handle:
            handle.write("first\n")
        self.run_crypt("pack-usernames")
        archive = os.path.join(self.repo, "analytics", "usernames.tar.gz.enc")
        before = open(archive, "rb").read()
        with open(source, "w", encoding="utf-8") as handle:
            handle.write("second\n")

        result = self.run_crypt("pack-usernames")
        self.assertIn("kept", result.stdout)
        self.assertEqual(open(archive, "rb").read(), before)
        self.run_crypt("pack-usernames", "--force")
        self.assertNotEqual(open(archive, "rb").read(), before)


if __name__ == "__main__":
    unittest.main()
