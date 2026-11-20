// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { it, expect } from 'vitest';
import { parse } from 'yaml';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sourceBuildEnvironment, sourceBuildCommands, assertHumanityDebugPanel } from '../../../../lab/shared/build.ts';
const root = new URL('../../../../',import.meta.url);
const read = (name:string) => readFileSync(new URL(name,root),'utf8');
// Humanity's staging deploy is not in this repository yet; this comparison runs again once it is.
it.skipIf(!existsSync(new URL('.github/workflows/humanity-deploy.yml', root)))('keeps the required Humanity production flags equal to staging', () => {
  const staging = parse(read('.github/workflows/humanity-deploy.yml')).env;
  for (const key of ['VITE_DEBUG_PANEL','VITE_LOG_LEVEL'] as const) expect(sourceBuildEnvironment[key]).toBe(staging[key]);
});
it('builds DIM2 with the same plain command and compiler as staging', () => {
  const deploy = parse(read('.github/workflows/deploy.yml'));
  const steps = Object.values(deploy.jobs).flatMap(job => (job as {steps?:Array<{name?:string;run?:string}>}).steps ?? []);
  const build = steps.find(step => step.name === 'Build the app')!;
  const dim2 = sourceBuildCommands[1];
  expect([dim2.command,...dim2.args].join(' ')).toBe(build.run);
  expect(JSON.parse(read('package.json')).scripts.build).toBe('npm run build -w @jollity/app');
  expect(JSON.parse(read('apps/jollity-app/package.json')).scripts.build).toBe('next build');
});
it('@negative-control: refuses a production bundle without its required panel', () => {
  const directory = mkdtempSync(join(tmpdir(),'flow-build-contract-'));
  try {
    mkdirSync(join(directory,'assets')); const script=join(directory,'assets','app.js');
    writeFileSync(script,'const home = "Humanity";');
    expect(()=>assertHumanityDebugPanel(directory)).toThrow(/no debug panel/);
    writeFileSync(script,'const panel = { id: "debug-panel" };');
    expect(()=>assertHumanityDebugPanel(directory)).not.toThrow();
  } finally {rmSync(directory,{recursive:true,force:true});}
});
