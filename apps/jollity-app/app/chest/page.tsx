// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE OLD ADDRESS of the collectables screen. A host that reopens the last page
 * it showed may still ask for /chest, the screen's address before it was
 * renamed: it goes on to /collectables with the same query.
 */
import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function OldCollectablesAddress() {
  const router = useRouter()
  useEffect(() => {
    router.replace(`/collectables${window.location.search}`)
  }, [router])
  return null
}
