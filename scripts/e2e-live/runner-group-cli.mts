// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// One physical runner, 2-3 isolated logical bots. Each boot remains an
// independent process; this supervisor owns only shared network state.
import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { applySupervisorOutcome, boundaryActions, boundaryDecision, ensureGroupDirectories, finalizeGroupChild, groupChildren, noteGroupChildMessage, parseRunnerGroup, recordSharedNetem, shapeDeadline, type GroupChild, type GroupChildOutcome } from "./runner-group"
import { netemStep, type NetemCall } from "./network"

const group = parseRunnerGroup(process.env.E2E_RUNNER_GROUP)
const children = groupChildren(group, process.env, process.env.RUNNER_TEMP ?? "/tmp")
ensureGroupDirectories(children)
const processes = new Map<number, ChildProcess>()
const ready = new Map<number, number | null>()
const terminal = new Set<number>()
const released = new Set<number>()
const deadlineMissed = new Map<number, string>()
const setupAffected = new Set<number>()
const waiters = new Set<() => void>()
const wake = () => { for (const waiter of [...waiters]) waiter() }
const waitUntil = async (deadline: number): Promise<void> => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); waiters.delete(done); resolve() }
  waiters.add(done)
  const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.error(`runner group ${group.group}: forwarding ${signal} to ${processes.size} child process(es)`)
    for (const child of processes.values()) child.kill(signal)
  })
}

function pipe(label: string, stream: NodeJS.ReadableStream | null, error = false): void {
  if (!stream) return
  createInterface({ input: stream }).on("line", (line) => {
    // a child's mask command must reach the runner at the start of a line, unprefixed (player-privacy.ts, mask.ts)
    if (line.startsWith("::add-mask::")) process.stdout.write(line + "\n")
    else (error ? console.error : console.log)(`[${label}] ${line}`)
  })
}

function send(child: GroupChild, message: { type: "e2e-group-release" } | { type: "e2e-group-abort"; reason: string }): void {
  const process = processes.get(child.member.bot)
  if (process?.connected) process.send({ ...message, slot: child.member.bot })
}

function stopWithOutcome(targets: readonly GroupChild[], detail: string): void {
  for (const child of targets) {
    deadlineMissed.set(child.member.bot, detail)
    send(child, { type: "e2e-group-abort", reason: detail })
    processes.get(child.member.bot)?.kill("SIGTERM")
  }
}

async function sharedNetem(call: NetemCall): Promise<void> {
  const at = new Date().toISOString()
  try {
    const text = await netemStep(process.cwd(), children[0].out, call)
    recordSharedNetem(children, call, text, at, true)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    recordSharedNetem(children, call, `ERROR ${detail}`, at)
    throw error
  }
}

const exits = children.map(async (child) => {
  const label = `bot ${child.member.bot}`
  console.log(`[${label}] starting profile ${child.member.profile}; state ${child.env.E2E_STATE_DIR}; out ${child.out}`)
  const childProcess = spawn(process.execPath, ["--import", "tsx", "scripts/e2e-live/boot.mts"], { env: child.env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
  processes.set(child.member.bot, childProcess)
  childProcess.on("message", (raw) => {
    if (noteGroupChildMessage(raw, child.member.bot, ready, deadlineMissed)) wake()
  })
  pipe(label, childProcess.stdout)
  pipe(label, childProcess.stderr, true)
  const exit = new Promise<number>((resolve) => {
    childProcess.once("error", (error) => { console.error(`[${label}] spawn failed: ${error.message}`); resolve(1) })
    childProcess.once("close", (value, signal) => {
      if (signal) console.error(`[${label}] exited on signal ${signal}`)
      terminal.add(child.member.bot)
      processes.delete(child.member.bot)
      wake()
      resolve(value ?? 1)
    })
  })
  const outcome = await finalizeGroupChild(child, exit)
  console.log(`[${label}] finished with exit ${outcome.code}`)
  return outcome
})

const watchdog = Date.now() + 600_000
let shaped = false
let cleanupFailure = ""
let setupFailure = ""
try {
  let decision = boundaryDecision(children, ready, terminal)
  while (true) {
    const { expire } = boundaryActions(decision, released, new Set(deadlineMissed.keys()))
    if (expire.length) stopWithOutcome(expire, "registration release deadline expired before shared network setup")
    const due = shapeDeadline(decision.ready, ready, watchdog)
    if (decision.ready.length && (!decision.pending.length || Date.now() >= due)) break
    if (!decision.ready.length && !decision.pending.length) throw new Error("every child exited before the shared network boundary")
    if (Date.now() >= watchdog) {
      stopWithOutcome(decision.pending, "shared runner boundary watchdog expired")
      throw new Error("runner group boundary watchdog expired")
    }
    await waitUntil(Math.min(watchdog, due))
    decision = boundaryDecision(children, ready, terminal)
  }

  shaped = true
  await sharedNetem(["apply", group.effect_profile])

  while (true) {
    decision = boundaryDecision(children, ready, terminal)
    const actions = boundaryActions(decision, released, new Set(deadlineMissed.keys()))
    if (actions.expire.length) stopWithOutcome(actions.expire, "registration release deadline expired before supervisor release")
    for (const child of actions.release) {
      send(child, { type: "e2e-group-release" })
      released.add(child.member.bot)
    }
    const pending = decision.pending.filter(({ member }) => !deadlineMissed.has(member.bot))
    if (!pending.length) break
    if (Date.now() >= watchdog) {
      stopWithOutcome(pending, "shared runner boundary watchdog expired before child readiness")
      break
    }
    // A slower child may select a later registration window than its already
    // released siblings. Wait for its own ready message and cutoff instead of
    // inheriting an earlier sibling's deadline.
    await waitUntil(watchdog)
  }
  console.log(`runner group ${group.group}: shared ${group.effect_profile} active; released bots ${[...released].join(", ")}`)
} catch (error) {
  setupFailure = error instanceof Error ? error.message : String(error)
  const live = children.filter(({ member }) => !terminal.has(member.bot) && !deadlineMissed.has(member.bot))
  for (const child of live) {
    setupAffected.add(child.member.bot)
    send(child, { type: "e2e-group-abort", reason: setupFailure })
    processes.get(child.member.bot)?.kill("SIGTERM")
  }
  console.error(`runner group ${group.group}: ${setupFailure}`)
}

let results: GroupChildOutcome[] = []
try {
  results = await Promise.all(exits)
  const missed = children.filter(({ member }) => deadlineMissed.has(member.bot))
  if (missed.length) applySupervisorOutcome(missed, results, { kind: "shared-registration-deadline-missed", detail: "child did not reach a usable release before its registration cutoff" })
  const setup = children.filter(({ member }) => setupAffected.has(member.bot))
  if (setup.length) applySupervisorOutcome(setup, results, { kind: "shared-network-setup-failed", detail: setupFailure })
} finally {
  if (shaped) {
    try {
      await sharedNetem(["clear"])
    } catch (error) {
      cleanupFailure = error instanceof Error ? error.message : String(error)
      console.error(`runner group ${group.group}: shared network cleanup failed: ${cleanupFailure}`)
    }
  }
}
if (cleanupFailure) applySupervisorOutcome(children, results, { kind: "shared-network-cleanup-failed", detail: cleanupFailure }, { create: false })
const failed = results.filter(({ code }) => code !== 0)
const missing = results.filter(({ result }) => !result)
if (failed.length) console.error(`runner group ${group.group}: bot failures recorded in result evidence: ${failed.map(({ bot, code }) => `bot ${bot} exit ${code}`).join(", ")}`)
if (missing.length) {
  console.error(`runner group ${group.group}: missing result evidence for ${missing.map(({ bot }) => `bot ${bot}`).join(", ")}`)
  process.exit(1)
}
