// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { cpuBusyPercent, parseProcNetDev, parseProcPairs, parseProcStat, parseTcpCounters, startRunnerHealth } from "./runner-health"

// as a Linux kernel prints them (trimmed TcpExt: the real line has ~120 names)
const SNMP = [
  "Ip: Forwarding DefaultTTL InReceives",
  "Ip: 1 64 77097",
  "Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors",
  "Tcp: 1 200 120000 -1 1450 12 31 207 42 900000 850000 1200 0 330 0",
  "Udp: InDatagrams NoPorts",
  "Udp: 5000 3",
].join("\n")
const NETSTAT = [
  "TcpExt: SyncookiesSent TCPAbortOnData TCPAbortOnClose TCPAbortOnMemory TCPAbortOnTimeout",
  "TcpExt: 0 17 4 0 2",
].join("\n")

describe("runner health evidence", () => {
  it("derives CPU pressure from consecutive Linux counters", () => {
    expect(parseProcStat("cpu  100 20 30 400 50 0 0 0\ncpu0 1 2 3 4")).toEqual({ idle: 450, total: 600 })
    expect(cpuBusyPercent({ idle: 450, total: 600 }, { idle: 500, total: 700 })).toBe(50)
  })

  it("retains per-interface packet, error, and drop counters", () => {
    const parsed = parseProcNetDev(`Inter-| Receive | Transmit\n eth0: 100 2 3 4 0 0 0 0 500 6 7 8 0 0 0 0`)
    expect(parsed.eth0).toEqual({
      rxBytes: 100, rxPackets: 2, rxErrors: 3, rxDropped: 4,
      txBytes: 500, txPackets: 6, txErrors: 7, txDropped: 8,
    })
  })

  it("reads the TCP counters that say who ended a connection (#944)", () => {
    expect(parseProcPairs(SNMP, "Udp")).toEqual({ InDatagrams: 5000, NoPorts: 3 })
    expect(parseTcpCounters(SNMP, NETSTAT)).toEqual({
      activeOpens: 1450, attemptFails: 31, estabResets: 207, currEstab: 42, retransSegs: 1200, inErrs: 0, outRsts: 330,
      abortOnData: 17, abortOnClose: 4, abortOnTimeout: 2,
    })
    // TcpExt is a second file: its absence keeps the Tcp line
    expect(parseTcpCounters(SNMP)).toMatchObject({ estabResets: 207, outRsts: 330 })
    expect(parseTcpCounters(SNMP)).not.toHaveProperty("abortOnData")
    // a file with no Tcp pair (or another file's text) is no counters, not zeros
    expect(parseTcpCounters("eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0")).toBeUndefined()
    expect(parseProcPairs("Tcp: RtoAlgorithm EstabResets", "Tcp")).toEqual({})
  })

  it("keeps the CPU and interface sample when the TCP counters cannot be read", () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const readText = vi.fn((path: string) => {
      if (path === "/proc/stat") return "cpu  1 2 3 4 5 6 7 8\n"
      if (path === "/proc/net/dev") return "eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0"
      throw new Error(`ENOENT: ${path}`)
    })
    const stop = startRunnerHealth("unused", { now: () => 1_000, readText, append: (line) => lines.push(line) })
    const row = JSON.parse(lines[0])
    expect(row).toMatchObject({ at: 1_000, network: { eth0: { rxBytes: 10 } }, tcpUnavailable: "ENOENT: /proc/net/snmp" })
    expect(row).not.toHaveProperty("unavailable")
    expect(row).not.toHaveProperty("tcp")
    stop()
    vi.useRealTimers()
  })

  it("samples the TCP counters beside the interfaces", () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const files: Record<string, string> = {
      "/proc/stat": "cpu  1 2 3 4 5 6 7 8\n",
      "/proc/net/dev": "eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0",
      "/proc/net/snmp": SNMP,
      "/proc/net/netstat": NETSTAT,
    }
    const stop = startRunnerHealth("unused", { now: () => 1_000, readText: (path) => files[path], append: (line) => lines.push(line) })
    expect(JSON.parse(lines[0])).toMatchObject({ tcp: { estabResets: 207, outRsts: 330, abortOnData: 17 } })
    stop()
    vi.useRealTimers()
  })

  it("writes an immediate sample and keeps failures as evidence", () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const readText = vi.fn((path: string) => {
      if (path === "/proc/stat") return "cpu  1 2 3 4 5 6 7 8\n"
      return "eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0"
    })
    const stop = startRunnerHealth("unused", { now: () => 1_000, readText, append: (line) => lines.push(line) })
    expect(JSON.parse(lines[0])).toMatchObject({ at: 1_000, network: { eth0: { rxBytes: 10, txBytes: 20 } } })
    readText.mockImplementation(() => { throw new Error("proc unavailable") })
    vi.advanceTimersByTime(5_000)
    expect(JSON.parse(lines[1])).toMatchObject({ unavailable: "proc unavailable" })
    stop()
    vi.useRealTimers()
  })

  it("never lets evidence-write failures escape the initial or timer sample", () => {
    vi.useFakeTimers()
    const append = vi.fn(() => { throw new Error("disk full") })
    const readText = vi.fn((path: string) => path === "/proc/stat"
      ? "cpu  1 2 3 4 5 6 7 8\n"
      : "eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0")

    let stop: (() => void) | undefined
    expect(() => {
      stop = startRunnerHealth("unused", { readText, append })
    }).not.toThrow()
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
    expect(append).toHaveBeenCalledTimes(2)

    stop?.()
    vi.useRealTimers()
  })

  it("never lets a broken clock escape sampling", () => {
    vi.useFakeTimers()
    const stop = startRunnerHealth("unused", {
      now: () => { throw new Error("clock unavailable") },
      append: () => { throw new Error("disk full") },
    })
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
    stop()
    vi.useRealTimers()
  })
})
