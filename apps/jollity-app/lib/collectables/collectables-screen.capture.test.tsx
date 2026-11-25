// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
/**
 * THE COLLECTABLES SCREEN SCREEN, CAPTURED — what /collectables does in each named scenario,
 * recorded at its edges, so that every change to it is a change to these
 * goldens, made on purpose.
 *
 * Real here: the page, the hook, the host and the reducer, the payoff
 * session, the reread schedule, the launch stall, the reconnect window and
 * the picks' rules. Faked at the module boundary: the chain (the source's
 * collectablesView and watchCollectables, the picks storage), the shared chain-health hook,
 * the host's seen-mark, the hand-off to Humanity, the journeys and the debug
 * log; and the vessel (the scene), the album close and the picker, as
 * recorders whose callbacks the scenarios press. The vessel stand-in opens as
 * the real one does: when it is asked to, or tapped once it may be, and says
 * so. Every fake writes what it was asked to do into one trace, stamped with
 * the fake clock, and the trace is a golden, together with the debug log.
 *
 * The goldens were first taken on main's page (2487226f), held through the
 * move onto the reducer, and then changed on purpose by the collecting
 * vessel: no loading ring (the vessel is up from the first read), claims fly
 * in as they land and the vessel opens on its own, the settle's claims join
 * the open collectables screen instead of "N more arrived / Show them", and the long wait
 * says so under the vessel. Then on purpose again by a fix: a hand-off the
 * host refuses brings the album's Continue back.
 */
import { act, cleanup, fireEvent, render, screen, type RenderResult } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { gatewayImageUrl } from "@/lib/bulletin-gateway"
import { FIXTURE_COLLECTIONS } from "@/lib/collectables-fixtures"
import type { CollectablesChoice, CollectablesItem, CollectablesView } from "@/lib/game-source"

interface SceneProps {
  seed?: string
  items: { name: string }[]
  open?: boolean
  canOpen?: boolean
  inspected?: number | null
  onLanded?: () => void
  onCollected?: (count: number) => void
  onOpened?: () => void
  onInspect?: (index: number, rect: DOMRect) => void
}
interface PickerProps {
  item: { name: string; choices: { collectionId: number }[] } | null
  onPick: (offer: { collectionId: number }) => void
  onClose: () => void
}
interface Read {
  afterSettle: boolean
  done: boolean
  answer(view: CollectablesView): void
}
interface Watch {
  onItems: (items: CollectablesItem[]) => void
  settle(): void
}

const h = vi.hoisted(() => {
  const rec = {
    t0: 0,
    trace: [] as string[],
    logs: [] as string[],
    /** a line of the trace, at the fake clock's ms since the scenario began */
    note(line: string) {
      rec.trace.push(`${String(Date.now() - rec.t0).padStart(6)} ${line}`)
    },
  }
  const ctl = {
    source: null as object | null,
    noIdentity: false,
    /** every collectablesView call, oldest first */
    reads: [] as Read[],
    /** every watchCollectables call, oldest first */
    watches: [] as Watch[],
    health: { lost: false } as { lost: boolean; reason?: string; answering?: boolean },
    healthListeners: new Set<() => void>(),
    handOffFails: false,
    scene: null as (SceneProps & { tap(): void }) | null,
    album: null as null | { onDone: () => void },
    picker: null as PickerProps | null,
  }
  return { rec, ctl }
})

vi.mock("@/lib/game-source", () => ({
  getGameSource: async () => (h.ctl.noIdentity ? null : h.ctl.source),
  collectablesSeed: (account: string, game: number | null) => `${account}:${game ?? "all"}`,
}))
vi.mock("@/lib/use-chain-health-card", async () => {
  const { useSyncExternalStore } = await import("react")
  return {
    useChainHealthCard: () => {
      const card = useSyncExternalStore(
        (listener) => {
          h.ctl.healthListeners.add(listener)
          return () => void h.ctl.healthListeners.delete(listener)
        },
        () => h.ctl.health,
      )
      return { card, consecutiveLost: 0, probe: async () => undefined, noteHealthy: async () => {} }
    },
  }
})
vi.mock("@/lib/collectables-picks", async (original) => ({
  ...(await original<typeof import("@/lib/collectables-picks")>()),
  readCollectablesPicks: async () => new Map(),
  saveCollectablesPick: async (hash: string, collectionId: number) => h.rec.note(`saveCollectablesPick ${hash.slice(0, 10)} ${collectionId}`),
}))
vi.mock("@/lib/host/stash-picks", () => ({ readStashPicks: async () => new Map() }))
vi.mock("@/lib/worker-bridge", () => ({
  markSeen: async (game: number, what: string) => h.rec.note(`markSeen ${game} ${what}`),
}))
vi.mock("@/lib/membership/humanity-target", () => ({
  openHumanity: async () => {
    h.rec.note("openHumanity")
    if (h.ctl.handOffFails) throw new Error("capture: the host would not open Humanity")
  },
}))
vi.mock("@/lib/journeys/game-trace", () => ({
  collectablesOpened: () => h.rec.note("collectablesOpened"),
  collectablesShown: (facts: object) => h.rec.note(`collectablesShown ${JSON.stringify(facts)}`),
  collectablesReadRecovered: (ms: number) => h.rec.note(`collectablesReadRecovered ${ms}`),
  payoffHandedOff: () => h.rec.note("payoffHandedOff"),
  payoffStalled: (stage: string) => h.rec.note(`payoffStalled ${stage}`),
}))
vi.mock("@/lib/telemetry/use-scene", () => ({ useScene: () => {} }))
vi.mock("@/lib/debug/log-store", () => ({
  devLog: (tag: string, message: string, data?: unknown, level?: string) =>
    h.rec.logs.push(`${level ?? "info"} [${tag}] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`),
}))
vi.mock("@/components/collectables/collectables-scene", async () => {
  const { useEffect, useRef } = await import("react")
  return {
    CollectablesScene(props: SceneProps) {
      const opened = useRef(false)
      const open = () => {
        if (opened.current) return
        opened.current = true
        h.rec.note("vessel opens")
        props.onOpened?.()
      }
      h.ctl.scene = { ...props, tap: () => (props.canOpen ? open() : h.rec.note("vessel tapped, stays shut")) }
      useEffect(() => {
        h.rec.note(`vessel up seed=${props.seed}`)
        return () => h.rec.note("vessel gone")
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      // asked to open, it opens, and says so (the engine's 'open')
      useEffect(() => {
        if (props.open) open()
      })
      return <div data-capture="scene" data-items={props.items.length} data-open={props.open ? 1 : 0} data-inspected={props.inspected ?? ""} />
    },
  }
})
vi.mock("@/components/pocket/pocket-claim", async () => {
  const { useEffect } = await import("react")
  return {
    PocketClaim(props: { pieces: { image: string }[]; claimed: boolean; refusals: number; onClaim: () => void; onDone: () => void }) {
      h.ctl.album = props
      const arts = props.pieces.filter((piece) => piece.image).length
      useEffect(() => {
        if (props.claimed) h.rec.note(`album srcs=${arts}`)
      }, [props.claimed, arts])
      useEffect(() => {
        if (props.refusals) h.rec.note(`album back, refusals=${props.refusals}`)
      }, [props.refusals])
      return props.claimed ? (
        <div data-capture="album">
          <button type="button" onClick={props.onDone}>
            Continue
          </button>
        </div>
      ) : (
        <button type="button" onClick={props.onClaim}>
          Continue
        </button>
      )
    },
  }
})
vi.mock("@/components/collectable/nft-picker", () => ({
  NftPicker(props: PickerProps) {
    h.ctl.picker = props.item ? props : null
    return props.item ? <div data-capture="picker" data-name={props.item.name} data-choices={props.item.choices.length} /> : null
  },
}))

const { default: CollectablesPage } = await import("@/app/collectables/page")
const { resetPayoffSessionsForTest } = await import("@/lib/payoff-session")
const { resetCollectablesFeedsForTest } = await import("@/lib/collectables/collectables-feed")

const { rec, ctl } = h

/** one approved collection's NFT (lib/collectables-fixtures), as a claim offers it */
function choice(collectionIndex: number, itemIndex: number): CollectablesChoice {
  const collection = FIXTURE_COLLECTIONS[collectionIndex % FIXTURE_COLLECTIONS.length]!
  const item = collection.items[itemIndex % collection.items.length]!
  return {
    collectionId: collection.id,
    collection: collection.name,
    name: item.archetype.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    tier: item.tier,
    rarity: item.rarity,
    image: gatewayImageUrl(item.thumbnail),
  }
}

/** `count` claims, one per piece, each offered in every approved collection */
function claims(count: number): CollectablesItem[] {
  return Array.from({ length: count }, (_, i) => {
    const choices = FIXTURE_COLLECTIONS.map((_, c) => choice(c + i, i + c))
    const shown = choices[0]!
    return {
      hash: "0x" + (i + 1).toString(16).padStart(64, "0"),
      proof: null,
      state: i === count - 1 && count > 1 ? "earned" : "claimable",
      name: shown.name,
      rarity: shown.rarity,
      tier: shown.tier,
      image: shown.image,
      collection: shown.collection,
      choices,
    }
  })
}
const collectables = (over: Partial<CollectablesView> = {}): CollectablesView => ({
  gameIndex: 7,
  seed: "player:7",
  items: [],
  unprovable: 0,
  pending: 0,
  claimed: 0,
  ...over,
})

/** a source whose every collectablesView is a read the scenario answers, and whose watch the scenario feeds */
function fakeSource(): object {
  return {
    player: "5player",
    collectablesView(options?: { player?: string; gameIndex?: number; afterSettle?: boolean; signal?: AbortSignal }) {
      const afterSettle = options?.afterSettle === true
      rec.note(`collectablesView game=${options?.gameIndex} player=${options?.player ?? "-"} afterSettle=${afterSettle}`)
      return new Promise<CollectablesView>((resolve, reject) => {
        const read: Read = {
          afterSettle,
          done: false,
          answer(view) {
            read.done = true
            resolve(view)
          },
        }
        options?.signal?.addEventListener("abort", () => {
          if (read.done) return
          read.done = true
          rec.note(`collectablesView aborted afterSettle=${afterSettle}`)
          reject(new Error("capture: aborted"))
        })
        ctl.reads.push(read)
      })
    },
    watchCollectables(options: { gameIndex: number; shown: readonly string[]; onItems: (items: CollectablesItem[]) => void; signal: AbortSignal }) {
      rec.note(`watchCollectables game=${options.gameIndex} shown=${options.shown.length}`)
      return new Promise<void>((resolve, reject) => {
        ctl.watches.push({ onItems: options.onItems, settle: resolve })
        options.signal.addEventListener("abort", () => {
          rec.note("watchCollectables let go")
          reject(new Error("capture: aborted"))
        })
      })
    },
  }
}

/** what is on screen, in a line */
function dom(): string {
  const parts: string[] = []
  const root = document.querySelector("[data-testid]")
  if (root) parts.push(`[${root.getAttribute("data-testid")}${root.getAttribute("data-restart-advice") ? ` ${root.getAttribute("data-restart-advice")}` : ""}]`)
  const scene = document.querySelector('[data-capture="scene"]')
  if (scene)
    parts.push(
      `vessel pieces=${scene.getAttribute("data-items")}${scene.getAttribute("data-open") === "1" ? " open" : ""}${scene.getAttribute("data-inspected") ? ` inspected=${scene.getAttribute("data-inspected")}` : ""}`,
    )
  const picker = document.querySelector('[data-capture="picker"]')
  if (picker) parts.push(`picker "${picker.getAttribute("data-name")}" choices=${picker.getAttribute("data-choices")}`)
  if (document.querySelector('[data-capture="album"]')) parts.push("album")
  for (const el of document.querySelectorAll("h1, h2, p")) {
    const text = el.textContent?.trim()
    if (text) parts.push(`${el.tagName.toLowerCase()} "${text}"`)
  }
  const footer = document.querySelector("footer")
  const hidden = footer?.className.includes("opacity-0")
  const buttons = screen.queryAllByRole("button").map((button) => `${button.textContent?.trim()}${hidden && footer?.contains(button) ? " (hidden)" : ""}`)
  if (buttons.length) parts.push(`buttons [${buttons.join(", ")}]`)
  return parts.join(" · ") || "empty"
}

let view: RenderResult | null = null
let shown = ""
function look() {
  const now = dom()
  if (now === shown) return
  shown = now
  rec.note(`dom: ${now}`)
}
/** run the fake clock to `ms` after the start, in slices, noting what the screen shows */
async function to(ms: number) {
  while (Date.now() - rec.t0 < ms) {
    const step = Math.min(50, ms - (Date.now() - rec.t0))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step)
    })
    look()
  }
}

interface Step {
  at: number
  label: string
  run: () => void
}
/** render the page, play the steps at their times, and run on to `until` */
async function scenario(steps: Step[], until: number) {
  view = render(<CollectablesPage />)
  look()
  for (const step of [...steps].sort((a, b) => a.at - b.at)) {
    await to(step.at)
    rec.note(`— ${step.label}`)
    await act(async () => step.run())
    look()
  }
  await to(until)
  return { trace: rec.trace, logs: [...rec.logs].sort() }
}

/** the oldest read still out */
const pending = (): Read => {
  const read = ctl.reads.find((r) => !r.done)
  if (!read) throw new Error("capture: no chest read is out")
  return read
}
const answer = (at: number, view: CollectablesView, label: string): Step => ({ at, label: `the read answers: ${label}`, run: () => pending().answer(view) })
const landed = (at: number): Step => ({ at, label: "the vessel lands", run: () => ctl.scene!.onLanded?.() })
const collected = (at: number, count: number): Step => ({ at, label: `${count} pieces have flown in`, run: () => ctl.scene!.onCollected?.(count) })
const tap = (at: number): Step => ({ at, label: "the vessel tapped", run: () => ctl.scene!.tap() })
const came = (at: number, items: CollectablesItem[]): Step => ({ at, label: `${items.length} more claims land`, run: () => ctl.watches.at(-1)!.onItems(items) })
const settles = (at: number): Step => ({ at, label: "the game settles", run: () => ctl.watches.at(-1)!.settle() })
const press = (at: number, name: string): Step => ({ at, label: `${name} pressed`, run: () => void fireEvent.click(screen.getByRole("button", { name })) })
const albumDone = (at: number): Step => ({ at, label: "the album close is done", run: () => ctl.album!.onDone() })
const health = (at: number, card: { lost: boolean; reason?: string }): Step => ({
  at,
  label: `the chain-health card says ${JSON.stringify(card)}`,
  run: () => {
    ctl.health = card
    ctl.healthListeners.forEach((listener) => listener())
  },
})

const lines = (trace: string[], needle: string) => trace.filter((line) => line.includes(needle))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] })
  vi.setSystemTime(new Date("2026-11-03T12:00:00Z"))
  rec.t0 = Date.now()
  rec.trace = []
  rec.logs = []
  Object.assign(ctl, {
    source: fakeSource(),
    noIdentity: false,
    reads: [],
    watches: [],
    health: { lost: false },
    healthListeners: new Set(),
    handOffFails: false,
    scene: null,
    album: null,
    picker: null,
  })
  shown = ""
  sessionStorage.clear()
  localStorage.clear()
  window.history.replaceState({}, "", "/collectables?game=7")
  resetPayoffSessionsForTest()
  resetCollectablesFeedsForTest()
})
afterEach(() => {
  cleanup()
  view = null
  vi.useRealTimers()
})

describe("the collectables screen, captured", () => {
  it("a settled collectables screen is up before the read answers, opens once all have flown in, and its Continue hands off", async () => {
    const run = await scenario(
      [landed(1500), answer(2000, collectables({ items: claims(6) }), "six, settled"), collected(3500, 6), press(6000, "Continue"), albumDone(7000)],
      8000,
    )
    expect(lines(run.trace, "dom:")[0]).not.toContain("Preparing")
    expect(lines(run.trace, "vessel opens")).toHaveLength(1)
    expect(lines(run.trace, "markSeen")).toEqual([expect.stringContaining("markSeen 7 chest")])
    expect(lines(run.trace, "openHumanity")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a collectables screen before the settle collects what lands, opens after the wait, and takes the settle's claims into the open collectables screen", async () => {
    const run = await scenario(
      [
        answer(500, collectables({ items: claims(4), settling: true }), "four, before the settle"),
        landed(1500),
        collected(2500, 4),
        came(6000, claims(6).slice(4)),
        collected(7000, 6),
        settles(14_000),
        answer(14_100, collectables({ items: claims(8) }), "the settle's read: eight"),
        collected(15_000, 8),
        press(17_000, "Continue"),
        albumDone(18_000),
      ],
      19_000,
    )
    expect(lines(run.trace, "vessel opens")).toEqual([expect.stringMatching(/^ 11500 vessel opens/)])
    expect(lines(run.trace, "markSeen")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a tap opens the vessel early once something is in, and not before", async () => {
    const run = await scenario([landed(500), tap(800), answer(1000, collectables({ items: claims(3) }), "three, settled"), tap(1500), collected(2000, 1), tap(2500)], 4000)
    expect(lines(run.trace, "vessel opens")).toEqual([expect.stringMatching(/^  2500 vessel opens/)])
    expect(run).toMatchSnapshot()
  })

  it("nothing read by the collect wait says it is taking longer; the first claim after it opens the vessel, and Continue stays", async () => {
    const run = await scenario([landed(500), answer(15_000, collectables({ items: claims(2), settling: true }), "two, before the settle"), collected(16_000, 1)], 17_000)
    expect(lines(run.trace, "payoffStalled")).toEqual([expect.stringMatching(/^ 10500 payoffStalled chest.slow/)])
    expect(lines(run.trace, "vessel opens")).toEqual([expect.stringMatching(/^ 16000 vessel opens/)])
    expect(lines(run.trace, "dom:").at(-1)).toContain("buttons [Continue]")
    expect(run).toMatchSnapshot()
  })

  it("Continue is offered the moment the vessel opens", async () => {
    const run = await scenario(
      [landed(500), answer(1000, collectables({ items: claims(3) }), "three, settled"), collected(2000, 3), press(3000, "Continue"), albumDone(4000)],
      5000,
    )
    expect(lines(run.trace, "dom: vessel pieces=3 open")[0]).toContain("buttons [Continue]")
    expect(lines(run.trace, "openHumanity")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a collectables screen left before its game settled is not seen", async () => {
    const run = await scenario(
      [answer(500, collectables({ items: claims(4), settling: true }), "four, before the settle"), landed(1000), collected(2000, 4), press(14_000, "Continue"), albumDone(15_000)],
      16_000,
    )
    expect(lines(run.trace, "markSeen")).toHaveLength(0)
    expect(run).toMatchSnapshot()
  })

  it.each([
    ["no-attestations", { attended: true }],
    ["report-missed", { attended: false, reportSent: false }],
    ["absent", { attended: false }],
    ["not-recognised", { attended: false, reportSent: true, verdict: "failed" }],
  ] as const)("an empty collectables screen says why (%s), and Continue goes on", async (_, why) => {
    const run = await scenario([answer(100, collectables(why), "nothing"), press(2000, "Continue")], 3000)
    expect(lines(run.trace, "markSeen")).toHaveLength(1)
    expect(lines(run.trace, "openHumanity")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("claims earned but not readable yet keep the vessel collecting, and a reread brings them", async () => {
    const run = await scenario([landed(500), answer(1000, collectables({ pending: 2 }), "two without a hash yet"), answer(31_500, collectables({ items: claims(2) }), "two, on the reread")], 32_000)
    expect(lines(run.trace, "dom:").join("\n")).not.toContain("They appear here")
    expect(run).toMatchSnapshot()
  })

  it("a collectables screen already in the Pocket says so", async () => {
    const run = await scenario([answer(100, collectables({ claimed: 3 }), "three claimed"), press(2000, "Continue")], 3000)
    expect(lines(run.trace, "markSeen")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a collectables screen too old to prove says so", async () => {
    const run = await scenario([answer(100, collectables({ unprovable: 2 }), "two unprovable"), press(2000, "Continue")], 3000)
    expect(run).toMatchSnapshot()
  })

  it("no player identity says so at once, and Continue goes on", async () => {
    ctl.noIdentity = true
    const run = await scenario([press(2000, "Continue")], 3000)
    expect(lines(run.trace, "collectablesView")).toHaveLength(0)
    expect(lines(run.trace, "openHumanity")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a failed read keeps the vessel collecting, and reads again until the collectables screen is there", async () => {
    const run = await scenario(
      [landed(500), answer(1000, collectables({ failed: "timeout" }), "it failed after its retries"), answer(31_500, collectables({ items: claims(5) }), "five, on the reread"), collected(32_000, 5)],
      33_000,
    )
    expect(lines(run.trace, "collectablesReadRecovered")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a failed read on a lost chain puts up the restart card", async () => {
    const run = await scenario([answer(100, collectables({ failed: "timeout" }), "it failed after its retries"), health(5000, { lost: true, reason: "chain-lost" })], 40_000)
    expect(lines(run.trace, "payoffStalled")).toEqual([expect.stringContaining("payoffStalled chest.load")])
    expect(run).toMatchSnapshot()
  })

  it("a read that never answers says it is taking longer 10 s after the vessel lands, and Continue leaves the collectables screen unseen", async () => {
    const run = await scenario([landed(1500), press(12_000, "Continue")], 13_000)
    expect(lines(run.trace, "payoffStalled")).toEqual([expect.stringMatching(/^ 11500 payoffStalled chest.slow/)])
    expect(lines(run.trace, "[collectables-slow]")).toEqual([
      expect.stringContaining(`p "Any collectables you earned this game will be in the chat when they're ready."`),
    ])
    expect(lines(run.trace, "markSeen")).toHaveLength(0)
    expect(lines(run.trace, "openHumanity")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("an empty collectables screen while players are still voting says nothing yet, never that it is taking longer, and Continue leaves it unseen", async () => {
    const run = await scenario([landed(500), answer(1000, collectables({ voting: true }), "nothing yet, votes out"), press(70_000, "Continue")], 71_000)
    expect(lines(run.trace, "dom:").join("\n")).toContain("Players are still voting. Anything you earn appears here.")
    expect(lines(run.trace, "dom: [collectables-voting]")).toEqual([expect.stringMatching(/^ 10000 dom/)])
    expect(lines(run.trace, "payoffStalled")).toHaveLength(0)
    expect(lines(run.trace, "markSeen")).toHaveLength(0)
    expect(lines(run.trace, "openHumanity")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a vessel that never lands still says it is taking longer after a minute", async () => {
    const run = await scenario([press(61_000, "Continue")], 62_000)
    expect(lines(run.trace, "payoffStalled")).toEqual([expect.stringMatching(/^ 60000 payoffStalled chest.slow/)])
    expect(lines(run.trace, "openHumanity")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a hand-off the host refuses is tried again from the album", async () => {
    ctl.handOffFails = true
    const run = await scenario(
      [landed(500), answer(1000, collectables({ items: claims(2) }), "two, settled"), collected(1500, 2), press(5000, "Continue"), albumDone(6000), albumDone(8000)],
      9000,
    )
    expect(lines(run.trace, "openHumanity")).toHaveLength(2)
    expect(lines(run.trace, "album back")).toEqual([expect.stringContaining("refusals=1"), expect.stringContaining("refusals=2")])
    expect(run).toMatchSnapshot()
  })

  it("a collection picked in the hologram is saved and dealt", async () => {
    const run = await scenario(
      [
        landed(500),
        answer(1000, collectables({ items: claims(3) }), "three, settled"),
        collected(1500, 3),
        { at: 5000, label: "the first opened piece tapped", run: () => ctl.scene!.onInspect?.(0, new DOMRect()) },
        {
          at: 6000,
          label: "another collection picked",
          run: () => {
            const offer = ctl.picker!.item!.choices.at(-1)!
            ctl.picker!.onPick(offer)
          },
        },
      ],
      7000,
    )
    expect(lines(run.trace, "saveCollectablesPick")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("leaving the screen mid-read lets the read go", async () => {
    const run = await scenario([{ at: 2000, label: "the page unmounts", run: () => view!.unmount() }], 3000)
    expect(run).toMatchSnapshot()
  })
})
