// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { betterSnapshot, type SnapshotScore } from "./snapshot-quality"

export interface SnapshotCandidate {
  url: string
  score: SnapshotScore
}

const revokeBlobUrl = (url: string): void => {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url)
}

/** Memory-only ownership and evidence-boundary lifecycle for captured stills. */
export class SnapshotCandidateStore<Id> {
  private readonly candidates = new Map<Id, SnapshotCandidate>()
  private isFrozen = false
  private version = 0

  constructor(private readonly revoke: (url: string) => void = revokeBlobUrl) {}

  photoFor(id: Id): string | undefined {
    return this.candidates.get(id)?.url
  }

  generation(): number {
    return this.version
  }

  frozen(): boolean {
    return this.isFrozen
  }

  offer(id: Id, candidate: SnapshotCandidate, generation: number): boolean {
    if (this.isFrozen || generation !== this.version) {
      this.revoke(candidate.url)
      return false
    }
    const current = this.candidates.get(id)
    if (current && !betterSnapshot(candidate.score, current.score)) {
      this.revoke(candidate.url)
      return false
    }
    if (current) this.revoke(current.url)
    this.candidates.set(id, candidate)
    return true
  }

  freeze(): void {
    if (this.isFrozen) return
    this.isFrozen = true
    this.version += 1
  }

  dispose(): void {
    this.freeze()
    for (const candidate of this.candidates.values()) this.revoke(candidate.url)
    this.candidates.clear()
  }
}
