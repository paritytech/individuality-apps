// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { AccountId, type PolkadotClient } from "polkadot-api"
import { PLAYER_NAME_KEY } from "@jollity/protocol"
import { learnUsername, readNameSet } from "./username"
import { chatEvent, configureTelemetry, resetTelemetry, setChatUser } from "./telemetry"
import type { WorkerHost } from "./host"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function hostWith(stored: unknown, userName?: () => Promise<string | null>) {
  return {
    storage: { readJSON: vi.fn(async (key: string) => (key === PLAYER_NAME_KEY ? stored : null)) },
    accounts: { userName },
  } as unknown as WorkerHost
}

async function userOfNextEvent(): Promise<unknown> {
  const sent: string[] = []
  configureTelemetry({ dsn: "https://k@o1.ingest.de.sentry.io/1", fetchImpl: async (_url, init) => void sent.push(init.body) })
  return { emit: async () => (chatEvent("x"), await flush(), JSON.parse(sent[0]!.split("\n")[2]!).user) }
}

describe("the worker's username", () => {
  beforeEach(() => resetTelemetry())

  it("comes from host storage, where the app wrote it, without asking the host", async () => {
    const userName = vi.fn(async () => "other")
    const { emit } = (await userOfNextEvent()) as { emit: () => Promise<unknown> }
    setChatUser("5Gabc")
    expect(await learnUsername(hostWith("carol.01", userName))).toBe("carol.01")
    expect(userName).not.toHaveBeenCalled()
    expect(await emit()).toEqual({ id: "5Gabc", username: "carol.01" })
  })

  it("is asked of the host when storage holds none", async () => {
    const { emit } = (await userOfNextEvent()) as { emit: () => Promise<unknown> }
    setChatUser("5Gabc")
    expect(await learnUsername(hostWith(null, async () => " carol.01 "))).toBe("carol.01")
    expect(await emit()).toEqual({ id: "5Gabc", username: "carol.01" })
  })

  it("leaves the id alone when the host gives no name or fails", async () => {
    const { emit } = (await userOfNextEvent()) as { emit: () => Promise<unknown> }
    setChatUser("5Gabc")
    expect(await learnUsername(hostWith(null, async () => { throw new Error("not connected") }))).toBeNull()
    expect(await learnUsername(hostWith(null))).toBeNull()
    expect(await emit()).toEqual({ id: "5Gabc" })
  })
})

const ROOT = AccountId().dec(new Uint8Array(32).fill(2))

/** A People chain where `carol.01` belongs to ROOT, whose consumer holds `consumer`, or one whose every read fails. */
function peopleWith(consumer: { full_username?: Uint8Array | null; lite_username?: Uint8Array | null } | "fails") {
  const read = <T>(value: T) => vi.fn(async () => {
    if (consumer === "fails") throw new Error("disconnected")
    return value
  })
  const query = {
    Resources: {
      UsernameOwnerOf: { getValue: read(ROOT) },
      Consumers: {
        getValue: read(consumer === "fails" ? consumer : { lite_username: consumer.lite_username, ...(consumer.full_username ? { full_username: consumer.full_username } : {}), credibility: { type: "Lite" } }),
      },
    },
  }
  const client = { getUnsafeApi: () => ({ query }) } as unknown as PolkadotClient
  return { people: vi.fn(async () => ({ client })), query }
}

describe("learning the full username works", () => {
  beforeEach(() => resetTelemetry())

  it("reads the consumer of the root that owns the stored username", async () => {
    const full = peopleWith({ full_username: new TextEncoder().encode("carol"), lite_username: new TextEncoder().encode("carol.01") })
    const lite = peopleWith({ full_username: null, lite_username: new TextEncoder().encode("carol.01") })
    expect(await readNameSet(hostWith("carol.01"), full.people)).toBe(true)
    expect(full.query.Resources.UsernameOwnerOf.getValue).toHaveBeenCalledWith(new TextEncoder().encode("carol.01"))
    expect(full.query.Resources.Consumers.getValue).toHaveBeenCalledWith(ROOT, expect.anything())
    expect(await readNameSet(hostWith("carol.01"), lite.people)).toBe(false)
  })

  it("asks the host for the username once when storage holds none", async () => {
    const lite = peopleWith({ full_username: null, lite_username: new TextEncoder().encode("carol.01") })
    const userName = vi.fn(async () => "carol.01")
    const host = hostWith(null, userName)
    await readNameSet(host, lite.people)
    await readNameSet(host, lite.people)
    expect(userName).toHaveBeenCalledTimes(1)
    expect(lite.query.Resources.Consumers.getValue).toHaveBeenCalledTimes(2)
  })

  it("cannot tell when the username is unknown, and the chain is not asked", async () => {
    const full = peopleWith({ full_username: new TextEncoder().encode("carol") })
    expect(await readNameSet(hostWith(null), full.people)).toBeNull()
    expect(full.query.Resources.Consumers.getValue).not.toHaveBeenCalled()
  })

  it("cannot tell, and never throws, when the chain fails", async () => {
    const broken = peopleWith("fails")
    const unreachable = vi.fn(async (): Promise<{ client: PolkadotClient }> => {
      throw new Error("no People chain")
    })
    await expect(readNameSet(hostWith("carol.01"), broken.people)).resolves.toBeNull()
    await expect(readNameSet(hostWith("carol.01"), unreachable)).resolves.toBeNull()
  })
})
