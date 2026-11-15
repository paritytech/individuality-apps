// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface HostTelemetryContext {
  hostSessionId: string
  appVersion?: string
  appBuild?: string
  appVariant?: string
  sourceCommit?: string
  platform?: string
  osVersion?: string
  truapiHostVersion?: string
  truapiCoreVersion?: string
  codecVersion?: string
  schemaVersion?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELDS = [
  "appVersion",
  "appBuild",
  "appVariant",
  "sourceCommit",
  "platform",
  "osVersion",
  "truapiHostVersion",
  "truapiCoreVersion",
  "codecVersion",
  "schemaVersion",
] as const

/** Read the optional native bootstrap once. It must never delay or break Sentry. */
export function readHostTelemetryContext(root: typeof globalThis = globalThis): HostTelemetryContext | null {
  try {
    const value = (root as typeof globalThis & { __trinityHostTelemetry?: unknown }).__trinityHostTelemetry
    if (!value || typeof value !== "object") return null
    const record = value as Record<string, unknown>
    if (typeof record.hostSessionId !== "string" || !UUID.test(record.hostSessionId)) return null

    const context: HostTelemetryContext = { hostSessionId: record.hostSessionId }
    for (const field of FIELDS) {
      const candidate = record[field]
      if (typeof candidate === "string" && candidate.length > 0) context[field] = candidate
    }
    return context
  } catch {
    return null
  }
}

export function hostTelemetryTags(context: HostTelemetryContext | null): Record<string, string> {
  if (!context) return {}
  return {
    "host.session_id": context.hostSessionId,
    ...(context.appVersion ? { "host.native_app_version": context.appVersion } : {}),
    ...(context.appBuild ? { "host.app_build": context.appBuild } : {}),
    ...(context.appVariant ? { "host.app_variant": context.appVariant } : {}),
    ...(context.sourceCommit ? { "host.source_commit": context.sourceCommit } : {}),
    ...(context.truapiHostVersion ? { "truapi.host_version": context.truapiHostVersion } : {}),
    ...(context.truapiCoreVersion ? { "truapi.core_version": context.truapiCoreVersion } : {}),
    ...(context.codecVersion ? { "truapi.codec_version": context.codecVersion } : {}),
    ...(context.schemaVersion ? { "truapi.schema_version": context.schemaVersion } : {}),
  }
}
