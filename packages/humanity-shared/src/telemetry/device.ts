// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The phone a report came from, on every event as tags and contexts.
 *
 * `sentry.ts` turns `httpHeaders` off, so no User-Agent reaches Sentry and
 * its own `os.name` / `browser.name` / `device.family` stay empty: without
 * this module a slow card load cannot be split by iPhone vs
 * Android, which is what tells a slow phone from a slow product. The user
 * agent is parsed here instead, and only the fields below leave the device.
 *
 * The tag names are Jollity's (`apps/jollity-app/lib/telemetry/device.ts`), so
 * one Sentry query groups both products by the same device fields:
 * `device.os`, `device.os_version`, `device.model`, `device.engine`,
 * `device.engine_version`, `device.cores`, `device.memory`, `net.type`,
 * `net.effective`. The `os` and `browser` contexts fill Sentry's own columns.
 *
 * The user-agent part is synchronous and set at init, before the first
 * flow opens, so `card.load` always carries it. Android WebView's client
 * hints (true model, OS version) arrive a moment later and refine the tags;
 * a flow that ends first keeps the user-agent values. Nothing here throws.
 */
import { getCurrentScope } from "@sentry/browser";

export type DeviceOs = "android" | "ios" | "macos" | "windows" | "linux" | "other";
export type DeviceEngine = "chromium-webview" | "chromium" | "webkit" | "other";

export interface ParsedUserAgent {
  os: DeviceOs;
  osVersion: string;
  engine: DeviceEngine;
  engineVersion: string;
  model: string | null;
}

const match = (text: string, pattern: RegExp): string | null => pattern.exec(text)?.[1] ?? null;

export function parseUserAgent(ua: string, maxTouchPoints = 0): ParsedUserAgent {
  let os: DeviceOs = "other";
  let osVersion = "";
  let model: string | null = null;
  if (/Android/i.test(ua)) {
    os = "android";
    osVersion = match(ua, /Android ([\d.]+)/) ?? "";
    const named =
      match(ua, /Android [\d.]+;\s*([^;)]*?)\s*Build\//) ?? match(ua, /Android [\d.]+;\s*([^;)]+)/);
    // "K" is Chrome's reduced user agent; "wv" is the WebView flag.
    model = named != null && named !== "K" && named !== "wv" ? named.trim() : null;
  } else if (/iPhone|iPad|iPod/.test(ua)) {
    os = "ios";
    osVersion = (match(ua, /OS (\d+(?:_\d+)*) like Mac/) ?? "").replace(/_/g, ".");
    model = /iPad/.test(ua) ? "iPad" : "iPhone";
  } else if (/Macintosh/.test(ua)) {
    // An iPad asking for the desktop site: a Mac user agent with a touch screen.
    if (maxTouchPoints > 1) {
      os = "ios";
      osVersion = match(ua, /Version\/([\d.]+)/) ?? "";
      model = "iPad";
    } else {
      os = "macos";
      osVersion = (match(ua, /Mac OS X (\d+(?:[_.]\d+)*)/) ?? "").replace(/_/g, ".");
    }
  } else if (/Windows/.test(ua)) {
    os = "windows";
    osVersion = match(ua, /Windows NT ([\d.]+)/) ?? "";
  } else if (/Linux|X11|CrOS/.test(ua)) {
    os = "linux";
  }
  let engine: DeviceEngine = "other";
  let engineVersion = "";
  const chrome = match(ua, /Chrome\/([\d.]+)/);
  if (chrome != null) {
    engine = /;\s*wv\)/.test(ua) ? "chromium-webview" : "chromium";
    engineVersion = chrome;
  } else if (/AppleWebKit/.test(ua)) {
    engine = "webkit";
    engineVersion = match(ua, /AppleWebKit\/([\d.]+)/) ?? "";
  }
  return { os, osVersion, engine, engineVersion, model };
}

/** The tags every event carries; a field that is not known is left out. */
export function deviceTags(
  device: ParsedUserAgent,
  hardware: { cores: number | null; memory: number | null },
): Record<string, string> {
  const tags: Record<string, string> = { "device.os": device.os, "device.engine": device.engine };
  const parts = device.osVersion.split(".");
  const osVersion = device.os === "android" ? parts[0] : parts.slice(0, 2).join(".");
  if (osVersion) tags["device.os_version"] = osVersion;
  if (device.model != null) tags["device.model"] = device.model;
  // iOS: WebKit says 605 on every device; the OS version is the engine's.
  const engineMajor = device.os === "ios" ? "" : device.engineVersion.split(".")[0];
  if (engineMajor) tags["device.engine_version"] = engineMajor;
  if (hardware.cores != null) tags["device.cores"] = String(hardware.cores);
  if (hardware.memory != null) tags["device.memory"] = String(hardware.memory);
  return tags;
}

const OS_NAME: Record<DeviceOs, string> = {
  android: "Android",
  ios: "iOS",
  macos: "Mac OS X",
  windows: "Windows",
  linux: "Linux",
  other: "Other",
};

const ENGINE_NAME: Record<DeviceEngine, string> = {
  "chromium-webview": "Chrome Mobile WebView",
  chromium: "Chrome",
  webkit: "WebKit",
  other: "Other",
};

interface ConnectionLike {
  type?: unknown;
  effectiveType?: unknown;
  addEventListener?: (name: "change", listener: () => void) => void;
}

interface UserAgentData {
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
}

/** `navigator.connection`, Chromium only: wifi or cellular, and how fast it feels. */
function connectionTags(connection: ConnectionLike): Record<string, string> {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : "unknown");
  return { "net.type": text(connection.type), "net.effective": text(connection.effectiveType) };
}

function apply(device: ParsedUserAgent, hardware: { cores: number | null; memory: number | null }): void {
  const scope = getCurrentScope();
  scope.setTags(deviceTags(device, hardware));
  scope.setContext("os", { name: OS_NAME[device.os], version: device.osVersion || undefined });
  scope.setContext("browser", {
    name: ENGINE_NAME[device.engine],
    version: device.engineVersion || undefined,
  });
  // Android only: on iOS the model is just "iPhone", and Sentry would
  // otherwise parse a model out of a User-Agent it never receives.
  if (device.os === "android" && device.model != null) {
    scope.setContext("device", { model: device.model, family: device.model, cores: hardware.cores ?? undefined, memory: hardware.memory ?? undefined });
  }
}

const CLIENT_HINTS_TIMEOUT_MS = 1_000;

/**
 * Put the device on the scope: the user agent now, client hints when they
 * land. Called once from `initTelemetry`, after the client is bound.
 */
export function setDeviceContext(): void {
  try {
    if (typeof navigator === "undefined") return;
    const nav = navigator as Navigator & {
      deviceMemory?: unknown;
      connection?: ConnectionLike;
      userAgentData?: UserAgentData;
    };
    const device = parseUserAgent(nav.userAgent ?? "", nav.maxTouchPoints ?? 0);
    const hardware = {
      cores: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
      memory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    };
    apply(device, hardware);

    const connection = nav.connection;
    if (connection != null) {
      getCurrentScope().setTags(connectionTags(connection));
      connection.addEventListener?.("change", () => {
        getCurrentScope().setTags(connectionTags(connection));
      });
    }

    const hints = nav.userAgentData?.getHighEntropyValues?.(["model", "platformVersion", "fullVersionList"]);
    if (hints == null) return;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CLIENT_HINTS_TIMEOUT_MS));
    void Promise.race([hints, timeout])
      .then((values) => {
        if (values == null) return;
        const refined = { ...device };
        if (typeof values.model === "string" && values.model !== "") refined.model = values.model;
        if (typeof values.platformVersion === "string" && values.platformVersion !== "") {
          refined.osVersion = values.platformVersion.replace(/(\.0)+$/, "");
        }
        const list = values.fullVersionList;
        if (Array.isArray(list)) {
          const brand = list.find((b: { brand?: unknown }) => /Android WebView|Chromium/.test(String(b?.brand)));
          const version = (brand as { version?: unknown } | undefined)?.version;
          if (typeof version === "string" && version !== "") refined.engineVersion = version;
        }
        apply(refined, hardware);
      })
      .catch(() => {});
  } catch {
    // Telemetry never breaks the app.
  }
}
