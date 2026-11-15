// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { DedupTable, dedupKey, NO_NODE, PathArena } from "./dedup-table"
import { isFault, type Label, type StepRecord } from "./labels"

export interface SearchRoom {
  enabled(): Label[]
  step(label: Label): Promise<StepRecord>
  reset(): Promise<void>
  violations(): { property: string; atStep: number; detail: string }[]
  faultsLeft(): number
  horizonReached(): boolean
  fingerprint?(): string
  /** Key-independent state used only by the collision replay (mesh/collision-replay.explore.ts). */
  collisionState?(): CollisionState
  /** Fair-drain result at a collision suffix leaf. */
  collisionDrain?(): Promise<CollisionDrain>
}

interface CollisionState {
  enabled: { key: string; label: Label }[]
  workCounters: string
  findings: string[]
  gaps: string[]
}

interface CollisionDrain {
  outcome: string
  workCounters: string
  findings: string[]
  gaps: string[]
}

export interface CensusPaths {
  key: string
  paths: Label[][]
}

export type Cut = "depth" | "faults" | "horizon" | "quiet" | "seen" | "harness"

export interface Leaf {
  labels: Label[]
  cut: Cut
  room: SearchRoom
  detail?: string
}

export interface SearchBounds {
  depth: number
  budgetMs: number
  sample?: { count: number; seed: number; depth?: number }
  onLeaf?: (leaf: Leaf) => Promise<void>
  /** Default off: fingerprint every visited node and count distinct terminal states. Never prunes. */
  census?: boolean
  /** Default off. Within each iterative-deepening level, expand a room
   * fingerprint only at the greatest remaining depth seen in this shard. */
  dedup?: {
    /** Replay every ordered Nth pruned node against its kept twin to suffix depth 2. */
    check?: { oneIn: number }
    /** Test-only negative control: production always includes faultsLeft. */
    includeFaults?: boolean
    /** Test-only negative controls may weaken only the pruning key. */
    key?: (room: SearchRoom, fingerprint: string) => string | Promise<string>
  }
  /** Test-only: keep expanding after a violation so equivalence compares the full finding set. */
  continueAfterViolation?: boolean
  /** search only this shard's part of the tree: labels at `depth` are dealt
   * from parent-local indices mod `of`, and nodes before that depth plus the
   * random sample are counted once. mergeReports adds the parts up. */
  shard?: { index: number; of: number; depth?: 1 | 2 }
  /** the clock the budget and level times read (default performance.now). A
   * room that fakes timers fakes performance and restarts it at each reset,
   * so mesh-pair passes a real one (quiescence.ts realMs). */
  now?: () => number
  /** called once after each iterative-deepening level that ran to its end (never for a level the budget cut short) */
  onLevel?: (level: SearchLevel, progress: { findings: number }) => void
}

export interface SearchLevel {
  depth: number
  leaves: number
  meanEnabled: number
  cuts: Record<Cut, number>
  details: Record<string, number>
  elapsedMs: number
  /** fingerprint keys stored (and therefore expanded) by dedup at this level */
  expanded?: number
  /** nodes pruned against a key expanded with at least as much depth left */
  seen?: number
  /** keys held by this shard's dedup table at the level's end (shared-prefix nodes included) */
  dedupEntries?: number
  /** bytes the dedup table and its path arena had allocated at the level's end */
  dedupBytes?: number
  /** sharded runs: the nodes behind meanEnabled, so a merge can weight it */
  nodes?: number
  census?: {
    depthLeaves: number
    distinctFingerprints: number
    ratio: number
  }
  /** Internal merge material, emitted only in shard reports. */
  _censusKeys?: string[]
  /** Internal collision-replay material: the first two paths for each key. */
  _censusPaths?: CensusPaths[]
}

export interface Finding {
  property: string
  labels: Label[]
  atStep: number
  detail: string
  sampled: boolean
  /** L1: the fixed point it ended in (room.ts Violation.evidence) */
  evidence?: unknown
}

export interface SearchResult {
  levels: SearchLevel[]
  closedAtDepth: number
  inconclusive: boolean
  findings: Finding[]
  /** the search ran out of states to expand before its depth bound */
  frontierClosed?: boolean
}

const emptyCuts = (): Record<Cut, number> => ({
  depth: 0,
  faults: 0,
  horizon: 0,
  quiet: 0,
  seen: 0,
  harness: 0,
})

const digest128 = (key: string): string =>
  /^[0-9a-f]{32}$/i.test(key)
    ? key
    : createHash("sha256").update(key).digest("hex").slice(0, 32)

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

export async function search(
  makeRoom: () => Promise<SearchRoom>,
  bounds: SearchBounds,
): Promise<SearchResult> {
  if (!Number.isInteger(bounds.depth) || bounds.depth < 1) {
    throw new RangeError("search depth must be a positive integer")
  }
  if (!Number.isFinite(bounds.budgetMs) || bounds.budgetMs < 0) {
    throw new RangeError("search budgetMs must be a non-negative number")
  }
  if (
    bounds.dedup?.check !== undefined &&
    (!Number.isInteger(bounds.dedup.check.oneIn) || bounds.dedup.check.oneIn < 1)
  ) {
    throw new RangeError("dedup check oneIn must be a positive integer")
  }
  if (bounds.dedup !== undefined && bounds.depth > 255) {
    throw new RangeError("search depth must be at most 255 with dedup")
  }
  const shard = bounds.shard
  if (
    shard !== undefined &&
    !(
      Number.isInteger(shard.of) &&
      shard.of >= 1 &&
      Number.isInteger(shard.index) &&
      shard.index >= 0 &&
      shard.index < shard.of &&
      (shard.depth === undefined || shard.depth === 1 || shard.depth === 2)
    )
  ) {
    throw new RangeError(
      "search shard must have 0 <= index < of and depth 1 or 2",
    )
  }
  const rootShard = shard === undefined || shard.index === 0

  const now = bounds.now ?? (() => performance.now())
  const room = await makeRoom()
  const started = now()
  const deadline = started + bounds.budgetMs
  const levels: SearchLevel[] = []
  const findings: Finding[] = []
  let closedAtDepth = 0
  let inconclusive = false

  const expired = (): boolean => now() >= deadline
  const recordFinding = (
    violation: { property: string; atStep: number; detail: string },
    labels: Label[],
    sampled: boolean,
  ) => {
    const finding: Finding = { ...violation, labels: [...labels], sampled }
    const existing = findings.findIndex(
      (candidate) =>
        candidate.property === finding.property &&
        candidate.detail === finding.detail &&
        candidate.sampled === finding.sampled,
    )
    if (existing === -1) {
      findings.push(finding)
    } else if (findings[existing].labels.length > finding.labels.length) {
      findings[existing] = finding
    }
  }

  for (let targetDepth = 1; targetDepth <= bounds.depth; targetDepth += 1) {
    if (expired()) {
      inconclusive = true
      break
    }

    const levelStarted = now()
    const cuts = emptyCuts()
    const details: Record<string, number> = {}
    let leaves = 0
    let enabledTotal = 0
    let enabledNodes = 0
    let completed = true
    let expanded = 0
    let seen = 0
    let seenOrdinal = 0
    const dealDepth = Math.min(shard?.depth ?? 1, targetDepth)
    const visited = bounds.dedup === undefined ? undefined : new DedupTable()
    // the dedup check replays a pruned node against the path that kept its key
    const paths = bounds.dedup?.check === undefined ? undefined : new PathArena()

    const owns = (owner: number | undefined): boolean =>
      shard === undefined || owner === shard.index
    const leafFingerprints = bounds.census ? new Set<string>() : undefined
    const censusPaths = bounds.census ? new Map<string, Label[][]>() : undefined
    let nodeFingerprint: string | undefined

    const leaf = async (
      labels: Label[],
      cut: Cut,
      owner: number | undefined,
      detail?: string,
    ): Promise<boolean> => {
      const sharedPrefixHarness =
        cut === "harness" &&
        shard !== undefined &&
        labels.length < dealDepth
      if (!owns(owner) && !sharedPrefixHarness) return false
      leaves += 1
      if (cut === "depth" && nodeFingerprint !== undefined) {
        leafFingerprints?.add(nodeFingerprint)
        const paths = censusPaths?.get(nodeFingerprint) ?? []
        if (paths.length < 2 && !paths.some((path) => path.join("\0") === labels.join("\0"))) {
          paths.push([...labels])
          censusPaths?.set(nodeFingerprint, paths)
        }
      }
      cuts[cut] += 1
      if (detail !== undefined) details[detail] = (details[detail] ?? 0) + 1
      await bounds.onLeaf?.({ labels: [...labels], cut, room, detail })
      return true
    }

    const roomCall = async <T>(
      call: () => T | Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false; detail: string }> => {
      try {
        return { ok: true, value: await call() }
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const visit = async (
      labels: Label[],
      owner: number | undefined,
      continueFromParent = false,
      parentNode = NO_NODE,
    ): Promise<boolean> => {
      if (!completed) return false
      if (expired()) {
        completed = false
        inconclusive = true
        return false
      }

      if (!continueFromParent) {
        const reset = await roomCall(() => room.reset())
        if (!reset.ok) {
          await leaf(labels, "harness", owner, reset.detail)
          return false
        }
      }
      nodeFingerprint = undefined
      const replay = continueFromParent ? labels.slice(-1) : labels
      for (const label of replay) {
        const stepped = await roomCall(() => room.step(label))
        if (!stepped.ok) {
          await leaf(labels, "harness", owner, stepped.detail)
          return false
        }
        const checked = await roomCall(() => room.violations())
        if (!checked.ok) {
          await leaf(labels, "harness", owner, checked.detail)
          return false
        }
        if (checked.value.length > 0) {
          if (owns(owner)) {
            if (bounds.census) {
              const fingerprinted = await roomCall(() => room.fingerprint?.())
              if (!fingerprinted.ok || fingerprinted.value === undefined) {
                await leaf(
                  labels,
                  "harness",
                  owner,
                  fingerprinted.ok
                    ? "census: room has no fingerprint"
                    : fingerprinted.detail,
                )
                return false
              }
              nodeFingerprint = fingerprinted.value
            }
            for (const violation of checked.value) {
              recordFinding(
                violation,
                labels.slice(0, violation.atStep + 1),
                false,
              )
            }
          }
          if (!bounds.continueAfterViolation) return false
        }
        if (expired()) {
          completed = false
          inconclusive = true
          return false
        }
      }

      if (bounds.census) {
        const fingerprinted = await roomCall(() => room.fingerprint?.())
        if (!fingerprinted.ok || fingerprinted.value === undefined) {
          await leaf(
            labels,
            "harness",
            owner,
            fingerprinted.ok
              ? "census: room has no fingerprint"
              : fingerprinted.detail,
          )
          return false
        }
        nodeFingerprint = fingerprinted.value
      }

      const horizon = await roomCall(() => room.horizonReached())
      if (!horizon.ok) {
        await leaf(labels, "harness", owner, horizon.detail)
        return false
      }
      if (horizon.value) {
        await leaf(labels, "horizon", owner)
        return false
      }
      if (labels.length === targetDepth) {
        await leaf(labels, "depth", owner)
        return false
      }

      let faultsValue: number | undefined
      let pathNode = NO_NODE
      if (bounds.dedup !== undefined && visited !== undefined) {
        const fingerprinted = await roomCall(() => room.fingerprint?.())
        if (!fingerprinted.ok || fingerprinted.value === undefined) {
          await leaf(
            labels,
            "harness",
            owner,
            fingerprinted.ok
              ? "dedup: room has no fingerprint"
              : fingerprinted.detail,
          )
          return false
        }
        const faults = await roomCall(() => room.faultsLeft())
        if (!faults.ok) {
          await leaf(labels, "harness", owner, faults.detail)
          return false
        }
        faultsValue = faults.value
        let weakened = fingerprinted.value
        if (bounds.dedup.key !== undefined) {
          const keyed = await roomCall(() => bounds.dedup!.key!(room, fingerprinted.value!))
          if (!keyed.ok) {
            await leaf(labels, "harness", owner, keyed.detail)
            return false
          }
          weakened = keyed.value
        }
        const key = dedupKey(
          digest128(weakened),
          bounds.dedup.includeFaults === false ? undefined : faults.value,
        )
        const remaining = targetDepth - labels.length
        const prior = visited.find(key)
        if (prior !== -1 && visited.remaining(prior) >= remaining) {
          if (owns(owner)) seen += 1
          seenOrdinal += 1
          if (
            bounds.dedup.check !== undefined &&
            seenOrdinal % bounds.dedup.check.oneIn === 0
          ) {
            const checked = await roomCall(() => replayCollisionPair(room, paths!.path(visited.node(prior)), labels, 2))
            if (!checked.ok || checked.value !== null) {
              const detail = checked.ok
                ? `dedup check mismatch: ${JSON.stringify(checked.value)}`
                : `dedup check: ${checked.detail}`
              await leaf(labels, "harness", owner, detail)
              return false
            }
            const restoredNode = await roomCall(async () => {
              await room.reset()
              for (const label of labels) await room.step(label)
            })
            if (!restoredNode.ok) {
              await leaf(labels, "harness", owner, `dedup check restore: ${restoredNode.detail}`)
              return false
            }
          }
          await leaf(labels, "seen", owner)
          const restoredParent = await roomCall(async () => {
            await room.reset()
            for (const label of labels.slice(0, -1)) await room.step(label)
          })
          if (!restoredParent.ok) {
            cuts.seen -= 1
            cuts.harness += 1
            details[`dedup parent restore: ${restoredParent.detail}`] =
              (details[`dedup parent restore: ${restoredParent.detail}`] ?? 0) + 1
            return false
          }
          return labels.length > 0
        }
        if (paths !== undefined) pathNode = paths.push(parentNode, labels.at(-1))
        visited.set(key, remaining, pathNode)
        if (owns(owner)) expanded += 1
      }

      const enabledResult = await roomCall(() => room.enabled())
      if (!enabledResult.ok) {
        await leaf(labels, "harness", owner, enabledResult.detail)
        return false
      }
      const enabled = enabledResult.value
      if (enabled.length === 0) {
        await leaf(labels, "quiet", owner)
        return false
      }

      if (faultsValue === undefined) {
        const faults = await roomCall(() => room.faultsLeft())
        if (!faults.ok) {
          await leaf(labels, "harness", owner, faults.detail)
          return false
        }
        faultsValue = faults.value
      }
      const faultsAvailable = faultsValue > 0
      const eligible = faultsAvailable
        ? enabled
        : enabled.filter((label) => !isFault(label))
      if (owns(owner)) {
        enabledNodes += 1
        enabledTotal += eligible.length
      }
      const atDealDepth = labels.length === dealDepth - 1
      const beforeDealDepth = labels.length < dealDepth - 1
      const childOwners = new Map<Label, number | undefined>()
      for (const [index, label] of enabled.entries()) {
        const childOwner =
          shard === undefined
            ? undefined
            : atDealDepth
              ? ((owner ?? 0) + index) % shard.of
              : beforeDealDepth
                ? index % shard.of
                : owner
        childOwners.set(label, childOwner)
      }

      let leafRanOnRoom = false
      if (!faultsAvailable) {
        for (const label of enabled) {
          if (isFault(label)) {
            leafRanOnRoom =
              (await leaf(
                [...labels, label],
                "faults",
                childOwners.get(label),
              )) || leafRanOnRoom
          }
        }
      }
      if (eligible.length === 0) return false

      let canContinueFromParent = !leafRanOnRoom
      for (const label of eligible) {
        const childOwner = childOwners.get(label)
        if (!beforeDealDepth && !owns(childOwner)) continue
        canContinueFromParent = await visit(
          [...labels, label],
          childOwner,
          canContinueFromParent,
          pathNode,
        )
        if (!completed) return false
      }
      return false
    }

    await visit([], shard === undefined ? undefined : 0)
    const distinctFingerprints = leafFingerprints?.size ?? 0
    levels.push({
      depth: targetDepth,
      leaves,
      meanEnabled: enabledNodes === 0 ? 0 : enabledTotal / enabledNodes,
      cuts,
      details,
      elapsedMs: now() - levelStarted,
      ...(visited === undefined ? {} : {
        expanded,
        seen,
        dedupEntries: visited.size,
        dedupBytes: visited.byteLength + (paths?.byteLength ?? 0),
      }),
      ...(shard === undefined ? {} : { nodes: enabledNodes }),
      ...(leafFingerprints === undefined ? {} : {
        census: {
          depthLeaves: cuts.depth,
          distinctFingerprints,
          ratio: distinctFingerprints === 0 ? 0 : cuts.depth / distinctFingerprints,
        },
        _censusKeys: [...leafFingerprints].sort(),
        _censusPaths: [...(censusPaths ?? [])]
          .map(([key, paths]) => ({ key, paths }))
          .sort((left, right) => left.key.localeCompare(right.key)),
      }),
    })

    if (!completed) break
    bounds.onLevel?.(levels[levels.length - 1]!, { findings: findings.length })
    if (cuts.harness === 0) closedAtDepth = targetDepth
  }

  if (!inconclusive && rootShard && bounds.sample && bounds.sample.count > 0) {
    const random = seededRandom(bounds.sample.seed)
    const sampleDepth = bounds.sample.depth ?? bounds.depth * 2
    for (let index = 0; index < bounds.sample.count; index += 1) {
      if (expired()) {
        inconclusive = true
        break
      }

      const labels: Label[] = []
      try {
        await room.reset()
        while (labels.length < sampleDepth) {
          if (room.horizonReached()) break
          const enabled = room.enabled().filter(
            (label) => room.faultsLeft() > 0 || !isFault(label),
          )
          if (enabled.length === 0) break
          const label = enabled[Math.floor(random() * enabled.length)]
          labels.push(label)
          await room.step(label)
          const violations = room.violations()
          if (violations.length > 0) {
            for (const violation of violations) {
              recordFinding(
                violation,
                labels.slice(0, violation.atStep + 1),
                true,
              )
            }
            break
          }
        }
      } catch {
        // A sampled harness failure is not evidence about the system under test.
      }
    }
  }

  return { levels, closedAtDepth, inconclusive, findings }
}

interface CollisionNode {
  state: Omit<CollisionState, "enabled"> & { enabled: string[] }
  drain?: CollisionDrain
}

export interface CollisionMismatch {
  left: Label[]
  right: Label[]
  suffix: string[]
  leftNode?: CollisionNode
  rightNode?: CollisionNode
}

/** Replay one real fingerprint collision without consulting the fingerprint.
 * Canonical label keys align renamed frame ids; every compared value is
 * otherwise independent ground truth. */
export async function replayCollisionPair(
  room: SearchRoom,
  left: readonly Label[],
  right: readonly Label[],
  suffixDepth: 2 | 3,
): Promise<CollisionMismatch | null> {
  if (!room.collisionState || !room.collisionDrain) {
    throw new Error("collision replay needs collisionState and collisionDrain")
  }
  const collect = async (prefix: readonly Label[]): Promise<Map<string, CollisionNode>> => {
    const nodes = new Map<string, CollisionNode>()
    const visit = async (suffixKeys: string[], suffixLabels: Label[]): Promise<void> => {
      await room.reset()
      for (const label of [...prefix, ...suffixLabels]) await room.step(label)
      const state = room.collisionState!()
      const enabled = [...state.enabled].sort((a, b) => a.key.localeCompare(b.key))
      const key = JSON.stringify(suffixKeys)
      const node: CollisionNode = {
        state: {
          enabled: enabled.map((entry) => entry.key),
          workCounters: state.workCounters,
          findings: [...state.findings].sort(),
          gaps: [...state.gaps].sort(),
        },
      }
      nodes.set(key, node)
      if (suffixKeys.length >= suffixDepth || enabled.length === 0) {
        node.drain = await room.collisionDrain!()
        return
      }
      for (const option of enabled) {
        await visit([...suffixKeys, option.key], [...suffixLabels, option.label])
      }
    }
    await visit([], [])
    return nodes
  }

  const leftNodes = await collect(left)
  const rightNodes = await collect(right)
  const suffixes = [...new Set([...leftNodes.keys(), ...rightNodes.keys()])].sort((leftKey, rightKey) => {
    const leftLength = (JSON.parse(leftKey) as string[]).length
    const rightLength = (JSON.parse(rightKey) as string[]).length
    return leftLength - rightLength || leftKey.localeCompare(rightKey)
  })
  for (const suffix of suffixes) {
    const leftNode = leftNodes.get(suffix)
    const rightNode = rightNodes.get(suffix)
    if (JSON.stringify(leftNode) !== JSON.stringify(rightNode)) {
      return {
        left: [...left],
        right: [...right],
        suffix: JSON.parse(suffix) as string[],
        leftNode,
        rightNode,
      }
    }
  }
  return null
}
