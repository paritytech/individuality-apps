// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE HOST-CRASH CONTROL: kill a slot's truapi-host mid-game and start it again on the same ports and session. The page
// goes down with the host, as a phone's WebView does, and is reopened only after the listener is ready. Two halves talk
// through files in the run's output dir, because only boot.mts holds what a restart
// needs (the host's spawn env, in CI the signer mnemonic) while the journey knows WHEN (round 2 of a live game):
//
//   journey -> <out>/host-crash-<n>.request   { downS }
//   boot.mts kills the host, writes status; journey closes the page and acknowledges that with .page-closed (or writes
//   .page-close-error so boot can restore the host without mistaking the failed lifecycle for successful retirement);
//   boot.mts then waits downS, spawns the host again, waits for its port,
//   and writes <out>/host-crash-<n>.status    { killedAt, restartedAt, upS }
//
// WHAT WAS MEASURED (2026-10-04, slot e2e-boot, home page). The page sees the loss as ERR_CONNECTION_REFUSED on the host's websocket,
// about a second apart. On the DESK, with `next dev` serving the app: a host back within ~1.3 s of the kill is re-adopted (data-source
// stays host); at 2.3 s the page had already reloaded itself into the read-only websocket view (data-source=ws) and did not rejoin the
// host when it came back. On a Linux CI runner with the DEPLOYED app (boot_only a live run): a 3.5 s outage (1 s down + a cold
// respawn) was re-adopted, no reload. So the reload is next dev's doing. The long outage was
// measured since: boot_only a live run (deployed app, Linux) kept the host down 8 s, back 9.8 s after the kill, and the page
// re-adopted it with no reload. `downS` is the knob (1 = host-crash, 8 = host-crash-long in profiles.json).
//
// Pure helpers are vitest-pinned (host-crash.test.ts); the two I/O halves are the watcher and requestHostCrash.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"

export const requestFile = (out: string, n: number): string => join(out, `host-crash-${n}.request`)
export const statusFile = (out: string, n: number): string => join(out, `host-crash-${n}.status`)
export const pageClosedFile = (out: string, n: number): string => join(out, `host-crash-${n}.page-closed`)
export const pageCloseErrorFile = (out: string, n: number): string => join(out, `host-crash-${n}.page-close-error`)

export const PAGE_RETIRE_TIMEOUT_MS = 30_000
export const PAGE_CLOSE_ACK_TIMEOUT_MS = 35_000

interface PageRetirementDeps {
  collectEvidence(): Promise<void>
  evidenceFailed(error: Error): void
  crashPage(): Promise<void>
  closeContext(): Promise<void>
  isPageClosed(): boolean
}
interface PageRetirementBudget {
  totalMs?: number
  evidenceMs?: number
  crashMs?: number
}

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))
const within = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)))])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Best-effort evidence, then one bounded teardown. Expected CDP/context errors are harmless only when the old page is actually gone. */
export async function retirePageForHostCrash(d: PageRetirementDeps, budget: PageRetirementBudget = {}): Promise<void> {
  const totalMs = budget.totalMs ?? PAGE_RETIRE_TIMEOUT_MS
  const started = Date.now()
  const remaining = () => Math.max(1, totalMs - (Date.now() - started))
  try {
    await within(d.collectEvidence(), Math.min(budget.evidenceMs ?? 3_000, remaining()), "host-crash evidence")
  } catch (error) {
    try {
      d.evidenceFailed(errorOf(error))
    } catch {
      // Evidence is best-effort; even recording its failure must not block
      // teardown of the executable page.
    }
  }

  let crashError: Error | null = null
  try {
    await within(d.crashPage(), Math.min(budget.crashMs ?? 7_000, remaining()), "crash page")
  } catch (error) {
    crashError = errorOf(error)
  }

  let closeError: Error | null = null
  try {
    await within(d.closeContext(), remaining(), "close context")
  } catch (error) {
    closeError = errorOf(error)
  }

  if (d.isPageClosed()) return
  const detail = [crashError && `crash page: ${crashError.message}`, closeError && `close context: ${closeError.message}`].filter(Boolean).join("; ")
  throw new Error(`old page is still open after the ${totalMs} ms host-crash teardown${detail ? ` (${detail})` : ""}`)
}

/** What the reopened page says about the host it booted into, from the home's SETTLED read (reopenPage's settledHome),
 *  never from a second read after it. A registered player's home in a live game router.replace()s to /game as soon as
 *  it settles, and a read racing that navigation finds the root detached and reads data-source as null (game 272,
 *  bot 18: settled "live (host)" at 01:41:50, /game at 01:41:52, and the re-read said data-source=null).
 *  "no-hooks": the page shows no home test hooks, so only the filed report can prove that signing came back.
 *  `onGame`: the reopen stopped on /game before the home settled (reopenSettleDecision). Whatever the home read held then is
 *  a home still loading, never its settled source, so it is judged as no hooks too (game 317, bot 20: the read caught the
 *  home's root, the home left for /game, and the reopen was failed on data-source=null). */
export function reopenedHostVerdict(home: { hooks: boolean; source: string | null; onGame?: boolean } | null): "host" | "not-host" | "no-hooks" {
  if (!home?.hooks || home.onGame) return "no-hooks"
  return home.source === "host" ? "host" : "not-host"
}

/** Where a reopened page may stop waiting for the home to settle (reopenPage's settledHome).
 *  A registered player's home in a live game router.replace()s to /game within ~2 s of the reopen, and the game page has
 *  neither the home's test hooks nor its words, so a loop that only knows the home ran its full 40 s (game 311, bot 20,
 *  cycle 5: reopened 16:41:57, /game 16:41:59, frames and taps back only at 16:42:40; turns 9-12 played blind).
 *  "settled": the home settled; "on-game": the page is on /game, stop at once and resume the recorder and taps;
 *  "wait": keep reading; "timeout": the deadline passed on a page that is neither. */
export function reopenSettleDecision(s: { url: string; homeSettled: boolean; elapsedMs: number; timeoutMs: number }): "settled" | "on-game" | "wait" | "timeout" {
  if (s.homeSettled) return "settled"
  if (onGamePage(s.url)) return "on-game"
  return s.elapsedMs >= s.timeoutMs ? "timeout" : "wait"
}

/** The page's path is /game (with or without a trailing slash, a base path, a query or a hash). */
export function onGamePage(url: string): boolean {
  try {
    return /\/game\/?$/.test(new URL(url).pathname)
  } catch {
    return false
  }
}

export interface HostCrashRequest {
  downS: number
}
export interface HostCrashStatus {
  killedAt: string
  /** the host's pid that was killed */
  killedPid: number
  restartedAt?: string
  /** seconds from the kill until the host's port accepted a connection again */
  upS?: number
  error?: string
}

/** The truapi-host among the direct children of the dev-host node process (`ps` lines "<pid> <command>"). */
export function pickHostPid(psLines: readonly string[]): number | null {
  for (const l of psLines) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l)
    if (m && /(^|\/)truapi-host(\s|$)/.test(m[2])) return Number(m[1])
  }
  return null
}

/** The host process under dev-host's pid: its child whose command is truapi-host. */
export function hostPidOf(devHostPid: number): number | null {
  try {
    const kids = execFileSync("pgrep", ["-P", String(devHostPid)], { encoding: "utf8" }).split("\n").filter(Boolean)
    if (kids.length === 0) return null
    const ps = execFileSync("ps", ["-o", "pid=,command=", "-p", kids.join(",")], { encoding: "utf8" }).split("\n")
    return pickHostPid(ps)
  } catch {
    return null
  }
}

const portOpen = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const s = connect({ host: "127.0.0.1", port })
    s.once("connect", () => (s.destroy(), done(true)))
    s.once("error", () => (s.destroy(), done(false)))
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForPageClosed(out: string, slot: number, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(pageClosedFile(out, slot))) {
      rmSync(pageClosedFile(out, slot), { force: true })
      rmSync(pageCloseErrorFile(out, slot), { force: true })
      return null
    }
    if (existsSync(pageCloseErrorFile(out, slot))) {
      let error = "page retirement failed"
      try {
        error = readFileSync(pageCloseErrorFile(out, slot), "utf8") || error
      } catch {
        /* caught mid-write; the generic error still keeps this lifecycle failed */
      }
      rmSync(pageCloseErrorFile(out, slot), { force: true })
      return error
    }
    await sleep(50)
  }
  return `the page did not close with host slot ${slot} in ${timeoutMs / 1000} s`
}

/** What a respawn hands back: a way to hear it die. Its output goes to the `onLine` it was given. */
export interface Respawned {
  onExit(cb: (code: number | null) => void): void
}
export interface HostControlDeps {
  out: string
  slot: number
  hostPort: number
  /** the dev-host process of the slot (its pid at the time of the request) */
  devHostPid: () => number | undefined
  /** the account the host paired as at boot: the restarted host must name the same person, or it is another session */
  pairedAs: () => string | null
  /** start the host again (same ports, same session); boot.mts owns how. Every output line of the new process goes to `onLine`. */
  respawn: (onLine: (line: string) => void) => Respawned
  say: (line: string) => void
  /** how long the restarted host may take to say it is ready */
  readyTimeoutMs?: number
  /** longer than the journey's whole PAGE_RETIRE_TIMEOUT_MS; injectable only for deterministic failure tests */
  pageCloseTimeoutMs?: number
}

/** Watch for the journey's request; handle one at a time. Any failure is WRITTEN as the error status, so the journey never polls for a status that will not come. */
export function startHostControl(d: HostControlDeps): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy || !existsSync(requestFile(d.out, d.slot))) return
    busy = true
    void handle(d)
      .catch((e: Error) => {
        d.say(`host-crash slot ${d.slot}: ${e.message}`)
        const prev = existsSync(statusFile(d.out, d.slot)) ? (JSON.parse(readFileSync(statusFile(d.out, d.slot), "utf8")) as Partial<HostCrashStatus>) : {}
        writeFileSync(statusFile(d.out, d.slot), JSON.stringify({ killedAt: new Date().toISOString(), killedPid: 0, ...prev, error: e.message }))
      })
      .finally(() => (busy = false))
  }, 250)
  return () => clearInterval(timer)
}

/** Wait for the respawned host the way boot does: "Signing host ready" AND "Paired with <the same account>", or an early exit / a timeout is an error. */
function untilReady(d: HostControlDeps, respawned: (onLine: (line: string) => void) => Respawned): Promise<{ pairedAs: string | null }> {
  return new Promise((done, fail) => {
    let paired: string | null = null
    let settled = false
    const timer = setTimeout(() => finish(new Error(`the restarted host was not ready in ${(d.readyTimeoutMs ?? 120_000) / 1000} s`)), d.readyTimeoutMs ?? 120_000)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) fail(error)
      else done({ pairedAs: paired })
    }
    const proc = respawned((line) => {
      const m = /Paired with (\S+)/.exec(line)
      if (m) paired = m[1]
      if (line.includes("Signing host ready")) {
        const want = d.pairedAs()
        if (want && paired !== want) finish(new Error(`the restarted host paired as ${paired ?? "nobody"}, the slot's account is ${want}`))
        else finish()
      }
    })
    proc.onExit((code) => finish(new Error(`the restarted host exited early (code ${code}) before it was ready`)))
  })
}

async function handle(d: HostControlDeps): Promise<void> {
  const req = JSON.parse(readFileSync(requestFile(d.out, d.slot), "utf8")) as HostCrashRequest
  rmSync(requestFile(d.out, d.slot), { force: true })
  const dev = d.devHostPid()
  const pid = dev === undefined ? null : hostPidOf(dev)
  if (pid === null) throw new Error("no truapi-host process found under the slot's dev-host")
  const killedMs = Date.now()
  process.kill(pid, "SIGKILL")
  const status: HostCrashStatus = { killedAt: new Date(killedMs).toISOString(), killedPid: pid }
  writeFileSync(statusFile(d.out, d.slot), JSON.stringify(status))
  d.say(`host-crash slot ${d.slot}: killed truapi-host ${pid}; down for ${req.downS} s`)
  // A phone loses its WebView with its host. Do not let next dev reload the
  // surviving page into browser mode before the replacement host is ready.
  const pageCloseError = await waitForPageClosed(d.out, d.slot, d.pageCloseTimeoutMs ?? PAGE_CLOSE_ACK_TIMEOUT_MS)
  await sleep(req.downS * 1000)
  const ready = await untilReady(d, d.respawn)
  // the port is the page's door: it must accept as well as the host saying it is ready
  for (let i = 0; i < 40 && !(await portOpen(d.hostPort)); i++) await sleep(250)
  if (!(await portOpen(d.hostPort))) throw new Error("the host said it was ready but its port accepts no connection")
  status.restartedAt = new Date().toISOString()
  status.upS = Math.round((Date.now() - killedMs) / 100) / 10
  if (pageCloseError) status.error = pageCloseError
  writeFileSync(statusFile(d.out, d.slot), JSON.stringify(status))
  d.say(`host-crash slot ${d.slot}: host back on :${d.hostPort} after ${status.upS} s, paired as ${ready.pairedAs ?? "?"}${pageCloseError ? `; lifecycle FAILED: ${pageCloseError}` : ""}`)
}

/** The journey's half: ask boot.mts for the crash and wait for it to finish (killed, page closed, then restarted). `onKilled` closes the page; its completion releases the restart. */
export async function requestHostCrash(out: string, slot: number, downS: number, onKilled: (s: HostCrashStatus) => void | Promise<void>, timeoutS = downS + 120): Promise<HostCrashStatus> {
  rmSync(statusFile(out, slot), { force: true })
  rmSync(pageClosedFile(out, slot), { force: true })
  rmSync(pageCloseErrorFile(out, slot), { force: true })
  writeFileSync(requestFile(out, slot), JSON.stringify({ downS } satisfies HostCrashRequest))
  let told = false
  let callbackError: Error | null = null
  for (let t = 0; t < timeoutS * 4; t++) {
    await sleep(250)
    if (!existsSync(statusFile(out, slot))) continue
    let s: HostCrashStatus
    try {
      s = JSON.parse(readFileSync(statusFile(out, slot), "utf8")) as HostCrashStatus
    } catch {
      continue // caught mid-write
    }
    if (!told && !s.error) {
      told = true
      try {
        await onKilled(s)
        // This file means exactly what it says: only verified retirement can
        // release the successful lifecycle.
        writeFileSync(pageClosedFile(out, slot), new Date().toISOString())
      } catch (error) {
        callbackError = errorOf(error)
        // Distinct from page-closed: boot restores the host best-effort, but
        // reports an error and the journey never opens a replacement page.
        writeFileSync(pageCloseErrorFile(out, slot), callbackError.message)
      }
    }
    if (s.error || s.restartedAt) {
      if (callbackError) throw callbackError
      return s
    }
  }
  throw new Error(`boot.mts did not finish the host crash for slot ${slot} in ${timeoutS} s`)
}
