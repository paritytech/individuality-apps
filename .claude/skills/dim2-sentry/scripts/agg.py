# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Deterministic, stdlib-only aggregation shared by live and stored metric rows."""
import re
import statistics


_FIELD = re.compile(r"^(count|sum|min|max|p50)\(value\)$")


def _order_value(value):
    """Sentry's measured group ordering: values ascending, NULL last."""
    if value is None:
        return (1, 0, "")
    if isinstance(value, bool):
        return (0, 0, int(value))
    if isinstance(value, (int, float)):
        return (0, 1, float(value))
    return (0, 2, str(value))


def aggregate(rows, group_fields, agg_fields):
    """Group raw metric points and compute the frozen Sentry-shaped aggregates."""
    group_fields = list(group_fields)
    agg_fields = list(agg_fields)
    if any(_FIELD.fullmatch(field) is None for field in agg_fields):
        raise ValueError("unsupported local aggregate")
    groups = {}
    for row in rows:
        key = tuple(row.get(field) for field in group_fields)
        groups.setdefault(key, []).append(row.get("value"))
    if not group_fields and not groups:
        groups[()] = []

    out = []
    for key in sorted(groups, key=lambda values: tuple(_order_value(value) for value in values)):
        values = [float(value) for value in groups[key] if value is not None]
        result = dict(zip(group_fields, key))
        for field in agg_fields:
            function = _FIELD.fullmatch(field).group(1)
            if function == "count":
                value = float(len(values))
            elif function == "sum":
                value = float(sum(values))
            elif not values:
                value = None
            elif function == "min":
                value = float(min(values))
            elif function == "max":
                value = float(max(values))
            else:
                value = float(statistics.median(sorted(values)))
            result[field] = value
        out.append(result)
    return out
