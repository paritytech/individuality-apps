// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Claims a won prize from the results card, with the claim of the app
 * (claimWithRetry in @jollity/protocol) and the signer the sign-up uses.
 *
 * The draw screen of the app claims a won prize by itself (lib/draw/auto-claim)
 * and sends the player here when that claim did not land, so the chat is the
 * second place a prize can be claimed before the next game closes the claim. A landed claim hands what
 * the game account holds to the CASH purse of the host, as the app does.
 */
import { type GameEngine } from "@jollity/protocol"
import { claimWithRetry, sweepPrizes, type ClaimFailure } from "@individuality/prize"
import { blake2b256, type WorkerHost } from "./host"
import { within } from "./state"
import { SIGNER_DEADLINE_MS, SIGNUP_STEP_DEADLINE_MS, signingRefused } from "./signup"
import { chatCount, chatFailure } from "./telemetry"

/** `detail` is the error the chain or the call named, which a refusal shows in words. */
type ClaimState = { kind: "busy" } | { kind: "claimed" } | { kind: "failed"; failure: ClaimFailure; detail: string }

export interface ClaimDependencies {
  host: WorkerHost
  /** The engine and the address the app plays as, or null while the host hands over no chain or account. */
  connect: () => Promise<{ engine: Pick<GameEngine, "claimPrize" | "prizeBalances">; address: string } | null>
  /** Whether the chain holds the claim, undefined when the read failed. */
  claimed: (address: string, gameIndex: number, airdropIndex: number) => Promise<boolean | undefined>
  account: { name: string; index: number }
  sleep?: (ms: number) => Promise<void>
  log?: (kind: "info" | "error", text: string) => void
}

export interface Claims {
  /** Undefined for a game with no claim sent from this run of the worker. */
  state(gameIndex: number): ClaimState | undefined
  subscribe(listener: () => void): () => void
  claim(gameIndex: number, airdropIndex: number): Promise<void>
}

export function createClaims(dependencies: ClaimDependencies): Claims {
  const { host, account } = dependencies
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const states = new Map<number, ClaimState>()
  const listeners = new Set<() => void>()
  const set = (gameIndex: number, next: ClaimState) => {
    states.set(gameIndex, next)
    for (const listener of listeners) listener()
  }

  const fail = (gameIndex: number, failure: ClaimFailure, detail: string) => {
    chatFailure("claim-failed", failure, { error: detail, "game.index": String(gameIndex) })
    dependencies.log?.("error", `The claim of the prize of game ${gameIndex} ended ${failure}: ${detail}`)
    set(gameIndex, { kind: "failed", failure, detail })
  }

  const sweep = async (engine: Pick<GameEngine, "prizeBalances">, address: string, claim: { gameIndex: number; airdropIndex: number }) => {
    try {
      const topUps = await sweepPrizes({
        balances: () => within(engine.prizeBalances(address), SIGNUP_STEP_DEADLINE_MS),
        topUp: (amount, id) => host.topUp(account.index, amount, id),
        hash: blake2b256,
        account: { namespace: "jollity", product: account.name, address },
        claim,
      })
      for (const { assetKey, amount, outcome } of topUps) {
        if (outcome === "refused" || outcome === "timeout") {
          chatFailure("prize-topup-failed", outcome, { "asset.key": assetKey, "prize.amount": amount.toString() })
        }
        dependencies.log?.(outcome === "refused" || outcome === "timeout" ? "error" : "info", `The prize top-up of ${amount} ended ${outcome}.`)
      }
    } catch (error) {
      dependencies.log?.("error", `The prize balances could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const claim = async (gameIndex: number, airdropIndex: number) => {
    const before = states.get(gameIndex)
    if (before?.kind === "busy" || before?.kind === "claimed") return
    if (before?.kind === "failed" && before.failure !== "cancelled") return
    set(gameIndex, { kind: "busy" })
    try {
      const signer = await within(host.accounts.signer(account.name, account.index), SIGNER_DEADLINE_MS)
      const connected = signer ? await within(dependencies.connect(), SIGNUP_STEP_DEADLINE_MS) : null
      if (!signer || !connected) return fail(gameIndex, "failed", !signer ? "no signer" : "no chain")
      const { engine, address } = connected
      const outcome = await claimWithRetry({
        status: async () => {
          const claimed = await within(dependencies.claimed(address, gameIndex, airdropIndex), SIGNUP_STEP_DEADLINE_MS)
          return claimed === undefined ? undefined : claimed ? "claimed" : "claimable"
        },
        send: () => engine.claimPrize(signer, gameIndex, airdropIndex, address),
        declined: signingRefused,
        sleep,
        onRetry: (attempt) => chatCount("chat.claim.retry", { "claim.retry_attempt": String(attempt) }),
      })
      if (outcome.kind !== "claimed") return fail(gameIndex, outcome.kind, outcome.detail)
      dependencies.log?.("info", `The prize of game ${gameIndex} was claimed from the chat.`)
      set(gameIndex, { kind: "claimed" })
      await sweep(engine, address, { gameIndex, airdropIndex })
    } catch (error) {
      fail(gameIndex, "failed", error instanceof Error ? error.message : String(error))
    }
  }

  return {
    state: (gameIndex) => states.get(gameIndex),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    claim,
  }
}
