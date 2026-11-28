// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  pageCloseErrorFile,
  pageClosedFile,
  pickHostPid,
  onGamePage,
  reopenSettleDecision,
  reopenedHostVerdict,
  requestFile,
  requestHostCrash,
  retirePageForHostCrash,
  startHostControl,
  statusFile,
} from "./host-crash"

describe("reopenedHostVerdict (the reopened page's host, from the home's settled read)", () => {
  it("game 272, bot 18: the settled read saw host; the re-read raced the home's router.replace to /game and saw null", () => {
    // relaunched note: "relaunched: new context, home live (host)"; browser log: NAV / at 01:41:50, NAV /game at 01:41:52
    expect(reopenedHostVerdict({ hooks: true, source: "host" })).toBe("host")
    // what the racing second read returned: the old code turned this into "the reopened page reads data-source=null"
    expect(reopenedHostVerdict({ hooks: true, source: null })).toBe("not-host")
  })
  it("a page that booted into the websocket view is still a problem", () => {
    expect(reopenedHostVerdict({ hooks: true, source: "ws" })).toBe("not-host")
  })
  it("game 317, bot 20: the reopen stopped on /game while the home's read still held a loading root: no hooks, never not-host", () => {
    // relaunched note: "relaunched: new context, home ? (?)"; browser log: NAV / at 16:41:57, NAV /game at 16:41:58; the
    // reopen was failed on "the reopened page reads data-source=null, not host"
    expect(reopenedHostVerdict({ hooks: true, source: null, onGame: true })).toBe("no-hooks")
    // the same read on a page that stayed on the home is still a problem (a reopen into no host)
    expect(reopenedHostVerdict({ hooks: true, source: null, onGame: false })).toBe("not-host")
    expect(reopenedHostVerdict({ hooks: true, source: "ws" })).toBe("not-host")
  })
  it("no home hooks (already on /game, or an old build) leaves the proof to the filed report", () => {
    expect(reopenedHostVerdict({ hooks: false, source: null })).toBe("no-hooks")
    expect(reopenedHostVerdict(null)).toBe("no-hooks")
  })
})

describe("pickHostPid", () => {
  it("takes the truapi-host child, not the wrapped npm exec", () => {
    expect(pickHostPid(["31491 truapi-host dev --network paseo-next-v2 --port 21000", "31509 npm exec next dev"])).toBe(31491)
    expect(pickHostPid(["22 /opt/x/.local/bin/truapi-host dev --port 1"])).toBe(22)
  })
  it("is null when there is no host among the children", () => {
    expect(pickHostPid(["31509 npm exec next dev --port 21100", "7 node truapi-host-wrapper.js"])).toBeNull()
    expect(pickHostPid([])).toBeNull()
  })
})

describe("retirePageForHostCrash", () => {
  it("bounds pending evidence without preventing verified teardown", async () => {
    let closed = false
    const evidenceErrors: string[] = []
    await retirePageForHostCrash(
      {
        collectEvidence: () => new Promise(() => {}),
        evidenceFailed: (error) => evidenceErrors.push(error.message),
        crashPage: async () => {
          throw new Error("CDP unavailable")
        },
        closeContext: async () => {
          closed = true
        },
        isPageClosed: () => closed,
      },
      { totalMs: 100, evidenceMs: 10, crashMs: 10 },
    )
    expect(evidenceErrors).toEqual([expect.stringMatching(/evidence.*10 ms/i)])
    expect(closed).toBe(true)
  })

  it("rejects a failed crash plus hung close while the old page remains alive", async () => {
    await expect(
      retirePageForHostCrash(
        {
          collectEvidence: async () => {},
          evidenceFailed: () => {},
          crashPage: async () => {
            throw new Error("crash failed")
          },
          closeContext: () => new Promise(() => {}),
          isPageClosed: () => false,
        },
        { totalMs: 50, evidenceMs: 5, crashMs: 5 },
      ),
    ).rejects.toThrow(/old page is still open.*crash failed.*close context.*timed out/i)
  })

  it("accepts expected teardown errors only when the page is demonstrably already closed", async () => {
    await expect(
      retirePageForHostCrash(
        {
          collectEvidence: async () => {},
          evidenceFailed: () => {},
          crashPage: async () => {
            throw new Error("target closed")
          },
          closeContext: async () => {
            throw new Error("context already closed")
          },
          isPageClosed: () => true,
        },
        { totalMs: 50, evidenceMs: 5, crashMs: 5 },
      ),
    ).resolves.toBeUndefined()
  })
})

describe("the request/status protocol, end to end with a real child process", () => {
  it("kills the process under the dev-host, waits downS, respawns, and reports both times", async () => {
    const out = mkdtempSync(join(tmpdir(), "host-crash-"))
    // a port the 'host' listens on, as the respawn will
    const server = createServer().listen(0, "127.0.0.1")
    await new Promise((r) => server.once("listening", r))
    const port = (server.address() as { port: number }).port
    server.close()
    await new Promise((r) => server.once("close", r))
    const { spawn } = await import("node:child_process")
    // a fake dev-host whose only child is named truapi-host (a node script that idles): the control must find and kill exactly it
    const bin = join(out, "truapi-host")
    writeFileSync(bin, "setInterval(() => {}, 1000)\n")
    const parent = spawn("sh", ["-c", `${process.execPath} ${bin} & wait`], { stdio: "ignore", detached: true })
    await new Promise((r) => setTimeout(r, 400))
    let respawned = 0
    let pageClosed = false
    let respawnSawClosed = false
    const lines: string[] = []
    const stop = startHostControl({
      out,
      slot: 3,
      hostPort: port,
      devHostPid: () => parent.pid,
      pairedAs: () => "jollityzzzz.01",
      respawn: (onLine) => {
        respawned++
        respawnSawClosed = pageClosed
        const s = createServer().listen(port, "127.0.0.1")
        setTimeout(() => s.close(), 2000)
        setTimeout(() => (onLine("✓ Paired with jollityzzzz.01"), onLine("Signing host ready")), 50)
        return { onExit: () => {} }
      },
      say: (l) => lines.push(l),
    })
    const killed: unknown[] = []
    const status = await requestHostCrash(out, 3, 1, async (s) => {
      killed.push(s)
      // Closing a real browser context can take longer than the requested
      // outage. The controller must not respawn until the dead host's page is
      // gone, otherwise next dev can reload that page outside truapi-host.
      await new Promise((r) => setTimeout(r, 1250))
      pageClosed = true
    }, 20)
    stop()
    try {
      process.kill(-(parent.pid as number), "SIGKILL")
    } catch {
      /* already gone */
    }
    expect(killed).toHaveLength(1)
    expect(status.killedPid).toBeGreaterThan(0)
    expect(status.error).toBeUndefined()
    expect(status.restartedAt).toBeTruthy()
    expect(status.upS).toBeGreaterThanOrEqual(1)
    expect(respawned).toBe(1)
    expect(respawnSawClosed).toBe(true)
    expect(pageClosedFile(out, 3)).not.toBe(requestFile(out, 3))
    expect(existsSync(pageClosedFile(out, 3))).toBe(false)
    expect(lines.join("\n")).toMatch(/killed truapi-host/)
    expect(requestFile(out, 3)).not.toBe(statusFile(out, 3))
  }, 30_000)

  it("reports an error, never a kill, when the slot has no host process", async () => {
    const out = mkdtempSync(join(tmpdir(), "host-crash-"))
    const stop = startHostControl({ out, slot: 1, hostPort: 1, devHostPid: () => undefined, pairedAs: () => null, respawn: () => ({ onExit: () => {} }), say: () => {} })
    const s = await requestHostCrash(out, 1, 1, () => {}, 10)
    stop()
    expect(s.error).toMatch(/no truapi-host/)
    expect(s.killedPid).toBe(0)
  })
})

describe("failed page retirement restores the host but fails the lifecycle", () => {
  const rig = async (out: string, slot: number, pageCloseTimeoutMs: number) => {
    const server = createServer().listen(0, "127.0.0.1")
    await new Promise((r) => server.once("listening", r))
    const port = (server.address() as { port: number }).port
    server.close()
    await new Promise((r) => server.once("close", r))
    const { spawn } = await import("node:child_process")
    const bin = join(out, "truapi-host")
    writeFileSync(bin, "setInterval(() => {}, 1000)\n")
    const parent = spawn("sh", ["-c", `${process.execPath} ${bin} & wait`], { stdio: "ignore", detached: true })
    await new Promise((r) => setTimeout(r, 400))
    let respawned = 0
    const stop = startHostControl({
      out,
      slot,
      hostPort: port,
      devHostPid: () => parent.pid,
      pairedAs: () => "jollityzzzz.01",
      respawn: (onLine) => {
        respawned++
        const listener = createServer().listen(port, "127.0.0.1")
        setTimeout(() => listener.close(), 2000)
        setTimeout(() => (onLine("Paired with jollityzzzz.01"), onLine("Signing host ready")), 20)
        return { onExit: () => {} }
      },
      say: () => {},
      pageCloseTimeoutMs,
    })
    const cleanup = () => {
      stop()
      try {
        process.kill(-(parent.pid as number), "SIGKILL")
      } catch {
        /* already gone */
      }
    }
    return { cleanup, respawned: () => respawned }
  }

  it("restores with an error when no page-close acknowledgement arrives", async () => {
    const out = mkdtempSync(join(tmpdir(), "host-crash-missing-ack-"))
    const h = await rig(out, 4, 100)
    writeFileSync(requestFile(out, 4), JSON.stringify({ downS: 0 }))
    let status: { restartedAt?: string; error?: string } = {}
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !status.restartedAt) {
      await new Promise((r) => setTimeout(r, 50))
      if (existsSync(statusFile(out, 4))) status = JSON.parse(readFileSync(statusFile(out, 4), "utf8"))
    }
    h.cleanup()
    expect(h.respawned()).toBe(1)
    expect(status.restartedAt).toBeTruthy()
    expect(status.error).toMatch(/page did not close.*0.1 s/i)
  }, 10_000)

  it("propagates a callback rejection after signalling failure and restoring the host", async () => {
    const out = mkdtempSync(join(tmpdir(), "host-crash-callback-error-"))
    const h = await rig(out, 5, 1000)
    await expect(
      requestHostCrash(out, 5, 0, async () => {
        throw new Error("page retirement failed")
      }, 10),
    ).rejects.toThrow(/page retirement failed/)
    h.cleanup()
    expect(h.respawned()).toBe(1)
    expect(existsSync(pageClosedFile(out, 5))).toBe(false)
    expect(existsSync(pageCloseErrorFile(out, 5))).toBe(false)
    const status = JSON.parse(readFileSync(statusFile(out, 5), "utf8")) as { restartedAt?: string; error?: string }
    expect(status.restartedAt).toBeTruthy()
    expect(status.error).toMatch(/page retirement failed/)
  }, 10_000)
})

describe("the restarted host must really be back", () => {
  const rig = async (respawn: (onLine: (l: string) => void) => { onExit(cb: (c: number | null) => void): void }, readyTimeoutMs = 3000) => {
    const out = mkdtempSync(join(tmpdir(), "host-crash-"))
    const bin = join(out, "truapi-host")
    writeFileSync(bin, "setInterval(() => {}, 1000)\n")
    const { spawn } = await import("node:child_process")
    const parent = spawn("sh", ["-c", `${process.execPath} ${bin} & wait`], { stdio: "ignore", detached: true })
    await new Promise((r) => setTimeout(r, 400))
    const stop = startHostControl({ out, slot: 2, hostPort: 1, devHostPid: () => parent.pid, pairedAs: () => "jollityaaaa.11", respawn, say: () => {}, readyTimeoutMs })
    const t0 = Date.now()
    const s = await requestHostCrash(out, 2, 0, () => {}, 15)
    stop()
    try {
      process.kill(-(parent.pid as number), "SIGKILL")
    } catch {
      /* gone */
    }
    return { s, took: Date.now() - t0 }
  }
  it("an early exit is an error status at once, not a poll until the timeout", async () => {
    const { s, took } = await rig((onLine) => (void onLine, { onExit: (cb) => void setTimeout(() => cb(1), 50) }))
    expect(s.error).toMatch(/exited early \(code 1\)/)
    expect(took).toBeLessThan(5000)
  }, 20_000)
  it("a host that pairs as someone else is an error", async () => {
    const { s } = await rig((onLine) => (setTimeout(() => (onLine("Paired with jollitybbbb.22"), onLine("Signing host ready")), 20), { onExit: () => {} }))
    expect(s.error).toMatch(/paired as jollitybbbb.22, the slot's account is jollityaaaa.11/)
  }, 20_000)
  it("a host that never says ready is an error after the timeout", async () => {
    const { s } = await rig(() => ({ onExit: () => {} }), 500)
    expect(s.error).toMatch(/not ready in 0.5 s/)
  }, 20_000)
})

describe("reopenSettleDecision (#638: a reopen that lands on /game must not wait out the home)", () => {
  const T = 40_000
  const base = { homeSettled: false, timeoutMs: T }
  it("cycle 4 (game 301): the read lands on the home before the navigation, so it settles from the hooks", () => {
    expect(reopenSettleDecision({ ...base, url: "http://localhost:3001/", homeSettled: true, elapsedMs: 12_000 })).toBe("settled")
  })
  it("cycle 5 (game 311): / at 16:41:57, /game at 16:41:59, so it stops 2 s in instead of at 40 s", () => {
    expect(reopenSettleDecision({ ...base, url: "http://localhost:3001/", elapsedMs: 1_000 })).toBe("wait")
    expect(reopenSettleDecision({ ...base, url: "http://localhost:3001/game", elapsedMs: 2_000 })).toBe("on-game")
    expect(reopenSettleDecision({ ...base, url: "http://localhost:3001/game", elapsedMs: 39_000 })).toBe("on-game")
  })
  it("keeps waiting on the home until the deadline when the app really stays there", () => {
    expect(reopenSettleDecision({ ...base, url: "http://localhost:3001/", elapsedMs: 39_999 })).toBe("wait")
    expect(reopenSettleDecision({ ...base, url: "http://localhost:3001/", elapsedMs: T })).toBe("timeout")
  })
  it("recognises /game with a base path, a trailing slash, a query; not other pages", () => {
    expect(onGamePage("http://x/base/game/?preview=play")).toBe(true)
    expect(onGamePage("http://x/game#t")).toBe(true)
    expect(onGamePage("http://x/")).toBe(false)
    expect(onGamePage("http://x/gamer")).toBe(false)
    expect(onGamePage("about:blank")).toBe(false)
    expect(onGamePage("garbage")).toBe(false)
  })
})
