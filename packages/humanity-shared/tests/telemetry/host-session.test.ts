// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The native host's session id is a searchable tag on what this product
 * sends, so Sentry can join `card.load` and `pocket.open` to the host's own
 * `host.*` events on `host.session_id`; with no usable bootstrap (a browser,
 * `vite dev`) nothing is added. Asserted on the transaction a real client
 * hands its transport.
 */
import { BrowserClient, defaultStackParser, getCurrentScope } from "@sentry/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openFlow } from "@humanity/shared/telemetry/flow.ts";
import { readHostBootstrap, setHostSession } from "@humanity/shared/telemetry/host-session.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = 1_793_880_000_000;

function hostRoot(bootstrap: unknown): typeof globalThis {
  return { __trinityHostTelemetry: bootstrap } as unknown as typeof globalThis;
}

afterEach(() => {
  vi.unstubAllGlobals();
  getCurrentScope().setClient(undefined);
  getCurrentScope().setTags({ "host.session_id": undefined, "open.source": undefined });
});

describe("setHostSession", () => {
  it("tags the transactions the client sends with the host session and what opened the page", async () => {
    vi.stubGlobal("__trinityHostTelemetry", { hostSessionId: ID, openSource: "deeplink" });
    const sent: Array<{ type?: string; tags?: Record<string, string> }> = [];
    const client = new BrowserClient({
      dsn: "https://key@o0.ingest.sentry.io/0",
      tracesSampleRate: 1,
      traceLifecycle: "static",
      stackParser: defaultStackParser,
      integrations: [],
      transport: () => ({
        send: (envelope) => {
          for (const item of envelope[1] as unknown[]) {
            if (Array.isArray(item)) sent.push(item[1] as (typeof sent)[number]);
          }
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });
    const scope = getCurrentScope();
    scope.setClient(client);
    client.init();
    setHostSession(scope);

    openFlow("card.load").finish({ kind: "member", ok: true });
    await client.flush();

    const tx = sent.find((payload) => payload.type === "transaction");
    expect(tx?.tags).toMatchObject({ "host.session_id": ID, "open.source": "deeplink" });
  });

  it("adds nothing outside a host", () => {
    const tags = vi.fn();
    setHostSession({ setTags: tags });
    expect(tags).not.toHaveBeenCalled();
  });
});

describe("readHostBootstrap", () => {
  it("keeps a plausible open and names a source it does not know `other`", () => {
    expect(
      readHostBootstrap(hostRoot({ hostSessionId: ID, openedAtEpochMs: NOW - 2_500, openSource: "pocket_card" }), NOW),
    ).toEqual({ hostSessionId: ID, openedAtEpochMs: NOW - 2_500, openSource: "pocket_card" });
    expect(readHostBootstrap(hostRoot({ hostSessionId: ID, openSource: "widget" }), NOW)).toEqual({
      hostSessionId: ID,
      openSource: "other",
    });
  });

  it.each([
    ["in the future", NOW + 1],
    ["five minutes old", NOW - 5 * 60 * 1000],
    ["not finite", Number.NaN],
    ["not a number", "yesterday"],
  ])("drops an open that is %s, and keeps the session", (_label, openedAtEpochMs) => {
    expect(readHostBootstrap(hostRoot({ hostSessionId: ID, openedAtEpochMs }), NOW)).toEqual({ hostSessionId: ID });
  });

  it.each([
    ["no host", undefined],
    ["a session id that is not a UUID", { hostSessionId: "abc" }],
    ["a bootstrap that is not an object", "x"],
  ])("is null for %s", (_label, bootstrap) => {
    expect(readHostBootstrap(hostRoot(bootstrap), NOW)).toBeNull();
  });

  it("is null, not a throw, when the bootstrap getter throws", () => {
    const root = Object.defineProperty({}, "__trinityHostTelemetry", {
      get() {
        throw new Error("native bootstrap failed");
      },
    }) as typeof globalThis;
    expect(readHostBootstrap(root, NOW)).toBeNull();
  });
});
