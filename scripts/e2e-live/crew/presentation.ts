// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describeGuard, identityFor, PEER_FAULT_DESCRIPTIONS, type Guard, type Profile, type TelemetryTorture, type TimelineStep } from "../profile"
import { allowsScriptedNeverTextWindow, isExpectedT9IsolationGuard } from "../guards"
import { networkPlan } from "../network"
import { knownProfiles, profileForName } from "../profiles"
import { dueActions, type ActId } from "../role-proof"
import { rolePlan, type RolePlan } from "../roles"
import type { CrewIdentity, PublicParameter, ScenarioActionPresentation, ScenarioPresentation } from "./catalogue"

const boundedNetworkCalls = new Set(["spike", "blackout", "outage", "udp-cut", "video-stall", "host-chain-cut", "host-chain-hang"])
const recoveryRoleActions = new Set(["relaunched", "visible", "rejoined", "host-restarted", "host-reconnected", "reloaded", "thawed", "video-enabled"])

const sentenceList = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? "ordinary healthy play") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`

const title = (name: string): string =>
  name
    .replace(/^game\d+-/, "")
    .split("-")
    .map((word) => (/^t\d+$/.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ")

const timing = (step: TimelineStep): string =>
  step.atTurn !== undefined
    ? `at turn ${step.atTurn}`
    : step.atS !== undefined
      ? `${step.atS} seconds after the game starts`
      : step.atBeforeGameS !== undefined
        ? `${step.atBeforeGameS} seconds before the game starts`
        : step.atOpen
          ? "when the app opens"
          : step.atSignUp
            ? "at sign-up"
            : step.atConfirm
              ? "when confirmation opens"
              : "during the run"

const impairment = (step: TimelineStep): string => {
  const parts: string[] = []
  if (step.profile) parts.push(`switch the link to ${step.profile}`)
  if (step.delayMs !== undefined) parts.push(`set ${step.delayMs} ms delay`)
  if (step.jitterMs !== undefined) parts.push(`set ${step.jitterMs} ms jitter`)
  if (step.lossPct !== undefined) parts.push(`apply ${step.lossPct}% packet loss${step.forS ? ` for ${step.forS} seconds` : ""}`)
  if (step.rateMbit !== undefined) parts.push(`limit the link to ${step.rateMbit} Mbit/s`)
  if (step.blackoutS !== undefined) parts.push(`drop the whole link for ${step.blackoutS} seconds`)
  if (step.outage) parts.push(`take ${step.outage} offline for ${step.forS} seconds`)
  if (step.udpCutS !== undefined) parts.push(`cut UDP for ${step.udpCutS} seconds while signaling stays reachable`)
  if (step.videoStallS !== undefined) parts.push(`stall RTP video for ${step.videoStallS} seconds while ICE consent stays live`)
  if (step.hostChainCutS !== undefined) {
    const holdS = step.hostChainHoldS ?? step.hostChainCutS
    parts.push(
      holdS === step.hostChainCutS
        ? `drop the signing host's People RPC sockets and refuse new connections for ${holdS} seconds`
        : `drop the signing host's People RPC sockets and refuse new connections for ${holdS} seconds, then observe reconnection through the rest of the ${step.hostChainCutS}-second window`,
    )
  }
  if (step.hostChainHangS !== undefined) parts.push(`silently hang the host chain path for ${step.hostChainHangS} seconds`)
  if (step.allowUdp) parts.push("restore direct UDP")
  if (step.concurrent) parts.push("run the disruption concurrently with the triggering game action")
  return sentenceList(parts)
}

const backgroundPurpose = (fromS: number, untilS: number): string =>
  `hide the app ${fromS} seconds after confirmation opens and show it again after ${untilS - fromS} seconds hidden (${untilS} seconds after confirmation opens)`

const rolePurpose = (role: RolePlan): string | null => {
  switch (role.kind) {
    case "baseline":
      return role.changeVerdictThenConfirm ? "change one verdict and restore it, then confirm during the countdown" : null
    case "late-join":
      return `leave the app and rejoin after turn ${role.joinAfterTurn}`
    case "video-return":
      return `rejoin after turn ${role.joinAfterTurn}${role.enableAtTurn ? `, enable video at turn ${role.enableAtTurn}` : ""}${role.disableAtTurn ? `, then disable it at turn ${role.disableAtTurn}` : ""}`
    case "background":
      return backgroundPurpose(role.background.fromS, role.background.untilS)
    case "kill-relaunch":
      return `kill the app in round ${role.killInRound} and relaunch it${role.background ? `, then ${backgroundPurpose(role.background.fromS, role.background.untilS)}` : ""}`
    case "seat-preparing":
      return "exercise a freshly bound seat while it is preparing"
    case "tap-storm":
      return `apply ${role.flips} opposing tap pairs per turn`
    case "host-crash":
      return `stop the signing host in round ${role.crashInRound} for ${role.downS} seconds, then restart it`
    case "reload":
      return `reload the page at turn ${role.reloadAtTurn}`
    case "hidden-step":
      return `hide at turn ${role.hideAtTurn}, step the clock by ${role.stepS} seconds, and return at turn ${role.showAtTurn}`
    case "freeze":
      return `freeze visible JavaScript at turn ${role.freezeAtTurn} for ${role.freezeS} seconds`
  }
}

const roleActionDescription = (role: RolePlan, action: ActId): string => {
  switch (action) {
    case "killed":
      return role.kind === "kill-relaunch" ? `kill the app in round ${role.killInRound}` : "kill the app"
    case "relaunched":
      return role.kind === "kill-relaunch"
        ? "relaunch the app on the same host slot"
        : "relaunch the app"
    case "hidden": {
      const background = role.kind === "kill-relaunch" || role.kind === "background" ? role.background : null
      if (background) return `hide the app ${background.fromS} seconds after confirmation opens`
      return role.kind === "hidden-step" ? `hide the app at turn ${role.hideAtTurn}` : "hide the app"
    }
    case "visible": {
      const background = role.kind === "kill-relaunch" || role.kind === "background" ? role.background : null
      if (background) return `show the app again after ${background.untilS - background.fromS} seconds hidden (${background.untilS} seconds after confirmation opens)`
      return role.kind === "hidden-step" ? `show the app again at turn ${role.showAtTurn}` : "show the app again"
    }
    case "left-app":
      return "leave the app before handover"
    case "rejoined":
      return role.kind === "late-join" || role.kind === "video-return" ? `rejoin after turn ${role.joinAfterTurn}` : "rejoin the game"
    case "confirm-tap":
      return "restore the changed verdict and tap Confirm while its countdown is visible"
    case "storm-taps":
      return role.kind === "tap-storm" ? `apply ${role.flips} opposing tap pairs to one tile, then settle it approved` : "apply the tap storm"
    case "host-killed":
      return role.kind === "host-crash" ? `stop the signing host in round ${role.crashInRound}` : "stop the signing host"
    case "host-restarted":
      return role.kind === "host-crash" ? `restart the signing host after ${role.downS} seconds` : "restart the signing host"
    case "reloading":
      return role.kind === "reload" ? `start a page reload at turn ${role.reloadAtTurn}` : "start a page reload"
    case "reloaded":
      return role.kind === "reload" ? `complete the turn-${role.reloadAtTurn} reload` : "complete the page reload"
    case "clock-step":
      return role.kind === "hidden-step" ? `step the hidden device clock by ${role.stepS} seconds` : "step the device clock"
    case "frozen":
      return role.kind === "freeze" ? `freeze visible JavaScript at turn ${role.freezeAtTurn}` : "freeze visible JavaScript"
    case "thawed":
      return role.kind === "freeze" ? `resume JavaScript after ${role.freezeS} seconds` : "resume JavaScript"
    case "video-suppressed":
      return "suppress outbound video before returning"
    case "video-enabled":
      return role.kind === "video-return" && role.enableAtTurn !== null ? `enable outbound video at turn ${role.enableAtTurn}` : "enable outbound video"
    case "video-disabled":
      return role.kind === "video-return" && role.disableAtTurn !== null ? `disable outbound video at turn ${role.disableAtTurn}` : "disable outbound video"
    default:
      return action.replaceAll("-", " ")
  }
}

const deviceDisruptions = (profile: Profile | null): string[] =>
  profile
    ? [
        ...(profile.network.profile !== "wifi" ? [`hold the link on ${profile.network.profile}`] : []),
        ...(profile.network.relayOnly ? ["force media through relay only"] : []),
        ...(profile.cpuThrottle !== 1 ? [`throttle the CPU by ${profile.cpuThrottle}x`] : []),
        ...(profile.camera.delayMs > 0 ? [`delay camera frames by ${profile.camera.delayMs} ms`] : []),
        ...(profile.camera.muteLoop ? ["mute every fresh camera track unless its open has live user activation"] : []),
        ...(profile.clockOffsetS !== 0 ? [`start the device clock ${profile.clockOffsetS > 0 ? `${profile.clockOffsetS} seconds ahead` : `${Math.abs(profile.clockOffsetS)} seconds behind`}`] : []),
        ...(profile.locale ? [`run with the ${profile.locale} locale${profile.timezoneId ? ` in ${profile.timezoneId}` : ""}`] : []),
        ...(profile.peerFault ? [PEER_FAULT_DESCRIPTIONS[profile.peerFault.kind]] : []),
      ]
    : []

const guardPresentation = (entry: Guard, profile: Profile): string => {
  if (entry.kind === "text" && isExpectedT9IsolationGuard(profile, entry)) {
    return `page shows "${entry.text}" inside the bounded blackout and recovery is observed`
  }
  const described = describeGuard(entry)
  if (entry.kind === "text" && entry.never && allowsScriptedNeverTextWindow(profile.name, entry.text)) {
    return `${described}; appearances are allowed only inside the scripted fault window and recovery margin`
  }
  return described
}

const telemetryDescription = (torture: TelemetryTorture): string => {
  const duration = torture.durationS ? ` for ${torture.durationS} seconds` : ""
  switch (torture.id) {
    case "T1":
      return "keep a healthy telemetry baseline"
    case "T2":
      return `hang the host storage call${duration} while the local outbox continues independently`
    case "T3":
      return `hold the emulated iOS Sentry fetch${duration}, then release it`
    case "T4":
      return "hang host storage and Sentry fetch, kill the first document while stuck, then reopen healthy"
    case "T5":
      return "keep the initial and first reopened documents stuck, then prove the second reopen is healthy"
    case "T6":
      return `freeze visible JavaScript after the report for ${torture.freezeAfterReportS} seconds, kill it, then drain telemetry on the next open`
    case "T7":
      return `block Sentry ingest${duration}, then prove recovery`
    case "T8":
      return `return sentry-429 responses${duration} with a ${torture.retryAfterS}-second Retry-After, then prove the retry obeys it`
    case "T9":
      return "prove telemetry isolation and recovery across the whole-link blackout"
    case "T10":
      return "produce a large game log and prove more than 48 KiB of rolling-chunk durability"
    case "T11":
      return "make the localStorage getter throw SecurityError and prove telemetry still survives"
    case "T12":
      return "reload while telemetry is queued and prove outbox persistence plus stable-chunk Sentry deduplication"
  }
}

const terminalPurpose = (profile: Profile | null): string | null => {
  if (!profile) return null
  if (profile.role.label === "stale-build") return "show the stale-build update gate before sign-up and prevent a transaction broadcast"
  if (profile.expectedOutcome?.kind !== "camera-unavailable") return null
  return profile.expectedOutcome.reason === "denied"
    ? "put camera permission into the denied state and verify the terminal camera-recovery screen"
    : "run with no camera device and verify the terminal camera-recovery screen"
}

const parameterKey = (prefix: string, key: string): string => `${prefix}${key[0].toUpperCase()}${key.slice(1)}`

const sourceNetworkSteps = (profile: Profile | null, includeAtOpen = false): TimelineStep[] => {
  if (!profile) return []
  const steps: TimelineStep[] = []
  if (profile.network.switchAtTurn !== undefined && profile.network.switchTo !== undefined) {
    steps.push({ atTurn: profile.network.switchAtTurn, profile: profile.network.switchTo, ...(profile.network.blackoutS ? { blackoutS: profile.network.blackoutS } : {}) })
  }
  steps.push(...(profile.network.timeline ?? []).filter((step) => includeAtOpen || !step.atOpen))
  return steps
}

const publicParameters = (profile: Profile | null): Record<string, PublicParameter> => {
  if (!profile) return { mode: "reserved baseline" }
  const parameters: Record<string, PublicParameter> = {
    device: profile.device,
    cpuThrottle: profile.cpuThrottle,
    cameraResolution: profile.camera.resolution,
    cameraDelayMs: profile.camera.delayMs,
    cameraMode: profile.camera.mode ?? "ok",
    ...(profile.camera.muteLoop ? { cameraMuteLoop: true } : {}),
    clockOffsetS: profile.clockOffsetS,
    networkProfile: profile.network.profile,
    relayOnly: profile.network.relayOnly,
    role: profile.role.kind,
    ...(profile.locale ? { locale: profile.locale } : {}),
    ...(profile.timezoneId ? { timezone: profile.timezoneId } : {}),
    ...(profile.acceptanceOnly ? { acceptanceOnly: true } : {}),
    ...(profile.peerFault ? { peerFault: profile.peerFault.kind } : {}),
    ...(profile.freshIdentity ? { freshIdentity: true } : {}),
    ...(profile.pending ? { pending: true } : {}),
    ...(profile.expectedOutcome ? { expectedOutcome: profile.expectedOutcome.kind, cameraReason: profile.expectedOutcome.reason } : {}),
  }
  sourceNetworkSteps(profile, true).forEach((step, index) => {
    for (const [key, value] of Object.entries(step)) {
      if (value === undefined) continue
      if (key === "atRoundChannelsOpen") {
        for (const [gateKey, gateValue] of Object.entries(value as Record<string, number>)) {
          parameters[parameterKey(`network${index + 1}AtRoundChannelsOpen`, gateKey)] = gateValue
        }
        continue
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`network parameter ${key} is not public-scalar data`)
      parameters[parameterKey(`network${index + 1}`, key)] = value
    }
  })
  for (const [key, value] of Object.entries(profile.role.params)) {
    if (key === "note" || value === undefined) continue
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`role parameter ${key} is not public-scalar data`)
    parameters[parameterKey("role", key)] = value
  }
  ;(profile.clockJumps ?? []).forEach((jump, index) => {
    parameters[`clock${index + 1}AtTurn`] = jump.atTurn
    parameters[`clock${index + 1}OffsetS`] = jump.offsetS
  })
  if (profile.telemetryTorture) {
    for (const [key, value] of Object.entries(profile.telemetryTorture)) {
      if (value !== undefined) parameters[parameterKey("telemetry", key)] = Array.isArray(value) ? [...value] : value
    }
  }
  return parameters
}

/** The steps of a profile's network plan, which do not depend on the network (only the hosts they name do, and the narration lists steps), on the one network that can plan every profile. */
const shapeOf = (profile: Profile | null) => networkPlan(profile, undefined, "paseo-next-v2")

const recoveredActions = (profile: Profile | null, role: RolePlan): Set<string> => {
  const recovered = new Set<string>()
  shapeOf(profile).timeline.forEach((step, index) => {
    if (step.calls.some(([call]) => boundedNetworkCalls.has(call))) recovered.add(`network.${index + 1}`)
  })
  for (const action of dueActions(role)) if (recoveryRoleActions.has(action)) recovered.add(`role.${action}`)
  return recovered
}

export const requiredNarrationActions = (profileName: string, profiles: Profile[]): string[] => {
  const profile = profileForName(profileName, profiles)
  return [
    ...shapeOf(profile).timeline.map((_, index) => `network.${index + 1}`),
    ...dueActions(rolePlan(profile, true)).map((action) => `role.${action}`),
    ...(profile?.clockJumps ?? []).map((_, index) => `clock.${index + 1}`),
    ...(profile?.telemetryTorture ? [`telemetry.${profile.telemetryTorture.id}`] : []),
  ]
}

export function deriveScenarioPresentations(identities: readonly CrewIdentity[], profiles: Profile[]): ScenarioPresentation[] {
  return knownProfiles(profiles).map((name) => {
    const profile = profileForName(name, profiles)
    const scenarioTitle = name === "baseline" ? "Reserved Baseline" : title(name)
    const username = profile ? identityFor(profile, "previewnet") : undefined
    const narrator = identities.find((identity) => identity.username === username)?.displayName ?? "The PreviewNet harness"
    const role = rolePlan(profile, true)
    const roleSummary = rolePurpose(role)
    const actions: Record<string, ScenarioActionPresentation> = {}
    const recoveries = recoveredActions(profile, role)

    sourceNetworkSteps(profile).forEach((step, index) => {
      const key = `network.${index + 1}`
      const at = timing(step)
      const fault = impairment(step)
      const description = `${at}, ${fault}`
      actions[key] = {
        active: `${at}, ${narrator} will ${fault}.`,
        ...(recoveries.has(key) ? { recovered: `${narrator}'s network phase has ended (${fault}); recovery evidence is now being checked.` } : {}),
        failed: `The run could not prove ${narrator}'s network phase: ${description}.`,
      }
    })
    for (const action of dueActions(role)) {
      const key = `role.${action}`
      const description = roleActionDescription(role, action)
      actions[key] = {
        active: `${narrator}: ${action.replaceAll("-", " ")} — ${description}.`,
        ...(recoveries.has(key) ? { recovered: `${narrator} completed ${action.replaceAll("-", " ")}; recovery evidence is now being checked.` } : {}),
        failed: `The run could not prove ${narrator}'s ${action.replaceAll("-", " ")} action.`,
      }
    }
    ;(profile?.clockJumps ?? []).forEach((jump, index) => {
      actions[`clock.${index + 1}`] = {
        active: `${narrator} moves the device clock to ${jump.offsetS >= 0 ? "+" : ""}${jump.offsetS} seconds at turn ${jump.atTurn}.`,
        failed: `The run could not prove ${narrator}'s clock change at turn ${jump.atTurn}.`,
      }
    })
    if (profile?.telemetryTorture) {
      const description = telemetryDescription(profile.telemetryTorture)
      actions[`telemetry.${profile.telemetryTorture.id}`] = {
        active: `${narrator} activates ${profile.telemetryTorture.id}: ${description}.`,
        failed: `The run could not prove telemetry case ${profile.telemetryTorture.id}: ${description}.`,
      }
    }

    const disruptions = [
      ...deviceDisruptions(profile),
      ...sourceNetworkSteps(profile, true).map((step) => `${timing(step)} ${impairment(step)}`),
      ...(roleSummary ? [roleSummary] : []),
      ...(terminalPurpose(profile) ? [terminalPurpose(profile) as string] : []),
      ...(profile?.clockJumps ?? []).map((jump) => `move the device clock to ${jump.offsetS >= 0 ? "+" : ""}${jump.offsetS} seconds at turn ${jump.atTurn}`),
      ...(profile?.telemetryTorture ? [`run telemetry case ${profile.telemetryTorture.id} to ${telemetryDescription(profile.telemetryTorture)}`] : []),
    ]
    const setup = profile ? `${profile.device} on ${profile.network.profile}${profile.network.relayOnly ? " through relay-only media" : ""}` : "the reserved healthy-path controls"
    const evidence = profile ? profile.expect.map((guard) => guardPresentation(guard, profile)) : ["ordinary play completes with truthful evidence"]
    return {
      profile: name,
      title: scenarioTitle,
      purpose: disruptions.length
        ? `${narrator}: ${sentenceList(disruptions)}. Test setup: ${setup}.`
        : `${narrator} uses ${setup} to play an ordinary game without an injected disruption.`,
      expected: `Evidence for ${scenarioTitle} must show ${sentenceList(evidence)}; absent evidence remains a failure and pending guards stay visibly pending.`,
      criteria: evidence,
      parameters: publicParameters(profile),
      phases: {
        preparing: `${narrator} is preparing ${scenarioTitle} on ${setup}.`,
        verifying: `${narrator} finished the actions; the run is checking ${evidence.length} evidence requirement${evidence.length === 1 ? "" : "s"}.`,
        passed: `${scenarioTitle} recorded every required observation.`,
        failed: `${scenarioTitle} is missing or contradicted by required evidence.`,
      },
      actions,
    }
  })
}
