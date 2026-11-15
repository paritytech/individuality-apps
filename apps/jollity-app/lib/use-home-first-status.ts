// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect } from "react"
import { beginHomeFirstStatus, endHomeFirstStatus } from "./journeys/home-first-status"

/** journey.home-first-status for the home page: starts at mount, ends `shown`
 *  with the first status that is not "loading", or `restart-card` when the
 *  restart card took the bare title's place. */
export function useHomeFirstStatus(options: { loading: boolean; cardReason: string | undefined }): void {
  const { loading, cardReason } = options
  useEffect(() => beginHomeFirstStatus(), [])
  useEffect(() => {
    if (cardReason) endHomeFirstStatus("restart-card", { reason: cardReason })
    else if (!loading) endHomeFirstStatus("shown")
  }, [loading, cardReason])
}
