// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  createStatementRpc,
  isChannelPriorityTooLow,
  isSubmitSuccess,
  providerTransport,
  type RpcSubscriber,
  type StatementRpcTransport,
  type SubmitResult,
} from "./rpc"

const statement = new Uint8Array([0x14, 0x00, 0xab])

describe("createStatementRpc.submit", () => {
  function transportReturning(results: SubmitResult[]) {
    const calls: { method: string; params: unknown[] }[] = []
    const transport: StatementRpcTransport = {
      async request(method, params) {
        calls.push({ method, params })
        return results.shift() as never
      },
      subscribe: () => () => {},
    }
    return { transport, calls }
  }

  const instantly = { sleep: async () => {}, retryDelayMs: 0 }

  it("submits 0x-prefixed hex as a single positional param", async () => {
    const { transport, calls } = transportReturning([{ status: "new" }])
    const rpc = createStatementRpc(transport, instantly)
    const result = await rpc.submit(statement)
    expect(result).toEqual({ status: "new" })
    expect(calls).toEqual([
      { method: "statement_submit", params: ["0x1400ab"] },
    ])
  })

  it("retries only noAllowance/storeFull, up to the attempt budget", async () => {
    const { transport, calls } = transportReturning([
      { status: "rejected", reason: "noAllowance" },
      { status: "rejected", reason: "storeFull" },
      { status: "new" },
    ])
    const rpc = createStatementRpc(transport, instantly)
    expect(await rpc.submit(statement)).toEqual({ status: "new" })
    expect(calls.length).toBe(3)
  })

  it("gives up after retryAttempts on a persistent retryable status", async () => {
    const results = Array.from(
      { length: 10 },
      (): SubmitResult => ({ status: "rejected", reason: "noAllowance" }),
    )
    const { transport, calls } = transportReturning(results)
    const rpc = createStatementRpc(transport, { ...instantly, retryAttempts: 4 })
    expect(await rpc.submit(statement)).toEqual({
      status: "rejected",
      reason: "noAllowance",
    })
    expect(calls.length).toBe(4)
  })

  it("does not retry non-retryable statuses", async () => {
    const { transport, calls } = transportReturning([
      { status: "invalid", reason: "badProof" },
    ])
    const rpc = createStatementRpc(transport, instantly)
    expect(await rpc.submit(statement)).toEqual({
      status: "invalid",
      reason: "badProof",
    })
    expect(calls.length).toBe(1)
  })

  it("classifies results", () => {
    expect(isSubmitSuccess({ status: "new" })).toBe(true)
    expect(isSubmitSuccess({ status: "known" })).toBe(true)
    expect(isSubmitSuccess({ status: "knownExpired" })).toBe(true)
    expect(isSubmitSuccess({ status: "rejected", reason: "accountFull" })).toBe(
      false,
    )
    expect(
      isChannelPriorityTooLow({
        status: "rejected",
        reason: "channelPriorityTooLow",
      }),
    ).toBe(true)
  })
})

describe("createStatementRpc.subscribeStatements", () => {
  it("subscribes with the positional matchAll single-topic filter", () => {
    let seen: { method: string; unsub: string; params: unknown[] } | undefined
    let subscriber: RpcSubscriber | undefined
    const transport: StatementRpcTransport = {
      request: async () => ({}) as never,
      subscribe(method, unsub, params, sub) {
        seen = { method, unsub, params }
        subscriber = sub
        return () => {}
      },
    }
    const rpc = createStatementRpc(transport)
    const batches: { statements: string[]; remaining: number }[] = []
    const topic = new Uint8Array(32).fill(0xcd)
    rpc.subscribeStatements(topic, (statements, remaining) =>
      batches.push({
        statements: statements.map((s) =>
          Array.from(s, (b) => b.toString(16).padStart(2, "0")).join(""),
        ),
        remaining,
      }),
    )
    expect(seen?.method).toBe("statement_subscribeStatement")
    expect(seen?.unsub).toBe("statement_unsubscribeStatement")
    expect(seen?.params).toEqual([{ matchAll: ["0x" + "cd".repeat(32)] }])

    subscriber!.next({
      event: "newStatements",
      data: { statements: ["0x1400ab"], remaining: 2 },
    })
    subscriber!.next({
      event: "newStatements",
      data: { statements: [] }, // absent remaining ⇒ 0
    })
    subscriber!.next({ event: "somethingElse" }) // ignored
    expect(batches).toEqual([
      { statements: ["1400ab"], remaining: 2 },
      { statements: [], remaining: 0 },
    ])
  })
})

describe("providerTransport", () => {
  interface SentMessage {
    id?: string | number | null
    method: string
    params?: unknown
  }

  function fakeProvider() {
    const sent: SentMessage[] = []
    let deliver: (message: unknown) => void = () => {}
    const provider = (onMessage: (message: unknown) => void) => {
      deliver = onMessage
      return {
        send: (message: SentMessage) => sent.push(message),
        disconnect: () => {},
      }
    }
    return { provider, sent, deliver: (m: unknown) => deliver(m) }
  }

  it("correlates requests by id", async () => {
    const { provider, sent, deliver } = fakeProvider()
    const transport = providerTransport(provider)
    const pending = transport.request<string>("statement_submit", ["0xff"])
    expect(sent[0]?.method).toBe("statement_submit")
    deliver({ jsonrpc: "2.0", id: sent[0]!.id, result: "ok" })
    expect(await pending).toBe("ok")
  })

  it("rejects on rpc errors", async () => {
    const { provider, sent, deliver } = fakeProvider()
    const transport = providerTransport(provider)
    const pending = transport.request("statement_submit", [])
    deliver({
      jsonrpc: "2.0",
      id: sent[0]!.id,
      error: { code: -32601, message: "nope" },
    })
    await expect(pending).rejects.toThrow(/-32601/)
  })

  it("routes subscription notifications and unsubscribes", async () => {
    const { provider, sent, deliver } = fakeProvider()
    const transport = providerTransport(provider)
    const received: unknown[] = []
    const unsubscribe = transport.subscribe(
      "statement_subscribeStatement",
      "statement_unsubscribeStatement",
      [{ matchAll: [] }],
      { next: (n) => received.push(n), error: () => {} },
    )
    deliver({ jsonrpc: "2.0", id: sent[0]!.id, result: "sub-1" })
    await Promise.resolve()
    deliver({
      jsonrpc: "2.0",
      method: "statement_subscribeStatement",
      params: { subscription: "sub-1", result: { event: "newStatements" } },
    })
    expect(received).toEqual([{ event: "newStatements" }])

    unsubscribe()
    expect(sent[1]?.method).toBe("statement_unsubscribeStatement")
    expect(sent[1]?.params).toEqual(["sub-1"])
    deliver({
      jsonrpc: "2.0",
      method: "statement_subscribeStatement",
      params: { subscription: "sub-1", result: { event: "ignored" } },
    })
    expect(received.length).toBe(1)
  })
})
