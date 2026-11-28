// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

const PREFIX = "E2E_NETEM_PHASE"
const DEFAULT_MAX_LINE_LENGTH = 8_192
const SAFE_DETAIL = /^[a-z][a-z0-9-]{0,63}$/

export type NetemLifecycleState = "active" | "restored"

export interface NetemLifecycleEvent {
  state: NetemLifecycleState
  detail: string
}

export class NetemLifecycleProtocolError extends Error {
  constructor(message: string) {
    super(`invalid netem lifecycle record: ${message}`)
    this.name = "NetemLifecycleProtocolError"
  }
}

/** Parse one stdout line. Ordinary netem diagnostics are not protocol data. */
export function parseNetemLifecycleLine(rawLine: string): NetemLifecycleEvent | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
  if (!line.startsWith(PREFIX)) return null
  const fields = line.split("\t")
  if (fields.length !== 3 || fields[0] !== PREFIX) throw new NetemLifecycleProtocolError("expected exactly three tab-separated fields")
  const state = fields[1]
  if (state !== "active" && state !== "restored") throw new NetemLifecycleProtocolError(`unknown state ${JSON.stringify(state)}`)
  const detail = fields[2]
  if (!SAFE_DETAIL.test(detail)) throw new NetemLifecycleProtocolError("detail is not a safe lowercase action key")
  return { state, detail }
}

/** Incremental parser for child-process stdout. Stderr is deliberately absent
 * from this API so a warning or injected diagnostic can never activate HUD state. */
export class NetemLifecycleParser {
  private buffered = ""
  private discardingOrdinaryLine = false
  private ended = false
  private readonly maxLineLength: number

  constructor(options: { maxLineLength?: number } = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
    if (!Number.isSafeInteger(this.maxLineLength) || this.maxLineLength < 1) throw new NetemLifecycleProtocolError("maxLineLength must be a positive safe integer")
  }

  push(chunk: string): NetemLifecycleEvent[] {
    if (this.ended) throw new NetemLifecycleProtocolError("stdout arrived after finish")
    if (this.discardingOrdinaryLine) {
      const newline = chunk.indexOf("\n")
      if (newline < 0) return []
      this.discardingOrdinaryLine = false
      chunk = chunk.slice(newline + 1)
    }
    this.buffered += chunk
    const events: NetemLifecycleEvent[] = []
    while (true) {
      const newline = this.buffered.indexOf("\n")
      if (newline < 0) break
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      events.push(...this.parseBounded(line))
    }
    if (this.buffered.length > this.maxLineLength) {
      if (this.buffered.startsWith(PREFIX)) throw new NetemLifecycleProtocolError(`stdout line exceeds ${this.maxLineLength} characters`)
      // Human diagnostics can contain unbounded host output. They are evidence
      // in the runner transcript, but are not protocol data: stop buffering
      // this line and resume at its newline.
      this.buffered = ""
      this.discardingOrdinaryLine = true
    }
    return events
  }

  finish(): NetemLifecycleEvent[] {
    if (this.ended) return []
    this.ended = true
    if (this.discardingOrdinaryLine) {
      this.discardingOrdinaryLine = false
      this.buffered = ""
      return []
    }
    const line = this.buffered
    this.buffered = ""
    return line ? this.parseBounded(line) : []
  }

  private parseBounded(line: string): NetemLifecycleEvent[] {
    if (line.length > this.maxLineLength) {
      if (line.startsWith(PREFIX)) throw new NetemLifecycleProtocolError(`stdout line exceeds ${this.maxLineLength} characters`)
      return []
    }
    const event = parseNetemLifecycleLine(line)
    return event ? [event] : []
  }
}
