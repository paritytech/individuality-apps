"""Tests for the one local aggregation implementation shared by live and store reads."""
import unittest

import agg


class Aggregate(unittest.TestCase):
    def test_p50_even_and_odd_counts(self):
        rows = [
            {"group": "even", "value": value} for value in (4.0, 1.0, 3.0, 2.0)
        ] + [{"group": "odd", "value": value} for value in (9.0, 3.0, 6.0)]
        self.assertEqual(agg.aggregate(rows, ["group"], ["p50(value)"]), [
            {"group": "even", "p50(value)": 2.5},
            {"group": "odd", "p50(value)": 6.0},
        ])

    def test_groups_and_order(self):
        rows = [
            {"round": 2.0, "peer": None, "value": 8.0},
            {"round": 1.0, "peer": "b", "value": 4.0},
            {"round": 1.0, "peer": "a", "value": 2.0},
            {"round": 1.0, "peer": "a", "value": 6.0},
        ]
        self.assertEqual(agg.aggregate(
            rows, ["round", "peer"], ["count(value)", "sum(value)"]), [
                {"round": 1.0, "peer": "a", "count(value)": 2.0, "sum(value)": 8.0},
                {"round": 1.0, "peer": "b", "count(value)": 1.0, "sum(value)": 4.0},
                {"round": 2.0, "peer": None, "count(value)": 1.0, "sum(value)": 8.0},
            ])

    def test_types_match_sentry_shapes(self):
        [row] = agg.aggregate(
            [{"value": 1}, {"value": 4.0}, {"value": None}], [],
            ["count(value)", "sum(value)", "min(value)", "max(value)", "p50(value)"],
        )
        self.assertEqual(row, {
            "count(value)": 2.0, "sum(value)": 5.0, "min(value)": 1.0,
            "max(value)": 4.0, "p50(value)": 2.5,
        })
        self.assertTrue(all(type(value) is float for value in row.values()))

    def test_empty_ungrouped_count_matches_sentry(self):
        self.assertEqual(agg.aggregate([], [], ["count(value)"]), [
            {"count(value)": 0.0},
        ])


if __name__ == "__main__":
    unittest.main()
