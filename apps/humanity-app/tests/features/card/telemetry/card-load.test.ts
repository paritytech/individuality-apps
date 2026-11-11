// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The card load is one transaction per launch dated from the script start,
 * narrated in a fixed stage order by hooks that re-run, and ended by the
 * first terminal event. Asserted on the envelopes a real client sends.
 */
import { flush, init } from "@sentry/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cardLoad, resetCardLoadForTests } from "@features/card/telemetry/card-load.ts";
import { tracedRead } from "@humanity/shared/chain/chain-read.ts";

interface SpanJson {
  description?: string;
  op?: string;
  start_timestamp: number;
}

interface TransactionJson {
  type: "transaction";
  transaction: string;
  start_timestamp: number;
  contexts: { trace: { status?: string; data?: Record<string, unknown> } };
  spans?: SpanJson[];
}

const sent: unknown[] = [];

function transactions(): TransactionJson[] {
  const out: TransactionJson[] = [];
  for (const envelope of sent) {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) continue;
    for (const item of envelope[1] as unknown[]) {
      const payload: unknown = Array.isArray(item) ? item[1] : null;
      if (
        payload != null &&
        typeof payload === "object" &&
        "type" in payload &&
        payload.type === "transaction"
      ) {
        out.push(payload as TransactionJson);
      }
    }
  }
  return out;
}

beforeAll(() => {
  init({
    dsn: "https://key@o0.ingest.sentry.io/0",
    tracesSampleRate: 1,
    traceLifecycle: "static",
    defaultIntegrations: false,
    transport: () => ({
      send: (envelope) => {
        sent.push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });
});

beforeEach(() => {
  resetCardLoadForTests();
});

afterEach(() => {
  sent.length = 0;
});

describe("cardLoad", () => {
  it("is one transaction from the script start through the stages in order, ended by the render", async () => {
    cardLoad.begin();
    cardLoad.begin(); // StrictMode double-invocation, a second import: one flow.
    cardLoad.stage("identity");
    // A refetch on window focus names a stage already passed: ignored.
    cardLoad.stage("game-account");
    cardLoad.stage("identity");
    cardLoad.stage("read");
    cardLoad.set({ "game.account": true });
    await tracedRead("finalized.pin", () => Promise.resolve("0x1"));
    // The re-keyed first read aborts and the second read begins: still `read`.
    cardLoad.stage("read");
    await tracedRead("Score.Participants", () => Promise.resolve(null));
    cardLoad.stage("render");
    expect(cardLoad.inFlight).toBe(true);
    cardLoad.set({ "card.cached": false });
    cardLoad.finish({ kind: "member", ok: true });
    expect(cardLoad.inFlight).toBe(false);
    // The 12 s refetch and a late effect after the launch's flow ended.
    cardLoad.stage("read");
    cardLoad.finish({ kind: "account-unavailable", ok: false });
    await flush();

    const [tx, ...rest] = transactions();
    expect(rest).toEqual([]);
    expect(tx?.transaction).toBe("card.load");
    expect(tx?.start_timestamp).toBeCloseTo(performance.timeOrigin / 1000, 1);
    expect(tx?.spans?.[0]?.start_timestamp).toBeCloseTo(performance.timeOrigin / 1000, 1);
    expect(tx?.contexts.trace.status).toBe("ok");
    expect(tx?.contexts.trace.data).toMatchObject({
      "flow.outcome": "member",
      "game.account": true,
      "card.cached": false,
    });
    expect((tx?.spans ?? []).map((span) => [span.op, span.description])).toEqual([
      ["flow.stage", "boot"],
      ["flow.stage", "identity"],
      ["flow.stage", "game-account"],
      ["flow.stage", "read"],
      ["chain.read", "finalized.pin"],
      ["chain.read", "Score.Participants"],
      ["flow.stage", "render"],
    ]);
  });

  it("ends failed when the host holds no identity, and before begin does nothing", async () => {
    cardLoad.stage("identity");
    cardLoad.finish({ kind: "member", ok: true });
    expect(cardLoad.inFlight).toBe(false);
    await flush();
    expect(transactions()).toEqual([]);

    cardLoad.begin();
    cardLoad.stage("identity");
    cardLoad.finish({ kind: "account-unavailable", ok: false });
    await flush();
    const [tx] = transactions();
    expect(tx?.contexts.trace.status).toBe("internal_error");
    expect(tx?.contexts.trace.data).toMatchObject({ "flow.outcome": "account-unavailable" });
  });
});

describe("pocket.open", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174000";

  function hostPage(
    ago: number,
    navigation = "navigate",
    source = "pocket_card",
    visibility = "visible",
    withOpenedAt = true,
  ) {
    vi.stubGlobal("__trinityHostTelemetry", {
      hostSessionId: ID,
      ...(withOpenedAt ? { openedAtEpochMs: Date.now() - ago } : {}),
      openSource: source,
    });
    const listeners: Array<() => void> = [];
    const doc = {
      visibilityState: visibility,
      addEventListener: (_type: string, listener: () => void) => void listeners.push(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        void listeners.splice(listeners.indexOf(listener), 1),
    };
    vi.stubGlobal("document", doc);
    vi.spyOn(performance, "getEntriesByType").mockImplementation(((type: string) =>
      type === "navigation" ? [{ type: navigation }] : []) as unknown as typeof performance.getEntriesByType);
    const change = (state: string) => () => {
      doc.visibilityState = state;
      for (const listener of [...listeners]) listener();
    };
    return { hide: change("hidden"), show: change("visible") };
  }

  const byName = (name: string) => transactions().find((tx) => tx.transaction === name);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs from the tap to the card shown, ending with card.load and leaving its children there", async () => {
    hostPage(800);
    const before = Date.now() / 1000;
    cardLoad.begin();
    cardLoad.stage("read");
    await tracedRead("Score.Participants", () => Promise.resolve(null));
    cardLoad.finish({ kind: "member", ok: true });
    await flush();

    const open = byName("pocket.open");
    const load = byName("card.load");
    expect(open?.start_timestamp).toBeCloseTo(before - 0.8, 1);
    expect(open?.contexts.trace.status).toBe("ok");
    expect(open?.contexts.trace.data).toMatchObject({ "flow.outcome": "member", "open.source": "pocket_card" });
    expect(open?.spans ?? []).toEqual([]);
    expect(load?.start_timestamp).toBeCloseTo(performance.timeOrigin / 1000, 1);
    expect((load?.spans ?? []).map((span) => span.description)).toContain("Score.Participants");
  });

  it("is abandoned when the page is hidden before the card shows, while card.load runs on", async () => {
    const { hide } = hostPage(300);
    cardLoad.begin();
    cardLoad.stage("read");
    hide();
    await tracedRead("Score.Participants", () => Promise.resolve(null));
    cardLoad.finish({ kind: "member", ok: true });
    await flush();

    const open = byName("pocket.open");
    expect(open?.contexts.trace.status).toBe("cancelled");
    expect(open?.contexts.trace.data).toMatchObject({ "flow.outcome": "abandoned" });
    expect(byName("card.load")?.contexts.trace.data).toMatchObject({ "flow.outcome": "member" });
    expect((byName("card.load")?.spans ?? []).map((span) => span.description)).toContain("Score.Participants");
  });

  it("is not abandoned by a page created hidden: it waits until shown, and the card then ends it ok", async () => {
    const { show } = hostPage(300, "navigate", "pocket_card", "hidden");
    cardLoad.begin();
    cardLoad.stage("read");
    show();
    cardLoad.finish({ kind: "member", ok: true });
    await flush();

    const open = byName("pocket.open");
    expect(open?.contexts.trace.status).toBe("ok");
    expect(open?.contexts.trace.data).toMatchObject({ "flow.outcome": "member" });
  });

  it("is abandoned when a page that was shown goes hidden again", async () => {
    const { hide, show } = hostPage(300, "navigate", "pocket_card", "hidden");
    cardLoad.begin();
    show();
    hide();
    cardLoad.finish({ kind: "member", ok: true });
    await flush();

    expect(byName("pocket.open")?.contexts.trace.data).toMatchObject({ "flow.outcome": "abandoned" });
  });

  it("sends only card.load when the bootstrap carries no openedAtEpochMs", async () => {
    hostPage(300, "navigate", "pocket_card", "visible", false);
    cardLoad.begin();
    cardLoad.finish({ kind: "member", ok: true });
    await flush();
    expect(transactions().map((tx) => tx.transaction)).toEqual(["card.load"]);
  });

  it("tells no story for a reload, whose bootstrap still carries the first open's time", async () => {
    hostPage(800, "reload");
    cardLoad.begin();
    cardLoad.finish({ kind: "member", ok: true });
    await flush();
    expect(transactions().map((tx) => tx.transaction)).toEqual(["card.load"]);
  });
});
