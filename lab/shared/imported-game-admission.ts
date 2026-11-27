// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export const drainStep = 'the lab drains imported games before the scenario';
/** A rejected chain precondition ran no product scenario. Raw Cucumber must remain nonzero. */
export class ImportedGameNotRun extends Error {
  constructor(reason: string, options?: ErrorOptions) { super(`not run: imported game drain: ${reason}`, options); this.name = 'ImportedGameNotRun'; }
}

/** Only known transient import-state messages qualify; guard, clock and finality faults do not. */
export function isImportedGameDrainRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return message === 'not run: imported game in Reporting' ||
    /^Imported DIM2 game #\d+ completion timed out after \d+ms: (?:finalized chain time has not reached report_ends|runtime block processing has not removed the imported game);/.test(message) ||
    /^Imported DIM2 cleanup refused replacement game #\d+:/.test(message) ||
    /^Imported DIM2 game #\d+ is in \S+ at finalized #\d+;/.test(message) ||
    /^Imported DIM2 cleanup is incomplete(?: at finalized #\d+:|:)/.test(message);
}
