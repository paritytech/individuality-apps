// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The daily-dollar registry as the app's sweep writes it: which draws it
 * registered for, which host notifications it scheduled, what the last sweep
 * did, and when this device saw each card revealed.
 *
 * Read-only apart from `Clear registry`, which writes an empty record for the
 * account — the way to re-arm registration and notification scheduling for
 * draws this device has already handled.
 *
 * Polls every 10 s: the panel has no way to subscribe to a key-value write.
 */
import { useCallback, useEffect, useState } from "react";

import { resolveAirdropAccount } from "@humanity/shared/airdrops/chain/airdrop-account.ts";
import { emptyRegistry } from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";
import type {
  DailyDollarRegistry,
  DrawRecord,
} from "@individuality/daily-dollar";
import {
  readDailyDollarRegistry,
  writeDailyDollarRegistry,
} from "@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts";

import { errorText, hex32Short, MISSING, timestamp, utcShort } from "./debug-format.ts";

const REFRESH_MS = 10_000;

/** `state · source`, with the attempt count and backoff only when they say
 *  something — an untouched record would otherwise read `none · app x0`. */
function registrationCell(record: DrawRecord): string {
  const { state, source, attempts, nextAttemptSeconds } = record.registration;
  const parts = [`${state} · ${source}`];
  if (attempts > 0) parts.push(`x${attempts}`);
  if (state === "failed" && nextAttemptSeconds != null) {
    parts.push(`retry ${utcShort(nextAttemptSeconds)}`);
  }
  return parts.join(" ");
}

/** Every live host notification handle, plus the push-retry deadline when a
 *  push failed — the two together are what says whether a reminder actually
 *  exists for this draw. */
function notificationsCell(record: DrawRecord): string {
  const parts = record.notifications.map(
    (notification) =>
      `${notification.kind} #${notification.id} ${utcShort(
        Math.floor(notification.scheduledAtMs / 1000),
      )}`,
  );
  if (record.notificationRetrySeconds != null) {
    parts.push(`retry ${utcShort(record.notificationRetrySeconds)}`);
  }
  return parts.length === 0 ? MISSING : parts.join(" · ");
}

/** Both failure channels, labelled: a registration error and a notification
 *  error mean different broken things, and a record can carry both. */
function errorCell(record: DrawRecord): string {
  const parts: string[] = [];
  if (record.registration.error != null) {
    parts.push(`reg: ${record.registration.error}`);
  }
  if (record.notificationError != null) {
    parts.push(`notify: ${record.notificationError}`);
  }
  return parts.length === 0 ? MISSING : parts.join(" · ");
}

/** When this device saw the card revealed; the notification planner stops
 *  reminding about an opened ticket. */
function scratchedCell(record: DrawRecord): string {
  return record.scratchedAtSeconds == null ? MISSING : utcShort(record.scratchedAtSeconds);
}

export function DebugDailyDollarRegistry({
  accountAddress,
}: {
  /** The airdrop account the page already resolved, when it has one. Saves a
   *  host round trip; the section resolves it itself otherwise. */
  accountAddress?: string | undefined;
}) {
  const [address, setAddress] = useState<string | null>(accountAddress ?? null);
  const [registry, setRegistry] = useState<DailyDollarRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (accountAddress != null) {
      setAddress(accountAddress);
      return;
    }
    let cancelled = false;
    resolveAirdropAccount()
      .then((account) => {
        if (!cancelled) setAddress(account?.address ?? null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setAddress(null);
        setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [accountAddress]);

  useEffect(() => {
    const target = address;
    if (target == null) return;
    let cancelled = false;
    const load = (): void => {
      void readDailyDollarRegistry(target)
        .then((next) => {
          if (cancelled) return;
          setRegistry(next);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorText(cause));
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [address, reload]);

  const clear = useCallback(() => {
    const target = address;
    if (target == null) return;
    void writeDailyDollarRegistry(emptyRegistry(target)).then(() => {
      setReload((count) => count + 1);
    });
  }, [address]);

  const records =
    registry == null
      ? []
      : Object.values(registry.draws).sort(
          (left, right) => right.drawTimeSeconds - left.drawTimeSeconds,
        );

  return (
    <section className="debug-section">
      <h2 className="debug-title">daily dollar registry</h2>
      <div className="debug-flows">
        <button
          type="button"
          className="debug-chip"
          disabled={address == null}
          onClick={clear}
        >
          Clear registry
        </button>
        <button
          type="button"
          className="debug-chip"
          disabled={address == null}
          onClick={() => setReload((count) => count + 1)}
        >
          Refresh
        </button>
        <span className="debug-note">refreshes every {REFRESH_MS / 1000}s</span>
      </div>
      <dl className="debug-rows">
        <div className="debug-row">
          <dt>account</dt>
          <dd>{address ?? MISSING}</dd>
        </div>
        <div className="debug-row">
          <dt>last tick</dt>
          <dd>
            {registry?.lastTick == null
              ? "never — no sweep has written yet"
              : `${registry.lastTick.result} · ${timestamp(registry.lastTick.atSeconds)}`}
          </dd>
        </div>
        <div className="debug-row">
          <dt>tick error</dt>
          <dd>{registry?.lastTick?.error ?? MISSING}</dd>
        </div>
        <div className="debug-row">
          <dt>read error</dt>
          <dd>{error ?? MISSING}</dd>
        </div>
        <div className="debug-row">
          <dt>draws held</dt>
          <dd>{registry == null ? MISSING : records.length}</dd>
        </div>
      </dl>
      {records.length === 0 ? (
        <p className="debug-note">
          No draw records — nothing has been registered on this
          device yet.
        </p>
      ) : (
        <div className="debug-table-wrap">
          <table className="debug-table">
            <thead>
              <tr>
                <th scope="col">draw</th>
                <th scope="col">status</th>
                <th scope="col">registration</th>
                <th scope="col">outcome</th>
                <th scope="col">notifications</th>
                <th scope="col">scratched</th>
                <th scope="col">error</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.eventId}>
                  <th scope="row">
                    #{record.drawIndex} {hex32Short(record.eventId)}
                  </th>
                  <td data-label="status">
                    {record.status} · draw {utcShort(record.drawTimeSeconds)}
                  </td>
                  <td data-label="registration">{registrationCell(record)}</td>
                  <td data-label="outcome">{record.outcome}</td>
                  <td data-label="notifications">{notificationsCell(record)}</td>
                  <td data-label="scratched">{scratchedCell(record)}</td>
                  <td data-label="error">{errorCell(record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
