// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SentencePattern } from '@parity/product-lab/domain';
import { RunRecording, RECORDING_SCHEMA_VERSION } from '@parity/product-lab/domain/recordings';
import type { CapturedVideo } from '@parity/product-lab/ports/recording';
import { scenarioSummary } from '../../../../.github/lab-scenario-summary.mts';

const actors = ['Alice', 'Bob', 'Carol'] as const;
type Timing = { pattern: string; startedAt: number; finishedAt: number };
type Video = { actor: string; app: 'peopl' | 'dim2'; file: string; openedAt: number; mediaType: string; source: 'headless-page' };
type Capture = { actorsStartedAt?: number; actorsFinishedAt?: number; closingAt?: number; steps: Timing[]; videos: Video[] };
const manifest = 'flow-capture.json';

/** App-owned timing/video metadata. Product-lab 0.1.0 made no feature recording for custom Cucumber steps; 0.1.2 may
 * save its own beside this one, and the demo cuts only this record (`FLOW_RECORDING_ID` in demo.mjs). */
export class FlowCapture {
  private data: Capture = { steps: [], videos: [] };
  constructor(private directory: string) {}
  private save() {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.directory, manifest), JSON.stringify(this.data) + '\n', { mode: 0o600 });
    } catch { console.warn('Flow demo metadata: not available'); }
  }
  actorStarted(at: number) { this.data.actorsStartedAt = Math.min(this.data.actorsStartedAt ?? at, at); this.save(); }
  actorReady(at: number) { this.data.actorsFinishedAt = Math.max(this.data.actorsFinishedAt ?? at, at); this.save(); }
  step(pattern: string, startedAt: number, finishedAt: number) { this.data.steps.push({ pattern, startedAt, finishedAt }); this.save(); }
  /** When the flow starts closing its sessions: every page, so every video, is still open then. */
  closing(at: number) {
    // @isolated restores the empty starting session after the flow. Its final close must not
    // replace the completed capture with a closing-only manifest lacking actor/step spans.
    if (this.data.actorsStartedAt === undefined) return;
    this.data.closingAt ??= at; this.save();
  }
  video(actor: string, app: 'peopl' | 'dim2', video: CapturedVideo | undefined) {
    if (!video || !actors.some(name => name.toLowerCase() === actor) || !/^[A-Za-z0-9@._-]+$/.test(video.name)) return;
    if (this.data.videos.some(item => item.actor === actor && item.app === app)) return;
    this.data.videos.push({ actor, app, file: `videos/${video.name}`, source: 'headless-page', openedAt: video.openedAt, mediaType: video.mediaType });
    this.save();
  }
}

/** Join measured spans to the actual report's verdicts; never infer a pass from videos or metadata. */
export function writeFlowRecording(directory: string, report: unknown, feature: string, uri: string, runId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(runId)) throw new Error('Flow recording needs its wrapper run namespace');
  const data = JSON.parse(readFileSync(join(directory, manifest), 'utf8')) as Capture;
  const summary = scenarioSummary(report, feature)[0];
  if (!summary || !['passed', 'failed'].includes(summary.status) || summary.steps[0]?.name !== 'these actors exist:') throw new Error('Flow recording needs a matching scenario report');
  const span = (startedAt: unknown, finishedAt: unknown) => {
    if (typeof startedAt !== 'number' || typeof finishedAt !== 'number' || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt < 0 || finishedAt < startedAt) throw new Error('Flow recording needs measured step times');
    return { startedAt, finishedAt };
  };
  const setup = span(data.actorsStartedAt, data.actorsFinishedAt);
  let next = 0;
  const steps = summary.steps.map((step, index) => {
    const status = step.status === 'passed' ? 'complete' : step.status === 'failed' ? 'failed' : step.status === 'skipped' ? 'skipped' : undefined;
    if (!status) throw new Error('Flow recording refuses an unknown step verdict');
    const timing = index === 0 ? setup : status === 'skipped' ? undefined : data.steps[next++];
    if (index > 0 && status !== 'skipped' && (!timing || !('pattern' in timing) || !SentencePattern.parse(String(timing.pattern)).match(step.name))) throw new Error('Flow recording timing does not match its feature step');
    const times: { startedAt?: number; finishedAt?: number } = timing ? span(timing.startedAt, timing.finishedAt) : {};
    const actor = actors.find(name => step.name.startsWith(`${name} `) || step.name.startsWith(`${name}'s `));
    return { index, run: runId, runStep: index, featureStep: index + 1, title: step.name, status, blocks: [], ...times, ...(actor ? { actor: actor.toLowerCase(), role: actor } : {}) };
  });
  if (next !== data.steps.length) throw new Error('Flow recording contains unmatched step timings');
  for (const name of actors) for (const app of ['peopl', 'dim2']) {
    if (!data.videos.some(video => video.actor === name.toLowerCase() && video.app === app)) throw new Error('Flow recording needs both actual page videos for every actor');
  }
  const id = 'humanity-dim2-custom-flow';
  const finishedAt = Math.max(...steps.map(step => step.finishedAt ?? 0));
  // Product-lab 0.1.2 places a step's held still only inside its video. Without ffprobe the video's length is
  // closedAt - openedAt, so each video gets the measured time its sessions began closing: a lower bound on its
  // real end, after every step. A run that never closed (a crash) leaves it out, and the demo refuses the last step.
  const closedAt = data.closingAt === undefined ? undefined : span(finishedAt, data.closingAt).finishedAt;
  const videos = data.videos.map(video => (closedAt === undefined ? video : { ...video, closedAt }));
  const recording = RunRecording.from({ schemaVersion: RECORDING_SCHEMA_VERSION, id, kind: 'feature', title: summary.name,
    lab: 'Humanity to DIM2 source flow', environment: { id: 'paseo-copy', label: 'Owned Paseo fork', provider: 'truapi-cli', session: runId },
    status: summary.status, startedAt: setup.startedAt, finishedAt, recordedAt: Date.now(),
    feature: { uri, tags: [] }, actors: actors.map(name => ({ id: name.toLowerCase(), name, role: name })), runs: [runId], steps,
    frames: [], observations: [], transactions: [], capture: { mode: 'steps', sources: [], media: 'none',
      notes: ['App-owned wrapper run: measured actor setup and step spans; actual page-video descriptors, closed no earlier than the measured start of session cleanup; verdicts from the scenario report. No screenshots or transaction evidence captured.'], videos },
  });
  mkdirSync(join(directory, id), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, id, 'recording.json'), JSON.stringify(recording.data) + '\n', { mode: 0o600 });
  return recording;
}
