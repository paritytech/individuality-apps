// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The journal exists because nothing else records a mutation the panel refused
 *  to submit, and because errors are transient React state a retry overwrites.
 *  So what is pinned here is that attempts accumulate in order and that the
 *  bound evicts the oldest rather than dropping the newest. */
import { beforeEach, describe, expect, it } from "vitest";

import {
  MUTATION_CAPACITY,
  clearMutationJournal,
  mutationJournal,
  recordMutation,
} from "@features/debug/debug-mutation-journal.ts";

beforeEach(() => {
  clearMutationJournal();
});

describe("recordMutation", () => {
  it("records the extrinsic, outcome and detail in order", () => {
    recordMutation("PeopleAirdrops.register", "submitted", "draw 4");
    recordMutation("PeopleAirdrops.register", "failed", "BadOrigin");

    const journal = mutationJournal();
    expect(journal).toHaveLength(2);
    expect(journal.map((entry) => [entry.mutation, entry.outcome, entry.detail])).toEqual([
      ["PeopleAirdrops.register", "submitted", "draw 4"],
      ["PeopleAirdrops.register", "failed", "BadOrigin"],
    ]);
  });

  // Two attempts on one draw and one attempt each on two draws are different
  // bugs, so identical repeats must not collapse.
  it("keeps identical repeated attempts as separate records", () => {
    recordMutation("PeopleAirdrops.claim", "rejected", "draw 9 is not in the standing");
    recordMutation("PeopleAirdrops.claim", "rejected", "draw 9 is not in the standing");
    expect(mutationJournal()).toHaveLength(2);
  });

  it("gives every record a distinct id and a timestamp", () => {
    recordMutation("a", "submitted", "");
    recordMutation("b", "submitted", "");
    const ids = mutationJournal().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
    for (const entry of mutationJournal()) {
      expect(entry.at).toBeGreaterThan(0);
    }
  });

  it("evicts the oldest past capacity and keeps the newest", () => {
    for (let index = 0; index < MUTATION_CAPACITY + 10; index += 1) {
      recordMutation("PeopleAirdrops.register", "submitted", `attempt-${index}`);
    }
    const journal = mutationJournal();
    expect(journal).toHaveLength(MUTATION_CAPACITY);
    expect(journal[journal.length - 1]?.detail).toBe(
      `attempt-${MUTATION_CAPACITY + 9}`,
    );
    expect(journal[0]?.detail).toBe("attempt-10");
  });

  it("clears to empty", () => {
    recordMutation("a", "failed", "boom");
    clearMutationJournal();
    expect(mutationJournal()).toEqual([]);
  });
});
