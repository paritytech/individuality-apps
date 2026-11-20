// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The same local/CI entry: reuse built apps, run one selected scenario in two CLI hosts and export measured datasets.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeSystem, processEnvironment } from '@parity/product-lab/composition';
import { acquireTruapiHost } from '@parity/product-lab/host-truapi-cli';
import { workingTreeHash } from '../working-tree.ts';
import { hostSelection } from '../../../apps/humanity-app/lab/opening/session.ts';
import { buildApps, installBuild } from '../build.ts';
import { planRuns, selectRun } from '../runs.ts';
import { assertScenarioReport } from '../../../apps/humanity-app/lab/scenarios/report-contract.ts';
import { renderReport, type Dataset, type Evidence, type RunConfig } from '../report.ts';
import { assertFiniteNumbers } from '../timing.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)), app = join(root, 'apps/humanity-app');
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function declared(file: string, needle: string) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const at = lines.findIndex(line => line.includes(needle));
  if (at < 0) throw Error(`Missing configuration declaration: ${file}`);
  return `${file}:${at + 1}`;
}
export function configuration(): RunConfig {
  const value = (setting: string, ref: string, basis: 'declared' | 'observed' = 'declared') => ({ value: setting, ref, basis });
  const card = 'apps/humanity-app/src/features/card/hooks/use-humanity-card.ts';
  const game = 'apps/humanity-app/src/features/card/hooks/use-current-game.ts';
  const commit = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw Error('Cannot observe app commit');
  const installed = (name: string) => {
    const lock = read(join(root, 'package-lock.json'));
    const paths = Object.keys(lock.packages).filter(key => key.endsWith(`node_modules/${name}`));
    if (paths.length !== 1) throw Error(`Expected one installed ${name}`);
    const manifest = read(join(root, paths[0]!, 'package.json'));
    return value(`${manifest.version}; build SHA ${manifest.gitHead ?? 'not measured (package has no gitHead)'}`, `${name}/package.json (installed)`, 'observed');
  };
  return {
    topology: value('Ada two-host lab; separate processes and storage; gameplay adds two independent Jollity media peer hosts (four hosts total)', declared('lab/shared/session.ts', "Jollity in Ada's second host process")),
    'Humanity reads': value('finalized card/game; Game.Players at best', declared(game, 'client.getFinalizedBlock()')),
    'Humanity card poll': value('12000 ms', declared(card, '12_000')),
    'Humanity next-game poll': value('30000 ms', declared(game, '30_000')),
    'Humanity live-record poll': value('3000 ms with a live, non-failed own or Jollity registration record; Jollity cross-product storage is absent in this topology', declared(game, '3_000')),
    'Jollity reads': value('best-block watchPlayer subscription', declared('packages/jollity-game-chain/src/engine.ts', 'watchPlayer(address') + '; ' + declared('node_modules/@parity/product-sdk-individuality/dist/index.js', 'query.Game.Players.watchValue')),
    'app commit': value(commit.stdout.trim() + '; shared static apps; Jollity loopback version stays current except for explicit update promotion', 'git rev-parse HEAD; shared build.json hashes; lab/cross-app/build.ts; working-tree changes separately hashed in dataset', 'observed'),
    'host SDK': installed('@parity/product-sdk-host'), SDK: installed('@parity/product-sdk'), 'individuality SDK': installed('@parity/product-sdk-individuality'),
    host: value(`truapi CLI ${read(join(app, 'lab/opening/host.lock.json')).official.version}; archive checksum verified by acquireTruapiHost`, 'apps/humanity-app/lab/opening/host.lock.json:4'),
    'product-lab': installed('@parity/product-lab'),
  };
}
function command(args: string[], environment = process.env) {
  const ran = spawnSync(process.execPath, args, { cwd: root, env: environment, stdio: 'inherit' });
  if (ran.status !== 0) throw Error(`Local lab command failed (${ran.status ?? ran.signal})`);
}
export function retainedRows(text: string): Evidence[] {
  if (!text.trim()) throw Error('Empty run');
  return text.trim().split('\n').map(line => { const row = JSON.parse(line) as Evidence; assertFiniteNumbers(row); return row; });
}
async function run(id: string) {
  const leg = selectRun(id), started = Date.now();
  const build = resolve(process.env.CROSS_APP_BUILD_DIR ?? join(root, 'artifacts/cross-app-shared-build'));
  installBuild(build);
  const output = resolve(process.env.CROSS_APP_CI_OUT ?? join(root, '.product-lab', 'cross-app-ci', id));
  const timings = join(output, 'timings'), reports = join(output, 'private-report');
  if (existsSync(join(timings, 'timings.jsonl'))) throw Error('Refusing to append a new leg to old timing evidence');
  mkdirSync(output, { recursive: true });
  const config = configuration();
  const system = new NodeSystem(processEnvironment());
  const host = await acquireTruapiHost({ ...hostSelection, commands: system.commands, patches: [] });
  const expected = read(join(app, 'lab/opening/host.lock.json')).official.version;
  if (!host.binarySha256 || host.version !== expected) throw Error('Acquired host differs from pinned CLI');
  config.host = { value: `truapi CLI ${host.version}; binary SHA256 ${host.binarySha256}`, basis: 'observed', ref: 'acquireTruapiHost; attestation required; lab/opening/host.lock.json' };
  const testedTree = await workingTreeHash(root);
  const environment = { ...process.env,
    CROSS_APP_UPDATE_LAB: '1', CROSS_APP_TIMINGS_DIR: timings, PRODUCT_LAB_FORK_BUNDLE: 'keep',
    HUMANITY_SCENARIOS_SETUP: process.env.HUMANITY_SCENARIOS_SETUP ?? 'fast',
    HUMANITY_SCENARIOS_VIDEO_SIZE: '640x360', HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS: '180000',
    PRODUCT_LAB_RECORDINGS: 'frames', PRODUCT_LAB_RECORDINGS_HOST_LOGS: 'off', PRODUCT_LAB_RECORDINGS_DIR: join(output, 'recordings') };
  let verdict = 'failed';
  try {
    const args = [join(root, 'node_modules/.bin/product-lab'), 'test', '--config', 'lab/cross-app/built.config.ts', '--tags', leg.tags, '--own-lab', '--video', '--report-dir', reports];
    args.push('--name', leg.code === 'C6' ? 'Full loop:' : `run ${leg.row}$`);
    command(args, environment);
    const report = assertScenarioReport(read(join(reports, 'product-lab-test.json')), 'passed');
    if (report.scenarios !== 1) throw Error('Expected exactly one cross-app scenario run');
    verdict = 'passed';
  } finally {
    const rows = existsSync(join(timings, 'timings.jsonl')) ? retainedRows(readFileSync(join(timings, 'timings.jsonl'), 'utf8')) : [];
    const dataset = { source: id, command: `cross-app-ci.mts run ${id}`, config, rows, verdict,
      seconds: (Date.now() - started) / 1000, workingTreeSha256: testedTree };
    // Only explicit sanitized inputs are uploaded. Host evidence and raw Cucumber attachments stay private.
    writeFileSync(join(output, 'dataset.json'), JSON.stringify(dataset, null, 2) + '\n');
    if (rows.length) { const report = renderReport([dataset]); writeFileSync(join(output, 'report.html'), report.html); writeFileSync(join(output, 'comment.md'), report.markdown + '\n'); }
  }
}
function files(at: string): string[] { return readdirSync(at, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(at, e.name)) : e.name === 'dataset.json' ? [join(at, e.name)] : []); }
export function summarizeRuns(directory: string, output: string) {
  mkdirSync(output, { recursive: true });
  const datasets = (existsSync(directory) ? files(directory) : []).map(file => read(file) as Dataset);
  const valid = datasets.filter(d => d.rows.length);
  const expected = planRuns(process.env.GITHUB_EVENT_NAME ?? 'pull_request', process.env.CROSS_APP_C6_ON_PR);
  const status = expected.map(run => {
    const matches = datasets.filter(d => d.source === run.id);
    if (matches.length > 1) throw Error('Duplicate scenario dataset');
    const d = matches[0];
    return `- ${run.name}: ${d?.verdict ?? 'not run'}${d?.seconds ? ` (${d.seconds.toFixed(1)} s)` : ''}`;
  }).join('\n');
  const report = valid.length ? renderReport(valid) : { html: '<!doctype html><html lang="en"><title>Cross-app lab</title><body><h1>No timing endpoints</h1></body></html>', markdown: '<!-- cross-app-lab-comment:v1 -->\n## Cross-app lab\n\nNo timing endpoints were recorded.' };
  const escaped = status.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  writeFileSync(join(output, 'report.html'), report.html.replace('</body>', `<h2>Scenario runs</h2><pre>${escaped}</pre></body>`));
  writeFileSync(join(output, 'comment.md'), report.markdown + '\n\n### Scenario runs\n\n' + status + '\n');
  writeFileSync(join(output, 'datasets.json'), JSON.stringify(datasets, null, 2) + '\n');
}
async function main() {
  const [mode, id, name, extra] = process.argv.slice(2);
  if (extra) throw Error('Unexpected cross-app argument');
  if (mode === 'cleanup' && !id) {
    const system = new NodeSystem(processEnvironment());
    const result = await system.processes.reapAbandoned(join(root, '.product-lab'), { maxDepth: 12 });
    if (result.failed.length) throw Error('Owned process cleanup failed');
    return;
  }
  if (mode === 'plan' && !name) { console.log(JSON.stringify(planRuns(id ?? process.env.GITHUB_EVENT_NAME ?? 'pull_request', process.env.CROSS_APP_C6_ON_PR))); return; }
  if (mode === 'build' && id && !name) return buildApps(resolve(id));
  if (mode === 'run' && id && !name) return run(id);
  if (mode === 'summarize' && id && name) return summarizeRuns(id, name);
  throw Error('Use cross-app-ci.mts build <out> | plan [event] | run <scenario-run> | summarize <datasets-directory> <out>');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
