// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE ROOT ERROR BOUNDARY: a render crash anywhere below the root layout is
 * reported as `render-crash`, with React's component stack, and the app
 * brings itself back. Our own class component, not app/error.tsx: Next's
 * error file conventions receive no component stack, and error.tsx does not
 * wrap the root layout.
 *
 * The first crash of a page load reloads at once and draws nothing. A crash
 * that comes straight back reloads on the backoff of lib/crash-reload, under
 * a screen that says so. There is nothing to tap: a reload is the only way
 * back, and the app takes it by itself.
 */
import { Component, type ErrorInfo, type ReactNode } from "react"
import { CRASH_RELOAD_GRACE_MS, clearCrashReload, crashReloadDelayMs, markCrashReload } from "@/lib/crash-reload"
import { renderCrashDetails, reportFailure } from "@/lib/telemetry"
import { noteOwnReload } from "@/lib/telemetry/session-record"

interface CrashState {
  crashed: boolean
  /** the wait before the reload, null before a crash */
  reloadInMs: number | null
}

function reload(): void {
  noteOwnReload()
  window.location.reload()
}

export class CrashBoundary extends Component<{ children: ReactNode }, CrashState> {
  state: CrashState = { crashed: false, reloadInMs: null }
  private cleanStart: ReturnType<typeof setTimeout> | undefined
  private reloadTimer: ReturnType<typeof setTimeout> | undefined

  static getDerivedStateFromError(): CrashState {
    return { crashed: true, reloadInMs: crashReloadDelayMs() }
  }

  componentDidMount() {
    this.cleanStart = setTimeout(clearCrashReload, CRASH_RELOAD_GRACE_MS)
  }

  componentWillUnmount() {
    if (this.cleanStart) clearTimeout(this.cleanStart)
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportFailure("render-crash", renderCrashDetails(error, info.componentStack))
    const wait = this.state.reloadInMs
    if (wait === null || this.reloadTimer) return
    if (this.cleanStart) clearTimeout(this.cleanStart)
    markCrashReload()
    this.reloadTimer = setTimeout(reload, wait)
  }

  render() {
    if (!this.state.crashed) return this.props.children
    if (this.state.reloadInMs === 0) return null
    return (
      <div className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-[28px] leading-9 font-bold">Something went wrong</h1>
        <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">
          We are bringing you back into the game as soon as we can.
        </p>
      </div>
    )
  }
}
