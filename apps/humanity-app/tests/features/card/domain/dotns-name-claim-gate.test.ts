// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  DOTNS_CLAIM_RETRY_MS,
  dotnsClaimGate,
  type DotnsClaimGateInputs,
} from "@features/card/domain/dotns-name-claim.ts";

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const NOW = 1_700_000_000_000;

const base: DotnsClaimGateInputs = {
  owner: OWNER,
  fullUsername: "alicewonder",
  gateway: { lite: "alice.06", full: null, aliasRegistered: false },
  record: null,
  membership: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 3 },
  busy: false,
  now: NOW,
};

describe("dotnsClaimGate", () => {
  it("fires when People holds a full username the gateway lacks (the #1433 case)", () => {
    expect(dotnsClaimGate(base)).toMatchObject({ kind: "firing", label: "alicewonder" });
  });

  it("claims for a key the people ring holds, and does not for one it is known not to (Domain.V1.NotMember)", () => {
    const included = { kind: "included" as const, ringIndex: 0, ringPage: 0, ringPosition: 3 };
    expect(dotnsClaimGate({ ...base, membership: included }).kind).toBe("firing");
    for (const membership of [
      { kind: "absent" as const },
      { kind: "suspended" as const },
      { kind: "onboarding" as const, queuePage: 0, queuedAtSeconds: 1 },
    ]) {
      expect(dotnsClaimGate({ ...base, membership })).toMatchObject({ kind: "idle" });
    }
  });

  it("still tries when the ring standing is unknown, and never re-proves for a known non-member", () => {
    expect(dotnsClaimGate({ ...base, membership: null }).kind).toBe("firing");
    const failedProof = {
      status: "stopped" as const,
      label: "alicewonder",
      at: NOW - 60_000,
      attempts: 3,
      code: "proof" as const,
      detail: "Domain.V1.NotMember",
    };
    // A retryable stop past its backoff would fire again; the ring says it cannot succeed.
    expect(dotnsClaimGate({ ...base, record: failedProof }).kind).toBe("firing");
    expect(dotnsClaimGate({ ...base, record: failedProof, membership: { kind: "absent" } }).kind).toBe("idle");
  });

  it("stays idle for a lite person and before the gateway is read", () => {
    expect(dotnsClaimGate({ ...base, fullUsername: null }).kind).toBe("idle");
    expect(dotnsClaimGate({ ...base, gateway: undefined }).kind).toBe("idle");
    expect(dotnsClaimGate({ ...base, owner: null }).kind).toBe("idle");
  });

  it("is settled once the gateway holds the same name", () => {
    expect(
      dotnsClaimGate({ ...base, gateway: { ...base.gateway!, full: "alicewonder" } }).kind,
    ).toBe("registered");
  });

  it("stops when the account already registered another name or an alias", () => {
    expect(
      dotnsClaimGate({ ...base, gateway: { ...base.gateway!, full: "someoneelse" } }).kind,
    ).toBe("stopped");
    expect(
      dotnsClaimGate({ ...base, gateway: { ...base.gateway!, aliasRegistered: true } }).kind,
    ).toBe("stopped");
  });

  it("never fires twice at once", () => {
    expect(dotnsClaimGate({ ...base, busy: true }).kind).toBe("idle");
    expect(
      dotnsClaimGate({
        ...base,
        record: { status: "sending", label: "alicewonder", at: NOW - 1_000, attempts: 1 },
      }).kind,
    ).toBe("holding");
  });

  it("gives a broadcast its retry window before trying again", () => {
    const sent = {
      status: "sent" as const,
      label: "alicewonder",
      at: NOW - 5_000,
      txHash: "0xabc",
      expiresAtBlock: 100,
      confirmed: false,
    };
    expect(dotnsClaimGate({ ...base, record: sent })).toMatchObject({
      kind: "holding",
      until: sent.at + DOTNS_CLAIM_RETRY_MS,
    });
    expect(dotnsClaimGate({ ...base, record: sent, now: sent.at + DOTNS_CLAIM_RETRY_MS }).kind).toBe(
      "firing",
    );
  });

  it("retries a transient failure after the backoff, never a permanent one", () => {
    const stopped = {
      status: "stopped" as const,
      label: "alicewonder",
      at: NOW - 10_000,
      attempts: 2,
      detail: "x",
    };
    expect(dotnsClaimGate({ ...base, record: { ...stopped, code: "ring-not-synced" } })).toMatchObject(
      { kind: "holding", until: stopped.at + DOTNS_CLAIM_RETRY_MS },
    );
    expect(
      dotnsClaimGate({
        ...base,
        record: { ...stopped, code: "ring-not-synced" },
        now: stopped.at + DOTNS_CLAIM_RETRY_MS,
      }).kind,
    ).toBe("firing");
    expect(dotnsClaimGate({ ...base, record: { ...stopped, code: "not-lite-owner" } }).kind).toBe(
      "stopped",
    );
    expect(
      dotnsClaimGate({ ...base, record: { ...stopped, code: "account-already-registered" } }).kind,
    ).toBe("stopped");
  });

  it("ignores a record for a different name", () => {
    expect(
      dotnsClaimGate({
        ...base,
        record: { status: "stopped", label: "oldname", at: NOW, attempts: 1, code: "not-lite-owner", detail: "" },
      }).kind,
    ).toBe("firing");
  });
});
