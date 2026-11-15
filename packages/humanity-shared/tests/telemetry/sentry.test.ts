// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The init contract: no DSN means no client at all, and with one the client
 * is tagged by surface, named by network, collects no personal data, sends
 * flows whole, and leaves console breadcrumbs to the LogTape sink.
 */
import { getClient, getCurrentScope, type ErrorEvent } from "@sentry/browser";
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  envConfig: {
    chain: { network: "previewnet", peopleWsUrl: null, gameAccountIndex: 1 },
    host: { productLabel: "peopl", productSubname: "dev" },
    logging: { level: "info" },
    telemetry: {
      sentryDsn: null as string | null,
      tracesSampleRate: 0.5,
      sendIdentity: false,
      release: "humanity-app@0.20.4+abc1234",
    },
    dev: false,
  },
}));

vi.mock("@humanity/shared/config/env.ts", () => env);

// Dynamic imports on purpose: `initTelemetry` runs once per module instance,
// so the two cases need the module loaded afresh with the env mock answering
// differently each time.
describe("initTelemetry", () => {
  it("does nothing without a DSN", async () => {
    const { initTelemetry, telemetrySurface } = await import("@humanity/shared/telemetry/sentry.ts");
    initTelemetry("app");
    expect(telemetrySurface()).toBeNull();
    expect(getClient()).toBeUndefined();
  });

  it("with a DSN, configures the client from the build and tags the surface", async () => {
    env.envConfig.telemetry.sentryDsn = "https://key@o0.ingest.sentry.io/0";
    vi.resetModules();
    const { initTelemetry, telemetrySurface } = await import("@humanity/shared/telemetry/sentry.ts");
    initTelemetry("worker");
    initTelemetry("app");
    expect(telemetrySurface()).toBe("worker");

    const options = getClient()?.getOptions();
    expect(options).toMatchObject({
      release: "humanity-app@0.20.4+abc1234",
      environment: "previewnet",
      traceLifecycle: "static",
      dataCollection: { userInfo: false, urlQueryParams: false },
    });
    expect(options?.integrations.map((integration) => integration.name)).not.toContain("Console");
    expect(options?.integrations.map((integration) => integration.name)).toContain("Breadcrumbs");
    expect(options?.beforeSend?.name).toBe("prepareEvent");
    // One card load per launch: always kept. Every other flow at the rate.
    const sample = options?.tracesSampler;
    expect(sample?.({ name: "card.load", attributes: {}, inheritOrSampleWith: () => 1 })).toBe(1);
    expect(sample?.({ name: "username.claim", attributes: {}, inheritOrSampleWith: () => 1 })).toBe(0.5);
    expect(
      sample?.({ name: "username.claim", parentSampled: true, attributes: {}, inheritOrSampleWith: () => 1 }),
    ).toBe(true);
    expect(getCurrentScope().getScopeData().tags).toMatchObject({
      surface: "worker",
      product: "peopl",
      "product.subname": "dev",
      // The device is on the scope before the first flow opens (`device.ts`).
      "device.os": expect.any(String),
      "device.engine": expect.any(String),
    });
  });
});

describe("dropAbandonedAbort", () => {
  const rejection = { type: "auto.browser.global_handlers.onunhandledrejection", handled: false };

  function event(values: Array<{ type: string; mechanism?: typeof rejection }>): ErrorEvent {
    return { type: undefined, exception: { values } } as ErrorEvent;
  }

  it("drops an unhandled rejection that is only an abort", async () => {
    const { dropAbandonedAbort } = await import("@humanity/shared/telemetry/sentry.ts");
    expect(dropAbandonedAbort(event([{ type: "AbortError", mechanism: rejection }]))).toBeNull();
  });

  it("keeps an unhandled rejection with any other error in its chain", async () => {
    const { dropAbandonedAbort } = await import("@humanity/shared/telemetry/sentry.ts");
    const mixed = event([
      { type: "AbortError" },
      { type: "ProductIndividualityError", mechanism: rejection },
    ]);
    expect(dropAbandonedAbort(mixed)).toBe(mixed);
  });

  it("keeps an abort a log line reported, and every other rejection", async () => {
    const { dropAbandonedAbort } = await import("@humanity/shared/telemetry/sentry.ts");
    const logged = event([{ type: "AbortError", mechanism: { type: "generic", handled: true } }]);
    const other = event([{ type: "TypeError", mechanism: rejection }]);
    expect(dropAbandonedAbort(logged)).toBe(logged);
    expect(dropAbandonedAbort(other)).toBe(other);
  });
});

describe("prepareEvent", () => {
  const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const bob = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
  const txHash = `0x${"ab".repeat(32)}`;

  function event(): ErrorEvent {
    return {
      type: undefined,
      message: `no host account for ${alice}`,
      exception: { values: [{ type: "Error", value: `alice.01.testnet is held by ${bob}` }] },
      breadcrumbs: [{ message: `registering bob.02 from ${alice}, tx ${txHash}` }],
      tags: { "log.detail": `owner ${alice}`, "card.kind": "member" },
      contexts: { log: { message: `claim of bob.02 for ${alice}`, template: "claim of {label} for {owner}" } },
    } as ErrorEvent;
  }

  it("takes addresses and usernames out of every text by default, and keeps the tx hash", async () => {
    env.envConfig.telemetry.sendIdentity = false;
    const { prepareEvent } = await import("@humanity/shared/telemetry/sentry.ts");
    const sent = prepareEvent(event());
    expect(sent?.message).toBe("no host account for [address]");
    expect(sent?.exception?.values?.[0]?.value).toBe("[username] is held by [address]");
    expect(sent?.breadcrumbs?.[0]?.message).toBe(`registering [username] from [address], tx ${txHash}`);
    expect(sent?.tags).toEqual({ "log.detail": "owner [address]", "card.kind": "member" });
    expect(sent?.contexts?.["log"]).toEqual({
      message: "claim of [username] for [address]",
      template: "claim of {label} for {owner}",
    });
  });

  it("leaves the event as it is when the deployer opted in", async () => {
    env.envConfig.telemetry.sendIdentity = true;
    const { prepareEvent } = await import("@humanity/shared/telemetry/sentry.ts");
    const original = event();
    expect(prepareEvent(event())).toEqual(original);
    env.envConfig.telemetry.sendIdentity = false;
  });
});
