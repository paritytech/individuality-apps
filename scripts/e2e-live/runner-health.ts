// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, readFileSync } from "node:fs"
import { freemem, loadavg, totalmem } from "node:os"

export interface CpuTimes {
  idle: number
  total: number
}

export interface NetworkCounters {
  rxBytes: number
  rxPackets: number
  rxErrors: number
  rxDropped: number
  txBytes: number
  txPackets: number
  txErrors: number
  txDropped: number
}

export function parseProcStat(text: string): CpuTimes | undefined {
  const line = text.split("\n").find((candidate) => /^cpu\s/.test(candidate))
  if (!line) return undefined
  const values = line.trim().split(/\s+/).slice(1).map(Number)
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return undefined
  const idle = values[3] + (values[4] ?? 0)
  return { idle, total: values.reduce((sum, value) => sum + value, 0) }
}

export function cpuBusyPercent(previous: CpuTimes | undefined, current: CpuTimes | undefined): number | undefined {
  if (!previous || !current) return undefined
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (total <= 0 || idle < 0) return undefined
  return +Math.max(0, Math.min(100, ((total - idle) / total) * 100)).toFixed(2)
}

export function parseProcNetDev(text: string): Record<string, NetworkCounters> {
  const interfaces: Record<string, NetworkCounters> = {}
  for (const raw of text.split("\n")) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(raw)
    if (!match) continue
    const values = match[2].trim().split(/\s+/).map(Number)
    if (values.length < 16 || values.some((value) => !Number.isFinite(value))) continue
    interfaces[match[1].trim()] = {
      rxBytes: values[0],
      rxPackets: values[1],
      rxErrors: values[2],
      rxDropped: values[3],
      txBytes: values[8],
      txPackets: values[9],
      txErrors: values[10],
      txDropped: values[11],
    }
  }
  return interfaces
}

/** The runner's TCP counters that say who ended a connection (issue #944).
 *  EstabResets counts established connections that went straight to CLOSED
 *  (a reset, either way); OutRsts counts resets this host sent. Five links
 *  dropping together with EstabResets up by five and OutRsts flat means the
 *  far end reset them; OutRsts up means a local abort; neither means a
 *  graceful close (FIN). A relay-only bot runs alone on its runner
 *  (runner-group.ts), so the deltas at its drop are its own. */
export interface TcpCounters {
  activeOpens?: number
  attemptFails?: number
  estabResets?: number
  currEstab?: number
  retransSegs?: number
  inErrs?: number
  outRsts?: number
  /** /proc/net/netstat TcpExt: connections this host aborted, and why */
  abortOnData?: number
  abortOnClose?: number
  abortOnTimeout?: number
}

/** One "Prefix: names…" / "Prefix: values…" line pair of /proc/net/snmp or
 *  /proc/net/netstat, by name; empty when the file has no such pair. */
export function parseProcPairs(text: string, prefix: string): Record<string, number> {
  const lines = text.split("\n").filter((line) => line.startsWith(`${prefix}:`))
  if (lines.length < 2) return {}
  const names = lines[0].slice(prefix.length + 1).trim().split(/\s+/)
  const values = lines[1].slice(prefix.length + 1).trim().split(/\s+/).map(Number)
  const out: Record<string, number> = {}
  names.forEach((name, index) => {
    const value = values[index]
    if (name && Number.isFinite(value)) out[name] = value
  })
  return out
}

const pick = (from: Record<string, number>, to: TcpCounters, pairs: Array<[keyof TcpCounters, string]>) => {
  for (const [key, name] of pairs) if (from[name] !== undefined) to[key] = from[name]
}

/** The TCP counters of /proc/net/snmp (Tcp) and /proc/net/netstat (TcpExt);
 *  undefined when neither file has them. */
export function parseTcpCounters(snmp: string, netstat = ""): TcpCounters | undefined {
  const counters: TcpCounters = {}
  pick(parseProcPairs(snmp, "Tcp"), counters, [
    ["activeOpens", "ActiveOpens"],
    ["attemptFails", "AttemptFails"],
    ["estabResets", "EstabResets"],
    ["currEstab", "CurrEstab"],
    ["retransSegs", "RetransSegs"],
    ["inErrs", "InErrs"],
    ["outRsts", "OutRsts"],
  ])
  pick(parseProcPairs(netstat, "TcpExt"), counters, [
    ["abortOnData", "TCPAbortOnData"],
    ["abortOnClose", "TCPAbortOnClose"],
    ["abortOnTimeout", "TCPAbortOnTimeout"],
  ])
  return Object.keys(counters).length ? counters : undefined
}

interface RunnerHealthOptions {
  intervalMs?: number
  now?: () => number
  readText?: (path: string) => string
  append?: (line: string) => void
}

/** Preserve runner pressure, kernel packet-loss counters and TCP reset
 * counters beside every bot's raw evidence. Linux exposes all of them without
 * privileges; local non-Linux runs retain an explicit unavailable sample rather
 * than silently omitting it. */
export function startRunnerHealth(path: string, options: RunnerHealthOptions = {}): () => void {
  const now = options.now ?? Date.now
  const readText = options.readText ?? ((file: string) => readFileSync(file, "utf8"))
  const append = options.append ?? ((line: string) => appendFileSync(path, line))
  let previousCpu: CpuTimes | undefined

  const safeAppend = (line: string) => {
    try {
      append(line)
    } catch {
      // Evidence collection is strictly best-effort. In particular, a full
      // disk must not let either the immediate sample or the interval callback
      // escape and terminate the bot before it can preserve other artifacts.
    }
  }

  const sample = () => {
    try {
      let row: string
      try {
        const at = now()
        const cpu = parseProcStat(readText("/proc/stat"))
        const network = parseProcNetDev(readText("/proc/net/dev"))
        // on its own: a runner without these files keeps the CPU and interface sample
        let tcp: TcpCounters | undefined
        let tcpUnavailable: string | undefined
        try {
          const netstat = (() => {
            try { return readText("/proc/net/netstat") } catch { return "" }
          })()
          tcp = parseTcpCounters(readText("/proc/net/snmp"), netstat)
          if (!tcp) tcpUnavailable = "no Tcp counters in /proc/net/snmp"
        } catch (error) {
          tcpUnavailable = error instanceof Error ? error.message : String(error)
        }
        row = JSON.stringify({
          at,
          atIso: new Date(at).toISOString(),
          cpuBusyPercent: cpuBusyPercent(previousCpu, cpu),
          loadAverage: loadavg(),
          memoryBytes: { free: freemem(), total: totalmem() },
          network,
          ...(tcp ? { tcp } : { tcpUnavailable }),
        }) + "\n"
        previousCpu = cpu
      } catch (error) {
        const at = (() => {
          try { return now() } catch { return undefined }
        })()
        row = JSON.stringify({
          ...(at === undefined ? {} : { at, atIso: new Date(at).toISOString() }),
          unavailable: error instanceof Error ? error.message : String(error),
        }) + "\n"
      }
      safeAppend(row)
    } catch {
      // Even constructing the diagnostic row is non-critical to the game.
    }
  }

  sample()
  const timer = setInterval(sample, options.intervalMs ?? 5_000)
  timer.unref()
  return () => clearInterval(timer)
}
