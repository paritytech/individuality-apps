// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A flow is one transaction with one trace: its stages, the host calls and
 * transaction phases made under it are its children, its status follows the
 * outcome the caller classifies, and a thrown error is classified by its
 * `code`. Asserted on the envelopes a real client hands its transport, not
 * on SDK internals.
 */
import { flush, init } from "@sentry/browser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { traceHostCall } from "@humanity/shared/chain/host-call-log.ts";
import {
  watchTransactionSubmission,
  type WatchTransaction,
} from "@humanity/shared/chain/transaction-submission.ts";
import { tracedRead } from "@humanity/shared/chain/chain-read.ts";
import { childSpan, openFlow, runFlow } from "@humanity/shared/telemetry/flow.ts";

interface SpanJson {
  description?: string;
  op?: string;
  status?: string;
  data?: Record<string, unknown>;
  parent_span_id?: string;
  span_id?: string;
}

interface TransactionJson {
  type: "transaction";
  transaction: string;
  start_timestamp: number;
  contexts: { trace: { op?: string; status?: string; data?: Record<string, unknown>; span_id?: string; trace_id?: string } };
  spans?: SpanJson[];
}

const sent: unknown[] = [];

function isTransaction(payload: unknown): payload is TransactionJson {
  return (
    payload != null &&
    typeof payload === "object" &&
    "type" in payload &&
    payload.type === "transaction"
  );
}

/** Every transaction the client sent since the last reset: an envelope is
 *  `[headers, items]`, an item `[header, payload]`. */
function transactions(): TransactionJson[] {
  const out: TransactionJson[] = [];
  for (const envelope of sent) {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) continue;
    for (const item of envelope[1] as unknown[]) {
      if (Array.isArray(item) && isTransaction(item[1])) out.push(item[1]);
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

afterEach(() => {
  sent.length = 0;
});

describe("runFlow", () => {
  it("sends one transaction per flow with its stages, steps and attributes as children", async () => {
    const result = await runFlow(
      "username.claim",
      async (flow) => {
        flow.stage("setup");
        await Promise.resolve();
        flow.stage("sign");
        const signed = await flow.step("ringVrfSign", () => Promise.resolve("sig"));
        flow.set({ "username.choice": "Standalone" });
        return { status: "included" as const, signed };
      },
      {
        attributes: { method: "truapi" },
        outcome: ({ status }) => ({ kind: status, ok: status === "included" }),
      },
    );
    await flush();

    expect(result).toEqual({ status: "included", signed: "sig" });
    const [tx, ...rest] = transactions();
    expect(rest).toEqual([]);
    expect(tx?.transaction).toBe("username.claim");
    expect(tx?.contexts.trace.op).toBe("flow");
    expect(tx?.contexts.trace.status).toBe("ok");
    expect(tx?.contexts.trace.data).toMatchObject({
      method: "truapi",
      "username.choice": "Standalone",
      "flow.outcome": "included",
    });
    const children = (tx?.spans ?? []).map((span) => [span.op, span.description, span.status]);
    expect(children).toEqual([
      ["flow.stage", "setup", "ok"],
      ["flow.stage", "sign", "ok"],
      ["flow.step", "ringVrfSign", "ok"],
    ]);
    // The step is nested under the stage that was open, not under the root.
    const sign = tx?.spans?.find((span) => span.description === "sign");
    const step = tx?.spans?.find((span) => span.description === "ringVrfSign");
    expect(step?.parent_span_id).toBe(sign?.span_id);
  });

  it("marks a classified non-ok outcome failed without throwing", async () => {
    const outcome = await runFlow("membership.promotion", async () => ({ kind: "refused" as const }), {
      outcome: ({ kind }) => ({ kind, ok: false }),
    });
    await flush();
    expect(outcome).toEqual({ kind: "refused" });
    const [tx] = transactions();
    expect(tx?.contexts.trace.status).not.toBe("ok");
    expect(tx?.contexts.trace.data?.["flow.outcome"]).toBe("refused");
  });

  it("classifies a thrown error by its code, fails the open stage, and rethrows it", async () => {
    class CodedError extends Error {
      code = "timeout";
    }
    await expect(
      runFlow("daily-dollar.claim", async (flow) => {
        flow.stage("submit");
        await Promise.resolve();
        throw new CodedError("People Chain did not respond in time.");
      }),
    ).rejects.toBeInstanceOf(CodedError);
    await flush();
    const [tx] = transactions();
    expect(tx?.contexts.trace.status).not.toBe("ok");
    expect(tx?.contexts.trace.data?.["flow.outcome"]).toBe("timeout");
    expect(tx?.spans?.map((span) => span.description)).toEqual(["submit"]);
  });

  it("reports an abandoned flow as cancelled, not failed", async () => {
    await expect(
      runFlow("card.load", () => Promise.reject(new DOMException("signal is aborted", "AbortError"))),
    ).rejects.toBeInstanceOf(DOMException);
    await flush();
    const [tx] = transactions();
    expect(tx?.contexts.trace.status).toBe("cancelled");
    expect(tx?.contexts.trace.data?.["flow.outcome"]).toBe("AbortError");
  });

  it("files host calls and transaction phases under the flow, and nothing outside one", async () => {
    const okResult = { isOk: () => true, value: 1 };
    const errResult = { isOk: () => false, error: { tag: "PermissionDenied" } };
    // Outside a flow: observed by the ledger, reported nowhere.
    await traceHostCall("accounts.getUserId", () => Promise.resolve(okResult));
    expect(childSpan("host.call", "orphan")).toBeTypeOf("function");

    await runFlow("daily-dollar.registration", async (flow) => {
      flow.stage("alias");
      await traceHostCall("accounts.listRingVrfKeys", () => Promise.resolve(okResult));
      await traceHostCall("accounts.ringVrfSign", () => Promise.resolve(errResult));
      flow.stage("submit");
      const tx: WatchTransaction<string> = {
        createSubmitAndWatch: () => ({
          subscribe(observer) {
            queueMicrotask(() => {
              observer.next?.({ type: "broadcasted", txHash: "0xabc" } as never);
              observer.next?.({ type: "finalized", txHash: "0xabc", ok: true, events: [] } as never);
            });
            return { unsubscribe() {} };
          },
        }),
      };
      await watchTransactionSubmission(tx, "signer", {}, {
        signingFailureMessage: "no",
        finalityFailureMessage: "no",
      });
    });
    await flush();

    const [tx, ...rest] = transactions();
    expect(rest).toEqual([]);
    const children = (tx?.spans ?? []).map((span) => [span.op, span.description, span.status]);
    expect(children).toEqual([
      ["flow.stage", "alias", "ok"],
      ["host.call", "accounts.listRingVrfKeys", "ok"],
      ["host.call", "accounts.ringVrfSign", "internal_error"],
      ["flow.stage", "submit", "ok"],
      ["chain.tx", "sign", "ok"],
      ["chain.tx", "settle", "ok"],
    ]);
    const refused = tx?.spans?.find((span) => span.description === "accounts.ringVrfSign");
    expect(refused?.data).toMatchObject({ "error.detail": "host error" });
    const settle = tx?.spans?.find((span) => span.description === "settle");
    expect(settle?.data).toMatchObject({ "tx.hash": "0xabc", "tx.status": "finalized" });
    const submit = tx?.spans?.find((span) => span.description === "submit");
    expect(settle?.parent_span_id).toBe(submit?.span_id);
  });
});

describe("openFlow", () => {
  it("dates the flow from the given start, orders its stages, and finishes once", async () => {
    const startTime = Date.now() / 1000 - 2.5;
    const flow = openFlow("card.load", { attributes: { "game.account": true }, startTime });
    flow.stage("boot");
    flow.stage("identity");
    await traceHostCall("accounts.getUserId", () => Promise.resolve({ isOk: () => true, value: 1 }));
    flow.stage("read");
    flow.finish({ kind: "member", ok: true });
    expect(flow.finished).toBe(true);
    // Late narration from a hook that did not know the flow had ended.
    flow.stage("render");
    flow.set({ late: true });
    flow.finish({ kind: "account-unavailable", ok: false });
    flow.fail(new Error("late"));
    await flush();

    const [tx, ...rest] = transactions();
    expect(rest).toEqual([]);
    expect(tx?.transaction).toBe("card.load");
    expect(tx?.start_timestamp).toBeCloseTo(startTime, 2);
    expect(tx?.contexts.trace.status).toBe("ok");
    expect(tx?.contexts.trace.data).toMatchObject({ "flow.outcome": "member", "game.account": true });
    expect(tx?.contexts.trace.data).not.toHaveProperty("late");
    expect((tx?.spans ?? []).map((span) => [span.op, span.description])).toEqual([
      ["flow.stage", "boot"],
      ["flow.stage", "identity"],
      ["host.call", "accounts.getUserId"],
      ["flow.stage", "read"],
    ]);
  });

  it("opens no children once finished", async () => {
    const flow = openFlow("card.load");
    flow.finish({ kind: "member", ok: true });
    await tracedRead("Score.Participants", () => Promise.resolve(1));
    await flush();
    expect(transactions()[0]?.spans ?? []).toEqual([]);
  });
});

describe("tracedRead", () => {
  it("files a chain read under the flow by name, with its failure detail, and nothing outside one", async () => {
    class PinError extends Error {
      override name = "BlockNotPinnedError";
    }
    expect(await tracedRead("finalized.pin", () => Promise.resolve(7))).toBe(7);
    await runFlow("card.load", async (flow) => {
      flow.stage("read");
      await tracedRead("finalized.pin", () => Promise.resolve("0xblock"));
      await expect(
        tracedRead("Score.Participants", () => Promise.reject(new PinError("lapsed"))),
      ).rejects.toBeInstanceOf(PinError);
    });
    await flush();

    const [tx, ...rest] = transactions();
    expect(rest).toEqual([]);
    expect((tx?.spans ?? []).map((span) => [span.op, span.description, span.status, span.data?.["error.detail"]])).toEqual([
      ["flow.stage", "read", "ok", undefined],
      ["chain.read", "finalized.pin", "ok", undefined],
      ["chain.read", "Score.Participants", "internal_error", "BlockNotPinnedError"],
    ]);
  });
});
