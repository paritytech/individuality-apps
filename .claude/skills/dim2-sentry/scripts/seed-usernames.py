#!/usr/bin/env python3
"""Fill the shared telemetry-store/usernames.json from archived game logs.

  python3 .claude/skills/dim2-sentry/scripts/seed-usernames.py [--logs-root docs-internal/game-logs]

Names already in the shared master stay unless a log has a name for the same account; the file only grows.
"""
import argparse
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--logs-root", help="archived game logs (default: shared main-checkout game-logs)")
    a = ap.parse_args()
    gr = _load("game_report", "game-report.py")
    logs_root = os.path.abspath(a.logs_root) if a.logs_root else gr.store_paths.game_logs_root()
    merged = {**gr.load_usernames(), **gr.gl.usernames_under(logs_root)}
    gr.save_usernames(gr.USERNAMES, merged)
    print(f"{len(merged)} usernames in {gr.USERNAMES}")


if __name__ == "__main__":
    main()
