// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import ts from 'typescript';
import { writeFlowRecording } from '../../lab/flows/recording.ts';
import { scenarioSummary, writeScenarioSummary } from '../../../../.github/lab-scenario-summary.mts';

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const workflow = parse(read('.github/workflows/humanity-dim2-flow.yml'));
const script = workflow.jobs.comment.steps[0].with.script as string;
const feature = read('apps/humanity-app/lab/flows/humanity-dim2.feature');
const name = /^\s*Scenario:\s*(.+)$/m.exec(feature)![1]!;
const names = [...feature.matchAll(/^\s*(?:Given|When|Then|And|But)\s+(.+)$/gm)].map(match => match[1]!);
const reason = 'not run: imported game in Reporting';
function report(outcome: 'passed' | 'failed' | 'not-run') {
  const failAt = outcome === 'passed' ? names.length : outcome === 'not-run' ? 1 : 12;
  return [{ elements: [{ type: 'scenario', name, steps: [
    { hidden: true, name: 'Before', result: { status: 'passed', error_message: '' } },
    ...names.map((name, index) => ({ name, result: { status: index < failAt ? 'passed' : index === failAt ? 'failed' : 'skipped', error_message: outcome === 'not-run' && index === 1 ? `Error: ${reason}\nprivate stack` : 'private transaction path' }, embeddings: [{ mime_type: 'application/json', data: Buffer.from('{"transactions":"private attachment"}').toString('base64') }] })),
  ] }] }];
}
const summary = (outcome: 'passed' | 'failed' | 'not-run') => scenarioSummary(report(outcome), feature, true);
const runUrl = 'https://github.com/paritytech/individuality-apps/actions/runs/123';
async function render(outcome: 'passed' | 'failed' | 'not-run', previous = '', evidence = summary(outcome), media: { status?: string; url?: string } = {}) {
  let body = previous;
  const issues = { listComments: () => {}, getComment: async () => ({ data: { body } }), updateComment: async (value: { body: string }) => { body = value.body; }, createComment: async (value: { body: string }) => { body = value.body; } };
  const github = { rest: { issues }, paginate: async () => body ? [{ id: 1, body, user: { login: 'github-actions[bot]', type: 'Bot' } }] : [] };
  const context = { runId: 123, repo: { owner: 'paritytech', repo: 'individuality-apps' }, issue: { number: 1661 } };
  const process = { env: { WORKFLOW: 'flow', DEMO_STATUS: media.status ?? 'produced', RESULT: outcome === 'passed' ? 'success' : 'failure', SCENARIOS: JSON.stringify(evidence), GITHUB_RUN_ATTEMPT: '1', GITHUB_SERVER_URL: 'https://github.com', DEMO_URL: media.url ?? `${runUrl}/artifacts/1`, VIDEOS_URL: `${runUrl}/artifacts/2`, RESULTS_URL: `${runUrl}/artifacts/3` } };
  await new Function('github', 'context', 'core', 'process', `return (async () => { ${script} })()`)(github, context, { warning: () => { throw new Error('Unexpected comment failure'); } }, process);
  return body;
}
it('projects all twenty-two flow steps without errors, attachments, transactions or paths', () => {
  expect(summary('passed')[0]).toEqual({ name, status: 'passed', steps: names.map(name => ({ name, status: 'passed' })) });
  expect(summary('failed')[0]!.status).toBe('failed');
  expect(summary('not-run')[0]).toMatchObject({ status: 'not-run', reason });
  expect(summary('not-run')[0]!.steps[1]!.status).toBe('not-run');
  expect(JSON.stringify(summary('not-run'))).not.toMatch(/private|embeddings|error_message|transactions|Before/);
  expect(scenarioSummary(report('not-run'), feature)[0]!.status).toBe('failed');
});
it('@negative-control never treats another error, mismatched evidence or a hidden failure as not-run', () => {
  for (const mutate of [
    (data: ReturnType<typeof report>) => { data[0]!.elements[0]!.steps[2]!.result.error_message = `Error: ${reason} extra`; },
    (data: ReturnType<typeof report>) => { data[0]!.elements[0]!.steps[2]!.name = 'different step'; },
    (data: ReturnType<typeof report>) => { data[0]!.elements[0]!.steps[0]!.result.status = 'failed'; },
    (data: ReturnType<typeof report>) => { data[0]!.elements[0]!.steps[1]!.result.status = 'failed'; },
    (data: ReturnType<typeof report>) => { data[0]!.elements[0]!.steps[4]!.result.status = 'failed'; },
  ]) {
    const data = report('not-run'); mutate(data);
    expect(scenarioSummary(data, feature, true)[0]!.status).toBe('failed');
  }
});
it('carries the identical isolated writer with a third section and the shared comment group', () => {
  for (const name of ['humanity', 'jollity']) {
    const sibling = parse(read(`.github/workflows/${name}-lab.yml`));
    expect(script).toBe(sibling.jobs.comment.steps[0].with.script);
    expect(workflow.jobs.comment.concurrency).toEqual(sibling.jobs.comment.concurrency);
  }
  const job = workflow.jobs.comment;
  expect(job.needs).toEqual(['flow']);
  expect(job.steps[0].env.WORKFLOW).toBe('flow');
  expect(job.steps).toHaveLength(1);
  expect(job['timeout-minutes']).toBe(3);
  expect(job['continue-on-error']).toBe(true);
  expect(job.steps[0]['continue-on-error']).toBe(true);
  expect(job.permissions).toEqual({ 'pull-requests': 'write' });
  const evaluate = new Function('github', 'needs', 'always', `return ${job.if.slice(3, -2)}`);
  for (const event of ['pull_request', 'push', 'workflow_dispatch']) for (const fork of [false, true]) for (const result of ['skipped', 'success', 'failure', 'cancelled']) {
    expect(evaluate({ event_name: event, repository: 'repo', event: { pull_request: { head: { repo: { full_name: fork ? 'fork' : 'repo' } } } } }, { flow: { result } }, () => true)).toBe(event === 'pull_request' && !fork && result !== 'skipped');
  }
  for (const [key, id] of [['demo', 'upload_demo'], ['videos', 'upload_videos'], ['results', 'upload_results']]) expect(workflow.jobs.flow.outputs[key!]).toBe(`\u0024{{ steps.${id}.outputs.artifact-url }}`);
  const readSummary = workflow.jobs.flow.steps.find((step: { id?: string }) => step.id === 'comment_summary');
  expect(readSummary.run).toContain('flow-reports/sanitized/scenario-steps.json');
  expect(readSummary.if).toBe('always()');
});
it.each(['passed', 'failed', 'not-run'] as const)('renders %s as its own third section, preserving both openings', async outcome => {
  const previous = '<!-- lab-opening-comment:v1 -->\n# Local fork openings\n\n<!-- lab-opening:humanity:start -->\nHumanity retained\n<!-- lab-opening:humanity:end -->\n<!-- lab-opening:jollity:start -->\nJollity retained\n<!-- lab-opening:jollity:end -->';
  const body = await render(outcome, previous);
  expect(body).toContain('Humanity retained'); expect(body).toContain('Jollity retained');
  expect(body).toContain('## DIM2 play-through\n');
  expect(body).toContain(`Result: **${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'NOT RUN: imported game in Reporting'}**`);
  expect(body.match(/\| PASS \|/g)).toHaveLength(outcome === 'passed' ? 22 : outcome === 'failed' ? 12 : 1);
  if (outcome === 'not-run') { expect(body).toContain('| NOT RUN |'); expect(body).not.toContain('Result: **PASS**'); }
  for (const [label, id] of [['Demo', 1], ['Videos', 2], ['Results', 3]]) expect(body).toContain(`[${label}](${runUrl}/artifacts/${id})`);
  expect(body).not.toMatch(/private|transactions|embeddings|error_message/);
  if (process.env.FLOW_COMMENT_SAMPLES_DIR) writeFileSync(join(process.env.FLOW_COMMENT_SAMPLES_DIR, `comment-${outcome}.md`), body + '\n');
});
it('executes the wrapper finally block: projects before cleanup, records not-run, exits nonzero even if cleanup fails', async () => {
  const runner = read('apps/humanity-app/scripts/lab/flow.mts');
  const ast = ts.createSourceFile('flow.mts', runner, ts.ScriptTarget.Latest, true);
  let block: ts.Block | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'writeScenarioSummary') {
      let ancestor = node.parent;
      while (ancestor && !ts.isBlock(ancestor)) ancestor = ancestor.parent;
      block = ancestor as ts.Block;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(block && ts.isBlock(block) && ts.isTryStatement(block.parent) && block.parent.finallyBlock === block).toBe(true);
  const javascript = ts.transpileModule(block!.getText(ast).slice(1, -1), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  for (const outcome of ['passed', 'not-run'] as const) for (const cleanupFails of [false, true]) {
    const base = mkdtempSync(join(tmpdir(), 'flow-projection-'));
    try {
      const reports = join(base, 'reports'), directory = join(base, 'raw'), app = join(base, 'app');
      mkdirSync(directory); mkdirSync(join(app, 'lab/flows'), { recursive: true });
      const data = report(outcome);
      if (cleanupFails && outcome === 'not-run') data[0]!.elements[0]!.steps.push({ hidden: true, name: 'After', result: { status: 'failed', error_message: 'private cleanup error' } });
      writeFileSync(join(directory, 'product-lab-test.json'), JSON.stringify(data));
      writeFileSync(join(app, 'lab/flows/humanity-dim2.feature'), feature);
      const messages: string[] = [], process = { exitCode: 0 };
      const scope = { initialPassed: outcome === 'passed', reports, directory, app, control: false, id: 'offline', source: {}, host: {}, started: Date.now(), recordingsDirectory: 'private-recording', forkDirectory: join(base, 'fork'), mkdirSync, writeFileSync, writeScenarioSummary, writeFlowRecording, read: (file: string) => JSON.parse(readFileSync(file, 'utf8')), join, rmSync, process, console: { warn: () => {}, error: (value: string) => messages.push(value) }, cleanup: async () => {
        expect(JSON.parse(readFileSync(join(reports, 'sanitized/scenario-steps.json'), 'utf8'))).toEqual(scenarioSummary(data, feature, true));
        rmSync(directory, { recursive: true });
        if (cleanupFails) throw new Error('offline cleanup failed');
      } };
      const execute = new Function(...Object.keys(scope), `return (async () => { let passed = initialPassed; ${javascript}\nreturn passed; })()`);
      const result = execute(...Object.values(scope));
      if (cleanupFails) await expect(result).rejects.toThrow('offline cleanup failed');
      else expect(await result).toBe(outcome === 'passed');
      expect(process.exitCode).toBe(outcome === 'not-run' || cleanupFails ? 1 : 0); expect(messages).toEqual(outcome === 'not-run' ? [reason] : []);
      const metadata = JSON.parse(readFileSync(join(reports, 'sanitized/offline.json'), 'utf8'));
      expect(metadata).toMatchObject({ passed: outcome === 'passed' && !cleanupFails, result: outcome === 'not-run' ? reason : cleanupFails ? 'failed' : 'passed' });
      expect(JSON.stringify(metadata)).not.toMatch(/private-recording|private transaction/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
});


it('retains the Reporting not-run reason when a teardown hook also fails, without passing that scenario', async () => {
  const data = report('not-run'); data[0]!.elements[0]!.steps.push({ hidden: true, name: 'After', result: { status: 'failed', error_message: 'private cleanup error' } });
  const evidence = scenarioSummary(data, feature, true);
  expect(evidence[0]).toMatchObject({ status: 'failed', reason });
  const body = await render('not-run', '', evidence);
  expect(body).toContain('Result: **FAIL (not run: imported game in Reporting)**');
  expect(body).toContain(`${name} · FAIL`);
  if (process.env.FLOW_COMMENT_SAMPLES_DIR) writeFileSync(join(process.env.FLOW_COMMENT_SAMPLES_DIR, 'comment-not-run-teardown-failed.md'), body + '\n');
  expect(body).not.toContain('Result: **PASS**');
});


it('makes a passed journey without a demo visible without changing the journey result', async () => {
  const body = await render('passed', '', summary('passed'), { status: 'not produced', url: '' });
  expect(body).toContain('Result: **PASS**');
  expect(body).toContain('Demo: **not produced**');
  expect(body).toContain('- Demo: unavailable');
  expect(body).toContain(`[Videos](${runUrl}/artifacts/2)`);
  if (process.env.FLOW_COMMENT_SAMPLES_DIR) writeFileSync(join(process.env.FLOW_COMMENT_SAMPLES_DIR, 'comment-passed-no-demo.md'), body + '\n');
});
