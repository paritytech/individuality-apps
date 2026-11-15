# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Nested fragments for the journey diagrams, on top of sequence.py.

Every journey-*.py diagram in this folder imports it.
"""

import sequence
from sequence import Diagram

# the lifeline colour the other journey diagrams already use
sequence.ACCENT = "oklch(62.7% .265 303.9)"


class Nested(sequence._Fragment):
    """A fragment that sits inside its parent, inset so the nesting is visible."""

    def __enter__(self):
        d = self.d
        self.inset = 20 + 14 * d.depth
        d.depth += 1
        self.top = d.y
        d.out.append("@@FRAME@@")
        self.slot = len(d.out) - 1
        x = self.inset
        d.out.append(
            f'  <path d="M {x} {self.top} H {x + 44} L {x + 52} {self.top + 8}'
            f' V {self.top + 20} H {x} Z" fill="#ffffff" stroke="{sequence.GREY}" stroke-width="1.2"/>'
        )
        d._label(x + 6, self.top + 15, self.kind, mono=False, size=11, anchor="start",
                 colour="#3a3a3a", bold=True)
        d._label(x + 66, self.top + 15, self.title or self.guard, mono=False, size=11,
                 anchor="start", bold=True)
        d.y += d.step
        return self

    def divider(self, guard):
        d = self.d
        x = self.inset
        d.out.append(
            f'  <line x1="{x}" y1="{d.y}" x2="{d.width - x}" y2="{d.y}" stroke="{sequence.GREY}"'
            f' stroke-width="1" stroke-dasharray="6,4"/>'
        )
        d._label(x + 12, d.y + 15, guard, mono=False, size=11, anchor="start", bold=True)
        d.y += d.step

    def __exit__(self, *exc):
        d = self.d
        x = self.inset
        d.out[self.slot] = (
            f'  <rect x="{x}" y="{self.top}" width="{d.width - 2 * x}" height="{d.y - self.top}"'
            f' fill="none" stroke="{sequence.GREY}" stroke-width="1.2"/>'
        )
        d.y += d.step
        d.depth -= 1
        return False


class Journey(Diagram):
    """A Diagram whose fragments nest, inset by depth."""

    depth = 0

    def frag(self, kind, guard, title=None):
        return Nested(self, kind, guard, title)
