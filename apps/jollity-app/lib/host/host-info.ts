// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHICH HOST, WHICH BUILD — the host's own report of itself, for telemetry.
 *
 * truApi `system.info()` returns `{ platform, name, version }` (the host's
 * native version string, e.g. "Polkadot Mobile" "1.4.2"). It is the only way
 * a product learns the host app's version; the user agent names the WebView,
 * not the app around it. Null outside a host, on an unavailable call, on an
 * error result, or after a second of silence. Never throws. Some current
 * Android builds omit `version`; preserve that as an empty value so telemetry
 * can describe it as a host that sent no version. A host older than truapi
 * 0.27 sends no `truapiVersion`, so the 0.27 decoder throws a RangeError on its
 * answer, and the read returns "older than truapi 0.27" as its version.
 */
import { devLog } from "../debug/log-store"
import { withTimeout } from "../with-timeout"
import { describeError } from "./error-detail"
import { retrySafeHostRead } from "./safe-call"

export interface HostInfo {
  platform: string
  name: string
  version: string
}

export interface HostInfoRead {
  info: HostInfo | null
  failed: boolean
}

const TIMEOUT_MS = 1000

export async function readHostInfoResult(): Promise<HostInfoRead> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    const truApi = await retrySafeHostRead(sdk, () => sdk.getTruApi())
    if (!truApi) return { info: null, failed: false }
    const result = await retrySafeHostRead(sdk, () => withTimeout(truApi.system.info(), TIMEOUT_MS), {
      errorOf: (value) => value && !value.isOk() ? value.error : null,
      operation: "host.system-info",
    })
    if (!result) return { info: null, failed: true }
    if (!result.isOk()) {
      devLog("host", "system.info failed", { detail: describeError(result.error) }, "warn")
      return { info: null, failed: true }
    }
    const { platform, name, version } = result.value
    return {
      info: { platform: String(platform), name: String(name), version: version == null ? "" : String(version) },
      failed: false,
    }
  } catch (error) {
    devLog("host", "system.info unavailable", { detail: describeError(error) }, "warn")
    if (error instanceof RangeError) return { info: { platform: "", name: "", version: "older than truapi 0.27" }, failed: false }
    return { info: null, failed: true }
  }
}

export async function readHostInfo(): Promise<HostInfo | null> {
  return (await readHostInfoResult()).info
}
