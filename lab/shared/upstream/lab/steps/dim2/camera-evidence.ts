// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserPage, LocatorRoot } from "@parity/product-lab/ports/browser";
import { SYNTHETIC_MEDIA_ARGS } from "@parity/product-lab/domain/devices";

/**
 * DIM2 is played on camera. Every lab browser runs Chromium's synthetic camera and grants the permission the app asks
 * for (`lab/sessions/synthetic-media.ts`), so no page can reach the machine's real camera, and a page whose camera is
 * refused is a lab question first. On 22 October 2026 (runs run-2 and s2-6 of job/humanity-early-close) all three
 * players' pages showed DIM2's "Your camera is busy" at once while the operator was on a video call; DIM2 shows it
 * when `getUserMedia` rejects with NotReadableError or AbortError. This module holds the DIM2 page's camera guard and
 * the camera diagnosis. Nothing here changes a gesture, a permission or the app.
 */

/** Chromium's synthetic camera: `fake_device_0` (more with `--use-fake-device-for-media-stream=device-count=N`). */
export const SYNTHETIC_CAMERA = /^fake_device_\d+$/;

/** The media log file in a DIM2 session's run directory (full Chromium writes it; the headless shell logs to stderr). */
export const DIM2_MEDIA_LOG = "chromium-media.log";

/**
 * Chromium's own log of media devices and video capture. It names the device each capture opens
 * (`VideoCaptureManager::Open, device.name = fake_device_0`) and each failure, about 70 lines per camera start and stop.
 * Full Chromium (the lab launcher's default) writes it to `runDir/chromium-media.log`; the headless shell ignores
 * `--log-file` and writes it to its stderr, which Playwright prints with `DEBUG=pw:browser` beside each browser's full
 * launch command line.
 */
export function dim2MediaLogArgs(runDir: string): string[] {
  return ["--enable-logging", `--log-file=${join(runDir, DIM2_MEDIA_LOG)}`, "--v=0", "--vmodule=*video_capture*=1,*media_stream*=1"];
}

/** What the lab knows of the browser behind a DIM2 surface: its launch arguments, how it was launched, where its run is kept. */
export interface Dim2Launch {
  readonly args: readonly string[];
  /** How the browser was launched: the session's opener through createDim2Session, or the lab window. */
  readonly launchPath: string;
  /** The session's run directory: each camera diagnosis is appended to its `camera.jsonl`. */
  readonly runDir?: string;
  /** The browser's media log file (`dim2MediaLogArgs`), when it writes one. */
  readonly mediaLogFile?: string;
  /** Why there is no media log file to read, when there is none. */
  readonly mediaLogNote?: string;
}

/**
 * How the lab window's browser is launched. A visible DIM2 surface is a frame of the lab window, or of a detached window,
 * which is a context of the window's browser; the framework launches it with Chromium's synthetic media always
 * (`LAB_WINDOW_MEDIA_ARGS` in `@parity/product-lab/shell/visible`, the same flags as `SYNTHETIC_MEDIA_ARGS`; held equal by
 * tests/synthetic-media.test.ts).
 */
export const LAB_WINDOW_LAUNCH = "the lab window (@product-lab/shell, visible/window.ts; a detached window is a context of its browser)";

/**
 * Why a surface's browser may not be running Chromium's synthetic media, by its launch arguments alone; undefined when
 * they hold both flags. Nothing in this module asks a page for a camera stream unless they do: no lab code, test or
 * control may ask the machine's real camera for one (coordinator, 22 October 2026).
 */
export function syntheticMediaMissing(launch: Dim2Launch | undefined): string | undefined {
  if (!launch) return "no launch known: not a lab DIM2 surface";
  const missing = SYNTHETIC_MEDIA_ARGS.filter((arg) => !launch.args.includes(arg));
  return missing.length ? `its browser was launched without ${missing.join(" ")}` : undefined;
}

const launches = new WeakMap<object, Dim2Launch>();
export function rememberDim2Launch(page: object, launch: Dim2Launch): void { launches.set(page, launch); }
export function dim2Launch(page: object): Dim2Launch | undefined { return launches.get(page); }

export interface MediaDeviceEntry { readonly kind: string; readonly label: string }

/** The devices the page lists, by `enumerateDevices()`. It opens no device. */
export async function readMediaDevices(page: Pick<BrowserPage, "evaluate">): Promise<readonly MediaDeviceEntry[]> {
  // No named functions inside: the test runner's transform would wrap them in a helper the page does not have.
  return page.evaluate(async () => {
    const media = globalThis.navigator.mediaDevices;
    if (!media) throw new Error("the page has no navigator.mediaDevices");
    return (await media.enumerateDevices()).map((device) => ({ kind: device.kind as string, label: device.label }));
  }, undefined);
}

/** Why a device list is not Chromium's synthetic camera alone, or undefined when it is: at least one camera, each `fake_device_N`. */
export function syntheticCameraProblem(devices: readonly MediaDeviceEntry[]): string | undefined {
  const cameras = devices.filter((device) => device.kind === "videoinput");
  if (cameras.length === 0) return "it lists no camera, and Chromium's synthetic camera is fake_device_0";
  const other = cameras.filter((camera) => !SYNTHETIC_CAMERA.test(camera.label));
  if (other.length === 0) return undefined;
  return `it lists ${other.length === 1 ? "a camera" : `${other.length} cameras`} that ${other.length === 1 ? "is" : "are"} not Chromium's synthetic one: `
    + other.map((camera) => JSON.stringify(camera.label || "(no label)")).join(", ");
}

/**
 * The devices a visible DIM2 surface (a frame of the lab window) lists. The window grants no permission ahead, so until
 * the app has asked for its camera the labels are blank; then one fresh `getUserMedia({ video: true })` (the window's
 * synthetic media accepts it at once; its tracks stopped at once) makes them readable. Read only through
 * `guardDim2Camera`, which asks nothing of a page whose browser's launch lacks the synthetic media. A request with no answer within
 * `timeoutMs`, or refused, is an error: nothing that browser could show is then known to be synthetic.
 */
export async function readSurfaceDevices(root: LocatorRoot, timeoutMs = 10_000): Promise<readonly MediaDeviceEntry[]> {
  return root.locator("body").evaluate(async (_body, limit) => {
    const media = globalThis.navigator.mediaDevices;
    if (!media) throw new Error("the page has no navigator.mediaDevices");
    // No named functions inside: the test runner's transform would wrap them in a helper the page does not have.
    const first = (await media.enumerateDevices()).map((device) => ({ kind: device.kind as string, label: device.label }));
    if (!first.some((device) => device.kind === "videoinput" && device.label === "")) return first;
    const answer = await Promise.race([
      media.getUserMedia({ video: true }).then(
        (stream) => { for (const track of stream.getTracks()) track.stop(); return "ok"; },
        (error: { name?: string; message?: string }) => `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`),
      new Promise<string>((resolve) => setTimeout(() => resolve(`no answer within ${Number(limit)} ms`), Number(limit))),
    ]);
    if (answer !== "ok") throw new Error(`the camera could not be asked for its labels: ${answer}`);
    return (await media.enumerateDevices()).map((device) => ({ kind: device.kind as string, label: device.label }));
  }, timeoutMs);
}

/**
 * The DIM2 surface's camera guard: it must list only Chromium's synthetic camera. Otherwise it throws at once, naming
 * the surface, the launch path and the browser's arguments, before the journey plays on a camera the lab does not own.
 */
export async function guardDim2Camera<P>(page: P, where: { readonly page: string; readonly launch: Dim2Launch },
  read: (page: P) => Promise<readonly MediaDeviceEntry[]>): Promise<void> {
  // The launch first: a browser without the synthetic media is refused before its page is asked anything.
  const unlaunched = syntheticMediaMissing(where.launch);
  let problem = unlaunched;
  // A navigation of the page's own (a redirect after load) can end one read; the device list does not change with it.
  // A read that fails is tried three times, 500 ms apart, whatever the failure: one that persists is named.
  for (let attempt = 1; unlaunched === undefined; attempt++) {
    try { problem = syntheticCameraProblem(await read(page)); break; } catch (error) {
      problem = `its devices could not be read (${String(error).split("\n")[0]})`;
      if (attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (problem === undefined) return;
  throw new Error(`DIM2 camera guard: ${where.page} could reach a camera the lab does not own: ${problem}. `
    + `Launched by ${where.launch.launchPath}, with [${where.launch.args.join(" ")}]. Every lab browser runs `
    + "--use-fake-ui-for-media-stream --use-fake-device-for-media-stream (lab/sessions/synthetic-media.ts), so no page can reach the machine's real camera.");
}

export interface Dim2CameraReading {
  /** `kind:label` for every device the page lists; Chromium's synthetic camera is `fake_device_0`. */
  readonly devices: readonly string[];
  /** The page's camera permission, or why it could not be read. */
  readonly permission: string;
  /** A fresh `getUserMedia({ video: true })` from the page, its tracks stopped at once: "ok <label>" or "<name>: <message>". */
  readonly probe: string;
}

/**
 * What the page sees of its camera now. Never throws; a failed read is named in the reading. `ask: { not: why }` makes
 * no fresh camera request (the browser's launch does not show the synthetic media): the probe says why.
 */
export async function readDim2Camera(page: LocatorRoot, timeoutMs = 5000, ask: true | { readonly not: string } = true): Promise<Dim2CameraReading> {
  try {
    return await page.locator("body").evaluate(async (_body, arg) => {
      const limit = arg as { readonly ms: number; readonly not: string | undefined }; // the port passes the argument as unknown
      const media = globalThis.navigator.mediaDevices;
      if (!media) return { devices: [], permission: "no navigator.mediaDevices", probe: "no navigator.mediaDevices" };
      const devices = await media.enumerateDevices().then(
        (list) => list.map((device) => `${device.kind}:${device.label || "(no label)"}`),
        (error: { name?: string; message?: string }) => [`enumerateDevices failed: ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`]);
      const permission = await (globalThis.navigator.permissions?.query({ name: "camera" as PermissionName }).then(
        (status) => status.state as string,
        (error: { name?: string; message?: string }) => `unreadable (${error?.name ?? "Error"}: ${error?.message ?? String(error)})`) ?? "no navigator.permissions");
      const probe = limit.not !== undefined ? `not asked: ${limit.not}` : await Promise.race([
        media.getUserMedia({ video: true }).then(
          (stream) => {
            const label = stream.getVideoTracks()[0]?.label ?? "(no video track)";
            for (const track of stream.getTracks()) track.stop();
            return `ok ${label}`;
          },
          (error: { name?: string; message?: string }) => `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`),
        new Promise<string>((resolve) => setTimeout(() => resolve(`no answer within ${limit.ms} ms`), limit.ms)),
      ]);
      return { devices, permission, probe };
    }, { ms: timeoutMs, not: ask === true ? undefined : ask.not });
  } catch (error) {
    const unread = `unread: ${String(error)}`;
    return { devices: [unread], permission: unread, probe: unread };
  }
}

/** What Chromium's media log says: the devices captures opened, and its failure lines (the last few). */
export interface MediaLogExcerpt {
  readonly source: string;
  readonly opened: readonly string[];
  readonly failures: readonly string[];
  /** Last screen-lock notification, with its browser-local timestamp (no year or zone); absent means unknown. */
  readonly screen?: { readonly state: "locked" | "unlocked"; readonly event: string };
}

const OPENED = /VideoCaptureManager::Open, device\.name = ([^,]+),/;
const FAILURE = /video capture:.*(?:[Ff]ail|[Ee]rror|[Tt]imeout)|START_TIMEOUT|Timeout starting video source/;

/** Reads the media log of a surface's browser. A missing log says why (the headless shell writes to stderr). */
export function mediaLogExcerpt(launch: Dim2Launch | undefined, read: (file: string) => string = (file) => readFileSync(file, "utf8")): MediaLogExcerpt {
  if (!launch) return { source: "no launch known: not a lab DIM2 surface", opened: [], failures: [] };
  const file = launch.mediaLogFile;
  if (!file) return { source: launch.mediaLogNote ?? "no media log", opened: [], failures: [] };
  let text: string;
  try { text = read(file); } catch (error) {
    return { source: `${file} unreadable (${(error as { code?: string }).code ?? String(error)}): the headless shell logs to its stderr, seen with DEBUG=pw:browser`, opened: [], failures: [] };
  }
  const lines = text.split("\n");
  const screenEvent = lines.findLast((line) => /VideoCaptureManager::OnScreen(?:Locked|Unlocked)\b/.test(line));
  return { source: file,
    ...(screenEvent ? { screen: { state: screenEvent.includes("::OnScreenLocked") ? "locked" as const : "unlocked" as const,
      event: screenEvent.slice(0, 500) } } : {}),
    opened: [...new Set(lines.flatMap((line) => OPENED.exec(line)?.[1]?.trim() ?? []))],
    failures: lines.filter((line) => FAILURE.test(line)).slice(-5).map((line) => line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 300)) };
}

/** Which camera failed: the machine's real one, or Chromium's synthetic camera (by a start timeout or otherwise). */
export function cameraVerdict(reading: Dim2CameraReading, log: MediaLogExcerpt): string {
  const realOpened = log.opened.filter((name) => !SYNTHETIC_CAMERA.test(name));
  if (realOpened.length) return `the real device: Chromium opened ${realOpened.map((name) => JSON.stringify(name)).join(", ")}`;
  const realListed = reading.devices.filter((device) => device.startsWith("videoinput:") && !SYNTHETIC_CAMERA.test(device.slice("videoinput:".length)));
  if (realListed.length) return `the real device: the page lists ${realListed.join(", ")}`;
  if (reading.probe.startsWith("not asked: ")) return `undetermined: no fresh camera request was made (${reading.probe.slice("not asked: ".length)})`;
  if (log.screen?.state === "locked" && !reading.probe.startsWith("ok ") && !reading.probe.startsWith("unread"))
    return `the screen was locked in Chromium's last notification when the log was read (browser-local timestamp: ${log.screen.event}); the synthetic camera probe returned ${reading.probe}. Chromium blocks new capture while locked; the lock timing relative to the probe is unknown and the current OS lock state was not read`;
  // A fresh request still pending at the reading's limit is a start that has not finished: a start timeout too.
  const pending = /^no answer within (\d+) ms/.exec(reading.probe);
  if (pending) return `a start timeout of Chromium's synthetic camera, not the real device (pending: the fresh request had no answer within ${pending[1]} ms)`;
  const timeout = /Timeout starting video source|START_TIMEOUT|[Tt]imeout/;
  if (timeout.test(reading.probe) || log.failures.some((line) => timeout.test(line)))
    return "a start timeout of Chromium's synthetic camera (fake_device_0), not the real device";
  if (/^ok fake_device_\d+/.test(reading.probe))
    return "not the real device: Chromium's synthetic camera starts now, so the app's own request failed earlier (its error is in the page's console.jsonl)";
  if (reading.probe.startsWith("unread")) return "undetermined: the page could not be read";
  // NotReadableError alone does not rule a timeout out: say only what the evidence holds.
  return `not the real device: Chromium's synthetic camera failed to start (${reading.probe}); neither the request nor the media log names a timeout`;
}

export interface Dim2CameraDiagnosis {
  readonly at: string;
  readonly why: string;
  readonly reading: Dim2CameraReading;
  readonly launch?: Dim2Launch;
  readonly mediaLog: MediaLogExcerpt;
  readonly verdict: string;
}

/**
 * The camera diagnosis for a DIM2 page, taken when a camera fails: the device list, a fresh `getUserMedia` error, the
 * launch arguments, the media log's opened devices and failures, and which camera it was. Appended to the session's
 * `camera.jsonl` when the page is a lab DIM2 session. Never throws.
 */
export async function diagnoseDim2Camera(page: LocatorRoot, why: string, launch: Dim2Launch | undefined = dim2Launch(page), now: () => Date = () => new Date()): Promise<Dim2CameraDiagnosis> {
  const lacks = syntheticMediaMissing(launch);
  const reading = await readDim2Camera(page, 5000, lacks ? { not: lacks } : true);
  const mediaLog = mediaLogExcerpt(launch);
  const diagnosis = { at: now().toISOString(), why, reading, ...(launch ? { launch } : {}), mediaLog, verdict: cameraVerdict(reading, mediaLog) };
  if (launch?.runDir) {
    try { appendFileSync(join(launch.runDir, "camera.jsonl"), JSON.stringify(diagnosis) + "\n", { mode: 0o600 }); } catch { /* the message still carries it */ }
  }
  return diagnosis;
}

export function describeDim2Camera(diagnosis: Dim2CameraDiagnosis): string {
  const { reading, launch, mediaLog } = diagnosis;
  return `camera (${diagnosis.why}): ${diagnosis.verdict}; devices [${reading.devices.join(", ") || "none"}], permission ${reading.permission}, getUserMedia ${reading.probe}; `
    + `media log ${mediaLog.source}: opened [${mediaLog.opened.join(", ") || "none"}], failures [${mediaLog.failures.join(" | ") || "none"}], screen ${mediaLog.screen ? `${mediaLog.screen.state} (browser-local timestamp: ${mediaLog.screen.event})` : "unknown (no lock notification recorded)"}; `
    + `browser launched ${launch ? `by ${launch.launchPath} with [${launch.args.join(" ")}]` : "with unknown arguments (not a lab DIM2 surface)"}`;
}

/** DIM2's own camera screens (`components/camera-needed.tsx`), by their headings. */
export const DIM2_CAMERA_SCREEN = /^(?:Jollity needs your camera|No camera found|Your camera is busy|Your camera is taking longer)$/;
