#!/usr/bin/env python3
"""Compare one late-complete stored game with live Sentry using frozen inputs."""
import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile

import store_paths


HERE = os.path.dirname(os.path.abspath(__file__))
REPORT = os.path.join(HERE, "game-report.py")
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
BYTE_EXACT = ("report.json", "links.json", "usernames.json")
ARTIFACTS = BYTE_EXACT + ("sentry-pull.json",)

# P9 landed in case B: both live and store paths use agg.aggregate. Case C is
# retained as an explicit dormant seam; it must never turn into general normalisation.
PERCENTILE_CASE = "B"
PERCENTILE_PATHS = ()


def _read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _json_paths(left, right, path="$"):
    if type(left) is not type(right):
        return [path]
    if isinstance(left, dict):
        out = []
        for key in sorted(set(left) | set(right)):
            child = "%s.%s" % (path, key)
            if key not in left or key not in right:
                out.append(child)
            else:
                out.extend(_json_paths(left[key], right[key], child))
        return out
    if isinstance(left, list):
        out = []
        for index in range(max(len(left), len(right))):
            child = "%s[%d]" % (path, index)
            if index >= len(left) or index >= len(right):
                out.append(child)
            else:
                out.extend(_json_paths(left[index], right[index], child))
        return out
    return [] if left == right else [path]


def compare_json_files(left, right):
    """G1's sole normalisation: parsed JSON object key order is insignificant."""
    if not os.path.exists(left) or not os.path.exists(right):
        return [] if os.path.exists(left) == os.path.exists(right) else ["$"]
    return _json_paths(_read_json(left), _read_json(right))


def _same_bytes(left, right):
    if not os.path.exists(left) or not os.path.exists(right):
        return os.path.exists(left) == os.path.exists(right)
    with open(left, "rb") as one, open(right, "rb") as two:
        return one.read() == two.read()


def compare_determinism(left, right):
    """G5: two store processes must leave byte-identical artifacts."""
    return sorted("%s:$" % name for name in ARTIFACTS
                  if not _same_bytes(os.path.join(left, name), os.path.join(right, name)))


def _exact_json_differences(name, left, right):
    left_path, right_path = os.path.join(left, name), os.path.join(right, name)
    if _same_bytes(left_path, right_path):
        return []
    paths = compare_json_files(left_path, right_path)
    # Byte identity is the contract even when parsed JSON differs only by layout/key order.
    return ["%s:%s" % (name, path) for path in paths] or ["%s:$ (bytes)" % name]


def _report_differences(stored, live):
    """Ignore only the stored report's top-level telemetry snapshot label."""
    left_path = os.path.join(stored, "report.json")
    right_path = os.path.join(live, "report.json")
    if not os.path.exists(left_path) or not os.path.exists(right_path):
        return _exact_json_differences("report.json", stored, live)
    left, right = _read_json(left_path), _read_json(right_path)
    if not isinstance(left, dict) or not isinstance(right, dict):
        return _exact_json_differences("report.json", stored, live)
    if "dataAsOf" not in left and "dataAsOf" not in right:
        return _exact_json_differences("report.json", stored, live)
    left, right = dict(left), dict(right)
    left.pop("dataAsOf", None)
    right.pop("dataAsOf", None)
    paths = _json_paths(left, right)
    if paths:
        return ["report.json:%s" % path for path in paths]
    left_bytes = json.dumps(left, indent=1, ensure_ascii=False).encode("utf-8")
    right_bytes = json.dumps(right, indent=1, ensure_ascii=False).encode("utf-8")
    return [] if left_bytes == right_bytes else ["report.json:$ (bytes)"]


def compare_legs(stored, live):
    """G1 plus frozen usernames. P9 case B permits no value tolerance."""
    different = _report_differences(stored, live)
    for name in ("links.json", "usernames.json"):
        different.extend(_exact_json_differences(name, stored, live))
    pull_paths = compare_json_files(os.path.join(stored, "sentry-pull.json"),
                                    os.path.join(live, "sentry-pull.json"))
    different.extend("sentry-pull.json:%s" % path for path in pull_paths)
    return sorted(different)


def _write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


def _tail(path, count=20):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return "".join(fh.readlines()[-count:]).rstrip()
    except OSError:
        return ""


def _leg_command(game, game_dir, leg_dir, usernames, sibling_usernames,
                 projects, store_root=None):
    os.makedirs(leg_dir, exist_ok=True)
    _write_json(os.path.join(leg_dir, "usernames.json"), usernames)
    _write_json(os.path.join(leg_dir, "sibling-usernames.json"), sibling_usernames)
    cmd = [
        sys.executable, REPORT, str(game),
        "--out", os.path.join(leg_dir, "report.json"),
        "--logs-dir", os.path.join(leg_dir, "game-%d" % game),
        "--usernames", os.path.join(leg_dir, "usernames.json"),
        "--sibling-usernames", os.path.join(leg_dir, "sibling-usernames.json"),
        "--chain-json", os.path.join(game_dir, "chain.json"),
        "--no-log-cache",
    ]
    if store_root is not None:
        cmd.extend(["--from-store", "--store-root", store_root])
    else:
        cmd.extend(["--project", ",".join(projects)])
    return cmd


def run_leg(label, command, directory, seed=None):
    env = os.environ.copy()
    if seed is not None:
        env["PYTHONHASHSEED"] = str(seed)
    stdout = os.path.join(directory, "stdout.txt")
    stderr = os.path.join(directory, "stderr.txt")
    with open(stdout, "w", encoding="utf-8") as out, open(stderr, "w", encoding="utf-8") as err:
        result = subprocess.run(command, cwd=REPO, env=env, stdout=out, stderr=err, text=True)
    if result.returncode:
        print("FAIL %s (exit %d)" % (label, result.returncode))
        tail = _tail(stderr)
        if tail:
            print(tail)
        return False
    return True


def _fail(step, differences, evidence):
    print("FAIL %s" % step)
    for item in differences[:20]:
        print(item)
    if len(differences) > 20:
        print("... %d more" % (len(differences) - 20))
    print("evidence: %s" % evidence)
    return 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game", type=int)
    parser.add_argument("--store-root", help="telemetry store root")
    parser.add_argument("--evidence-dir", help="durable output directory (default: a preserved temp directory)")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.store_root or store_paths.store_root())
    game_dir = store_paths.game_dir(args.game, root=root)
    manifest_path = os.path.join(game_dir, "manifest.json")
    try:
        manifest = _read_json(manifest_path)
    except (OSError, ValueError) as error:
        print("FAIL manifest: %s" % error)
        return 1
    if manifest.get("pass") is not True:
        print("FAIL manifest did not pass: %s" % manifest_path)
        return 1
    if manifest.get("late_complete") is not True:
        print("FAIL late_complete is not true: %s" % manifest_path)
        return 1
    try:
        inputs = _read_json(os.path.join(game_dir, "inputs.json"))
        usernames = dict(inputs["usernames"])
        sibling_usernames = dict(inputs["siblingUsernames"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("FAIL frozen inputs: %s" % error)
        return 1
    projects = list((manifest.get("projects") or {}).keys())
    if not projects:
        print("FAIL manifest has no projects")
        return 1

    evidence = os.path.abspath(args.evidence_dir or tempfile.mkdtemp(
        prefix="store-golden-g%d-" % args.game))
    if os.path.exists(evidence) and os.listdir(evidence):
        print("FAIL evidence directory is not empty: %s" % evidence)
        return 1
    os.makedirs(evidence, exist_ok=True)
    print("evidence: %s" % evidence, flush=True)
    store_one = os.path.join(evidence, "store-seed-1")
    store_two = os.path.join(evidence, "store-seed-2")
    live = os.path.join(evidence, "live")

    command = _leg_command(args.game, game_dir, store_one, usernames, sibling_usernames,
                           projects, store_root=root)
    if not run_leg("store seed 1", command, store_one, seed=1):
        print("evidence: %s" % evidence)
        return 1
    command = _leg_command(args.game, game_dir, store_two, usernames, sibling_usernames,
                           projects, store_root=root)
    if not run_leg("store seed 2", command, store_two, seed=2):
        print("evidence: %s" % evidence)
        return 1
    differences = compare_determinism(store_one, store_two)
    if differences:
        return _fail("G5 determinism", differences, evidence)

    command = _leg_command(args.game, game_dir, live, usernames, sibling_usernames, projects)
    if not run_leg("live", command, live):
        print("evidence: %s" % evidence)
        return 1
    differences = compare_legs(store_one, live)
    if differences:
        return _fail("G1 live against store", differences, evidence)

    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, check=True,
                          capture_output=True, text=True).stdout.strip()
    now = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    print("PASS game %d; data as of %s; checked %s; head %s" % (
        args.game, manifest.get("data_as_of_local"), now, head))
    print("evidence: %s" % evidence)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
