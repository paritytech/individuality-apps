#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Read the local DIM2 telemetry store through rebuildable in-memory DuckDB views."""
import argparse
import glob
import json
import os
import re

import duckdb

import store_paths


DATASETS = (
    "spans", "errors", "transactions", "tracemetrics", "logs",
    "events_json", "attachments", "context_usernames", "context_releases",
)

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "store_views.sql")
VIEW_MARKER = re.compile(r"(?m)^-- view ([a-z_]+)\n")
JSON_VIEWS = {"chain": "chain.json", "manifests": "manifest.json"}


def _root(root):
    return os.path.abspath(root) if root else store_paths.store_root()


def _view_files(name, root):
    if name in DATASETS:
        filename = name + ".parquet"
    elif name in JSON_VIEWS:
        filename = JSON_VIEWS[name]
    elif name == "accounts":
        filename = JSON_VIEWS["chain"]
    else:
        raise ValueError("unknown view %r" % name)
    return glob.glob(os.path.join(root, "*", "g*", filename))


def views_sql(root=None):
    """Render the SQL template, commenting out views whose exact glob is empty."""
    resolved = _root(root)
    with open(TEMPLATE, encoding="utf-8") as fh:
        template = fh.read()

    matches = list(VIEW_MARKER.finditer(template))
    pieces = [template[:matches[0].start()]] if matches else [template]
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(template)
        name = match.group(1)
        block = template[match.start():end]
        pieces.append(block if _view_files(name, resolved) else "-- no files for %s\n\n" % name)
    # SQL string literals quote an apostrophe by doubling it.
    return "".join(pieces).replace("{root}", resolved.replace("'", "''"))


def write_views(root=None):
    """Rebuild <root>/views.sql as SQL text, never as a persistent DuckDB database."""
    resolved = _root(root)
    os.makedirs(resolved, exist_ok=True)
    path = os.path.join(resolved, "views.sql")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(views_sql(resolved))
    return path


def connect(root=None):
    """Return an in-memory DuckDB connection with every available view loaded."""
    con = duckdb.connect(":memory:")
    try:
        con.execute(views_sql(root))
    except BaseException:
        con.close()
        raise
    return con


def manifest(game, network="paseo", root=None):
    """Read one stored game's manifest."""
    path = os.path.join(store_paths.game_dir(game, network, _root(root)), "manifest.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def games(root=None):
    """The stored games and their capture/completeness labels, in path order."""
    resolved = _root(root)
    result = []
    pattern = os.path.join(resolved, "*", "g*", "manifest.json")
    for path in glob.glob(pattern):
        folder = os.path.basename(os.path.dirname(path))
        match = re.fullmatch(r"g([0-9]+)", folder)
        if not match:
            continue
        network = os.path.basename(os.path.dirname(os.path.dirname(path)))
        with open(path, encoding="utf-8") as fh:
            item = json.load(fh)
        result.append({
            "network": network,
            "game": int(match.group(1)),
            "pulled_at_local": item.get("pulled_at_local"),
            "data_as_of_local": item.get("data_as_of_local"),
            "late_complete": item.get("late_complete"),
            "pass": item.get("pass"),
        })
    return sorted(result, key=lambda item: (item["network"], item["game"]))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("views")
    subparsers.add_parser("games")
    query = subparsers.add_parser("query")
    query.add_argument("sql")
    args = parser.parse_args(argv)

    if args.command == "views":
        print(write_views())
    elif args.command == "games":
        for item in games():
            print(json.dumps(item, sort_keys=True))
    else:
        con = connect()
        try:
            con.sql(args.sql).show(max_width=200)
        finally:
            con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
