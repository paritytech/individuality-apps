// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
// @ts-expect-error -- Node executes the resolver CLI's exported pure checker.
import { assertPublicationReadback } from "../../scripts/dotns-resolve.mjs";

describe("DotNS publication release evidence", () => {
  it("accepts a worker executable without a contenthash when its record matches", () => {
    expect(() =>
      assertPublicationReadback(
        [
          {
            name: "card.peopl.dot",
            contenthash: new Uint8Array([1]),
            records: { executable: "card-record" },
          },
          {
            name: "worker.peopl.dot",
            contenthash: null,
            records: { executable: "worker-record" },
          },
        ],
        new Map([
          ["card.peopl.dot", "card-record"],
          ["worker.peopl.dot", "worker-record"],
        ]),
        new Set(["card.peopl.dot"]),
      ),
    ).not.toThrow();
  });

  it("rejects a mismatched executable readback", () => {
    expect(() =>
      assertPublicationReadback(
        [
          {
            name: "worker.peopl.dot",
            contenthash: null,
            records: { executable: "stale-record" },
          },
        ],
        new Map([["worker.peopl.dot", "worker-record"]]),
        new Set(),
      ),
    ).toThrow("executable readback did not match for worker.peopl.dot");
  });
});
