// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * An event filed after the card was read says in which standing, and whose
 * card only when the deployer opted in to identity; a forced debug scenario
 * is marked as one; a refetch in flight leaves the last known standing in
 * place.
 */
import { captureMessage, flush, init } from "@sentry/browser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";
import {
  setCardContext,
  setDebugContext,
  setIdentityContext,
} from "@humanity/shared/telemetry/app-context.ts";

const env = vi.hoisted(() => ({
  envConfig: { telemetry: { sendIdentity: false } },
}));

vi.mock("@humanity/shared/config/env.ts", () => env);

interface EventJson {
  event_id?: string;
  type?: string;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown> | null>;
}

const sent: unknown[] = [];

function lastEvent(): EventJson {
  for (let i = sent.length - 1; i >= 0; i--) {
    const envelope = sent[i];
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) continue;
    for (const item of envelope[1] as unknown[]) {
      if (Array.isArray(item) && item[1] != null && typeof item[1] === "object" && "event_id" in item[1]) {
        return item[1] as EventJson;
      }
    }
  }
  throw new Error("no event sent");
}

const candidate = {
  kind: "card",
  primaryUsername: "alice.01.testnet",
  accountAddress: "5Fcandidate",
  ownerAccount: null,
  participantKey: "account",
  state: { kind: "candidate", score: 4, personhoodThreshold: 10, gamesRemaining: 6 },
} as unknown as ResolvedHumanityCard;

beforeAll(() => {
  init({
    dsn: "https://key@o0.ingest.sentry.io/0",
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

afterEach(() => {
  sent.length = 0;
  env.envConfig.telemetry.sendIdentity = false;
  setIdentityContext(null);
  setCardContext({ kind: "account-unavailable" }, null);
  setDebugContext(null);
});

describe("app context", () => {
  it("puts the standing, and no username or address, on the next event by default", async () => {
    setIdentityContext({ primaryUsername: "alice.01.testnet", username: "alice.01", isUpgraded: false });
    setCardContext(candidate, "5Fgame");
    captureMessage("something failed");
    await flush();

    const event = lastEvent();
    expect(event.tags).toMatchObject({ "card.kind": "candidate" });
    expect(event.tags?.["username"]).toBeUndefined();
    expect(event.contexts?.["identity"]).toEqual({ kind: "lite" });
    expect(event.contexts?.["card"]).toEqual({
      kind: "candidate",
      score: 4,
      personhoodThreshold: 10,
      gamesRemaining: 6,
    });
    expect(JSON.stringify(event)).not.toMatch(/alice|5Fcandidate|5Fgame/);
  });

  it("with the identity opt-in, puts the person and the card state on the next event, with kind and username as tags", async () => {
    env.envConfig.telemetry.sendIdentity = true;
    setIdentityContext({ primaryUsername: "alice.01.testnet", username: "alice.01", isUpgraded: false });
    setCardContext(candidate, "5Fgame");
    captureMessage("something failed");
    await flush();

    const event = lastEvent();
    expect(event.tags).toMatchObject({ "card.kind": "candidate", username: "alice.01" });
    expect(event.contexts?.["identity"]).toMatchObject({ username: "alice.01", kind: "lite" });
    expect(event.contexts?.["card"]).toMatchObject({
      kind: "candidate",
      score: 4,
      personhoodThreshold: 10,
      accountAddress: "5Fcandidate",
      gameAccount: "5Fgame",
    });
    expect(event.contexts?.["debug"]).toBeUndefined();
  });

  it("keeps the last standing while a read is in flight, and drops it for an unavailable account", async () => {
    setCardContext(candidate, "5Fgame");
    setCardContext(undefined, "5Fgame");
    captureMessage("during refetch");
    await flush();
    expect(lastEvent().contexts?.["card"]).toMatchObject({ kind: "candidate" });

    setCardContext({ kind: "account-unavailable" }, null);
    captureMessage("no account");
    await flush();
    expect(lastEvent().contexts?.["card"]).toEqual({ kind: "account-unavailable" });
    expect(lastEvent().tags?.["card.kind"]).toBe("account-unavailable");
  });

  it("marks a forced debug scenario and clears the mark when it is released", async () => {
    setDebugContext("caution");
    captureMessage("under override");
    await flush();
    expect(lastEvent().contexts?.["debug"]).toEqual({ scenario: "caution" });
    expect(lastEvent().tags?.["debug.scenario"]).toBe("caution");

    setDebugContext(null);
    captureMessage("released");
    await flush();
    expect(lastEvent().contexts?.["debug"]).toBeUndefined();
    expect(lastEvent().tags?.["debug.scenario"]).toBeUndefined();
  });
});
