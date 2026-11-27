// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { resetClientCache } from "@humanity/shared/chain/connection.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { runFlow, type FlowOutcome, type FlowRun } from "@humanity/shared/telemetry/flow.ts";
import {
  submissionDetail,
  TransactionSubmissionError,
} from "@humanity/shared/chain/transaction-submission.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { getPeopleClient, type PeopleApi } from "@humanity/shared/chain/client.ts";
import {
  individualityChain,
  peopleAirdropsRegisterCalls,
} from "@humanity/shared/chain/individuality.ts";

import type {
  DailyDollarRegistry,
  Hex32,
  RegistrationSource,
} from "@individuality/daily-dollar";
import {
  applyRegistrationResult,
  applyRegistrationSubmitted,
  DEFAULT_REGISTRY_PLAN_CONFIG,
} from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";
import { updateDailyDollarRegistry } from "@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts";

import { RegisterDrawsError } from "./register-draws-shared.ts";
import type { RegisterDrawsResult } from "./register-draws-shared.ts";
import {
  resolveAirdropAccount,
  type AirdropAccount,
} from "./airdrop-account.ts";
import { ensureAirdropAlias, NotAttestedDeviceError } from "./ensure-airdrop-alias.ts";
import { runRegisterChunk } from "./register-draw-chunk.ts";

export type {
  RegisterDrawChunkResult,
  RegisterDrawsResult,
} from "./register-draws-shared.ts";
export { RegisterDrawsError } from "./register-draws-shared.ts";

export interface RegisterForDrawsArgs {
  /** Event ids to register for, in the order they should hit the chain. */
  eventIds: Hex32[];
  /**
   * Who is submitting. Recorded on every daily-dollar registry record this
   * call touches, so the worker's own submissions are distinguishable from
   * the ones the app made while a person had it open. Defaults to `"app"`:
   * the worker is the only caller that has to say so.
   */
  source?: RegistrationSource;
}

const logger = loggerFor("airdrops", "register-draws");

/**
 * Mirror one chunk's lifecycle into the daily-dollar registry.
 *
 * The registry is a record, never a gate: a storage failure must not turn a
 * finalized on-chain registration into a failed one, so every write is
 * swallowed with a log. The store is contracted not to throw; this is the
 * belt to that braces.
 */
async function recordRegistryUpdate(
  accountAddress: string,
  phase: string,
  update: (
    registry: DailyDollarRegistry,
    nowSeconds: number,
  ) => DailyDollarRegistry,
): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    await updateDailyDollarRegistry(accountAddress, (current) =>
      update(current, nowSeconds),
    );
  } catch (error) {
    logger.warning("daily-dollar registry {phase} write failed. error={error}", {
      phase,
      error,
    });
  }
}

/** The chunk error as the registry stores it: a plain string, or nothing. */
function outcomeError(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error == null) return undefined;
  return String(error);
}

const SETUP_TIMEOUT_MS = 15_000;
const SIGNING_TIMEOUT_MS = 60_000;
const FINALITY_TIMEOUT_MS = 120_000;

const CHAIN_TIMEOUT_MESSAGE = "People Chain did not respond in time.";
const ACCOUNT_MISSING_MESSAGE =
  "We couldn't find your People Chain account. Try again shortly.";
const SIGNING_FAILURE_MESSAGE =
  "We couldn't submit your airdrop registration. Try again shortly.";
const FINALITY_FAILURE_MESSAGE =
  "We couldn't confirm your airdrop registration. Try again shortly.";
const SETUP_FAILURE_MESSAGE =
  "We couldn't refresh People Chain. Try again shortly.";
const NOT_ATTESTED_MESSAGE =
  "This device can't enter the Daily Dollar yet.";

/**
 * How long a "not the attested device" answer is trusted before the host is
 * asked again.
 *
 * A host without the person's full-personhood key cannot bind an alias, and
 * nothing this product does changes that: only the phone's `PeopleLite.attest`
 * enrols a key in the ring, and that happens once in a device's life, if
 * ever. The answer is only trusted once `resolveAirdropProofAccess` has
 * registered the personhood key and the registry still names no handle for
 * the ring - a registry that was merely fresh gets its handle on that first
 * pass and never reaches this memo. The worker sweeps every minute and the
 * app on every standing refetch, so without a memo each of them asked the
 * host for its keys, failed the same way and logged an error every beat -
 * over a thousand Sentry events a day from hosts that were never going to
 * register. One re-check an hour is enough to notice the rare device that
 * does become attested.
 */
const NOT_ATTESTED_RECHECK_MS = 60 * 60 * 1_000;
let notAttestedUntilMs = 0;

/**
 * Drop the memo so the next call asks the host again. For a hand-triggered
 * attempt from the debug panel, and for tests.
 */
export function forgetNotAttestedDevice(): void {
  notAttestedUntilMs = 0;
}

/**
 * Submit `PeopleAirdrops.register` for every pending draw, chunked at the
 * runtime's `MaxRegisterBatch` bound, sequentially, with one in-flight
 * submission per call.
 *
 * - The pending marker is written at broadcast and cleared per the rules in
 *   `pending-registration.ts`; `unknown` keeps it, `finalized` clears it, a
 *   thrown failure clears it.
 * - Chunks run sequentially because each one is a separately signed
 *   transaction from one account; PAPI fetches a fresh nonce for each.
 * - A failed chunk does not abort the remaining chunks and is not retried:
 *   all-or-nothing is the *chain's* per-call semantics, but one bad draw
 *   must not starve every other. The result is a per-chunk outcome list.
 * - Every chunk is mirrored into the daily-dollar registry twice: as
 *   `submitted` before it is signed, then with its outcome, so the headless
 *   worker and the app see one shared history per draw whichever of them
 *   made the submission.
 *
 * @throws RegisterDrawsError on account unavailability or setup-phase
 *   failure before any chunk ran.
 */
export function registerForDraws({
  eventIds,
  source = "app",
}: RegisterForDrawsArgs): Promise<RegisterDrawsResult> {
  if (eventIds.length === 0) return Promise.resolve([]);
  return runFlow("daily-dollar.registration", (flow) => runRegistration(eventIds, source, flow), {
    attributes: { source, "draws.count": eventIds.length },
    outcome: registrationOutcome,
  });
}

/** Chunks settle one by one, so the flow is as good as its worst chunk: a
 *  `failed` chunk is a failure, an `unknown` one needs a look, and only all
 *  `finalized` is done. */
function registrationOutcome(result: RegisterDrawsResult): FlowOutcome {
  const statuses = new Set(result.map((chunk) => chunk.status));
  if (statuses.has("failed")) return { kind: "failed", ok: false };
  if (statuses.has("unknown")) return { kind: "unknown", ok: false };
  return { kind: "finalized", ok: true };
}

async function runRegistration(
  eventIds: readonly Hex32[],
  source: RegistrationSource,
  flow: FlowRun,
): Promise<RegisterDrawsResult> {
  if (Date.now() < notAttestedUntilMs) {
    logger.debug("skipping registration: this device is not the attested one");
    throw new RegisterDrawsError("not-attested-device", NOT_ATTESTED_MESSAGE);
  }

  let airdropAccount: AirdropAccount | null;
  let api: PeopleApi;
  let peopleClient: Awaited<ReturnType<typeof getPeopleClient>>;
  flow.stage("setup");
  try {
    const [account, client] = await withTimeout(
      Promise.all([resolveAirdropAccount(), getPeopleClient()]),
      SETUP_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
      () => {
        void resetClientCache();
      },
    );
    airdropAccount = account;
    peopleClient = client;
    api = client.api;
  } catch (cause) {
    logger.error("airdrop registration setup failed: {detail}", {
      detail: submissionDetail(cause),
    });
    if (cause instanceof Error && cause.message === CHAIN_TIMEOUT_MESSAGE) {
      throw new RegisterDrawsError("timeout", CHAIN_TIMEOUT_MESSAGE, { cause });
    }
    throw new RegisterDrawsError("signing", SETUP_FAILURE_MESSAGE, { cause });
  }

  if (airdropAccount == null) {
    throw new RegisterDrawsError("account-missing", ACCOUNT_MISSING_MESSAGE);
  }

  let authorization: Awaited<ReturnType<typeof ensureAirdropAlias>>;
  flow.stage("alias");
  try {
    authorization = await ensureAirdropAlias({
      api,
      client: peopleClient.client,
      network: peopleClient.network,
      account: airdropAccount,
    });
  } catch (cause) {
    if (cause instanceof NotAttestedDeviceError) {
      // A fact about the host, not a failure of this attempt: remembered so
      // the next hour of sweeps skips the host call, and logged below error
      // so it stays a breadcrumb rather than an issue.
      notAttestedUntilMs = Date.now() + NOT_ATTESTED_RECHECK_MS;
      logger.warning("this device cannot register for draws: {detail}", {
        detail: cause.message,
      });
      throw new RegisterDrawsError("not-attested-device", NOT_ATTESTED_MESSAGE, { cause });
    }
    // The alias bind carries its own decoded reason, and the auto-register
    // hook reports the `RegisterDrawsError` below at error with its whole
    // cause chain (linked errors included): an error here as well filed each
    // failed bind to Sentry twice, so this is the breadcrumb.
    logger.warning("airdrop alias binding failed before registration: {detail}", {
      detail: submissionDetail(cause),
    });
    if (cause instanceof TransactionSubmissionError) {
      throw new RegisterDrawsError("signing", cause.message, { cause });
    }
    throw new RegisterDrawsError("signing", SETUP_FAILURE_MESSAGE, { cause });
  }

  // The SDK splits the ids to the runtime's `MaxRegisterBatch` and refuses
  // any id that is not a `PeopleAirdrops` draw before anything is signed.
  flow.stage("build");
  const calls = await peopleAirdropsRegisterCalls(
    individualityChain(peopleClient.client, api),
    eventIds,
  );
  if (!calls.ok) {
    logger.error("airdrop registration could not be built: {detail}", {
      detail: submissionDetail(calls.error),
    });
    throw new RegisterDrawsError("signing", SIGNING_FAILURE_MESSAGE, {
      cause: calls.error,
    });
  }

  const results: RegisterDrawsResult = [];
  flow.stage("submit");
  flow.set({ "chunks.count": calls.value.length });
  for (const call of calls.value) {
    const chunk = call.eventIds as Hex32[];
    await recordRegistryUpdate(
      airdropAccount.address,
      "submitted",
      (registry, nowSeconds) =>
        applyRegistrationSubmitted(registry, chunk, source, nowSeconds),
    );
    const result = await runRegisterChunk({
      tx: call.tx,
      signer: authorization.signer,
      pendingKey: authorization.alias,
      eventIds: chunk,
      signingFailureMessage: SIGNING_FAILURE_MESSAGE,
      finalityFailureMessage: FINALITY_FAILURE_MESSAGE,
      signingTimeoutMs: SIGNING_TIMEOUT_MS,
      finalityTimeoutMs: FINALITY_TIMEOUT_MS,
    });
    await recordRegistryUpdate(
      airdropAccount.address,
      "result",
      (registry, nowSeconds) =>
        applyRegistrationResult(
          registry,
          chunk,
          {
            status: result.status,
            txHash: result.txHash,
            error: outcomeError(result.error),
          },
          source,
          nowSeconds,
          DEFAULT_REGISTRY_PLAN_CONFIG,
        ),
    );
    results.push(result);
  }
  return results;
}
