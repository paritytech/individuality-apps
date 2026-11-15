// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Copy text to the clipboard from inside the host WebView.
 *
 * The async Clipboard API is often policy-blocked in the host iframe, so this
 * falls back to a hidden `<textarea>` + `execCommand("copy")` under the user
 * gesture — the same host-sandbox-safe path the debug sheet's Copy uses. Call
 * it directly from a click/touch handler so the gesture is still active.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* Clipboard API blocked (common in the host iframe) — fall through */
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0"
    document.body.append(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand("copy")
    ta.remove()
    return ok
  } catch {
    return false
  }
}
