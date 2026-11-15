// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game's permission set:
 *
 *  - Camera (device)           the gesture video — Camera ONLY, no Microphone
 *                              (the game sends no audio)
 *  - Remote { domains }        the TURN/STUN relays AND the identity backend
 *                              that issues their credentials — without it the
 *                              relays are unreachable. The Bulletin IPFS gateway
 *                              was dropped: results art loads through the host
 *                              PREIMAGE MANAGER (product-sdk getPreimageManager)
 *                              instead of a Remote-permitted fetch, and preimage
 *                              reads need no grant (PreimageSubmit would
 *                              auto-prompt if we ever write).
 *  - AutoSigning               silent extrinsic signing for sign-up and report
 *                              (a resource allocation, one modal). NOT the
 *                              product's StatementStoreAllowance: the game's
 *                              statements are proved AS THE PLAYER with the
 *                              allowance the Game pallet grants at sign-up
 *                              (lib/host/statement-store.ts) — the product's
 *                              own slot buys nothing the game uses, and under
 *                              truapi-host its purchase fails on chain (RPC
 *                              error 1010, invalid transaction).
 *
 *  - WebRtc                    the host's consent gate on peer connections —
 *                              NOT on the implicit-prompt list of TrUAPI
 *                              RFC-0002 (github.com/paritytech/truapi,
 *                              docs/rfcs/), so it must be pre-asked
 *  - StatementSubmit           pre-asked so the implicit consent modal never
 *                              interrupts mid-game at the first signal
 *
 * App-open contract: the root page runs allPermissionsGranted() (silent) and
 * redirects to /permissions when it fails; the permissions page redirects
 * BACK to root on mount when everything is already there — so a fully
 * granted user never sees it. Host grants have no silent query, so a
 * successful full pass is remembered locally and the camera (the one
 * queryable grant) is re-verified every open.
 *
 * Everything goes through @parity/product-sdk-host in a host container. In a
 * plain browser only the native camera prompt exists — the host-only items
 * pass trivially so the dev flow can complete.
 *
 * Telemetry's optional Remote warm-up is deliberately outside the game's
 * permission set. It is asked at most once per page open and never gates,
 * pauses or closes telemetry delivery.
 */
import { devLog } from "./debug/log-store"
import { describeError } from "./host/error-detail"
import { tryReadStoredString, writeStoredJSON, writeStoredString } from "./host/storage"
import { CAMERA_KEY, deviceUniquenessBackendUrl, productAccount } from "@jollity/protocol"
import { classifyHostFailure } from "@individuality/people-chain"
import { fetchIceServers } from "./webrtc/ice"
import { ingestHost } from "./telemetry/environment"
import { withTimeout } from "./with-timeout"
import { retrySafeHostRead } from "./host/safe-call"
import { readCameraPermissionState } from "./camera-permission-read"

export const PERMISSION_ITEMS = [
  {
    id: "camera",
    title: "Camera",
    description: "To copy gestures and be seen by your group.",
  },
  {
    id: "network",
    title: "Network access",
    description: "To reach the video relays that carry the game.",
  },
  {
    id: "webrtc",
    title: "Peer connections",
    description: "To stream video directly between players.",
  },
  {
    id: "statements",
    title: "Game messages",
    description: "To exchange game signals, signed by the host.",
  },
] as const

export type PermissionId = (typeof PERMISSION_ITEMS)[number]["id"]
export type PermissionState = "idle" | "asking" | "granted" | "denied"

/**
 * Why a request failed — drives the row message and the gate's guidance.
 *
 * A host call comes back as a Result<T, HostError>: `ok: false` means the
 * CALL failed (SDK unavailable, a HostUnavailableError/HostCallFailedError,
 * a thrown exception, or our own timeout race) — it says nothing about what
 * the user answered, because they were never shown a prompt to answer. Only
 * `ok: true` with a false value, or (for the AutoSigning allocation) an
 * explicit "Rejected" outcome, is a genuine "no". Collapsing both onto
 * "denied" was the original bug here (every failure rendered as "Denied",
 * including on hosts where the call itself was broken) — this file keeps
 * "denied" for the real refusal and "host-error" for everything else, so the
 * row — and the console line next to it — point at what's actually true.
 */
export type DenialReason =
  | "denied" // a genuine user "no" — re-asking can work
  | "blocked" // hard-denied at browser/OS level — only settings can fix it
  | "no-camera" // no camera hardware on this device
  | "busy" // camera exists but another app holds it
  | "timeout" // the host modal never answered
  | "host-error" // the host call failed/threw/was unavailable — NOT a user "no"

/** One row of the permission gate, as the page draws it. */
export type PermissionRowState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "granted" }
  | { kind: "denied"; reason: DenialReason }

export interface PermissionResult {
  ok: boolean
  reason?: DenialReason
  /**
   * Which host call this outcome came from, for a branch with more than one
   * (statements: the StatementSubmit CONSENT vs the AutoSigning ALLOCATION).
   * Lets a caller — not just the console.warn below — tell which step failed
   * instead of a bare "statements didn't grant". Undefined for the
   * single-call branches (network, webrtc), where there is nothing to
   * disambiguate.
   */
  step?: "permission" | "consent" | "allocation"
  /** the host's own words for a `host-error`, for the failure report */
  detail?: string
}

/**
 * Host calls get a bound so "Asking…" can never hang forever — but a GENEROUS
 * one: consent modals wait on a human, and a host's resource allocation can
 * legitimately take ~300 s (TrUAPI allows 420 s). A shorter app timeout does
 * not cancel the host request, it only lets later calls pile up behind it,
 * which stalls the signer mid-game.
 */
const CONSENT_TIMEOUT_MS = 120_000
export const ALLOCATION_TIMEOUT_MS = 420_000

function bounded<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))])
}

/** WebRTC infrastructure the Remote grant must cover. */
export const REMOTE_DOMAINS: string[] = [
  "turn.cloudflare.com", // TURN relay
  "stun.cloudflare.com", // STUN discovery
  new URL(deviceUniquenessBackendUrl()).hostname, // TURN credentials
]

// Both shapes below are deliberately loosely typed — they cross a dynamic
// `import()` boundary, and the host a bundle runs against can be newer than
// the truapi types it was built with (say, a 0.13.1 bundle on a 0.16 host).

/** The envelope `requestPermission` returns: Result<boolean, HostError>. */
type BoolHostResult = { ok?: boolean; value?: boolean; error?: unknown }

/**
 * The envelope `requestResourceAllocation` returns: Result<AllocationOutcome[],
 * HostError>, where AllocationOutcome is a plain string union in
 * @parity/truapi 0.16 — "Allocated" | "Rejected" | "NotAvailable" — never a
 * tag object. Match it exactly; do not go back to a fuzzy/stringify check.
 */
type AllocationHostResult = { ok?: boolean; value?: string[]; error?: unknown }

/** a host call that failed or threw: logged with the host's own words, and
 *  carried on the result for the failure report */
function hostError(label: string, step: "permission" | "consent" | "allocation", error: unknown): PermissionResult {
  const detail = describeError(error)
  devLog("permissions", label, { detail }, "error")
  return { ok: false, reason: "host-error", step, detail }
}

/**
 * Classify a Result<boolean, HostError> and log the one diagnostic line a
 * host container's console is the only window onto: `ok !== true` is a
 * failed/unavailable host call (host-error, not the user's answer); `ok:
 * true` with a false value is the user's genuine "no".
 */
function classifyGrant(
  id: PermissionId | "telemetry" | "version",
  step: "permission" | "consent",
  result: unknown,
): PermissionResult {
  const r = result as BoolHostResult
  // WHAT THE HOST ACTUALLY SAID, in the sheet. An `ok` here is not proof the
  // host asked: a tag it already granted answers instantly, so a domain added
  // later can be accepted and never applied. Without this line that case and
  // a real fresh grant are the same two words on screen.
  devLog("permissions", `${id} ${step}`, { ok: r?.ok, value: r?.value, error: r?.error }, r?.value ? "info" : "error")
  if (!r || r.ok !== true) {
    const failure = r?.ok === false ? r.error : r
    console.warn(`[permissions] ${id} ${step} not granted`, failure)
    // already in the sheet, with the whole record, by the line above
    return { ok: false, reason: "host-error", step, detail: describeError(failure) }
  }
  if (!r.value) {
    console.warn(`[permissions] ${id} ${step} not granted`, r)
    return { ok: false, reason: "denied", step }
  }
  return { ok: true }
}

/**
 * Takes the relays during setup rather than at kickoff.
 *
 * Credentials are proof-authorized, see lib/host/turn-proof.ts, and a proof
 * needs the host, a registered ring key and a reachable issuer. Each of those
 * can be missing, and found mid-game it would leave the mesh dark with twelve
 * turns running. Asking here makes a failure a setup failure. It lands in the sheet beside the grant that was meant to enable
 * it, minutes before anyone is waiting on video.
 *
 * It also warms the ICE cache, so the mesh usually finds the credentials
 * already there.
 */
let turnIssue: Promise<void> | null = null

/** the TURN credential fetch the last network grant started, for the
 *  permission journey's `network.turn-receipt` step */
export function turnIssueInFlight(): Promise<void> | null {
  return turnIssue
}

async function takeTurnCredentials(): Promise<void> {
  // `fetchIceServers` records the outcome in the health ladder and writes its
  // own log lines, so this neither counts nor narrates. It exists to move the
  // work to setup time and to warm the cache.
  await fetchIceServers(undefined, "warmup").catch((error: unknown) => {
    devLog("permissions", "credentials unavailable after the grant", { detail: describeError(error) }, "error")
    return []
  })
}

/**
 * Classify a Result<AllocationOutcome[], HostError> the same way, plus the
 * per-resource outcome: an explicit "Rejected" is the user's "no";
 * "NotAvailable" (the requested resource was not offered) is not — it must
 * not brick the gate, see the DenialReason header above.
 */
function classifyAllocation(
  id: PermissionId,
  step: "allocation",
  result: unknown,
): PermissionResult {
  const r = result as AllocationHostResult
  if (!r || r.ok !== true) {
    const failure = r?.ok === false ? r.error : r
    console.warn(`[permissions] ${id} ${step} not granted`, failure)
    return hostError(`${id} ${step} failed`, step, failure)
  }
  const outcomes = Array.isArray(r.value) ? r.value : []
  if (outcomes.includes("Rejected")) {
    console.warn(`[permissions] ${id} ${step} not granted`, outcomes)
    return { ok: false, reason: "denied", step }
  }
  return { ok: true }
}

/**
 * Prompt one permission and report the outcome. Serialized by the caller —
 * the host shows one modal at a time.
 */
export async function requestPermissionItem(id: PermissionId): Promise<PermissionResult> {
  let sdk: typeof import("@parity/product-sdk-host") | undefined
  try {
    sdk = await import("@parity/product-sdk-host")
    if (!sdk.isInsideContainerSync()) sdk = undefined
  } catch {
    sdk = undefined
  }

  switch (id) {
    case "camera": {
      // host device permission first (no-op outside), then the native prompt —
      // the grant is the goal, nothing is captured
      if (sdk) {
        try {
          await sdk.requestDevicePermission("Camera")
        } catch (error) {
          // best-effort — the getUserMedia probe decides
          devLog("permissions", "host camera permission call failed", { detail: describeError(error) }, "warn")
        }
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        stream.getTracks().forEach((track) => track.stop())
        return { ok: true }
      } catch (error) {
        const name = (error as DOMException)?.name
        if (name === "NotFoundError" || name === "OverconstrainedError")
          return { ok: false, reason: "no-camera" }
        if (name === "NotReadableError" || name === "AbortError")
          return { ok: false, reason: "busy" }
        if (name !== "NotAllowedError") return hostError("camera request failed", "permission", error)
        // NotAllowedError covers both "dismissed" and "hard-blocked" — the
        // Permissions API tells them apart where it exists
        try {
          const status = await readCameraPermissionState()
          if (status.state === "denied") return { ok: false, reason: "blocked" }
        } catch {
          /* no Permissions API — treat as a soft denial */
        }
        return { ok: false, reason: "denied" }
      }
    }
    case "network": {
      if (!sdk) return { ok: true } // nothing to grant in a plain browser
      try {
        const result = await bounded(
          retrySafeHostRead(sdk, () =>
            sdk.requestPermission({
              tag: "Remote",
              value: { domains: REMOTE_DOMAINS },
            } as Parameters<typeof sdk.requestPermission>[0]),
          ),
          CONSENT_TIMEOUT_MS,
        )
        if (result === "timeout") return { ok: false, reason: "timeout" }
        const outcome = classifyGrant("network", "permission", result)
        // The grant just authorized the issuer, so redeem it here. The proof
        // is taken and the relays are in hand before anyone waits on video.
        //
        // Logged and never gating. A refusal has to be visible without making
        // the gate unpassable on a host we cannot fix from here.
        if (outcome.ok) {
          // Telemetry's own domain is asked for separately, after this step
          // passes (lib/permission-pass.ts): a "no" to it must never fail it.
          turnIssue = takeTurnCredentials()
        }
        return outcome
      } catch (error) {
        console.warn("[permissions] network permission not granted", error)
        return hostError("network permission call failed", "permission", error)
      }
    }
    case "webrtc": {
      if (!sdk) return { ok: true }
      try {
        const result = await bounded(
          retrySafeHostRead(sdk, () =>
            sdk.requestPermission({
              tag: "WebRtc",
              value: undefined,
            } as Parameters<typeof sdk.requestPermission>[0]),
          ),
          CONSENT_TIMEOUT_MS,
        )
        if (result === "timeout") return { ok: false, reason: "timeout" }
        return classifyGrant("webrtc", "permission", result)
      } catch (error) {
        console.warn("[permissions] webrtc permission not granted", error)
        return hostError("webrtc permission call failed", "permission", error)
      }
    }
    case "statements": {
      if (!sdk) return { ok: true }
      // tracked so a timeout or a thrown exception (both caught below) can
      // still name which host call was in flight
      let step: "consent" | "allocation" = "consent"
      try {
        // consent first (pre-asked so it never interrupts mid-game), then
        // silent signing (one allocation modal)
        const consent = await bounded(
          retrySafeHostRead(sdk, () =>
            sdk.requestPermission({
              tag: "StatementSubmit",
              value: undefined,
            } as Parameters<typeof sdk.requestPermission>[0]),
          ),
          CONSENT_TIMEOUT_MS,
        )
        if (consent === "timeout") {
          console.warn(`[permissions] statements ${step} not granted`, "timeout")
          return { ok: false, reason: "timeout", step }
        }
        const consentResult = classifyGrant("statements", step, consent)
        if (!consentResult.ok) return consentResult

        step = "allocation"
        // AutoSigning alone: sign_up/report are signed with the product-account
        // signer and this is what makes that silent. The product's
        // StatementStoreAllowance is deliberately NOT requested — see the
        // header; the player's allowance comes with the sign-up.
        const allocation = await bounded(
          sdk.requestResourceAllocation([
            { tag: "AutoSigning", value: undefined },
          ] as Parameters<typeof sdk.requestResourceAllocation>[0]),
          ALLOCATION_TIMEOUT_MS,
        )
        if (allocation === "timeout") {
          console.warn(`[permissions] statements ${step} not granted`, "timeout")
          return { ok: false, reason: "timeout", step }
        }
        // the call succeeding is NOT the user agreeing: parse the per-resource
        // outcomes — an explicit Rejected is a denial; NotAvailable is not
        // the user's "no" and must not brick the gate
        return classifyAllocation("statements", step, allocation)
      } catch (error) {
        console.warn(`[permissions] statements ${step} not granted`, error)
        return hostError(`statements ${step} call failed`, step, error)
      }
    }
  }
}

// Per product, because the grants are. One global key meant a pass on any
// build marked every other build done, and the next product opened onto the
// home screen having asked the host for nothing.
const GRANTED_FLAG = `jollity.permissions.v2:${productAccount()}`
const GRANTED_FLAG_READ_TIMEOUT_MS = 3_000

type GrantedFlagState = "granted" | "missing" | "unavailable"

async function writeStored(key: string): Promise<void> {
  await writeStoredString(key, "1")
}

/**
 * The remembered pass is a convenience gate, not an authorisation boundary:
 * the browser and host still enforce every permission at the call site. Keep
 * an absent value distinct from a failed/hung host-storage RPC so a storage
 * outage cannot masquerade as the player's first open and eject a live game.
 */
async function readFlag(): Promise<GrantedFlagState> {
  const result = await withTimeout(tryReadStoredString(GRANTED_FLAG), GRANTED_FLAG_READ_TIMEOUT_MS)
  if (result === null || !result.ok) return "unavailable"
  return result.value === "1" ? "granted" : "missing"
}

export function isSigningDeclined(detail: string): boolean {
  return classifyHostFailure(detail) === "declined"
}

/** Remember that a full grant pass succeeded (bump the key on set changes). */
export async function markPermissionsGranted(): Promise<void> {
  await writeStored(GRANTED_FLAG)
}

/** The camera answer the chat card draws its line from, as JSON because the worker storage reads only JSON. */
export async function markCameraAnswer(answer: "on" | "off"): Promise<void> {
  await writeStoredJSON(`${CAMERA_KEY}:${productAccount()}`, answer)
}

/** What a camera result says the player answered, nothing when the host or the device failed before they could. */
export function cameraAnswerOf(result: PermissionResult): "on" | "off" | undefined {
  if (result.ok) return "on"
  return result.reason === "denied" || result.reason === "blocked" ? "off" : undefined
}

// ── telemetry's own grant ──────────────────────────────────────────────────
// Sentry's ingest host is NOT in REMOTE_DOMAINS, and is asked for in a request
// of its own: a "no" to telemetry must never fail the game's network step.
//
// The app stores no answer. One ask per open warms the host; its result never
// changes delivery, which runs independently through the bounded retry queue.

// One host is asked for: the production DSN's, or the test DSN's when a build
// carries the test DSN alone (lib/telemetry/environment.ts pickDsn). Two DSNs
// in one Sentry org share its ingest host, so one grant covers both.
const telemetryHost = () =>
  ingestHost(process.env.NEXT_PUBLIC_SENTRY_DSN) ?? ingestHost(process.env.NEXT_PUBLIC_SENTRY_DSN_TEST)

let telemetryAsk: Promise<boolean> | null = null

/**
 * Ask the host for Sentry's ingest domain. Never throws, never blocks the game:
 * a refusal, a timeout or a host error is logged but changes no delivery
 * state. The same promise is kept for the page lifetime: exactly one ask.
 */
export function requestTelemetryGrant(): Promise<boolean> {
  telemetryAsk ??= askTelemetry()
  return telemetryAsk
}

async function askTelemetry(): Promise<boolean> {
  const host = telemetryHost()
  if (!host) return false
  try {
    const answer = await requestRemoteGrant(host, "telemetry")
    if (answer === "timeout") {
      devLog("permissions", "telemetry permission timed out", undefined, "error")
      return false
    }
    // The telemetry answer is deliberately not stored between app opens.
    if (answer === "refused") return false
    return true
  } catch (error) {
    devLog("permissions", "telemetry permission failed", { detail: describeError(error) }, "error")
    return false
  }
}

/**
 * The host's Remote grant for ONE domain, the part telemetry and the version
 * file share. "no-host" is a plain browser, which has nothing to block the
 * request. A thrown host call propagates: each caller keeps its own policy.
 */
async function requestRemoteGrant(
  host: string,
  id: "telemetry" | "version",
): Promise<"granted" | "no-host" | "refused" | "timeout"> {
  let sdk: typeof import("@parity/product-sdk-host") | undefined
  try {
    sdk = await import("@parity/product-sdk-host")
    if (!sdk.isInsideContainerSync()) sdk = undefined
  } catch {
    sdk = undefined
  }
  if (!sdk) return "no-host"
  const result = await bounded(
    retrySafeHostRead(sdk, () =>
      sdk.requestPermission({
        tag: "Remote",
        value: { domains: [host] },
      } as Parameters<typeof sdk.requestPermission>[0]),
    ),
    CONSENT_TIMEOUT_MS,
  )
  if (result === "timeout") return "timeout"
  return classifyGrant(id, "permission", result).ok ? "granted" : "refused"
}

/** App-open, once the game's permission check has passed: ask the host for this open (the
 *  caller never awaits this). An Always grant answers without UI, and a
 *  refusal the host keeps answers the same way; an answer already given this
 *  page session (the permission pass) stands. */
export async function syncTelemetryGrant(): Promise<void> {
  await requestTelemetryGrant()
}

let versionAsk: Promise<boolean> | null = null
let versionGranted = false

/**
 * The version file's domain, asked in a Remote grant of its OWN. It is kept out
 * of REMOTE_DOMAINS on purpose: a "no" here costs only the update check, and
 * must never fail the game's network step. Never throws. A grant is kept for
 * the page session; a refusal is not (the host keeps its own, as for
 * telemetry above). One ask at a time.
 */
export function requestVersionGrant(url: string): Promise<boolean> {
  if (versionGranted) return Promise.resolve(true)
  versionAsk ??= askVersion(url).finally(() => {
    versionAsk = null
  })
  return versionAsk
}

async function askVersion(url: string): Promise<boolean> {
  try {
    const answer = await requestRemoteGrant(new URL(url).hostname, "version")
    versionGranted = answer === "granted" || answer === "no-host"
    return versionGranted
  } catch (error) {
    devLog("permissions", "version permission failed", { detail: describeError(error) }, "error")
    return false
  }
}

/** The camera grant IS silently queryable — Permissions API first, device
 * labels (only visible once granted) as the fallback. Never prompts. */
async function readCameraEvidence(): Promise<"granted" | "denied" | "unknown"> {
  // POSITIVE SIGNAL FIRST: a videoinput with a non-empty label is exposed only
  // once camera access is granted — the one check that reads true on every
  // host (iOS WebKit has no Permissions API; it lands here).
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    if (devices.some((device) => device.kind === "videoinput" && device.label !== "")) return "granted"
  } catch {
    /* enumerateDevices unavailable — fall through to the Permissions API */
  }
  // The Permissions API is only trusted for its DEFINITIVE answers. Android's
  // WebView reports "prompt" for camera even after the host granted it
  // natively (the WebView permission store is not the getUserMedia grant the
  // host bridges), so a non-"granted" state is NOT proof of revocation — only
  // an explicit "denied" is. Treating "prompt" as revoked bounced Android
  // players back to the gate on every open (iOS, with no Permissions API, was
  // unaffected). So: "granted" → yes, "denied" → no, anything else → trust the
  // remembered grant (the caller has already confirmed the stored flag) rather
  // than re-asking. A camera revoked mid-session still surfaces when
  // getUserMedia fails, which the mesh handles.
  try {
    const status = await readCameraPermissionState()
    if (status.state === "granted") return "granted"
    if (status.state === "denied") return "denied"
    return "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Host storage remembers that these grants once passed, but it is not their
 * authority. If that memory is unavailable while the browser independently
 * proves the camera grant, ask the host-only grants again. Already-granted
 * tags answer immediately; a genuine first run must still obtain every grant
 * and cannot pass merely because another product used the same camera.
 */
async function recoverHostOnlyPermissions(): Promise<boolean> {
  for (const id of ["network", "webrtc", "statements"] as const) {
    if (!(await requestPermissionItem(id)).ok) return false
  }
  return true
}

/**
 * Silent app-open check — NO prompts. True only when a full grant pass has
 * succeeded before AND the camera grant still holds now. Host grants cannot
 * be queried without prompting; if one was revoked host-side, the re-ask on
 * /permissions resolves instantly for everything still granted.
 */
export async function allPermissionsGranted(): Promise<boolean> {
  const flag = await readFlag()
  if (flag === "missing") {
    // A player who declined the camera never finished a pass, so a grant from
    // Settings reaches the chat card only through this read.
    void cameraGrantedNow(true)
    return false
  }
  if (flag === "granted") return cameraGrantedNow()
  // Android WebView's ambiguous `prompt` state cannot prove a pass when host
  // storage is unavailable. Positive camera evidence is only the prerequisite
  // for revalidating every host-only grant, never a substitute for them.
  if (!(await cameraGrantedNow(true))) return false
  return recoverHostOnlyPermissions()
}

/** The open never reaches the permission page once a pass is remembered, so a grant is recorded here. */
async function cameraGrantedNow(requirePositiveEvidence = false): Promise<boolean> {
  const evidence = await readCameraEvidence()
  if (evidence === "granted") void markCameraAnswer("on")
  return evidence === "granted" || (evidence === "unknown" && !requirePositiveEvidence)
}

/**
 * Watch the camera grant for changes (Permissions API `onchange`) — how the
 * gate self-heals when the user flips the settings toggle and comes back.
 * Returns an unsubscribe; resolves to a no-op where the API is missing.
 */
export async function watchCameraGrant(onGranted: () => void): Promise<() => void> {
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName })
    const listener = () => {
      if (status.state === "granted") onGranted()
    }
    status.addEventListener("change", listener)
    return () => status.removeEventListener("change", listener)
  } catch {
    return () => {}
  }
}
