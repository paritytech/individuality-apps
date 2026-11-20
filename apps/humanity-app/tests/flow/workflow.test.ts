// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sourceBuildCommands, sourceBuildEnvironment } from '../../../../lab/shared/build.ts';
const root = new URL('../../../../', import.meta.url);
const text = (path: string) => readFileSync(new URL(path, root), 'utf8');
const workflow = text('.github/workflows/humanity-dim2-flow.yml'), runner = text('apps/humanity-app/scripts/lab/flow.mts');
const group = "humanity-dim2-flow-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.event_name == 'push' && 'main' || format('dispatch-{0}', github.ref) }}";
type Build = { command: string; args: readonly string[] };
function properties(yaml: string, script = runner, builds: readonly Build[] = sourceBuildCommands, buildEnv: Record<string,string> = sourceBuildEnvironment) {
  const w = parse(yaml), steps = w.jobs.flow.steps as Array<{name?:string; id?:string; uses?:string; run?:string; if?:string; env?:Record<string,string>; with?:Record<string,unknown>; 'timeout-minutes'?:number}>;
  const trigger = Object.keys(w.on).sort().join(',') === 'pull_request,push,workflow_dispatch' && JSON.stringify(w.on.push) === JSON.stringify({branches:['main']}) && JSON.stringify(w.on.pull_request) === JSON.stringify({branches:['main'],types:['labeled','synchronize','reopened','opened']});
  const coalescing = !w.concurrency && [w.jobs.sources, w.jobs.flow].every(job => JSON.stringify(job.concurrency) === JSON.stringify({group, 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}"}));
  const isolation = Object.keys(w.jobs).length === 3 && JSON.stringify(w.jobs.flow.needs) === '["sources"]' && w.jobs.flow.if.includes("!cancelled()") &&
    w.permissions.contents === 'read' && w.jobs.flow['runs-on'] === "${{ vars.DIM2_FLOW_RUNNER || 'ubuntu-24.04' }}" && w.jobs.flow['timeout-minutes'] === 120;
  const noCache = !/actions\/cache|release-cid-|\bcache\s*:/i.test(yaml) && w.jobs.flow.env.PRODUCT_LAB_FORK_BUNDLE === 'fresh' && script.includes('process.env.PRODUCT_LAB_FORK_BUNDLE = "fresh";');
  const bothSource = JSON.stringify(builds) === JSON.stringify([{command:'npm',args:['run','humanity:build']},{command:'npm',args:['run','build']}]) &&
    script.includes('for (const build of sourceBuildCommands) await command(') &&
    script.includes('apps: { peopl: { mode: "source", ...source }, dim2: { mode: "source", ...source } }') &&
    steps.some(s => s.run?.includes('npm run --workspace @humanity/app humanity:e2e:flow -- --fresh'));
  // Humanity's staging deploy is not in this repository yet: until it is, the flags must at least be set.
  const staging = existsSync(new URL('.github/workflows/humanity-deploy.yml', root)) ? parse(text('.github/workflows/humanity-deploy.yml')).env : undefined;
  const stagingFlags = ['VITE_DEBUG_PANEL','VITE_LOG_LEVEL'].every(key => staging ? buildEnv[key] === staging[key] : Boolean(buildEnv[key])) &&
    script.includes('Object.assign(process.env, sourceBuildEnvironment);') && script.includes('assertHumanityDebugPanel(join(app, "dist"));');
  const retained = steps.filter(s => s.uses?.startsWith('actions/upload-artifact@'));
  const evidence = retained.length === 3 && retained.every(s => s.if === 'always()' && s.with?.['retention-days'] === 14) && !/secrets\./.test(yaml) &&
    !retained.some(s => /wallet|forks|host|players/.test(String(s.with?.path)));
  const authenticated = steps.filter(s => s.env?.GH_TOKEN || s.env?.GITHUB_TOKEN);
  const tokenScope = !w.jobs.flow.env.GH_TOKEN && !w.jobs.flow.env.GITHUB_TOKEN && authenticated.length === 2 &&
    authenticated.every(s => (s.name === 'Prepare locked tooling' || s.id === 'flow') && s.env?.GH_TOKEN === '${{ github.token }}' && s.env?.GITHUB_TOKEN === '${{ github.token }}');
  const budgets = {'Install dependencies':10,'Check the flow offline':5,'Prepare locked tooling':15,'Build both apps from this commit and run the three-player journey':50,'Clean up owned processes':5,'Install demo tools when absent':5,'Cut the journey demo':15};
  const timeouts = Object.entries(budgets).every(([name,limit]) => { const minutes=steps.find(s=>s.name===name)?.['timeout-minutes']; return typeof minutes === 'number' && minutes > 0 && minutes <= limit; }) && (steps.find(s => s.id === 'flow')?.['timeout-minutes'] ?? 0) >= 40;
  return {trigger,coalescing,isolation,noCache,bothSource,stagingFlags,evidence,tokenScope,timeouts};
}
describe('merge flow workflow properties and deliberate breaks', () => {
  it('has all nine properties', () => expect(Object.values(properties(workflow))).toEqual(Array(9).fill(true)));
  const mutations: Array<[keyof ReturnType<typeof properties>, (w: string) => string]> = [
    ['trigger',w=>w.replace('  push:','  schedule:')],
    ['trigger',w=>w.replace('branches: [main]','branches: [develop]')],
    ['trigger',w=>w.replace('  workflow_dispatch:','  schedule:')],
    ['coalescing',w=>w.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}",'cancel-in-progress: false')],
    ['coalescing',w=>w.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}","cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n      queue: max")],
    ['coalescing',w=>w.replace(group,'humanity-dim2-flow')],
    ['coalescing',w=>w.replace("format('dispatch-{0}', github.ref)","'main'")],
    ['isolation',w=>w.replace('    needs: [sources]','    needs: [deploy]')],
    ['noCache',w=>w.replace('      - name: Record capacity','      - uses: actions/cache@v4\n      - name: Record capacity')],
    ['noCache',w=>w+'\n# release-cid-fake\n'],
    ['noCache',w=>w.replace('PRODUCT_LAB_FORK_BUNDLE: fresh','PRODUCT_LAB_FORK_BUNDLE: keep')],
    ['bothSource',w=>w.replaceAll('humanity:e2e:flow','released:flow')],
    ['evidence',w=>w.replace('retention-days: 14','retention-days: 90')],
    ['tokenScope',w=>w.replaceAll('GITHUB_TOKEN:','WRONG_TOKEN:')],
    ['tokenScope',w=>w.replace('      PRODUCT_LAB_FORK_BUNDLE: fresh','      GH_TOKEN: ${{ github.token }}\n      PRODUCT_LAB_FORK_BUNDLE: fresh')],
    ['timeouts',w=>w.replace('timeout-minutes: 50','timeout-minutes: 150')],
    ['timeouts',w=>w.replace('timeout-minutes: 50','timeout-minutes: 30')],
  ];
  mutations.forEach(([property,mutate],n)=>it(`@negative-control ${n+1}: catches broken ${property}`,()=>expect(properties(mutate(workflow))[property]).toBe(false)));
  it('@negative-control: catches each removed source build, webpack, and a mislabeled source', () => {
    for (let n=0;n<2;n++) expect(properties(workflow,runner,sourceBuildCommands.filter((_b,i)=>i!==n)).bothSource).toBe(false);
    expect(properties(workflow,runner,[sourceBuildCommands[0],{command:'npm',args:['run','build','--','--webpack']}]).bothSource).toBe(false);
    expect(properties(workflow,runner.replace('dim2: { mode: "source"','dim2: { mode: "released"')).bothSource).toBe(false);
  });
  it('@negative-control: catches each missing staging flag and a disabled compiled-panel check', () => {
    for (const key of ['VITE_DEBUG_PANEL','VITE_LOG_LEVEL']) {
      const broken:Record<string,string>={...sourceBuildEnvironment}; delete broken[key];
      expect(properties(workflow,runner,sourceBuildCommands,broken).stagingFlags).toBe(false);
    }
    expect(properties(workflow,runner.replace('assertHumanityDebugPanel(join(app, "dist"));','')).stagingFlags).toBe(false);
  });
  it('is consumed by no deploy or release workflow', () => {
    for (const file of readdirSync(new URL('.github/workflows/',root)).filter(f=>/\.ya?ml$/.test(f)&&f!=='humanity-dim2-flow.yml')) {
      const w=parse(text('.github/workflows/'+file));
      expect(JSON.stringify(w.on?.workflow_run??{}),file).not.toMatch(/Humanity to DIM2|humanity-dim2-flow/);
      expect(JSON.stringify(w.jobs),file).not.toMatch(/uses[^\n]*humanity-dim2-flow/);
    }
  });
  it('runs workspace offline checks on PRs into main without adding root scripts', () => {
    const ci=parse(text('.github/workflows/ci.yml')), scripts=JSON.parse(text('apps/humanity-app/package.json')).scripts;
    expect(ci.on).toHaveProperty('pull_request'); expect(ci.on.pull_request?.branches ?? ['main']).toContain('main');
    expect(JSON.stringify(ci.jobs.humanity)).toContain('humanity:lint');
    expect(JSON.stringify(ci.jobs.humanity)).toContain('npm run --workspace @humanity/app humanity:lab:check');
    expect(scripts['humanity:lab:check']).toContain('npm run humanity:flow:check');
    for (const key of ['humanity:flow:check','humanity:flow:prepare','humanity:e2e:flow']) {
      expect(scripts[key]).toContain('scripts/lab/flow.mts'); expect(JSON.parse(text('package.json')).scripts).not.toHaveProperty(key);
    }
    expect(JSON.parse(text('package.json')).scripts['humanity:lab:check']).not.toContain('flow');
  });
  it('keeps the flow tooling outside the Jollity preview bundle inputs', () => {
    const {classify}:{classify(files:string[]):{deploy:boolean}}=createRequire(import.meta.url)('../../../../scripts/ci/changes.mjs');
    expect(classify(['apps/humanity-app/package.json','apps/humanity-app/.changeset/humanity-dim2-flow.md','.github/workflows/humanity-dim2-flow.yml','lab/shared/build.ts'])).toEqual({deploy:false});
    expect(classify(['package.json'])).toEqual({deploy:true});
  });
  it('records immutable upstream sources with explicit adaptations and full paths', () => {
    const manifest=JSON.parse(text('apps/humanity-app/lab/flows/UPSTREAM.json'));
    for (const row of [...manifest.files,...manifest.localPorts]) {
      expect(createHash('sha256').update(readFileSync(fileURLToPath(new URL(row.destination,root)))).digest('hex')).toBe(row.sha256);
      if (row.sourceSha256!==row.sha256) expect(row.adaptation).toBeTruthy();
      expect(text(row.destination)).not.toMatch(/\/Users\/|\.\.\/.*e2e-worktrees/);
    }
    expect(manifest.files.every((r:{source:string})=>r.source.startsWith('suites/humanity/')||r.source.startsWith('scripts/'))).toBe(true);
    expect(manifest.landedDifferences.files).toHaveLength(3); expect(manifest.landedDifferences.renames).toHaveLength(1);
  });
});

it('records portable tool names in both wrappers without paths or command arguments', () => {
  for (const script of [runner, text('apps/humanity-app/scripts/lab/opening.mts')]) {
    const expression = script.match(/phases\.push\(\{ command: (.*), seconds:/)?.[1];
    expect(expression).toBeTruthy();
    const label = new Function('file', 'argv', `return ${expression}`);
    expect(label('node', ['/workspace/source/node_modules/.bin/product-lab', '--report-dir', '/workspace/reports'])).toBe('product-lab');
    expect(label('node', ['C:\\workspace\\node_modules\\.bin\\tsc', '-p', '/workspace/config'])).toBe('tsc');
    expect(label('npm', ['run', 'build'])).toBe('npm');
    expect(label('/workspace/bin/git', ['diff'])).toBe('git');
    expect(script).toContain('PATH node differs from the running Node version');
    expect(script).toContain('throw new Error(`${phases.at(-1)!.command} failed (${code})`)');
  }
});
