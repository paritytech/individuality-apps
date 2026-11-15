// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { PeopleClient } from "./client"
import { fetchAirdropDraw } from "./airdrop"

const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`

/** The chain serves `Game::airdrop_event_id_base` as hex. */
const BASE = hex(new TextEncoder().encode("pop:game:airdrop:          "))

const BEST = { hash: "0xbe57", number: 12 }

const BLOCKS = { getBestBlocks: async () => [BEST], getFinalizedBlock: async () => ({ hash: "0xf1", number: 10 }) }

/** The chain holds one registration and no event row, so the draw is long gone. */
function fakeClient(registrant: unknown) {
  const events = vi.fn().mockResolvedValue(undefined)
  const api = {
    constants: { Game: { airdrop_event_id_base: vi.fn().mockResolvedValue(BASE) } },
    query: {
      Airdrop: {
        Events: { getValue: events },
        Registrations: {
          getEntries: vi.fn().mockResolvedValue([{ keyArgs: ["0xevent", "0x7e"], value: registrant }]),
        },
        Winners: { getEntries: vi.fn().mockResolvedValue([]) },
        EventEntropy: { getValue: vi.fn().mockResolvedValue(undefined) },
      },
    },
  }
  return { people: { api, client: BLOCKS } as unknown as PeopleClient, events }
}

describe("draw reading works", () => {
  // The id is "pop:game:airdrop:" with ten spaces, then 07, then 01020304.
  it("addresses the draw by base, airdrop index and big-endian game index", async () => {
    // Given
    const { people, events } = fakeClient(undefined)
    const eventId = "0x706f703a67616d653a61697264726f703a202020202020202020200701020304"

    // When
    const draw = await fetchAirdropDraw(people, { gameIndex: 0x01020304, airdropIndex: 7, player: "5F..." })

    // Then
    expect(draw.eventId).toBe(eventId)
    expect(events).toHaveBeenCalledWith(eventId, expect.anything())
  })

  it("finds the ticket an account registered under", async () => {
    // Given
    const { people } = fakeClient({ type: "Account", value: { account_id: "5F..." } })

    // When
    const draw = await fetchAirdropDraw(people, { gameIndex: 42, airdropIndex: 0, player: "5F..." })

    // Then
    expect(draw).toEqual(expect.objectContaining({ status: "gone", ticket: "0x7e", totalEntries: 1 }))
  })
})

/**
 * Game 149 on paseo, as the chain held it: three tickets, the target past all
 * of them (so the draw wraps round to the lowest ticket), one winner — who then
 * claimed, which removed them from `Airdrop.Winners`.
 */
const YOU = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
/** a 32-byte slot from the leading hex the chain showed (the rest is padding) */
const slot32 = (lead: string) => `0x${lead.padEnd(64, "0")}`
const GAME_149 = {
  target: slot32("f2136b44fe8d3f82b"),
  registrations: [
    ["0x37066df28e43d56f250ef1823d4a4687cbe7475be585a19e9511543235bbf793", YOU],
    [slot32("5f45834fa92"), "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy"],
    [slot32("8c76e186f82"), BOB],
  ] as const,
}

function game149People(options: { claimed: boolean }) {
  const [yourTicket] = GAME_149.registrations[0]
  const api = {
    constants: { Game: { airdrop_event_id_base: vi.fn().mockResolvedValue(BASE) } },
    query: {
      Airdrop: {
        Events: {
          getValue: vi.fn().mockImplementation(async (id: string) => ({
            id,
            status: { type: "Claiming", value: { total_participants: 3, effective_winners: 1, claimed: options.claimed ? 1 : 0 } },
            info: {
              prize: { asset_id: "cash", asset_amount: 10_000_000n, max_winners: 1, winner_cap: 1_000_000 },
              registration_starts: 1790788032n,
              draw_time: 1790788500n,
              end_time: 1790792100n,
            },
          })),
        },
        Registrations: {
          getEntries: vi.fn().mockResolvedValue(
            GAME_149.registrations.map(([ticket, account]) => ({
              keyArgs: ["0xevent", ticket],
              value: { type: "Account", value: { account_id: account } },
            })),
          ),
        },
        // the claim removes the winner's entry
        Winners: {
          getEntries: vi.fn().mockResolvedValue(
            options.claimed ? [] : [{ keyArgs: ["0xevent", { type: "Account", value: { account_id: YOU } }], value: yourTicket }],
          ),
        },
        EventEntropy: { getValue: vi.fn().mockResolvedValue(GAME_149.target) },
      },
      Assets: {
        Metadata: { getValue: vi.fn().mockResolvedValue({ symbol: "0x70555344", name: "0x70555344", decimals: 6 }) },
      },
    },
  }
  return { api, client: BLOCKS } as unknown as PeopleClient
}

describe("a claimed win works", () => {
  it("reads the winner before the claim, from the winners storage", async () => {
    // Given
    const people = game149People({ claimed: false })

    // When
    const draw = await fetchAirdropDraw(people, { gameIndex: 149, airdropIndex: 0, player: YOU })

    // Then
    expect(draw).toEqual(expect.objectContaining({ won: true, claimed: false }))
    expect(draw.winningTickets).toEqual([GAME_149.registrations[0][0]])
  })

  it("still reads the winner after the claim removed them, and says it is claimed", async () => {
    // Given
    const people = game149People({ claimed: true })

    // When
    const draw = await fetchAirdropDraw(people, { gameIndex: 149, airdropIndex: 0, player: YOU })

    // Then
    expect(draw).toEqual(expect.objectContaining({ won: true, claimed: true }))
    expect(draw.winningTickets).toEqual([GAME_149.registrations[0][0]])
  })

  it("does not hand the claimed win to anyone else", async () => {
    // Given
    const people = game149People({ claimed: true })

    // When
    const draw = await fetchAirdropDraw(people, { gameIndex: 149, airdropIndex: 0, player: BOB })

    // Then
    expect(draw).toEqual(expect.objectContaining({ won: false, claimed: false }))
  })
})
