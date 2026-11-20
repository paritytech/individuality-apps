// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { peopleAirdropsEventId } from "@parity/product-sdk-individuality"
import { describe, expect, it, vi } from "vitest"
import type { People } from "../chain"
import type { WorkerHost } from "../host"
import { decPayload } from "../renderer"
import { ROOM_ID } from "../state"
import type { ChatLine, DailyDollarRegistry } from "./registry"
import { DAILY_DOLLAR_SCRATCH_KEY } from "@individuality/shared-records"
import { HUMANITY_REGISTRY_KEY_PREFIX, MESSAGE_DAILY_DOLLAR, REGISTRY_KEY_PREFIX, createDailyDollar, humanityPocketLink, scratchLink } from "./worker"

const CONTEXT = `0x${"c0".repeat(32)}`
const ALIAS = `0x${"a1".repeat(32)}`
const SALT = `0x${"5a".repeat(32)}`
const ACCOUNT_KEY = new Uint8Array(32).fill(7)
const WON = peopleAirdropsEventId(0n)
const OPEN = peopleAirdropsEventId(1n)
const NOW = 3_000
const BEST = { hash: `0x${"77".repeat(32)}`, number: 79 }

const rawEvent = (id: string, status: string, drawTime: number) => ({
  id,
  info: {
    prize: { asset_id: { parents: 1, interior: { type: "Here" } }, asset_amount: 1_000_000n, max_winners: 10, winner_cap: 1000 },
    registration_starts: 1_000n,
    draw_time: BigInt(drawTime),
    end_time: BigInt(drawTime + 86_400),
  },
  status: { type: status, value: { total_participants: 4, effective_winners: 1, claimed: 0 } },
})

function fakePeople({ bound, rootRevision = 7 }: { bound: boolean; rootRevision?: number }) {
  const register = vi.fn((args: { event_ids: string[] }) => ({
    args,
    createAndSubmit: vi.fn().mockResolvedValue({ ok: true, txHash: "0xfeed" }),
    createSubmitAndWatch: vi.fn(),
  }))
  const chain = {
    raw: { individuality: { getFinalizedBlock: async () => BEST, getBestBlocks: async () => [BEST] } },
    individuality: {
      constants: { PeopleAirdrops: { people_airdrops_context: async () => CONTEXT, MaxRegisterBatch: async () => 16 } },
      query: {
        People: {
          AccountToAlias: { getValue: async () => (bound ? { revision: 7, ring: 2, ca: { alias: ALIAS, context: CONTEXT } } : undefined) },
        },
        Members: { Root: { getValue: async () => ({ revision: rootRevision }) } },
        PeopleAirdrops: { DrawSalts: { getValues: async (keys: [string][]) => keys.map(() => [SALT, 0n]) } },
        Airdrop: {
          Events: {
            getEntries: async () => [
              { keyArgs: [WON], value: rawEvent(WON, "Claiming", 2_000) },
              { keyArgs: [OPEN], value: rawEvent(OPEN, "Registering", 5_000) },
            ],
          },
          Registrations: { getValues: async (keys: unknown[]) => keys.map(() => undefined) },
          Winners: { getValues: async (keys: [string, unknown][]) => keys.map(([id]) => (id === WON ? "0x01" : undefined)) },
        },
      },
      tx: { PeopleAirdrops: { register } },
    },
  }
  return { people: { client: {}, api: {}, chain } as unknown as People, register }
}

function fakeHost(product: Record<string, unknown> = {}) {
  // the host's personhood keys: it holds the person's key in any ring it is asked about
  const keys = { holds: vi.fn(async () => true), prove: vi.fn() }
  const store = new Map<string, unknown>()
  const host = {
    chat: {
      registerBot: vi.fn(),
      registerRoom: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      postText: vi.fn().mockResolvedValue(undefined),
      setRoomFooter: vi.fn(),
    },
    notifications: { push: vi.fn().mockResolvedValue(1), cancel: vi.fn().mockResolvedValue(undefined) },
    navigate: vi.fn().mockResolvedValue(true),
    storage: {
      readJSON: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
      writeJSON: vi.fn(async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      }),
      readProductJSON: vi.fn(async (_product: string, key: string) => product[key] ?? null),
    },
    productAccount: vi.fn().mockResolvedValue(ACCOUNT_KEY),
    peopleGenesis: vi.fn().mockResolvedValue(`0x${"ab".repeat(32)}`),
    accounts: {
      signer: vi.fn().mockResolvedValue({ publicKey: ACCOUNT_KEY, signTx: vi.fn(), signBytes: vi.fn() }),
      personhood: vi.fn(() => keys),
    },
  }
  return { host: host as unknown as WorkerHost, store, raw: host, keys }
}

const posted = (host: WorkerHost): ChatLine[] => [
  ...vi.mocked(host.chat.postText).mock.calls.map(([, text]) => ({ text })),
  ...vi.mocked(host.chat.postMessage).mock.calls.map(([, , payload]) => decPayload<ChatLine>(payload)),
]

describe("the Daily Dollar in the Jollity chat", () => {
  it("registers the open draw under the alias and invites to scratch the won one, once", async () => {
    const { people, register } = fakePeople({ bound: true })
    const { host, raw } = fakeHost()
    const dd = createDailyDollar({ host, connect: async () => people, now: () => NOW })

    expect(await dd.tick()).toBe("ok")

    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]![0]).toEqual({ event_ids: [OPEN] })
    expect(register.mock.results[0]!.value.createAndSubmit).toHaveBeenCalledTimes(1)
    expect(raw.accounts.signer).toHaveBeenCalledWith("peopl.paseo", 1)

    expect(raw.chat.postText).not.toHaveBeenCalled()
    expect(raw.chat.postMessage).toHaveBeenCalledTimes(1)
    const [room, type, payload, alt] = raw.chat.postMessage.mock.calls[0]!
    expect([room, type, alt]).toEqual([ROOM_ID, MESSAGE_DAILY_DOLLAR, "Scratch now, you may have won a dollar today."])
    expect(decPayload<ChatLine>(payload)).toEqual({
      text: "Scratch now, you may have won a dollar today.",
      buttons: [{ actionId: "open-card", title: "Scratch" }],
      card: { kind: "ticket", eventId: WON, drawTimeSeconds: 2_000 },
    })

    await dd.tick()
    expect(raw.chat.postText).not.toHaveBeenCalled()
    expect(raw.chat.postMessage).toHaveBeenCalledTimes(1)
  })

  it("skips registration outside the membership ring: no register call and nothing logged as failed", async () => {
    const { people, register } = fakePeople({ bound: false })
    const { host, store } = fakeHost()
    const dd = createDailyDollar({ host, connect: async () => people, now: () => NOW })

    expect(await dd.tick()).toBe("ok")
    await dd.tick()

    expect(register).not.toHaveBeenCalled()
    const registry = [...store.entries()].find(([key]) => key.startsWith(REGISTRY_KEY_PREFIX))![1] as DailyDollarRegistry
    const record = registry.draws[OPEN as `0x${string}`]!
    expect(record.registration.state).toBe("none")
    expect(record.registration.error).toBeNull()
  })

  it("does not register when the ring moved on and the personhood key is no longer in it", async () => {
    const { people, register } = fakePeople({ bound: true, rootRevision: 9 })
    const { host, keys } = fakeHost()
    keys.holds.mockResolvedValue(false)
    const dd = createDailyDollar({ host, connect: async () => people, now: () => NOW })

    await dd.tick()

    expect(register).not.toHaveBeenCalled()
  })

  it("renews an alias whose ring moved on with the personhood key in the airdrops context", async () => {
    const { people, register } = fakePeople({ bound: true, rootRevision: 9 })
    const { host, keys } = fakeHost()
    const dd = createDailyDollar({ host, connect: async () => people, now: () => NOW })

    await dd.tick()

    expect(keys.holds).toHaveBeenCalledWith({
      key: "full",
      owner: "peopl.paseo",
      ring: { chainId: `0x${"ab".repeat(32)}`, junctions: [{ tag: "CollectionId", value: expect.stringMatching(/^0x[0-9a-f]{64}$/) }] },
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.results[0]!.value.createAndSubmit).toHaveBeenCalledTimes(1)
  })

  it("says how a ticket went once Humanity's registry has the scratch", async () => {
    const { people } = fakePeople({ bound: true })
    const first = fakeHost()
    await createDailyDollar({ host: first.host, connect: async () => people, now: () => NOW }).tick()
    const [key, ours] = [...first.store.entries()].find(([k]) => k.startsWith(REGISTRY_KEY_PREFIX))!
    const owner = key.slice(REGISTRY_KEY_PREFIX.length)
    const theirs = structuredClone(ours) as DailyDollarRegistry
    theirs.draws[WON as `0x${string}`]!.scratchedAtSeconds = NOW + 10

    const { host, store } = fakeHost({ [`${HUMANITY_REGISTRY_KEY_PREFIX}${owner}`]: theirs })
    for (const [k, v] of first.store) store.set(k, v)
    await createDailyDollar({ host, connect: async () => people, now: () => NOW + 20 }).tick()

    expect(posted(host).map((line) => line.text)).toEqual([expect.stringMatching(/^You scratched a winner: \$1!/)])
  })

  it("opens Humanity's pocket card when Scratch is pressed", () => {
    const { host, raw } = fakeHost()
    const dd = createDailyDollar({ host, connect: async () => null, now: () => NOW })
    let press: ((actionId: string) => void) | undefined
    const sent = vi.fn()
    dd.render(new TextEncoder().encode(JSON.stringify({ text: "hi", buttons: [{ actionId: "open-card", title: "Scratch" }] })), sent, (cb) => {
      press = (id) => cb(id, undefined)
      return () => {}
    })
    expect(sent).toHaveBeenCalledTimes(1)
    press!("open-card")
    expect(raw.navigate).toHaveBeenCalledWith(scratchLink())
    expect(scratchLink()).toBe("polkadotapp://pocket/open?product=peopl.paseo&card=humanity&open=scratch")
    expect(humanityPocketLink()).toBe("polkadotapp://pocket/open?product=peopl.paseo&card=humanity")
  })

  /** The CTAs of the last tree sent: a live host Button with its wire variant, or the worker's grey done pill (a Text in fg.secondary). */
  function lastButtons(sent: ReturnType<typeof vi.fn>): string[] {
    const found: string[] = []
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node == null) return
      const { tag, value } = node as {
        tag?: string
        value?: { props?: { text?: string; variant?: string; enabled?: boolean; color?: string }; children?: unknown[] }
      }
      if (tag === "Button") found.push(`${value!.props!.text} (${value!.props!.variant}${value!.props!.enabled ? "" : ", disabled"})`)
      if (tag === "Text" && value?.props?.color === "FgSecondary") found.push(`${(value.children?.[0] as { value?: { text?: string } })?.value?.text} (done pill)`)
      for (const child of value?.children ?? []) walk(child)
    }
    walk(sent.mock.calls.at(-1)![0])
    return found
  }

  async function renderTicket(now: number, scratched: boolean, humanity: Record<string, unknown> = {}) {
    const { people } = fakePeople({ bound: true })
    const { host, raw, store } = fakeHost(humanity)
    await createDailyDollar({ host, connect: async () => people, now: () => NOW }).tick()
    const [key, ours] = [...store.entries()].find(([k]) => k.startsWith(REGISTRY_KEY_PREFIX))!
    if (scratched) {
      const next = structuredClone(ours) as DailyDollarRegistry
      next.draws[WON as `0x${string}`]!.scratchedAtSeconds = NOW + 1
      store.set(key, next)
    }
    const payload = raw.chat.postMessage.mock.calls[0]![2] as Uint8Array
    const sent = vi.fn()
    let press: ((actionId: string) => void) | undefined
    createDailyDollar({ host, connect: async () => people, now: () => now }).render(payload, sent, (cb) => {
      press = (id) => cb(id, undefined)
      return () => {}
    })
    await vi.waitFor(() => expect(sent.mock.calls.length).toBeGreaterThan(scratched || DAILY_DOLLAR_SCRATCH_KEY in humanity || now >= 2_000 + 86_400 ? 1 : 0))
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { sent, press: press!, raw }
  }

  it("draws an open ticket as a Daily Dollar card with a live Scratch button", async () => {
    const { sent } = await renderTicket(NOW, false)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(lastButtons(sent)).toEqual(["Scratch (Primary)"])
  })

  it("greys the button out as Scratched, and ignores taps, once the ticket is scratched", async () => {
    const { sent, press, raw } = await renderTicket(NOW, true)
    expect(lastButtons(sent)).toEqual(["Scratched (done pill)"])
    press("open-card")
    expect(raw.navigate).not.toHaveBeenCalled()
  })

  it("greys the button out once Humanity's shared scratch record names the draw, with no registry entry for it", async () => {
    const { sent, press, raw } = await renderTicket(NOW, false, { [DAILY_DOLLAR_SCRATCH_KEY]: { [WON.toUpperCase().replace("0X", "0x")]: NOW + 1 } })
    expect(lastButtons(sent)).toEqual(["Scratched (done pill)"])
    press("open-card")
    expect(raw.navigate).not.toHaveBeenCalled()
  })

  it("greys the button out as Expired once the claim window has shut", async () => {
    const { sent } = await renderTicket(10_000_000, false)
    expect(lastButtons(sent)).toEqual(["Expired (done pill)"])
  })
})
