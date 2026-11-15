// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Who a report is about stays out of it unless the deployer opts in
 * (`VITE_SENTRY_SEND_IDENTITY=true`, `envConfig.telemetry.sendIdentity`).
 *
 * Three layers, each for a path the one before cannot see:
 *  - `app-context.ts` leaves the username tag and the address fields out of
 *    the `identity` and `card` contexts, and keeps the standing.
 *  - `sentry-sink.ts` blanks the log properties whose *key* names a person
 *    (`isIdentityKey`), in the event's tags and in the rendered line, so a
 *    DotNS label or a username is redacted however it is spelled.
 *  - `redactEvent`, the client's last step before sending an error or a
 *    flow's transaction, rewrites every text the event carries (message,
 *    exception values, breadcrumbs, tags, span attributes) through
 *    `redactText`: SS58 addresses and `name.NN` usernames, wherever they
 *    were interpolated — an error's message, a `detail` string.
 *
 * Pattern matching is best effort: it catches the shapes this app produces,
 * not every way a person could be described. Hex keys and transaction hashes
 * are left as they are: a tx hash is what an operator needs to find a
 * failed submission, and the flows put it there on purpose.
 */
import type { Event } from "@sentry/browser";

import { envConfig } from "@humanity/shared/config/env.ts";

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/** Whether reports may name the person. Read per call so tests can flip it. */
export function sendsIdentity(): boolean {
  return envConfig.telemetry.sendIdentity;
}

/**
 * Log property keys whose values name a person: accounts and addresses
 * (`account`, `owner`, `hostAccount`, `claimant`, `candidate`, `who`), and
 * usernames and DotNS labels (`name`, `label`, `lite`, `username`).
 */
const IDENTITY_KEY =
  /account|address|owner|username|claimant|candidate|signer|alias|participant|recipient|^who$|^name$|^label$|^lite$/i;

export function isIdentityKey(key: string): boolean {
  return IDENTITY_KEY.test(key);
}

const BASE58 = "1-9A-HJ-NP-Za-km-z";
/** A 32-byte account in SS58, any prefix: 46 to 48 base58 characters. */
const SS58_ADDRESS = new RegExp(`(?<![${BASE58}])[${BASE58}]{46,48}(?![${BASE58}])`, "g");
/** A Humanity username, `name.NN`, with or without a network suffix. */
const USERNAME = /(?<![\w.-])[a-z][a-z0-9-]*\.\d{2}(?:\.[a-z]+)?(?![\w-])/g;

/** `text` with every SS58 address and `name.NN` username replaced. */
export function redactText(text: string): string {
  return text.replace(SS58_ADDRESS, "[address]").replace(USERNAME, "[username]");
}

function redactRecord<T extends Record<string, unknown>>(record: T | undefined): T | undefined {
  if (record == null) return record;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = typeof value === "string" ? redactText(value) : value;
  }
  return out as T;
}

/**
 * The event with the person taken out of its text, unless the deployer
 * opted in. Runs as the client's `beforeSend` and `beforeSendTransaction`,
 * after every other source has written to the event.
 */
export function redactEvent<E extends Event>(event: E): E {
  if (sendsIdentity()) return event;
  if (typeof event.message === "string") event.message = redactText(event.message);
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === "string") value.value = redactText(value.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === "string") crumb.message = redactText(crumb.message);
    crumb.data = redactRecord(crumb.data);
  }
  event.tags = redactRecord(event.tags);
  for (const span of event.spans ?? []) span.data = redactRecord(span.data) ?? span.data;
  const contexts = event.contexts;
  if (contexts != null) {
    const log = contexts["log"];
    if (log != null) contexts["log"] = redactRecord(log);
    const trace = contexts.trace;
    if (trace?.data != null) trace.data = redactRecord(trace.data);
  }
  return event;
}
