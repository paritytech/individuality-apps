# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Layout engine for UML sequence diagrams as SVG.

Import it, describe the flow top to bottom, print the result. Every gap is one
STEP, so inserting a message never collides with what follows. That is the
whole reason this file exists instead of hand-written SVG.

    from sequence import Diagram

    d = Diagram([("user", "User"), ("app", "App", "app.example.com"), ("host", "Host API")])
    d.call("app", "host", "getAccount()")
    d.ret("host", "app", "account")
    with d.frag("opt", "[ !account ]"):
        d.sees("app", "user", ["Sign in to continue"], colour=d.WARN)
    print(d.svg())

Run `python3 sequence.py > example.svg` for a working sample.
"""

from html import escape

GREY = "#606060"
LINE = "#909090"
WARN = "#c08a00"
ACCENT = "oklch(62.3% .214 259.815)"
FILL_EXTERNAL = "#e0e0e0"
FILL_OURS = "#ffffff"


class Diagram:
    WARN = WARN
    GREY = GREY

    def __init__(self, participants, step=42, gap=300, margin=130, box=165):
        """participants: [(key, title)] or [(key, title, subtitle)] or
        [(key, title, subtitle, fill)]. Left to right, in drawing order."""
        self.step, self.gap, self.box = step, gap, box
        self.p = {}
        self.order = []
        for i, spec in enumerate(participants):
            key, title = spec[0], spec[1]
            sub = spec[2] if len(spec) > 2 else None
            fill = spec[3] if len(spec) > 3 else FILL_EXTERNAL
            self.p[key] = {"x": margin + i * gap, "title": title, "sub": sub, "fill": fill}
            self.order.append(key)
        self.width = margin + (len(participants) - 1) * gap + box // 2 + margin - 50
        self.out = []
        self.y = 130
        self.sources = []

    # ── message primitives ───────────────────────────────────────────────────

    def _x(self, key):
        return self.p[key]["x"]

    def _label(self, x, y, text, mono=True, colour=GREY, size=None, anchor="middle", bold=False):
        font = ' font-family="monospace" font-size="11"' if mono else ""
        if size:
            font = f' font-size="{size}"'
        if bold:
            font += ' font-weight="bold"'
        self.out.append(
            f'  <text x="{x}" y="{y}" text-anchor="{anchor}"{font} fill="{colour}">{escape(text, quote=False)}</text>'
        )

    def call(self, frm, to, label, note=None, mono=True, colour=LINE):
        """A solid arrow. The label is an expression, never prose."""
        a, b = self._x(frm), self._x(to)
        x1, x2 = (a + 6, b - 6) if b > a else (a - 6, b + 6)
        self.out.append(
            f'  <line x1="{x1}" y1="{self.y}" x2="{x2}" y2="{self.y}" stroke="{colour}"'
            f' stroke-width="1.5" marker-end="url(#arrow)"/>'
        )
        self._label((a + b) // 2, self.y - 6, label, mono)
        src = self._package(label)
        if src:
            self._label((a + b) // 2, self.y + 13, src, mono=False, size=8)
        if note:
            self._label((a + b) // 2, self.y + 27, note, mono=False, size=10, colour="#909090")
        # a note sits under the package line, so it takes room of its own
        self.y += self.step + (14 if note else 0)

    def ret(self, frm, to, label, note=None, mono=True):
        """A dashed arrow carrying the SHAPE of what came back."""
        a, b = self._x(frm), self._x(to)
        x1, x2 = (a - 6, b + 6) if a > b else (a + 6, b - 6)
        self.out.append(
            f'  <line x1="{x1}" y1="{self.y}" x2="{x2}" y2="{self.y}" stroke="{LINE}"'
            f' stroke-width="1.2" stroke-dasharray="5,3" marker-end="url(#arrow)"/>'
        )
        self._label((a + b) // 2, self.y - 6, label, mono)
        if note:
            self._label((a + b) // 2, self.y + 16, note, mono=False, size=10, colour="#909090")
        self.y += self.step

    def sees(self, frm, to, lines, colour=GREY):
        """Draws what renders, in the literal copy of the product. Multi-line
        stacks upward and reserves its own headroom, or it collides with the
        guard above."""
        marker = "arrow-warn" if colour == WARN else "arrow"
        a, b = self._x(frm), self._x(to)
        self.y += 16 * (len(lines) - 1)
        for i, line in enumerate(reversed(lines)):
            self._label((a + b) // 2, self.y - 6 - i * 16, line, mono=False, colour=colour)
        x1, x2 = (a - 6, b + 6) if a > b else (a + 6, b - 6)
        self.out.append(
            f'  <line x1="{x1}" y1="{self.y}" x2="{x2}" y2="{self.y}" stroke="{colour}"'
            f' stroke-width="1.2" stroke-dasharray="5,3" marker-end="url(#{marker})"/>'
        )
        self.y += self.step

    def selfcall(self, at, label):
        """Our own code, not a boundary crossing: seatPathFor, crypto.subtle, a
        wrapper we wrote. It never earns a lifeline."""
        x = self._x(at)
        self.out.append(
            f'  <path d="M {x} {self.y} H {x + 40} V {self.y + 14} H {x + 6}" fill="none"'
            f' stroke="{LINE}" stroke-width="1.5" marker-end="url(#arrow)"/>'
        )
        self._label(x + 48, self.y + 11, label, mono=False, anchor="start")
        src = self._package(label)
        if src:
            self._label(x + 48, self.y + 25, src, mono=False, size=8, anchor="start")
        self.y += self.step + 14

    def section(self, text):
        self._label(28, self.y, text, mono=False, size=11, anchor="start", colour="#909090", bold=True)
        self.y += self.step

    # ── fragments ────────────────────────────────────────────────────────────

    def spread(self, width, margin=130):
        """Re-space the lifelines evenly across `width`, so diagrams with
        different participant counts render at the same scale side by side."""
        n = len(self.order)
        gap = (width - 2 * margin) // max(n - 1, 1)
        for i, key in enumerate(self.order):
            self.p[key]["x"] = margin + i * gap
        self.gap = gap
        self.width = width

    def frag(self, kind, guard, title=None):
        return _Fragment(self, kind, guard, title)

    # ── provenance (optional) ────────────────────────────────────────────────

    def package(self, needle, name):
        """Tag every label containing `needle` with a tiny package line."""
        self.sources.append((needle, name))

    def _package(self, label):
        for needle, name in self.sources:
            if needle in label:
                return name
        return None

    # ── emit ─────────────────────────────────────────────────────────────────

    def svg(self):
        bottom = self.y
        head = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} {bottom + 100}"'
            f' font-family="sans-serif" font-size="12">',
            "  <defs>",
            '    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">',
            f'      <path d="M0,0 L0,6 L8,3 z" fill="{LINE}"/>',
            "    </marker>",
            '    <marker id="arrow-warn" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">',
            f'      <path d="M0,0 L0,6 L8,3 z" fill="{WARN}"/>',
            "    </marker>",
            "  </defs>",
            "",
        ]
        for key in self.order:
            head += self._box(key, 18)
        for key in self.order:
            x = self._x(key)
            head.append(
                f'  <line x1="{x}" y1="70" x2="{x}" y2="{bottom + 20}" stroke="{ACCENT}"'
                f' stroke-width="1" stroke-dasharray="4,3"/>'
            )
        foot = []
        for key in self.order:
            foot += self._box(key, bottom + 20)
        return "\n".join(head + [""] + self.out + [""] + foot + ["</svg>", ""])

    def _box(self, key, y):
        p = self.p[key]
        x = p["x"]
        lines = [
            f'  <rect x="{x - self.box // 2}" y="{y}" width="{self.box}" height="52" rx="6"'
            f' fill="{p["fill"]}" stroke="{ACCENT}" stroke-width="1.5"/>'
        ]
        if p["sub"]:
            lines.append(
                f'  <text x="{x}" y="{y + 24}" text-anchor="middle" font-weight="bold"'
                f' fill="#3a3a3a">{p["title"]}</text>'
            )
            lines.append(
                f'  <text x="{x}" y="{y + 42}" text-anchor="middle" font-size="10"'
                f' fill="{GREY}">{p["sub"]}</text>'
            )
        else:
            lines.append(
                f'  <text x="{x}" y="{y + 31}" text-anchor="middle" font-weight="bold"'
                f' fill="#3a3a3a">{p["title"]}</text>'
            )
        return lines


class _Fragment:
    """Frames an opt, alt or loop. The top and bottom of the frame each sit
    one STEP from the neighbouring arrow, and every operand is the same
    height."""

    def __init__(self, d, kind, guard, title):
        self.d, self.kind, self.guard, self.title = d, kind, guard, title

    def __enter__(self):
        d = self.d
        self.top = d.y
        d.out.append("@@FRAME@@")
        self.slot = len(d.out) - 1
        d.out.append(
            f'  <path d="M 20 {self.top} H 64 L 72 {self.top + 8} V {self.top + 20} H 20 Z"'
            f' fill="#ffffff" stroke="{GREY}" stroke-width="1.2"/>'
        )
        d._label(26, self.top + 15, self.kind, mono=False, size=11, anchor="start", colour="#3a3a3a", bold=True)
        d._label(86, self.top + 15, self.title or self.guard, mono=False, size=11, anchor="start", bold=True)
        d.y += d.step
        return self

    def divider(self, guard):
        d = self.d
        d.out.append(
            f'  <line x1="20" y1="{d.y}" x2="{d.width - 20}" y2="{d.y}" stroke="{GREY}"'
            f' stroke-width="1" stroke-dasharray="6,4"/>'
        )
        d._label(32, d.y + 15, guard, mono=False, size=11, anchor="start", bold=True)
        d.y += d.step

    def __exit__(self, *exc):
        d = self.d
        bottom = d.y
        d.out[self.slot] = (
            f'  <rect x="20" y="{self.top}" width="{d.width - 40}" height="{bottom - self.top}"'
            f' fill="none" stroke="{GREY}" stroke-width="1.2"/>'
        )
        d.y = bottom + d.step
        return False


if __name__ == "__main__":
    d = Diagram(
        [
            ("user", "User"),
            ("app", "App", "app.example.com", FILL_OURS),
            ("host", "Host API"),
        ]
    )
    d.package("getAccount", "@parity/product-sdk-host")
    d.call("app", "host", "getAccount()")
    d.ret("host", "app", "{ address, publicKey }")
    with d.frag("alt", "[ account ]") as f:
        d.sees("app", "user", ["You're in"])
        f.divider("[ else ]")
        d.sees("app", "user", ["Sign in to continue"], colour=d.WARN)
    print(d.svg())
