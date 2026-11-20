// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function flowDemoStatus(outcome: string | undefined, url: string | undefined, runUrl: string) {
  const suffix = url?.startsWith(`${runUrl}/artifacts/`) ? url.slice(`${runUrl}/artifacts/`.length) : '';
  return outcome === 'success' && /^\d+$/.test(suffix) ? 'produced' : 'not produced';
}

export function writeFlowDemoStatus(options: { outcome?: string; url?: string; runUrl: string; journey?: string; scenarios?: unknown; directory: string; output: string; summary: string }) {
  const demo = flowDemoStatus(options.outcome, options.url, options.runUrl);
  let journey = new Map([['success', 'PASS'], ['failure', 'FAIL'], ['cancelled', 'CANCELLED'], ['skipped', 'SKIPPED']]).get(options.journey ?? '') ?? 'UNAVAILABLE';
  const reason = 'not run: imported game in Reporting';
  const notRun = (Array.isArray(options.scenarios) ? options.scenarios : []).find(value => value !== null && typeof value === 'object' &&
    ['not-run', 'failed'].includes(value.status) && value.reason === reason);
  if (notRun) journey = notRun.status === 'failed' ? `FAIL (${reason})` : 'NOT RUN: imported game in Reporting';
  mkdirSync(options.directory, { recursive: true });
  writeFileSync(join(options.directory, 'demo-status.json'), JSON.stringify({ demo, journey }) + '\n');
  appendFileSync(options.output, `demo_status=${demo}\n`);
  appendFileSync(options.summary, `## DIM2 play-through evidence\n\nJourney: **${journey}**\n\nDemo: **${demo}**\n\n${demo === 'produced' ? 'The demo artifact contains the three actor cuts.' : 'The demo was not produced. Use the raw actor videos and sanitized results; the journey result is unchanged.'}\n`);
  return demo;
}
