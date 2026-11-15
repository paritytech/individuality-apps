// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export type TelemetryRecordKind = "event" | "transaction" | "metric" | "log"

export interface TelemetryRecord {
  kind: TelemetryRecordKind
  name: string
  value?: number
  level?: string
  tags: Record<string, string>
  user?: { id?: string; username?: string }
  contexts?: Record<string, Record<string, unknown>>
  measurements?: Record<string, { value: number; unit: string }>
}

type Attribute = { value?: unknown }

const attributes = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, Attribute>).map(([key, attribute]) => [key, String(attribute?.value ?? "")]),
  )
}

const detail = (body: string): Record<string, unknown> | undefined => {
  const tab = body.indexOf("\t")
  if (tab < 0) return undefined
  try {
    const parsed = JSON.parse(body.slice(tab + 1))
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { value: parsed }
  } catch {
    return { text: body.slice(tab + 1) }
  }
}

/** Decode the worker's SDK-free Sentry envelope into typed records for behavior tests. */
export function decodeTelemetryEnvelope(body: string): TelemetryRecord[] {
  const lines = body.split("\n").map((line) => JSON.parse(line))
  const item = lines[1] as { type?: string }
  const payload = lines[2] as Record<string, unknown>
  if (item.type === "trace_metric") {
    return ((payload.items ?? []) as Array<Record<string, unknown>>).map((point) => ({
      kind: "metric",
      name: String(point.name ?? ""),
      value: Number(point.value),
      tags: attributes(point.attributes),
    }))
  }
  if (item.type === "log") {
    return ((payload.items ?? []) as Array<Record<string, unknown>>).map((record) => {
      const body = String(record.body ?? "")
      const parsedDetail = detail(body)
      return {
        kind: "log",
        name: body.split("\t", 1)[0]!,
        level: String(record.level ?? ""),
        tags: attributes(record.attributes),
        ...(parsedDetail ? { contexts: { detail: parsedDetail } } : {}),
      }
    })
  }
  const transaction = item.type === "transaction"
  return [{
    kind: transaction ? "transaction" : "event",
    name: String(transaction ? payload.transaction ?? "" : payload.message ?? ""),
    level: typeof payload.level === "string" ? payload.level : undefined,
    tags: (payload.tags as Record<string, string> | undefined) ?? {},
    user: payload.user as TelemetryRecord["user"],
    contexts: payload.contexts as TelemetryRecord["contexts"],
    measurements: payload.measurements as TelemetryRecord["measurements"],
  }]
}

export const telemetryRecords = (records: TelemetryRecord[], name: string, kind: TelemetryRecordKind): TelemetryRecord[] =>
  records.filter((record) => record.name === name && record.kind === kind)
