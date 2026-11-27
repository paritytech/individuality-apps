// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { customSteps } from '@parity/product-lab/steps';
import { DemoRecording } from '@parity/product-lab/application';
import { RunRecording } from '@parity/product-lab/domain/recordings';
import { FileRecordingStore } from '@parity/product-lab/storage-filesystem';
import { PageFrameCapture } from '@parity/product-lab/browser-playwright';
import { FlowCapture, writeFlowRecording } from '../../lab/flows/recording.ts';
import { flowState } from '../../lab/flows/session.ts';
import { cutDemos } from '../../lab/flows/demo.mjs';
import { writeScenarioSummary } from '../../../../.github/lab-scenario-summary.mts';
import '../../lab/flows/steps.ts';

const app = new URL('../../', import.meta.url);
const feature = readFileSync(new URL('lab/flows/humanity-dim2.feature', app), 'utf8');
const name = /^\s*Scenario:\s*(.+)$/m.exec(feature)![1]!;
const sentences = [...feature.matchAll(/^\s*(?:Given|When|Then|And|But)\s+(.+)$/gm)].map(match => match[1]!);
const report = () => [{ elements: [{ type: 'scenario', name, steps: sentences.map(name => ({ name, result: { status: 'passed', error_message: 'private error' }, embeddings: [{ data: 'private attachment' }] })) }] }];
async function seed(directory: string) {
  const capture = new FlowCapture(directory);
  capture.actorStarted(1000); capture.actorReady(3000);
  for (const [index, text] of sentences.slice(1).entries()) {
    const step = customSteps().find(step => step.pattern.match(text)); expect(step, text).toBeDefined();
    capture.step(step!.pattern.text, 3000 + index * 1000, 4000 + index * 1000);
  }
  mkdirSync(join(directory, 'videos'), { recursive: true });
  for (const actor of ['alice', 'bob', 'carol']) for (const [app, openedAt] of [['peopl', 1100], ['dim2', 7000]] as const) {
    const video = { name: `${actor}-${app}.webm`, openedAt, mediaType: 'video/webm' };
    // Use the installed page-video adapter, without launching a browser.
    const frames = new PageFrameCapture({ pages: () => ({ recordedVideo: async () => video }) });
    capture.video(actor, app, await frames.video(actor));
    writeFileSync(join(directory, 'videos', video.name), 'offline video stand-in');
  }
  // Sessions start closing after the last step (21 steps from 3000 ms, one second each).
  capture.closing(3000 + sentences.length * 1000);
  return capture;
}
function wrapperFinally() {
  const text = readFileSync(new URL('scripts/lab/flow.mts', app), 'utf8');
  const source = ts.createSourceFile('flow.mts', text, ts.ScriptTarget.Latest, true);
  let block: ts.Block | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'writeScenarioSummary') {
      let parent = node.parent; while (parent && !ts.isBlock(parent)) parent = parent.parent; block = parent as ts.Block;
    }
    ts.forEachChild(node, visit);
  }
  visit(source); expect(block).toBeDefined();
  return ts.transpileModule(block!.getText(source).slice(1, -1), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
}
it('reproduces raw CI videos without a feature record, then the actual wrapper makes all three demos selectable', async () => {
  const base = mkdtempSync(join(tmpdir(), 'flow-demo-ci-'));
  try {
    const recordingsDirectory = join(base, 'recordings'), reports = join(base, 'reports'), directory = join(base, 'raw');
    await seed(recordingsDirectory); mkdirSync(directory); mkdirSync(reports);
    writeFileSync(join(directory, 'product-lab-test.json'), JSON.stringify(report()));
    // This is the CI failure: six videos are present, but the pinned generic recorder made no feature JSON.
    const before = cutDemos({ runsDir: recordingsDirectory, out: join(base, 'before'), workDir: join(base, 'edit-before') }, () => '{}');
    expect(before.errors).toEqual(['current: no humanity-dim2 feature recording; raw videos retained if present']);
    const warnings: string[] = [];
    const scope = { reports, directory, recordingsDirectory, app: new URL('.', app).pathname, control: false, id: 'offline', source: {}, host: {}, started: 1000, forkDirectory: join(base, 'fork'), mkdirSync, readFileSync, writeFileSync, join, rmSync, read: (path: string) => JSON.parse(readFileSync(path, 'utf8')), writeScenarioSummary, writeFlowRecording,
      cleanup: async () => {}, process: { exitCode: 0 }, console: { warn: (text: string) => warnings.push(text), error: () => {} } };
    await new Function(...Object.keys(scope), `return (async () => { let passed = true; ${wrapperFinally()} })()`)(...Object.values(scope));
    expect(warnings).toEqual([]);
    const stores: string[] = [];
    const after = cutDemos({ runsDir: recordingsDirectory, out: join(base, 'after'), workDir: join(base, 'edit') }, (bin: string, _args: string[], options?: { env?: Record<string, string> }) => {
      if (bin === 'ffprobe') return '60';
      if (bin === 'ffmpeg') writeFileSync(_args.at(-1)!, 'offline stitched video stand-in');
      if (bin === 'node') stores.push(options!.env!.PRODUCT_LAB_RECORDINGS_DIR!);
      return '{}';
    });
    expect(after.errors).toEqual([]); expect(after.demos).toHaveLength(3);
    expect(after.demos).toEqual(expect.arrayContaining(['Alice', 'Bob', 'Carol'].map(actor => expect.objectContaining({ actor }))));
    for (const store of stores) {
      const files = { exists: existsSync, makeDirectory: (path: string) => mkdirSync(path, { recursive: true }), writePrivateBytes: (path: string, bytes: Uint8Array) => writeFileSync(path, bytes) };
      const editor = new DemoRecording({ lab: { root: base } } as never, { execute: async () => ({ features: [] }) } as never,
        { current: () => ({ store: new FileRecordingStore(store) }) } as never, { value: (value: unknown) => value, text: (text: string) => text } as never, files as never);
      const read = await new FileRecordingStore(store).read('humanity-dim2-custom-flow');
      expect(read!.data.steps).toHaveLength(22);
      // Without ffprobe the plan reads the stitched video's length from closedAt; the last step ends inside it.
      expect(read!.data.capture.videos!.map(video => video.closedAt)).toEqual([3000 + sentences.length * 1000]);
      expect(read!.data.steps.at(-1)!.finishedAt).toBeLessThan(read!.data.capture.videos![0]!.closedAt!);
      const demo = await editor.execute({ recording: read!.id, actor: read!.data.actors.find(actor => read!.data.capture.videos![0]!.actor === actor.id)!.name, out: join(store, 'plan'), planOnly: true });
      expect(demo.plan.captions).toBe(22);
      expect(demo.plan.segments).toBeGreaterThan(0);
      expect(JSON.stringify(read!.data)).not.toMatch(/private error|private attachment|embeddings|error_message/);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
it('preserves measured setup and steps when the isolated flow restores and closes an empty session', async () => {
  const base = mkdtempSync(join(tmpdir(), 'flow-isolated-capture-'));
  try {
    await seed(base);
    const path = join(base, 'flow-capture.json'), measured = readFileSync(path, 'utf8');
    // 0.1.2 gives @isolated its starting state back by reopening sessions without actors.
    // The final environment close calls closing() on this fresh, empty capture.
    new FlowCapture(base).closing(100_000);
    expect(readFileSync(path, 'utf8')).toBe(measured);
    const recording = writeFlowRecording(base, report(), feature, 'lab/flows/humanity-dim2.feature', 'offline');
    expect(recording.data.steps).toHaveLength(22);
    expect(recording.data.steps[0]).toMatchObject({ startedAt: 1000, finishedAt: 3000 });
    const demos = cutDemos({ runsDir: base, out: join(base, 'demos'), workDir: join(base, 'edit'), plan: true }, (bin: string, args: string[]) => {
      if (bin === 'ffprobe') return '60';
      if (bin === 'ffmpeg') writeFileSync(args.at(-1)!, 'offline stitched video stand-in');
      return '{}';
    });
    expect(demos.errors).toEqual([]); expect(demos.demos).toHaveLength(3);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
it('refuses to fabricate a passed record from missing timings, mismatched steps or missing page descriptors', async () => {
  const base = mkdtempSync(join(tmpdir(), 'flow-demo-refusal-'));
  try {
    await seed(base);
    const path = join(base, 'flow-capture.json'), original = readFileSync(path, 'utf8');
    for (const mutate of [
      (data: { steps: unknown[]; videos: unknown[]; closingAt?: number }) => { data.steps.pop(); },
      (data: { steps: unknown[]; videos: unknown[]; closingAt?: number }) => { data.videos.pop(); },
      // Sessions cannot close before the last step finished.
      (data: { steps: unknown[]; videos: unknown[]; closingAt?: number }) => { data.closingAt = 23_999; },
    ]) {
      const data = JSON.parse(original); mutate(data); writeFileSync(path, JSON.stringify(data));
      expect(() => writeFlowRecording(base, report(), feature, 'lab/flows/humanity-dim2.feature', 'offline')).toThrow();
    }
    // A run that never reached session cleanup (a crash) keeps its videos without an end it did not measure.
    const unclosed = JSON.parse(original); delete unclosed.closingAt; writeFileSync(path, JSON.stringify(unclosed));
    expect(writeFlowRecording(base, report(), feature, 'lab/flows/humanity-dim2.feature', 'offline').data.capture.videos!.every(video => !('closedAt' in video))).toBe(true);
    writeFileSync(path, original);
    const failed = report(); failed[0]!.elements[0]!.steps.at(-1)!.result.status = 'failed';
    const recorded = writeFlowRecording(base, failed, feature, 'lab/flows/humanity-dim2.feature', 'offline');
    expect(RunRecording.from(recorded.data).data.status).toBe('failed');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
it('the actual custom-step wrapper measures a failed step while preserving its original error', async () => {
  const base = mkdtempSync(join(tmpdir(), 'flow-step-capture-')), previous = flowState.active;
  try {
    const capture = new FlowCapture(base);
    flowState.active = { capture, actors: [{ account: 'offline' }], people: { access: { finalizedHead: async () => ({ hash: 'offline' }), historicalStorage: async () => { throw new Error('offline read failure'); } } } } as never;
    const step = customSteps().find(step => step.pattern.text === 'the three fresh fork players have zero PAS and no prior credits')!;
    await expect(step.run({ lab: { attach: async () => {} } } as never)).rejects.toThrow('offline read failure');
    const data = JSON.parse(readFileSync(join(base, 'flow-capture.json'), 'utf8'));
    expect(data.steps).toHaveLength(1); expect(data.steps[0].pattern).toBe(step.pattern.text);
    expect(data.steps[0].finishedAt).toBeGreaterThanOrEqual(data.steps[0].startedAt);
  } finally { flowState.active = previous; rmSync(base, { recursive: true, force: true }); }
});
