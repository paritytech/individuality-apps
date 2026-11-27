"""Tests for store_write.py: Arrow tables and atomic game folders. Needs the skill venv."""
import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

try:
    import pyarrow, duckdb  # noqa: F401
except ImportError:
    raise unittest.SkipTest("store tests need the skill venv: .claude/skills/dim2-sentry/.venv/bin/python -m pytest")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import store_write  # noqa: E402
import store_paths  # noqa: E402

UTC = datetime.timezone.utc


class TypesFollowDiscovery(unittest.TestCase):
    def test_types_follow_discovery_not_values(self):
        # a "number" column is float64, so 425.0 stays 425.0 (it is not truncated to 425)
        table, json_columns = store_write.rows_to_table(
            [{"id": "a", "tags[n,number]": 425.0}],
            [("id", "string"), ("tags[n,number]", "number")],
            {})
        self.assertEqual(table.schema.field("tags[n,number]").type, pyarrow.float64())
        self.assertEqual(table.column("tags[n,number]").to_pylist(), [425.0])
        self.assertEqual(table.column("id").to_pylist(), ["a"])
        self.assertEqual(json_columns, [])

        # a number handed to a string column becomes json.dumps(v); the column stays a string
        table, _ = store_write.rows_to_table(
            [{"tags[foo]": 425.0, "tags[bar]": 777}],
            [("tags[foo]", "string"), ("tags[bar]", "string")],
            {})
        self.assertEqual(table.schema.field("tags[foo]").type, pyarrow.string())
        self.assertEqual(table.column("tags[foo]").to_pylist(), ["425.0"])
        self.assertEqual(table.column("tags[bar]").to_pylist(), ["777"])

        # any non-string scalar (a stray boolean too) becomes json.dumps(v), never an Arrow crash
        table, _ = store_write.rows_to_table(
            [{"tags[bool]": True, "tags[none]": None}],
            [("tags[bool]", "string"), ("tags[none]", "string")],
            {})
        self.assertEqual(table.column("tags[bool]").to_pylist(), ["true"])
        self.assertEqual(table.column("tags[none]").to_pylist(), [None])

        # a string handed to a number column means discovery was wrong: refuse
        with self.assertRaises(ValueError):
            store_write.rows_to_table(
                [{"tags[n,number]": "not-a-number"}],
                [("tags[n,number]", "number")],
                {})

    def test_number_columns_keep_their_fraction(self):
        # int64 would silently turn 0.5 into 0 and a p50 of 777.9 into 777
        columns = [("tags[n,number]", "number")]
        rows = [{"tags[n,number]": 0.5}, {"tags[n,number]": 777.9}, {"tags[n,number]": 1234.5}]
        table, _ = store_write.rows_to_table(rows, columns, {})
        self.assertEqual(table.column("tags[n,number]").to_pylist(), [0.5, 777.9, 1234.5])

        tmp = tempfile.mkdtemp(prefix="store-write-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "n.parquet")
        store_write.write_parquet(table, path)
        con = duckdb.connect()
        try:
            got = [row[0] for row in con.execute(
                "SELECT \"tags[n,number]\" FROM read_parquet(?) ORDER BY 1", [path]).fetchall()]
            described = dict((name, typ) for name, typ, *_ in con.execute(
                "DESCRIBE SELECT * FROM read_parquet(?)", [path]).fetchall())
        finally:
            con.close()
        self.assertEqual(got, [0.5, 777.9, 1234.5])
        self.assertEqual(described["tags[n,number]"], "DOUBLE")

    def test_unknown_keys_get_fixed_types(self):
        nanos = 1792512189696000000
        table, json_columns = store_write.rows_to_table(
            [{"id": "a", "project.name": "jollity-next", "timestamp_precise": nanos, "tags[weird]": "x"}],
            [("id", "string")],
            {})
        # requested first, then the unrequested keys in sorted order
        self.assertEqual(table.column_names, ["id", "project.name", "tags[weird]", "timestamp_precise"])
        self.assertEqual(table.schema.field("project.name").type, pyarrow.string())
        self.assertEqual(table.schema.field("tags[weird]").type, pyarrow.string())
        self.assertEqual(table.schema.field("timestamp_precise").type, pyarrow.int64())
        self.assertEqual(table.column("timestamp_precise").to_pylist(), [nanos])
        self.assertEqual(json_columns, [])

    def test_timestamp_precise_round_trips_nanoseconds_exactly(self):
        nanos = [1792512189696000000, 1792512189696000001]
        table, _ = store_write.rows_to_table(
            [{"id": "a", "timestamp_precise": nanos[0]},
             {"id": "b", "timestamp_precise": nanos[1]}],
            [("id", "string")],
            {})
        self.assertEqual(table.schema.field("timestamp_precise").type, pyarrow.int64())

        tmp = tempfile.mkdtemp(prefix="store-write-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "precise.parquet")
        store_write.write_parquet(table, path)
        con = duckdb.connect()
        try:
            got = [row[0] for row in con.execute(
                'SELECT timestamp_precise FROM read_parquet(?) ORDER BY timestamp_precise',
                [path]).fetchall()]
        finally:
            con.close()
        self.assertEqual(got, nanos)

    def test_timestamp_precise_overrides_discovered_number_type(self):
        nanos = 1792512189696000000
        table, _ = store_write.rows_to_table(
            [{"timestamp_precise": nanos}],
            [("timestamp_precise", "number")],
            {})
        empty = store_write.empty_table([("timestamp_precise", "number")])
        self.assertEqual(table.schema.field("timestamp_precise").type, pyarrow.int64())
        self.assertEqual(table.column("timestamp_precise").to_pylist(), [nanos])
        self.assertEqual(empty.schema.field("timestamp_precise").type, pyarrow.int64())

    def test_observed_timestamp_nanos_overrides_discovered_string_type(self):
        nanos = 1792512189696000000
        table, _ = store_write.rows_to_table(
            [{"sentry.observed_timestamp_nanos": str(nanos)}],
            [("sentry.observed_timestamp_nanos", "string")],
            {})
        empty = store_write.empty_table(
            [("sentry.observed_timestamp_nanos", "string")])
        self.assertEqual(
            table.schema.field("sentry.observed_timestamp_nanos").type,
            pyarrow.int64())
        self.assertEqual(
            table.column("sentry.observed_timestamp_nanos").to_pylist(),
            [nanos])
        self.assertEqual(
            empty.schema.field("sentry.observed_timestamp_nanos").type,
            pyarrow.int64())

    def test_int_columns_accept_decimal_strings_without_losing_precision(self):
        nanos = 1792010400800848123
        table, _ = store_write.rows_to_table(
            [{"sentry.observed_timestamp_nanos": str(nanos)}],
            [("sentry.observed_timestamp_nanos", "int")],
            {})
        self.assertEqual(table.schema.field("sentry.observed_timestamp_nanos").type, pyarrow.int64())
        self.assertEqual(table.column("sentry.observed_timestamp_nanos").to_pylist(), [nanos])
        scientific = 1.792512180495e18
        table, _ = store_write.rows_to_table(
            [{"timestamp_precise": scientific}],
            [("timestamp_precise", "number")],
            {})
        self.assertEqual(table.column("timestamp_precise").to_pylist(), [1792512180495000000])
        for bad in (True, 1.5, "1.5", "not-an-int"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                store_write.rows_to_table([{"n": bad}], [("n", "int")], {})

    def test_list_and_dict_become_json_strings_and_are_reported(self):
        table, json_columns = store_write.rows_to_table(
            [{"id": "a", "tags[list]": [3, 1, 2], "tags[dict]": {"b": 1, "a": 2}}],
            [("id", "string"), ("tags[list]", "string")],
            {})
        self.assertEqual(table.column("tags[list]").to_pylist(), ["[3, 1, 2]"])
        self.assertEqual(table.column("tags[dict]").to_pylist(), ['{"a": 2, "b": 1}'])
        self.assertEqual(table.schema.field("tags[list]").type, pyarrow.string())
        self.assertEqual(json_columns, ["tags[list]", "tags[dict]"])

    def test_reserved_names_are_renamed(self):
        for name in store_write.RESERVED:
            self.assertEqual(store_write.column_name(name), "attr." + name)
        self.assertEqual(store_write.column_name("game.index"), "game.index")
        self.assertEqual(store_write.column_name("attr._game"), "attr._game")

        table, _ = store_write.rows_to_table(
            [{"_part": "window", "_game": "254"}],
            [("_part", "string"), ("_game", "string")],
            {})
        self.assertEqual(table.column_names, ["attr._part", "attr._game"])
        self.assertEqual(table.column("attr._part").to_pylist(), ["window"])


class BadValuesRaiseValueError(unittest.TestCase):
    """A value the declared type cannot hold raises ValueError, never a raw Arrow error."""

    def test_number_column_rejects_bool_list_and_dict(self):
        for bad in (True, False, [1, 2], {"a": 1}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                store_write.rows_to_table(
                    [{"tags[n,number]": bad}], [("tags[n,number]", "number")], {})

    def test_boolean_column_accepts_only_real_bools(self):
        table, _ = store_write.rows_to_table(
            [{"is_transaction": True}, {"is_transaction": None}],
            [("is_transaction", "boolean")],
            {})
        self.assertEqual(table.schema.field("is_transaction").type, pyarrow.bool_())
        self.assertEqual(table.column("is_transaction").to_pylist(), [True, None])
        for bad in ("true", 1, 0, [True], {"a": True}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                store_write.rows_to_table(
                    [{"is_transaction": bad}], [("is_transaction", "boolean")], {})


class Tables(unittest.TestCase):
    def test_empty_table_has_schema_and_zero_rows(self):
        columns = [("id", "string"), ("span.duration", "number"), ("is_transaction", "boolean")]
        table = store_write.empty_table(columns)
        self.assertEqual(table.num_rows, 0)
        self.assertEqual(table.column_names, ["id", "span.duration", "is_transaction"])
        self.assertEqual(table.schema.field("id").type, pyarrow.string())
        self.assertEqual(table.schema.field("span.duration").type, pyarrow.float64())
        self.assertEqual(table.schema.field("is_transaction").type, pyarrow.bool_())

        # rows_to_table with no rows is the same shape
        empty_from_rows, json_columns = store_write.rows_to_table([], columns, {})
        self.assertEqual(empty_from_rows.schema, table.schema)
        self.assertEqual(json_columns, [])

        # and it survives a round trip through parquet + duckdb
        tmp = tempfile.mkdtemp(prefix="store-write-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "empty.parquet")
        store_write.write_parquet(table, path)
        con = duckdb.connect()
        try:
            rows = con.execute("SELECT * FROM read_parquet(?)", [path]).fetchall()
            self.assertEqual(rows, [])
            described = dict((name, typ) for name, typ, *_ in con.execute(
                "DESCRIBE SELECT * FROM read_parquet(?)", [path]).fetchall())
        finally:
            con.close()
        self.assertEqual(set(described), {"id", "span.duration", "is_transaction"})
        self.assertEqual(described["span.duration"], "DOUBLE")
        self.assertEqual(described["is_transaction"], "BOOLEAN")

    def test_blob_table_keeps_non_utf8_bytes(self):
        schema = [("event_id", "string"), ("size", "int"), ("body", "binary")]
        rows = [
            {"event_id": "e1", "size": 4, "body": b"\x00\xff\xfe\x01"},
            {"event_id": "e2", "size": 0, "body": None},
        ]
        table = store_write.blob_table(rows, schema)
        self.assertEqual(table.column_names, ["event_id", "size", "body"])
        self.assertEqual(table.schema.field("size").type, pyarrow.int64())
        self.assertEqual(table.schema.field("body").type, pyarrow.binary())
        self.assertEqual(table.column("body").to_pylist(), [b"\x00\xff\xfe\x01", None])
        self.assertEqual(table.column("size").to_pylist(), [4, 0])


class Commit(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="store-commit-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.base = os.path.join(self.root, "paseo")
        os.makedirs(self.base)
        self.final = os.path.join(self.base, "g254")

    def _mk_tmp(self, marker="new"):
        tmp = store_paths.tmp_dir(254, root=self.root)
        os.makedirs(tmp)
        with open(os.path.join(tmp, "marker"), "w") as fh:
            fh.write(marker + "\n")
        return tmp

    def _mk_final(self, marker="old"):
        os.makedirs(self.final, exist_ok=True)
        with open(os.path.join(self.final, "marker"), "w") as fh:
            fh.write(marker + "\n")
        return self.final

    def _read_marker(self, folder):
        with open(os.path.join(folder, "marker")) as fh:
            return fh.read().strip()

    def _old_folders(self):
        return [n for n in os.listdir(self.base) if n.startswith(store_paths.OLD_PREFIX)]

    def _commit(self, tmp, refresh, old_manifest, new_manifest, allow_shrink=False):
        return store_write.commit_game_dir(
            tmp, self.final, refresh, old_manifest, new_manifest, 254, "paseo", self.root,
            allow_shrink=allow_shrink)

    @staticmethod
    def _manifest(rows_stored):
        return {"datasets": {"spans": {"per_project": {
            "4512177451237456": {"window": {"rows_stored": rows_stored}}}}}}

    def test_commit_new_folder_and_read_only_files(self):
        tmp = self._mk_tmp("new")
        self._commit(tmp, False, None, self._manifest(10))
        self.assertFalse(os.path.exists(tmp))
        self.assertTrue(os.path.isdir(self.final))
        self.assertEqual(self._read_marker(self.final), "new")
        mode = os.stat(os.path.join(self.final, "marker")).st_mode & 0o777
        self.assertEqual(mode, 0o444)
        # the folder itself stays writable
        self.assertTrue(os.stat(self.final).st_mode & 0o200)

    def test_commit_refuses_existing_without_refresh(self):
        self._mk_final("old")
        tmp = self._mk_tmp("new")
        with self.assertRaises(store_write.DumpRefused):
            self._commit(tmp, False, self._manifest(10), self._manifest(10))
        # nothing moved
        self.assertEqual(self._read_marker(self.final), "old")
        self.assertTrue(os.path.isdir(tmp))
        self.assertEqual(self._old_folders(), [])

    def test_refresh_swaps_and_removes_old(self):
        self._mk_final("old")
        tmp = self._mk_tmp("new")
        self._commit(tmp, True, self._manifest(10), self._manifest(10))
        self.assertEqual(self._read_marker(self.final), "new")
        self.assertFalse(os.path.exists(tmp))
        self.assertEqual(self._old_folders(), [])
        self.assertEqual(os.stat(os.path.join(self.final, "marker")).st_mode & 0o777, 0o444)

    def test_refresh_shrink_guard_refuses_and_keeps_old(self):
        self._mk_final("old")
        tmp = self._mk_tmp("new")
        with self.assertRaises(store_write.DumpRefused):
            self._commit(tmp, True, self._manifest(10), self._manifest(9))
        # the old folder is untouched and the tmp folder is left for the caller to clean up
        self.assertEqual(self._read_marker(self.final), "old")
        self.assertTrue(os.path.isdir(tmp))
        self.assertEqual(self._old_folders(), [])

    def test_shrink_guard_is_per_dataset_project_and_part(self):
        old = {"datasets": {
            "spans": {"per_project": {"1": {"window": {"rows_stored": 10}, "late": {"rows_stored": 4}}}},
            "errors": {"per_project": {"1": {"window": {"rows_stored": 8}}}},
        }}
        # the same totals but the late part lost a row: still a shrink
        new = {"datasets": {
            "spans": {"per_project": {"1": {"window": {"rows_stored": 11}, "late": {"rows_stored": 3}}}},
            "errors": {"per_project": {"1": {"window": {"rows_stored": 8}}}},
        }}
        self._mk_final("old")
        tmp = self._mk_tmp("new")
        with self.assertRaises(store_write.DumpRefused):
            self._commit(tmp, True, old, new)
        self.assertEqual(self._read_marker(self.final), "old")
        # --allow-shrink overrides it
        self._commit(tmp, True, old, new, allow_shrink=True)
        self.assertEqual(self._read_marker(self.final), "new")

    def test_shrink_guard_covers_datasets_without_per_project(self):
        # events_json, attachments and the context tables carry a bare rows_stored
        old = {"datasets": {
            "spans": {"per_project": {"1": {"window": {"rows_stored": 10}}}},
            "events_json": {"rows": 2100, "rows_stored": 2100},
        }}
        new = {"datasets": {
            "spans": {"per_project": {"1": {"window": {"rows_stored": 10}}}},
            "events_json": {"rows": 2000, "rows_stored": 2000},
        }}
        self._mk_final("old")
        tmp = self._mk_tmp("new")
        with self.assertRaises(store_write.DumpRefused):
            self._commit(tmp, True, old, new)
        self.assertEqual(self._read_marker(self.final), "old")

    def test_shrink_guard_treats_a_null_dataset_as_zero_rows(self):
        # a null dataset in the NEW manifest is a dataset with no rows: refuse, never AttributeError
        old = {"datasets": {"spans": {"per_project": {"1": {"window": {"rows_stored": 10}}}}}}
        new = {"datasets": {"spans": None}}
        self._mk_final("old")
        tmp = self._mk_tmp("new")
        with self.assertRaises(store_write.DumpRefused):
            self._commit(tmp, True, old, new)
        self.assertEqual(self._read_marker(self.final), "old")
        # a null dataset on BOTH sides is not a shrink
        new2 = {"datasets": {"spans": None, "events_json": None}}
        self._commit(tmp, True, {"datasets": {"spans": None}}, new2)
        self.assertEqual(self._read_marker(self.final), "new")

    def test_a_failed_old_removal_does_not_fail_the_dump(self):
        # the new g<N> is already in place; a leftover .old is recover()'s job
        self._mk_final("old")
        tmp = self._mk_tmp("new")
        with mock.patch.object(store_write.shutil, "rmtree",
                               side_effect=OSError("busy")):
            with mock.patch("sys.stdout") as out:
                self._commit(tmp, True, self._manifest(10), self._manifest(10))
        self.assertEqual(self._read_marker(self.final), "new")
        self.assertTrue(out.write.called)  # the warning was printed
        self.assertEqual(len(self._old_folders()), 1)  # left behind for recover()


class LocalLabel(unittest.TestCase):
    def test_local_label_cest_and_cet(self):
        self.assertEqual(store_write.local_label(datetime.datetime(2026, 10, 23, 10, 12, tzinfo=UTC)),
                         "23 Oct 2026, 12:12 CEST")
        self.assertEqual(store_write.local_label(datetime.datetime(2026, 10, 27, 10, 12, tzinfo=UTC)),
                         "27 Oct 2026, 11:12 CET")

    def test_local_label_accepts_a_naive_utc_datetime(self):
        self.assertEqual(store_write.local_label(datetime.datetime(2026, 10, 23, 10, 12)),
                         "23 Oct 2026, 12:12 CEST")


class WriteJson(unittest.TestCase):
    def test_write_json_indent_and_ascii_and_trailing_newline(self):
        tmp = tempfile.mkdtemp(prefix="store-write-json-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "manifest.json")
        store_write.write_json(path, {"game": 254, "note": "café"})
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertTrue(text.endswith("\n"))
        self.assertIn("café", text)  # ensure_ascii=False
        self.assertEqual(json.loads(text), {"game": 254, "note": "café"})
        # indent=1: the second line starts with exactly one space
        self.assertEqual(text.splitlines()[1][:2], " \"")

    def test_write_json_is_store_paths_one(self):
        self.assertIs(store_write.write_json, store_paths.write_json)


if __name__ == "__main__":
    unittest.main()
