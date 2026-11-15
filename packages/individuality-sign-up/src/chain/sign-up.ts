// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SIGN-UP, ON THE CHAIN: the product SDK's game registration
 * (`@parity/product-sdk-individuality`: `readGameSeat`, `holdsLiteKey`,
 * `bindGameSeat`, `registerForGame`), in the shape the flow (../sign-up-flow.ts)
 * reads, with one rule of Jollity's on top: a player this game cannot make a
 * member signs up without a draw ticket (../draw-ticket.ts, #167).
 *
 * Nothing here decides a route or retries; the SDK decides the route, and the
 * flow retries. What only a surface can reach, its game account, signer,
 * submission, ticket signer and personhood keys, comes in as the SDK's
 * `GameRegistrationCapabilities`.
 */
import { Enum } from "polkadot-api"
import {
  bindGameSeat,
  fromPapi,
  GameRegistrationError,
  GameSeatBindError,
  holdsLiteKey,
  readGameSeat,
  registerForGame,
  type GameRegistrationCapabilities,
  type GameRegistrationChain,
  type PlayerKey,
} from "@parity/product-sdk-individuality"
import type { PeopleClient } from "@individuality/people-chain"
import { drawTicketCanPay, gamesToMembership, type ScoreStanding } from "../draw-ticket"
import type { BindResult, SignUpDraws, SignUpFlowChain } from "../sign-up-types"
import { verifyVrf } from "./vrf"

const accountKey = (address: string): PlayerKey => Enum("Account", address)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The player's `Score.Participants` row and the threshold, at the best block:
 *  what the draw rule judges a ticket by. */
async function readStanding(client: PeopleClient, address: string): Promise<{ row: ScoreStanding | undefined; threshold: number }> {
  const api = client.api
  const [participant, threshold] = await Promise.all([
    api.query.Score.Participants.getValue(accountKey(address), { at: "best" }),
    api.query.Score.PersonhoodThreshold.getValue({ at: "best" }),
  ])
  const row =
    participant === undefined
      ? undefined
      : {
          score: participant.score,
          streak: { type: participant.streak.type, count: participant.streak.value },
          recognition: { type: participant.recognition.type },
          reached_personhood: participant.reached_personhood,
        }
  return { row, threshold }
}

/**
 * The chain a sign-up flow runs over: the SDK's registration calls for the
 * network `tld` (such as `"paseo"`), and the two reads the flow reconciles
 * with, `Game.Players` at the best block and `Game.Game` at the finalized one.
 */
export function signUpFlowChain(client: PeopleClient, options: { tld: string }): SignUpFlowChain {
  const { tld } = options
  const api = client.api
  const chain: GameRegistrationChain = fromPapi(client.client, api)

  return {
    async seat(account, facts) {
      const seat = await readGameSeat(chain, { account, tld, litePerson: facts.litePerson, bound: facts.bound })
      if (!seat.ok) throw seat.error
      return seat.value
    },

    async holdsLiteKey(capabilities) {
      const holds = await holdsLiteKey(chain, capabilities, { tld })
      if (!holds.ok) throw holds.error
      return holds.value
    },

    async bind(capabilities, bindOptions) {
      const bound = await bindGameSeat(chain, capabilities, { tld, signal: bindOptions?.signal })
      if (bound.ok) return { kind: bound.value }
      const error = bound.error
      if (!(error instanceof GameSeatBindError)) throw error
      const refused: BindResult = {
        kind: "refused",
        permanent: error.permanent,
        refusal: error.refusal,
        code: error.code,
        detail: error.message,
      }
      return error.account ? { ...refused, account: error.account } : refused
    },

    async register(capabilities, identifierKey, registerOptions) {
      // THE DRAW RULE (#167): a ticket this game can never pay goes nowhere.
      // A standing that cannot be read leaves the tickets to the SDK.
      const standing = await readStanding(client, capabilities.account.address).catch(() => undefined)
      const memberYet = !standing || drawTicketCanPay(standing.row, standing.threshold)
      const games = standing && !memberYet ? gamesToMembership(standing.row, standing.threshold) : 0
      // without the ticket signer the SDK enters no account ticket, and says "signature"
      const { signVrf, ...unsigned } = capabilities
      const signUpCapabilities: GameRegistrationCapabilities = {
        ...(memberYet ? { ...unsigned, signVrf } : unsigned),
        // a ticket that does not verify fails the whole sign-up on chain
        verifyVrf: capabilities.verifyVrf ?? verifyVrf,
      }
      const draws = (outcome: SignUpDraws): SignUpDraws =>
        memberYet || outcome.kind !== "signature"
          ? outcome
          : { ...outcome, kind: "not-member-yet", skipped: `this game cannot make the player a member (${games} games to go)` }

      const result = await registerForGame(chain, signUpCapabilities, {
        tld,
        identifierKey,
        // the sign-up counts as landed at finality, as Jollity's always has
        waitFor: "finalized",
        signal: registerOptions?.signal,
        onStage: (stage) => {
          if (stage === "broadcast") registerOptions?.onBroadcast?.()
        },
        onDraws: (outcome) => registerOptions?.onDraws?.(draws(outcome)),
      })
      if (result.ok) {
        switch (result.value.kind) {
          case "registered":
            return { ok: true }
          // in already: the flow reads the chain and ends it as landed
          case "already-registered":
            return { ok: false, error: "AlreadyRegistered" }
          case "not-open":
            return { ok: false, error: "NoRegistration" }
          case "unfunded":
            return { ok: false, error: `the account is ${result.value.missing} short of the deposit` }
        }
      }
      const error = result.error
      if (error instanceof GameRegistrationError)
        return { ok: false, error: error.message, code: error.code, ...(error.landingUnknown ? { landingUnknown: true as const } : {}) }
      return { ok: false, error: messageOf(error) }
    },

    async player(address) {
      const record = await api.query.Game.Players.getValue(accountKey(address), { at: "best" })
      return record === undefined ? undefined : { registered: record.registered }
    },

    async game() {
      const game = await api.query.Game.Game.getValue({ at: "finalized" })
      return game === undefined ? undefined : { index: game.index, state: { type: game.state.type }, registration_ends: game.registration_ends }
    },
  }
}
