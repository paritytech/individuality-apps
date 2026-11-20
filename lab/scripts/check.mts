// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Verify the single root install, vendored provenance and both runtime registrations without starting a fork.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryRoot } from '../shared/paths.ts';
const read = (file: string) => JSON.parse(readFileSync(join(repositoryRoot, file), 'utf8'));
const lock = read('package-lock.json');
const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith('node_modules/@parity/product-lab'));
if (entries.length !== 1 || entries[0]![0] !== 'node_modules/@parity/product-lab' || (entries[0]![1] as { version: string }).version !== '0.4.0') throw Error('Expected exactly one root product-lab 0.4.0 entry');
if (!read('lab/package.json').private) throw Error('The root lab workspace must stay private');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(join(repositoryRoot, path))).digest('hex');
const upstream = read('apps/humanity-app/lab/flows/UPSTREAM.json');
for (const file of [...upstream.files, ...upstream.localPorts]) if (sha256(file.destination) !== file.sha256) throw Error(`Vendored digest differs: ${file.destination}`);
for (const patch of read('patches/humanity-jollity-scarcity-e2e/manifest.json').patches) {
  if (sha256(patch.destination) !== patch.destinationSha256 || sha256(`patches/humanity-jollity-scarcity-e2e/${patch.file}`) !== patch.sha256) throw Error('Patch provenance differs');
}
// Humanity (and the cross-app lab, which reads Humanity's lock) moved to 0.31.0, the first release with trinity-user-agents#1974.
for (const [product, version] of [['humanity', '0.31.0'], ['jollity', '0.27.0']]) if (read(`apps/${product}-app/lab/opening/host.lock.json`).official.version !== version) throw Error(`The qualified ${product} CLI host pin changed`);
for (const args of [['check', '--config', 'lab.config.ts'], ['lint', '--config', 'lab.config.ts'], ['check', '--config', 'lab/cross-app/lab.cross-app.config.ts'], ['lint', '--config', 'lab/cross-app/lab.cross-app.config.ts']]) {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'node_modules/.bin/product-lab'), ...args], { cwd: repositoryRoot, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) throw Error(`product-lab ${args[0]} failed`);
}
for (const name of ['humanity-scenarios', 'humanity-flow', 'humanity-opening', 'jollity-opening', 'jollity-scenarios', 'cross-app']) {
  const directory = join(repositoryRoot, '.product-lab', 'root-check-plans', name);
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'node_modules/.bin/product-lab'), 'test', '--config', 'lab.config.ts', '--dry-run', '--report-dir', directory], {
    cwd: repositoryRoot, env: { ...process.env, PRODUCT_LAB_LAB: name }, stdio: 'inherit',
  });
  if (result.status !== 0) throw Error(`Root ${name} plan failed`);
  const report = JSON.parse(readFileSync(join(directory, 'product-lab-test.json'), 'utf8')) as Array<{ elements?: Array<{ type?: string; steps?: Array<{ result?: { status?: string } }> }> }>;
  const scenarios = report.flatMap(feature => feature.elements ?? []).filter(element => element.type === 'scenario');
  if (!scenarios.length || scenarios.some(scenario => scenario.steps?.some(step => ['undefined', 'ambiguous'].includes(step.result?.status ?? '')))) throw Error(`Root ${name} has missing scenarios or bindings`);
  console.log(`Root ${name}: ${scenarios.length} scenario(s) planned; no scenario executed.`);
}
console.log('Root lab checks passed: one 0.4.0 entry, private workspace, sealed provenance, CLI hosts (Humanity 0.31.0, Jollity 0.27.0) and lab plans.');
