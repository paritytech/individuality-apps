#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Arrow tables and atomic game folders for the local DIM2 telemetry store.

Needs the skill venv (pyarrow, duckdb). This module makes NO network call: it
turns rows the dump already fetched into Parquet, and it swaps a finished tmp
folder into place. Rules A1-A3 of the store spec live here.

Typing follows section D6: **Sentry's attributeType decides, and values never
do**, except for Sentry's built-in nanosecond timestamps, whose documented
integer precision must be preserved. A "number" column is float64 in every game (Sentry sends 425.0 for one
count and 777 for another, and a p50 of 777.9 must stay 777.9), so union_by_name
never meets a column that is a string in one game and a double in another.
Numbers inside string attributes are parsed at query time, never here.

Folder names come from store_paths (TMP_PREFIX / OLD_PREFIX and the dir
helpers); this module never re-spells them.
"""
import datetime
import decimal
import json
import os
import shutil
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq

import store_paths

RESERVED = {"_game", "_network", "_project", "_part", "filename"}
EXTRA_TYPES = {
    "project.name": "string",
    "sentry.observed_timestamp_nanos": "int",
    "timestamp_precise": "int",
}

BERLIN = ZoneInfo("Europe/Berlin")

_ARROW_TYPES = {
    "string": pa.string(),
    "number": pa.float64(),
    "boolean": pa.bool_(),
    "int": pa.int64(),
    "binary": pa.binary(),
}


class DumpRefused(RuntimeError):
    """A dump that must not replace an existing folder (A2, or the A3 shrink guard)."""


def column_name(key):
    """The column for a response key: verbatim, or attr.<key> when it is reserved."""
    return "attr." + key if key in RESERVED else key


def _bad_value(key, value, kind):
    """The one refusal for a value the column's declared type cannot hold: discovery was wrong."""
    return ValueError("%r given for %s column %r: field discovery was wrong" % (value, kind, key))


def _coerce(key, value, kind):
    """One cell to the shape its column's declared type needs. Discovery, not values, sets kind."""
    if value is None:
        return None
    if kind == "number":
        if isinstance(value, (list, dict, bool)) or isinstance(value, str):
            raise _bad_value(key, value, kind)
        return value
    if kind == "boolean":
        if not isinstance(value, bool):
            raise _bad_value(key, value, kind)
        return value
    if kind == "int":
        if isinstance(value, bool):
            raise _bad_value(key, value, kind)
        if isinstance(value, int):
            return value
        if isinstance(value, (str, float)):
            try:
                # Decimal preserves exactly the digits Sentry returned. A JSON float in
                # scientific notation may already have lost lower nanosecond digits upstream.
                exact = decimal.Decimal(str(value))
                if exact == exact.to_integral_value():
                    return int(exact)
            except decimal.InvalidOperation:
                pass
        raise _bad_value(key, value, kind)
    if kind == "string":
        if isinstance(value, (list, dict)):
            return json.dumps(value, sort_keys=True)
        if isinstance(value, (str, bytes)):
            return value
        return json.dumps(value)
    return value


def _build_table(names, kinds, values):
    arrays = [pa.array(values[name], type=_ARROW_TYPES[kind]) for name, kind in zip(names, kinds)]
    return pa.Table.from_arrays(arrays, names=names)


def rows_to_table(rows, columns, extra_cols):
    """Rows into a Table, and the columns that hold json.dumps'd list/dict values.

    columns is the requested (response key, attributeType) list, in order.
    Unrequested keys are appended in sorted order, typed by extra_cols, then
    EXTRA_TYPES, then "string".
    """
    requested = [key for key, _ in columns]
    unrequested = sorted({key for row in rows for key in row} - set(requested))

    names = [column_name(key) for key in requested] + [column_name(key) for key in unrequested]
    kinds = [EXTRA_TYPES.get(key, kind) for key, kind in columns] + [
        extra_cols.get(key) or EXTRA_TYPES.get(key, "string") for key in unrequested]

    values = {}
    json_columns = []
    for key, name, kind in zip(requested + unrequested, names, kinds):
        # one pass: coerce the column and note a json column as we go
        is_json = False
        column = []
        for row in rows:
            value = row.get(key)
            is_json = is_json or isinstance(value, (list, dict))
            column.append(_coerce(key, value, kind))
        if is_json:
            json_columns.append(name)
        values[name] = column
    return _build_table(names, kinds, values), json_columns


def empty_table(columns):
    """A Table with the columns' schema and no rows, so Parquet can hold a zero-row dataset."""
    names = [column_name(key) for key, _ in columns]
    kinds = [EXTRA_TYPES.get(key, kind) for key, kind in columns]
    return _build_table(names, kinds, {name: [] for name in names})


def write_parquet(table, path):
    """Write one Parquet file, zstd-compressed."""
    pq.write_table(table, path, compression="zstd")


def blob_table(rows, schema):
    """A Table for events_json and attachments: types "string", "int" (int64) and "binary"."""
    names = [name for name, _ in schema]
    kinds = [kind for _, kind in schema]
    values = {name: [row.get(name) for row in rows] for name in names}
    return _build_table(names, kinds, values)


def local_label(dt_utc):
    """A UTC datetime as a local label, e.g. "23 Oct 2026, 12:12 CEST". tzname(), never "CEST"."""
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=datetime.timezone.utc)
    local = dt_utc.astimezone(BERLIN)
    return "%d %s %s" % (local.day, local.strftime("%b %Y, %H:%M"), local.tzname())


def _rows_stored(entry):
    """A dataset's rows_stored, or 0 when it is absent or null (a dataset with no rows)."""
    return (entry or {}).get("rows_stored") or 0


def _shrink_failures(old_manifest, new_manifest):
    """Every dataset that holds fewer rows_stored than the old manifest.

    The raw datasets are compared per project and part; a dataset without a
    per_project map (events_json, attachments, the context tables) is compared
    on its own rows_stored.
    """
    bad = []
    old_datasets = (old_manifest or {}).get("datasets") or {}
    new_datasets = (new_manifest or {}).get("datasets") or {}
    for dataset, old_ds in old_datasets.items():
        new_ds = new_datasets.get(dataset) or {}
        old_pp = old_ds.get("per_project") if isinstance(old_ds, dict) else None
        if not old_pp:
            before, after = _rows_stored(old_ds), _rows_stored(new_ds)
            if after < before:
                bad.append((dataset, "", "", before, after))
            continue
        new_pp = new_ds.get("per_project") or {}
        for pid, old_parts in old_pp.items():
            for part, old_part in old_parts.items():
                before = _rows_stored(old_part)
                after = _rows_stored((new_pp.get(pid) or {}).get(part))
                if after < before:
                    bad.append((dataset, pid, part, before, after))
    return bad


def _read_only(tmp):
    """chmod every file to 0o444; folders stay writable so the rename can proceed."""
    for dirpath, _dirnames, filenames in os.walk(tmp):
        for filename in filenames:
            os.chmod(os.path.join(dirpath, filename), 0o444)


def commit_game_dir(tmp, final, refresh, old_manifest, new_manifest, game, network, root,
                    allow_shrink=False):
    """A1-A3: freeze the tmp folder's files, then swap it into place. Raises DumpRefused.

    game, network and root name the store folder and are the caller's (it has
    them); store_paths stays the only owner of the naming.
    """
    if os.path.exists(final) and not refresh:
        raise DumpRefused("%s exists; use --refresh" % os.path.basename(final))

    if refresh and not allow_shrink:
        bad = _shrink_failures(old_manifest, new_manifest)
        if bad:
            raise DumpRefused("refusing to shrink: " + ", ".join(
                "%s/%s/%s %d -> %d" % row for row in bad))

    _read_only(tmp)

    if not os.path.exists(final):
        os.rename(tmp, final)
        return

    # --refresh: move the old folder aside (same filesystem, so os.rename), swap, then drop it.
    old = store_paths.old_dir(game, network, root)
    os.rename(final, old)
    os.rename(tmp, final)
    try:
        shutil.rmtree(old)
    except OSError as exc:
        # the new g<N> is already in place; a leftover .old is recover()'s job, not a dump failure
        print("warning: could not remove %s (%s); recover() will clean it up" % (old, exc))


write_json = store_paths.write_json
