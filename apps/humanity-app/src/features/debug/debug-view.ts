// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pure projection of what the home page read into the debug panel's sections.
 * Free of React so the mapping stays unit-testable, and free of chain access so
 * the panel can only ever show what the card itself saw.
 */
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import type {
  LiteSignUpBlocker,
  LiteSignUpVerdict,
} from "@features/card/domain/lite-signup.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import type { GameAccountDiagnostics } from "@humanity/shared/identity/game-account.ts";
import type { AirdropStanding } from "@individuality/daily-dollar";
import type { ResourcesAliasDiagnostics } from "@humanity/shared/chain/resources-alias.ts";
import type { CoinageBalanceDiagnostics } from "@humanity/shared/chain/coinage-balance.ts";
import type {
  AccountBalances,
  PayoutBalanceDiagnostics,
} from "@features/airdrops/chain/payout-balance.ts";
import type { HostCallRecord } from "@humanity/shared/chain/host-call-log.ts";
import { AIRDROP_ASSET_DECIMALS, formatPrizeDollars } from "@humanity/shared/domain/prize-money.ts";
import {
  GAME_ACCOUNT_INDEX,
  CANDIDATE_PRODUCT_DOMAIN,
} from "@humanity/shared/identity/game-account.ts";

import {
  bool,
  MISSING,
  queryStatus,
  timestamp,
  type DebugRow,
  type DebugSection,
} from "./debug-format.ts";
import { airdropDrawsTable, airdropRows } from "./debug-airdrops.ts";
import { personhoodRows } from "./debug-personhood.ts";
import { resourcesAliasRows } from "./debug-resources-alias.ts";

export type { DebugSection } from "./debug-format.ts";

/** Transport state captured for the debug panel. */
interface ProviderDiagnostics {
  readonly provider: "host-bridge" | "ws";
  readonly failureReason?: string;
  readonly acquisitionMs: number;
}

/** Everything the panel renders, exactly as the page saw it. */
export interface DebugInput {
  network: string;
  productDomain: string;
  insideContainer: boolean;
  providerDiagnostics: ProviderDiagnostics | undefined;
  gameAccountDiagnostics: GameAccountDiagnostics | undefined;
  resourcesAlias: ResourcesAliasDiagnostics | undefined;
  /** Host coinage purse, as the panel's own subscription last saw it. */
  coinage: CoinageBalanceDiagnostics | undefined;
  /** People Chain balances of the claim destination and the claiming
   *  account, as the panel's own poll last read them. */
  payoutBalances: PayoutBalanceDiagnostics | undefined;
  /** Every host method called so far, one record each, last call wins. */
  hostCalls: readonly HostCallRecord[];
  card: HumanityCardResult | undefined;
  cardPending: boolean;
  cardError: unknown;
  game: CurrentGameResult | undefined;
  gamePending: boolean;
  gameError: unknown;
  airdrops: AirdropStanding | undefined;
  airdropsPending: boolean;
  airdropsError: unknown;
}

export type DebugPageInput = Omit<
  DebugInput,
  | "insideContainer"
  | "providerDiagnostics"
  | "gameAccountDiagnostics"
  | "resourcesAlias"
  | "coinage"
  | "payoutBalances"
  | "hostCalls"
>;

function sessionRows(input: DebugInput): DebugRow[] {
  return [
    { label: "network", value: input.network || "(default)" },
    { label: "product domain", value: input.productDomain },
    {
      label: "game product",
      value: `${CANDIDATE_PRODUCT_DOMAIN} / ${GAME_ACCOUNT_INDEX}`,
    },
    {
      label: "card query",
      value: queryStatus(input.cardPending, input.cardError, input.card),
    },
    {
      label: "game query",
      value: queryStatus(input.gamePending, input.gameError, input.game),
    },
    {
      label: "airdrops query",
      value: queryStatus(input.airdropsPending, input.airdropsError, input.airdrops),
    },
  ];
}

/** The host's coinage purse: whether the payment surface answers at all,
 *  and the spendable balance both raw and as the dollar figure a top-up of
 *  claimed winnings should move. */
function coinageRows(coinage: CoinageBalanceDiagnostics | undefined): DebugRow[] {
  if (coinage == null) return [{ label: "payments", value: "unresolved" }];
  switch (coinage.status) {
    case "pending":
      return [{ label: "payments", value: "pending" }];
    case "unavailable":
      return [{ label: "payments", value: "unavailable: no host payment manager" }];
    case "error":
      return [{ label: "payments", value: `error: ${coinage.reason}` }];
    case "subscribed":
    case "interrupted": {
      const rows: DebugRow[] = [
        {
          label: "payments",
          value:
            coinage.status === "subscribed"
              ? "subscribed"
              : `interrupted: ${coinage.reason}`,
        },
      ];
      if (coinage.available == null) {
        rows.push({
          label: "available",
          value:
            coinage.status === "subscribed" ? "awaiting first balance" : "never delivered",
        });
      } else {
        rows.push(
          { label: "available (base units)", value: coinage.available.toString() },
          {
            label: `available ($, ${AIRDROP_ASSET_DECIMALS} dp)`,
            value: formatPrizeDollars(coinage.available),
          },
        );
      }
      if (coinage.status === "subscribed" && coinage.updatedAtMs != null) {
        rows.push({ label: "updated", value: new Date(coinage.updatedAtMs).toISOString() });
      }
      return rows;
    }
  }
}

function balanceRows(label: string, balances: AccountBalances): DebugRow[] {
  return [
    { label: `${label} account`, value: balances.address },
    {
      label: `${label} prize balance`,
      value:
        balances.prize == null
          ? "none"
          : `${formatPrizeDollars(balances.prize)} · ${balances.prize.toString()} base units`,
    },
    { label: `${label} native (plancks)`, value: balances.native.toString() },
  ];
}

/** Where a claimed dollar actually lands: the payout account is
 *  `PeopleAirdrops.claim`'s `destination`, the airdrop account signs the
 *  claim. Both are read from the best block, in the prize asset the latest
 *  draw pays in and in the native token. */
function payoutBalanceRows(balances: PayoutBalanceDiagnostics | undefined): DebugRow[] {
  if (balances == null) return [{ label: "read", value: "unresolved" }];
  switch (balances.status) {
    case "pending":
      return [{ label: "read", value: "pending" }];
    case "unavailable":
      return [{ label: "read", value: "unavailable: no host product accounts" }];
    case "error":
      return [{ label: "read", value: `error: ${balances.reason}` }];
    case "ok":
      return [
        ...balanceRows("payout", balances.payout),
        ...balanceRows("airdrop", balances.airdrop),
        { label: "at block", value: balances.atBlockHash },
        { label: "updated", value: new Date(balances.updatedAtMs).toISOString() },
      ];
  }
}

/** One row per host method: the last call's arguments, its outcome, and how
 *  long it took. `pending` means the host has not answered yet — a row that
 *  stays pending is the hang the panel exists to find. */
function hostCallsSection(calls: readonly HostCallRecord[]): DebugSection {
  const pending = calls.filter((call) => call.outcome === "pending").length;
  const failed = calls.filter((call) => call.outcome === "error").length;
  const section: DebugSection = {
    title: "truAPI",
    rows: [
      {
        label: "calls",
        value:
          calls.length === 0
            ? "none yet"
            : `${calls.reduce((n, call) => n + call.calls, 0)} across ${calls.length} methods · pending ${pending} · failed ${failed}`,
      },
    ],
  };
  if (calls.length > 0) {
    section.table = {
      columns: ["method", "×", "last", "args", "result", "ms"],
      rows: calls.map((call) => [
        call.method,
        String(call.calls),
        call.outcome,
        call.args === "" ? MISSING : call.args,
        call.outcome === "pending" ? "…" : call.result,
        call.lastElapsedMs == null ? MISSING : String(call.lastElapsedMs),
      ]),
    };
  }
  return section;
}

function chainRows(input: DebugInput): DebugRow[] {
  const diagnostics = input.providerDiagnostics;
  const gameAccount = input.gameAccountDiagnostics;
  const rows: DebugRow[] = [
    { label: "inside container", value: bool(input.insideContainer) },
    { label: "provider", value: diagnostics?.provider ?? "unresolved" },
  ];
  if (diagnostics?.failureReason != null) {
    rows.push({ label: "failure reason", value: diagnostics.failureReason });
  }
  rows.push({
    label: "provider acquisition",
    value: diagnostics == null ? "unresolved" : `${diagnostics.acquisitionMs} ms`,
  });
  rows.push(
    {
      label: "game account domain",
      value: gameAccount?.productDomain ?? CANDIDATE_PRODUCT_DOMAIN,
    },
    {
      label: "game account index",
      value: String(gameAccount?.index ?? GAME_ACCOUNT_INDEX),
    },
    { label: "game account outcome", value: gameAccount?.outcome ?? "unresolved" },
    {
      label: "game account elapsed",
      value: gameAccount == null ? "unresolved" : `${gameAccount.elapsedMs} ms`,
    },
    {
      label: "game account address",
      value: gameAccount == null ? "unresolved" : gameAccount.address ?? MISSING,
    },
  );
  return rows;
}

/** The three accounts that get confused in practice: the DotNS username, the
 *  account owning it, and the product account that actually plays. */
function identityRows(card: HumanityCardResult | undefined): DebugRow[] {
  if (card?.kind === "account-unavailable" && card.accountAddress != null) {
    return [
      { label: "username", value: card.primaryUsername ?? MISSING },
      { label: "username owner", value: card.accountAddress },
      { label: "candidate account", value: "unavailable" },
    ];
  }
  if (card == null || card.kind !== "card") {
    return [{ label: "card", value: card?.kind ?? "unresolved" }];
  }
  return [
    { label: "username", value: card.primaryUsername },
    { label: "username owner", value: card.accountAddress },
    {
      label: "candidate account",
      value: `${card.playerIdentities.accountAddress} (index ${GAME_ACCOUNT_INDEX})`,
    },
  ];
}

function gameRows(game: CurrentGameResult | undefined): DebugRow[] {
  if (game == null) return [{ label: "game", value: "unresolved" }];
  if (game.kind !== "game") return [{ label: "game", value: game.kind }];
  return [
    { label: "game index", value: game.gameIndex.toString() },
    { label: "phase", value: game.phase.label },
    {
      label: "registered",
      value: game.registered == null ? "unknown" : bool(game.registered),
    },
    { label: "plays at", value: timestamp(game.gameDateSeconds) },
    {
      label: "registration ends",
      value: timestamp(game.registrationEndsSeconds),
    },
    { label: "airdrops scheduled", value: game.airdropsScheduled.toString() },
    ...seatVerdictRows(game.liteSignUp),
  ];
}

/**
 * What each seat blocker means and what would clear it. A bare tag sent one
 * debugging session looking for a client-side flag when the real answer was a
 * missing chain entry, so every arm names the storage item that is read and
 * the call that writes it. Wording follows the SDK's own doc comments on
 * `LiteSignUpBlocker` — the panel is not the place to invent a second
 * vocabulary for the same union.
 */
const BLOCKER_DETAIL: Record<LiteSignUpBlocker["tag"], string> = {
  NoGameRunning: "Game.Game is empty, so there is nothing to sign up for",
  NotInRegistration:
    "the game left its registration phase, so Game.NoRegistration",
  RegistrationEnded:
    "past registrationEnds while still in the phase, so Game.NoRegistration",
  AlreadyRegistered: "Game.Players[account].registered is already set",
  AccountVrfsNeedAnAccount:
    "draws only: an unrecognized person satisfies neither draw arm, the sign-up itself is fine",
  NoDrawsScheduled:
    "draws only: no draws scheduled, so anything but None fails the count check",
  NotSr25519:
    "draws only: the account id is not an sr25519 key, so its VRFs cannot verify",
  AliasNotBound:
    "PeopleLite.AccountToAlias has no entry for the seat account, and PeopleLite.set_alias_account is the call that writes it; until it runs the signed leg fails with NoAliasBinding",
  AliasBoundElsewhere:
    "the binding exists but outside Score.score_context, the only context the game's origin check admits; clearing it needs PeopleLite.unset_alias_account with a proof in the old context",
  AnotherAccountInvited:
    "Game.LiteInvites[alias] pins forever the one account this lite person may invite, and it is not this one, so Game.AnotherAccountInvited",
  AccountIsALitePerson:
    "PeopleLite.LitePeople[account] exists, so a bind hits PeopleLite.AlreadyRegistered",
  NotLiteMember:
    "the lite member key is not an Included member of the lite people ring, so no proof minted with it verifies",
  ContextNotProductDerived:
    "Score.score_context is not the product derivation of peopl.<Score.Suffix>/Index(0), so no stock host can mint the bind leg's proof",
  AlreadyPlaying:
    "a Game.Players entry exists, so Game.UseInviteButAlreadyPlaying; the entry survives a finished game",
  AccountIsAStatementAccount:
    "Game.StmtAccountToAlias[account] exists, so Game.StatementAccountAlreadyInUse; only the alias that named this account clears it",
  StaleAlias:
    "the binding predates the ring's current revision, so Custom(172) in validate; re-point it with AliasWithAccountRevised",
};

/** A tag the table does not know is still worth printing verbatim: the SDK
 *  may widen the union, and a panel that silently drops a blocker the chain
 *  reported is worse than one that prints a name with no gloss. */
function blockerText(blocker: LiteSignUpBlocker): string {
  const detail: string | undefined = BLOCKER_DETAIL[blocker.tag];
  return detail == null ? blocker.tag : `${blocker.tag}: ${detail}`;
}

/** The seat verdict decides whether the weekly block offers an in-app
 *  reservation, a hand-off, or nothing at all — so "unknown" versus "no
 *  blockers" is the first thing to check when a button does nothing. */
function seatVerdictRows(verdict: LiteSignUpVerdict | null): DebugRow[] {
  if (verdict == null) {
    return [{ label: "seat verdict", value: "unknown (read unavailable)" }];
  }
  const rows: DebugRow[] = [
    { label: "seat can sign up", value: bool(verdict.canSignUp) },
    { label: "seat needs bind", value: bool(verdict.needsBind) },
    {
      label: "seat blockers",
      value: verdict.blockers.map(blockerText).join(" | ") || "none",
    },
  ];
  if (verdict.invitedAccount != null) {
    rows.push({ label: "seat pinned to", value: verdict.invitedAccount });
  }
  return rows;
}

/** Build every section, in debugging order: what am I connected to, who am I,
 *  what personhood state am I in, what game is live, what draws are open. The
 *  personhood section is omitted rather than faked when no card resolved; the
 *  airdrops section is *always* rendered — its job is naming the failure
 *  modes (context mismatch, pending, error) that look like "no draws open"
 *  otherwise. */
export function buildDebugView(input: DebugInput): DebugSection[] {
  const sections: DebugSection[] = [
    { title: "session", rows: sessionRows(input) },
    { title: "chain", rows: chainRows(input) },
    hostCallsSection(input.hostCalls),
    { title: "identity", rows: identityRows(input.card) },
  ];
  if (input.card?.kind === "card") {
    sections.push({
      title: "personhood",
      rows: personhoodRows(
        input.card.state,
        input.card.snapshot,
        input.card.devicehood,
        input.card.membershipStanding,
        input.card.devicehoodRing,
        input.card.deviceKeyCheck,
      ),
    });
  }
  // Always rendered, like airdrops and for the same reason: it names the two
  // failure modes behind a refused `register_person` — a context this build
  // derives differently from the runtime, versus a context that is right but
  // never bound on chain.
  sections.push({
    title: "resources alias",
    rows: resourcesAliasRows(input.resourcesAlias, input.card),
  });
  sections.push({ title: "weekly game", rows: gameRows(input.game) });
  sections.push({ title: "coinage", rows: coinageRows(input.coinage) });
  // Wall-clock seconds are derived at render rather than published: a
  // ticking dependency in usePublishDebugInput would republish every second,
  // and the panel's invariant is about chain reads — not about freezing the
  // current time. Reading it here keeps the deadlines in the per-draw rows
  // live, which is strictly better for a debug panel.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const airdrops: DebugSection = {
    title: "airdrops",
    rows: airdropRows(
      input.airdrops,
      input.airdropsPending,
      input.airdropsError,
      nowSeconds,
    ),
  };
  const table = airdropDrawsTable(input.airdrops, nowSeconds);
  if (table != null) airdrops.table = table;
  sections.push(airdrops);
  sections.push({
    title: "payout balances",
    rows: payoutBalanceRows(input.payoutBalances),
  });
  return sections;
}

type DebugCategoryName = "connection" | "identity" | "prizes";

export interface DebugCategory {
  name: DebugCategoryName;
  sections: DebugSection[];
}

const CATEGORY_ORDER: readonly DebugCategoryName[] = ["connection", "identity", "prizes"];

const CATEGORY_OF_SECTION: Record<string, DebugCategoryName> = {
  session: "connection",
  chain: "connection",
  truAPI: "connection",
  identity: "identity",
  personhood: "identity",
  "resources alias": "identity",
  "weekly game": "prizes",
  coinage: "prizes",
  airdrops: "prizes",
  "payout balances": "prizes",
};

/** Fold the flat section list into the panel's collapsible categories,
 *  keeping section order within each. A section without a category is a
 *  programming error: it would otherwise vanish from the panel silently. */
export function groupDebugSections(sections: readonly DebugSection[]): DebugCategory[] {
  const grouped: Record<DebugCategoryName, DebugSection[]> = {
    connection: [],
    identity: [],
    prizes: [],
  };
  for (const section of sections) {
    const category = CATEGORY_OF_SECTION[section.title];
    if (category == null) throw new Error(`debug section "${section.title}" has no category`);
    grouped[category].push(section);
  }
  return CATEGORY_ORDER.map((name) => ({ name, sections: grouped[name] }));
}
