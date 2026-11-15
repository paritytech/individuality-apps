// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Thin statement-store RPC layer over the node's `statement_*` methods.
 *
 * - `statement_submit` with one positional param: 0x-prefixed hex of the
 *   full SCALE statement. Retries only the spec's retryable statuses
 *   (rejected/noAllowance, rejected/storeFull) — 10 attempts, 2 s apart.
 * - `statement_subscribeStatement` with the positional Android param shape
 *   `[{"matchAll": ["0x<topic>"]}]`; notifications are
 *   `{event: "newStatements", data: {statements, remaining}}`.
 *
 * The transport is injected so polkadot-api providers, raw
 * @polkadot-api/substrate-client instances, and in-memory test hubs can
 * all back the same interface. (polkadot-api's high-level client only
 * exposes promise-based `_request`, which cannot host subscriptions —
 * use `providerTransport` with the same kind of JsonRpcProvider you give
 * `createClient`, or `substrateClientTransport`.)
 */

// --- transport --------------------------------------------------------------

export interface RpcSubscriber {
  next: (notification: unknown) => void
  error: (error: Error) => void
}

export interface StatementRpcTransport {
  request: <T = unknown>(method: string, params: unknown[]) => Promise<T>
  /** Returns an unsubscribe function (also sends `unsubscribeMethod`). */
  subscribe: (
    method: string,
    unsubscribeMethod: string,
    params: unknown[],
    subscriber: RpcSubscriber,
  ) => () => void
}

// --- submit result -----------------------------------------------------------

export type SubmitResult =
  | { status: "new" | "known" | "knownExpired" }
  | ({ status: "rejected" | "invalid" | "internalError"; reason?: string } & Record<
      string,
      unknown
    >)

export const isSubmitSuccess = (result: SubmitResult): boolean =>
  result.status === "new" ||
  result.status === "known" ||
  result.status === "knownExpired"

/** Non-fatal for signaling: an ICE burst can outbid its own channel */
export const isChannelPriorityTooLow = (result: SubmitResult): boolean =>
  result.status === "rejected" && result.reason === "channelPriorityTooLow"

const isRetryable = (result: SubmitResult): boolean =>
  result.status === "rejected" &&
  (result.reason === "noAllowance" || result.reason === "storeFull")

// --- statement rpc -------------------------------------------------------------

export interface StatementRpc {
  /** Submit a SCALE-encoded statement; retries retryable rejections. */
  submit: (statement: Uint8Array) => Promise<SubmitResult>
  /**
   * Subscribe to statements matching the topic. Replays matching stored
   * statements first (batches with a decreasing `remaining`), then streams
   * new ones. Returns an unsubscribe function.
   */
  subscribeStatements: (
    topic: Uint8Array,
    onStatements: (statements: Uint8Array[], remaining: number) => void,
    onError?: (error: Error) => void,
  ) => () => void
}

export interface StatementRpcOptions {
  /** Total submit attempts for retryable statuses (default 10) */
  retryAttempts?: number
  /** Delay between attempts in ms (default 2000) */
  retryDelayMs?: number
  /** Injectable for tests */
  sleep?: (ms: number) => Promise<void>
}

const toHex = (bytes: Uint8Array): string =>
  "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const fromHex = (hex: string): Uint8Array => {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex
  const out = new Uint8Array(stripped.length / 2)
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16)
  return out
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createStatementRpc(
  transport: StatementRpcTransport,
  options: StatementRpcOptions = {},
): StatementRpc {
  const attempts = options.retryAttempts ?? 10
  const retryDelayMs = options.retryDelayMs ?? 2000
  const sleep = options.sleep ?? defaultSleep

  return {
    async submit(statement) {
      const hex = toHex(statement)
      let result: SubmitResult
      let attempt = 0
      for (;;) {
        result = await transport.request<SubmitResult>("statement_submit", [hex])
        attempt += 1
        if (!isRetryable(result) || attempt >= attempts) return result
        await sleep(retryDelayMs)
      }
    },

    subscribeStatements(topic, onStatements, onError) {
      return transport.subscribe(
        "statement_subscribeStatement",
        "statement_unsubscribeStatement",
        [{ matchAll: [toHex(topic)] }],
        {
          next(notification) {
            const event = notification as {
              event?: string
              data?: { statements?: string[]; remaining?: number }
            }
            if (event?.event !== "newStatements") return
            const statements = (event.data?.statements ?? []).map(fromHex)
            onStatements(statements, event.data?.remaining ?? 0)
          },
          error(error) {
            onError?.(error)
          },
        },
      )
    },
  }
}

// --- adapters -------------------------------------------------------------------

/** Structural JsonRpcRequest/Response shapes of @polkadot-api/json-rpc-provider */
interface JsonRpcOut {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: unknown
}

/**
 * A polkadot-api JsonRpcProvider (e.g. the result of `getWsProvider(url)`),
 * typed structurally to avoid a hard dependency.
 */
export type JsonRpcProviderLike = (onMessage: (message: unknown) => void) => {
  send: (message: JsonRpcOut) => void
  disconnect: () => void
}

/**
 * Minimal JSON-RPC client over a raw polkadot-api provider, with
 * subscription routing by subscription id. Opens its own connection —
 * independent of any papi `createClient` on the same provider factory.
 */
export function providerTransport(
  provider: JsonRpcProviderLike,
): StatementRpcTransport & { disconnect: () => void } {
  interface Pending {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }
  const pending = new Map<string, Pending>()
  const subscriptions = new Map<string, RpcSubscriber>()
  let nextId = 1

  const connection = provider((message) => {
    const msg = message as {
      id?: string | number | null
      result?: unknown
      error?: { code: number; message: string }
      params?: { subscription?: string; result?: unknown; error?: unknown }
    }
    if (msg.id !== undefined && msg.id !== null) {
      const entry = pending.get(String(msg.id))
      if (!entry) return
      pending.delete(String(msg.id))
      if (msg.error)
        entry.reject(new Error(`rpc error ${msg.error.code}: ${msg.error.message}`))
      else entry.resolve(msg.result)
      return
    }
    const subscriptionId = msg.params?.subscription
    if (subscriptionId !== undefined) {
      subscriptions.get(subscriptionId)?.next(msg.params?.result)
    }
  })

  const request = <T>(method: string, params: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = `stmt-${nextId++}`
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      connection.send({ jsonrpc: "2.0", id, method, params })
    })

  return {
    request,

    subscribe(method, unsubscribeMethod, params, subscriber) {
      let subscriptionId: string | undefined
      let cancelled = false
      request<string>(method, params).then(
        (id) => {
          if (cancelled) {
            request(unsubscribeMethod, [id]).catch(() => {})
            return
          }
          subscriptionId = id
          subscriptions.set(id, subscriber)
        },
        (error) => {
          if (!cancelled) subscriber.error(error)
        },
      )
      return () => {
        if (cancelled) return
        cancelled = true
        if (subscriptionId !== undefined) {
          subscriptions.delete(subscriptionId)
          request(unsubscribeMethod, [subscriptionId]).catch(() => {})
        }
      }
    },

    disconnect() {
      const error = new Error("transport disconnected")
      for (const entry of pending.values()) entry.reject(error)
      pending.clear()
      for (const sub of subscriptions.values()) sub.error(error)
      subscriptions.clear()
      connection.disconnect()
    },
  }
}

/**
 * The `createClient` result of @polkadot-api/substrate-client (a transitive
 * polkadot-api dependency), typed structurally. Its callback-form `_request`
 * exposes raw subscriptions via `followSubscription`.
 */
export interface SubstrateClientLike {
  request: <T>(method: string, params: unknown[]) => Promise<T>
  _request: (
    method: string,
    params: unknown[],
    cb: {
      onSuccess: (
        result: unknown,
        followSubscription: (
          subscriptionId: string,
          subscriber: RpcSubscriber,
        ) => () => void,
      ) => void
      onError: (error: Error) => void
    },
  ) => () => void
}

export function substrateClientTransport(
  client: SubstrateClientLike,
): StatementRpcTransport {
  return {
    request: (method, params) => client.request(method, params),

    subscribe(method, unsubscribeMethod, params, subscriber) {
      let unfollow: (() => void) | undefined
      let subscriptionId: string | undefined
      let cancelled = false
      const abandon = client._request(method, params, {
        onSuccess(result, followSubscription) {
          const id = result as string
          if (cancelled) {
            client.request(unsubscribeMethod, [id]).catch(() => {})
            return
          }
          subscriptionId = id
          unfollow = followSubscription(id, subscriber)
        },
        onError(error) {
          if (!cancelled) subscriber.error(error)
        },
      })
      return () => {
        if (cancelled) return
        cancelled = true
        abandon()
        unfollow?.()
        if (subscriptionId !== undefined)
          client.request(unsubscribeMethod, [subscriptionId]).catch(() => {})
      }
    },
  }
}
