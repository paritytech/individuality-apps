// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Build each distinct app variant once, then verify the exact commit and bytes on every consuming runner.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHumanityDebugPanel, sourceBuildEnvironment } from '../shared/build.ts';
import type { AppDevServerDeclaration } from '@parity/product-lab/domain/apps';
export const repository = resolve(fileURLToPath(new URL("../../", import.meta.url))), appRoot = resolve(repository, "apps/humanity-app");
export function commit() {
  const r = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) throw Error('Cannot observe build commit');
  return r.stdout.trim();
}
export function buildFiles(at: string): string[] { return readdirSync(at, { withFileTypes: true }).flatMap(e => e.isDirectory() ? buildFiles(join(at, e.name)) : [join(at, e.name)]).sort(); }
export function hashes(directory: string) {
  return Object.fromEntries(buildFiles(directory).filter(p => relative(directory, p) !== 'build.json').map(p => [relative(directory, p), createHash('sha256').update(readFileSync(p)).digest('hex')]));
}
export function verifyBuild(directory: string, expected = commit()) {
  const manifest = JSON.parse(readFileSync(join(directory, 'build.json'), 'utf8'));
  if (manifest.commit !== expected) throw Error('Built apps belong to another commit');
  if (JSON.stringify(hashes(directory)) !== JSON.stringify(manifest.files)) throw Error('Built app bytes differ from the shared build');
  for (const entry of ['humanity/index.html', 'jollity/index.html']) if (!existsSync(join(directory, entry))) throw Error('Shared build is missing an app');
}
export function buildApps(directory: string) {
  if (existsSync(directory)) throw Error('Shared app build output already exists');
  mkdirSync(directory, { recursive: true });
  const started = Date.now(), measurements: Record<string, number> = {};
  const build = (variant: string, workspace: string, environment: Record<string, string>, from: string) => {
    const at = Date.now();
    const ran = spawnSync('npm', ['run', 'build', '--workspace', workspace], { cwd: repository, env: { ...process.env, ...sourceBuildEnvironment, ...environment }, stdio: 'inherit' });
    if (ran.status !== 0) throw Error(`Shared ${variant} build failed`);
    cpSync(join(repository, from), join(directory, variant), { recursive: true });
    measurements[variant] = (Date.now() - at) / 1000;
  };
  build('humanity', '@humanity/app', {}, 'apps/humanity-app/dist');
  assertHumanityDebugPanel(join(directory, 'humanity'));
  build('jollity', '@jollity/app', { NEXT_PUBLIC_VERSION_URL: 'http://127.0.0.1:49791/version.json', NEXT_PUBLIC_APP_VERSION: 'cross-app-update-lab', NEXT_PUBLIC_BUILD_TIME: '1' }, 'apps/jollity-app/out');
  writeFileSync(join(directory, 'build.json'), JSON.stringify({ commit: commit(), seconds: (Date.now() - started) / 1000, measurements, files: hashes(directory) }, null, 2) + '\n');
}
export function installBuild(directory: string) {
  verifyBuild(directory);
  rmSync(join(appRoot, 'dist'), { recursive: true, force: true });
  rmSync(join(repository, 'apps/jollity-app/out'), { recursive: true, force: true });
  cpSync(join(directory, 'humanity'), join(appRoot, 'dist'), { recursive: true });
  cpSync(join(directory, 'jollity'), join(repository, 'apps/jollity-app/out'), { recursive: true });
}
/** Only the cross-app CLI process replaces the scenario's dev-server declaration, before loading its config.
 * Ordinary scenario commands still use Vite. Both modes keep the same serveApp proxy and real app bytes. */
export function useBuiltHumanity(declaration: object, built: AppDevServerDeclaration) {
  for (const key of Object.keys(declaration)) Reflect.deleteProperty(declaration, key);
  Object.assign(declaration, built);
}
