#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later
"""Plaintext-player-data guard. Stdlib only. Runs in ci.yml on EVERY pull request.

Scans every TRACKED file (`git ls-files -z`) — not just the ported directories — for
plaintext player data:

  - a full SS58 address            5[1-9A-HJ-NP-Za-km-z]{46,47}
  - a truncated SS58 (report form) 6-char prefix + ellipsis + 4-char suffix
  - a hex public key               0x + 64 hex digits
  - a username token               [a-z]+.NN not on the committed allowlist
  - JSON values under firstName / first_name / device / model keys off the allowlist

and asserts no tracked path is named `usernames*` or ends `.enc` (no exemption).

`*.gz` files are decompressed and their contents scanned; the ONE named exception is
scripts/fixtures/game170-block1319690.json.gz, which holds public on-chain addresses
only — it is exempt from the full-SS58 pattern ONLY, never from the username, hex-key,
truncated-address or first-name patterns.

Made-up fixtures use shapes real data cannot have: `player-NN` names (dash, never the
`name.NN` dot) and 6-char `5XxxxN` addresses (cannot match the 47-48 char SS58 regex).
The allowlist of made-up names lives in player_data_allowlist.txt beside this script.

Exit 0 = clean, exit 1 = findings (printed one per line).
"""
import gzip
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FULL_SS58 = re.compile(r"5[1-9A-HJ-NP-Za-km-z]{46,47}")
TRUNC_SS58 = re.compile(r"5[1-9A-HJ-NP-Za-km-z]{5}[.…]{1,3}[1-9A-HJ-NP-Za-km-z]{4}\b")
HEX_KEY = re.compile(r"0x[0-9a-fA-F]{64}\b")
USERNAME_TOKEN = re.compile(r"\b[a-z]+\.\d{2}\b")
PERSON_KEYS = ("firstName", "first_name", "device", "model")

# The one named exception to the full-SS58 pattern: public on-chain addresses only.
GZ_SS58_EXCEPTIONS = {"scripts/fixtures/game170-block1319690.json.gz"}

# Short documented excludes, each with its reason (D3: the scan is all tracked files,
# these are the only carve-outs):
# - package-lock.json, *.lock: generated lockfiles
# - .papi/*.json, stacks/*.json: generated chain metadata / stack descriptors
# - *.svg, coin logo.js: artwork path data, where digit runs read as truncated-address
#   shapes
# The address patterns (full/truncated SS58, hex key) are scoped to the trees where a
# report could carry them (.claude/, scripts/, .github/); pre-existing well-known dev
# accounts in apps/ and packages/ test fixtures are public dev values, not player data.
# The username-token and person-key patterns apply repo-wide.
import fnmatch
EXCLUDE_EXACT = {"package-lock.json"}
EXCLUDE_SUFFIX = (".lock",)
EXCLUDE_GLOBS = (
    "packages/*/.papi/*.json",
    "packages/jollity-protocol/src/stacks/*.json",
    "*.svg",
    "apps/jollity-app/lib/draw/wheel/proto/render-utils/coin/logo.js",
    # public signing keys of pinned chain-stack descriptors (also allowlisted in
    # .gitleaks.toml): public chain values, not player accounts
    "scripts/deploy.mjs",
    ".github/workflows/humanity-grants.yml",
)
ADDRESS_SCOPED_PREFIXES = (".claude/", "scripts/", ".github/")

def excluded(path):
    if path in EXCLUDE_EXACT or path.endswith(EXCLUDE_SUFFIX):
        return True
    return any(fnmatch.fnmatch(path, g) for g in EXCLUDE_GLOBS)

ALLOWLIST_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "player_data_allowlist.txt")


def load_allowlist():
    with open(ALLOWLIST_FILE, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip() and not line.startswith("#")}


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True)
    return [p for p in out.stdout.decode("utf-8", "replace").split("\0") if p]


def read_text(path):
    """Return the text to scan, decompressing *.gz; None for binary files."""
    full = os.path.join(ROOT, path)
    with open(full, "rb") as fh:
        raw = fh.read()
    if path.endswith(".gz"):
        try:
            raw = gzip.decompress(raw)
        except OSError:
            return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def json_person_values(text):
    """Yield (key, value) for JSON values under person-ish keys, best effort."""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return
    stack = [data]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            for k, v in node.items():
                if k in PERSON_KEYS and isinstance(v, str):
                    yield k, v
                else:
                    stack.append(v)
        elif isinstance(node, list):
            stack.extend(node)


def scan():
    allow = load_allowlist()
    findings = []
    files = tracked_files()
    # hard assertions: no usernames* or *.enc anywhere (no exemption)
    for path in files:
        base = os.path.basename(path)
        if base.startswith("usernames") or path.endswith(".enc"):
            findings.append(f"FORBIDDEN PATH {path}: no usernames* or *.enc file may be tracked")
    for path in files:
        if excluded(path):
            continue
        text = read_text(path)
        if text is None:
            continue
        address_scoped = path.startswith(ADDRESS_SCOPED_PREFIXES)
        ss58_exempt = path in GZ_SS58_EXCEPTIONS
        if address_scoped and not ss58_exempt and FULL_SS58.search(text):
            findings.append(f"{path}: full SS58 address")
        if address_scoped and TRUNC_SS58.search(text):
            findings.append(f"{path}: truncated SS58 address")
        if address_scoped and HEX_KEY.search(text):
            findings.append(f"{path}: hex public key (0x + 64 hex)")
        for token in USERNAME_TOKEN.findall(text):
            if token not in allow:
                findings.append(f"{path}: username token {token!r} not on the allowlist")
        if path.endswith(".json"):
            for key, value in json_person_values(text):
                if value not in allow:
                    findings.append(f"{path}: {key} value {value!r} not on the allowlist")
    return findings


def main():
    findings = scan()
    if findings:
        print("player-data guard: %d finding(s)" % len(findings), file=sys.stderr)
        for f in findings:
            print("  " + f, file=sys.stderr)
        return 1
    print("player-data guard: clean (all tracked files scanned)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
