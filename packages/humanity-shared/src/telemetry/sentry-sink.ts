// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The LogTape sink that turns the app's own log into Sentry's view of it.
 *
 * Every record below `error` becomes a breadcrumb, so an issue arrives with
 * the last sixty lines the console would have shown — stages reached, reads
 * that came back empty, the retry that preceded the failure. An `error` or
 * `fatal` record is the *event*: the flow modules already write exactly one
 * of those per failure, with the decoded reason in it, which makes the log
 * line the one place a failure is declared and this sink the one place it
 * is reported from.
 *
 * Grouping is by category and message *template*, never the interpolated
 * values: "Score.register stopped ({kind}): {detail}" is one issue however
 * many candidates and details it has seen, and the values travel as event
 * tags and context where they can be searched instead of splitting groups.
 * A record whose properties carry an `Error` is reported as that exception,
 * so the stack and cause chain survive; anything else is reported as a
 * message.
 *
 * Unless the deployer opted in to identity (`redact.ts`), a property whose
 * key names a person — an account, a username, a DotNS label — is replaced
 * with `[redacted]`, in the tags and in the rendered line alike.
 *
 * Nothing here checks whether Sentry is initialised: without a client every
 * call below is the SDK's no-op, which is also why `logger.ts` can install
 * the sink unconditionally.
 */
import type { LogLevel, LogRecord, Sink } from "@logtape/logtape";
import {
  addBreadcrumb,
  captureException,
  captureMessage,
  type SeverityLevel,
} from "@sentry/browser";

import { isIdentityKey, REDACTED, sendsIdentity } from "@humanity/shared/telemetry/redact.ts";

const SEVERITY: Record<LogLevel, SeverityLevel> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  warning: "warning",
  error: "error",
  fatal: "fatal",
};

/** Keep an event's tag values searchable and short; Sentry caps tags at 200. */
const MAX_TAG_LENGTH = 200;

function text(message: readonly unknown[]): string {
  let out = "";
  for (const part of message) out += typeof part === "string" ? part : String(part);
  return out;
}

/** The placeholder names of a template, in order (`{{` and `}}` are escapes). */
function placeholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{\{|\}\}|\{([^{}]*)\}/g)) {
    if (match[1] !== undefined) names.push(match[1].trim());
  }
  return names;
}

/**
 * The record's line with the values of identity properties blanked. The
 * message alternates text and values, one value per placeholder; when the
 * two do not line up the line is left whole for `redactEvent` to scrub.
 */
function redactedText(record: LogRecord): string {
  if (typeof record.rawMessage !== "string") return text(record.message);
  const names = placeholders(record.rawMessage);
  if (names.length * 2 + 1 !== record.message.length) return text(record.message);
  return text(
    record.message.map((part, index) => {
      if (index % 2 === 0) return part;
      const key = names[(index - 1) / 2] ?? "";
      return isIdentityKey(key.split(".")[0] ?? key) ? REDACTED : part;
    }),
  );
}

/** The first `Error` among the record's properties, as the exception to file. */
function thrown(properties: Record<string, unknown>): Error | null {
  for (const value of Object.values(properties)) {
    if (value instanceof Error) return value;
  }
  return null;
}

function tagValue(value: unknown): string {
  const rendered =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
        ? String(value)
        : value instanceof Error
          ? `${value.name}: ${value.message}`
          : JSON.stringify(value) ?? String(value);
  return rendered.length > MAX_TAG_LENGTH ? `${rendered.slice(0, MAX_TAG_LENGTH - 1)}…` : rendered;
}

export const sentrySink: Sink = (record: LogRecord): void => {
  const category = record.category.join(".");
  const level = SEVERITY[record.level];
  const identity = sendsIdentity();
  const message = identity ? text(record.message) : redactedText(record);

  if (record.level !== "error" && record.level !== "fatal") {
    addBreadcrumb({
      type: "default",
      category,
      level,
      message,
      timestamp: record.timestamp / 1000,
    });
    return;
  }

  const tags: Record<string, string> = { "log.category": category };
  for (const [key, value] of Object.entries(record.properties)) {
    if (value === undefined || value === null) continue;
    tags[`log.${key}`] = !identity && isIdentityKey(key) ? REDACTED : tagValue(value);
  }
  const template =
    typeof record.rawMessage === "string" ? record.rawMessage : record.rawMessage.join("{}");
  const context = {
    level,
    tags,
    fingerprint: [category, template],
    contexts: { log: { message, template } },
  };
  const error = thrown(record.properties);
  if (error == null) captureMessage(message, context);
  else captureException(error, context);
};
