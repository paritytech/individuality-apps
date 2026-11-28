// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { NetemLifecycleParser, type NetemLifecycleEvent } from "./netem-lifecycle"

export const NETEM_INCONCLUSIVE_EXIT = 64

export class NetemError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout = "",
    readonly stderr = "",
    readonly timedOut = false,
    readonly signal: NodeJS.Signals | null = null,
  ) {
    super(message)
    this.name = "NetemError"
  }
}

export type NetemRunner = (call: readonly string[], onLifecycle?: (event: NetemLifecycleEvent) => void) => Promise<string>

interface RunNetemProcessOptions {
  timeoutMs: number
  killGraceMs?: number
  onLifecycle?: (event: NetemLifecycleEvent) => void
}

// Firewall cleanup can involve several xtables operations and cgroup moves on
// a loaded self-hosted runner. One second is not enough for the shell's TERM
// trap to finish, and killing it mid-trap can poison the next bot.
const DEFAULT_CLEANUP_GRACE_MS = 15_000

const transcript = (stdout: string, stderr: string): string => [stdout, stderr].map((value) => value.trim()).filter(Boolean).join("\n")

/** Stream a process so lifecycle markers are observed while a bounded fault is
 * still active. Only stdout reaches the protocol parser; both streams remain
 * verbatim evidence on success or failure. */
export function runNetemProcess(command: string, args: readonly string[], options: RunNetemProcessOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
    const stdoutDecoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")
    const parser = new NetemLifecycleParser()
    const killGraceMs = options.killGraceMs ?? DEFAULT_CLEANUP_GRACE_MS
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let protocolError: Error | null = null
    let spawnError: Error | null = null
    let settled = false
    let forceKill: ReturnType<typeof setTimeout> | undefined

    const signal = (name: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, name)
          return
        } catch {
          // Fall through to the direct child when the process group has
          // already exited or could not be created.
        }
      }
      child.kill(name)
    }
    const terminate = (): void => {
      signal("SIGTERM")
      forceKill ??= setTimeout(() => signal("SIGKILL"), killGraceMs)
    }
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      stdout += stdoutTail
      stderr += stderrTail
      if (!protocolError) {
        try {
          for (const event of [...parser.push(stdoutTail), ...parser.finish()]) options.onLifecycle?.(event)
        } catch (error) {
          protocolError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (!timedOut && !protocolError && !spawnError && code === 0) {
        resolve(stdout)
        return
      }
      const outcome = timedOut
        ? `timed out after ${options.timeoutMs} ms`
        : protocolError
          ? protocolError.message
          : spawnError
            ? spawnError.message
            : code === NETEM_INCONCLUSIVE_EXIT
              ? "INCONCLUSIVE"
              : `failed with exit ${code ?? exitSignal ?? "unknown"}`
      const evidence = transcript(stdout, stderr)
      reject(new NetemError(`netem process ${outcome}${evidence ? `: ${evidence}` : ""}`, code, stdout, stderr, timedOut, exitSignal))
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return
      const text = stdoutDecoder.write(chunk)
      stdout += text
      try {
        for (const event of parser.push(text)) options.onLifecycle?.(event)
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error))
        terminate()
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (!settled) stderr += stderrDecoder.write(chunk)
    })
    child.once("error", (error) => {
      spawnError = error
      finish(null, null)
    })
    child.once("close", finish)
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
  })
}

export function makeNetemRunner(
  script: string,
  options: { timeoutFor: (call: readonly string[]) => number; killGraceMs?: number },
): NetemRunner {
  return (call, onLifecycle) => runNetemProcess("bash", [script, ...call], {
    timeoutMs: options.timeoutFor(call),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    ...(onLifecycle ? { onLifecycle } : {}),
  })
}
