// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { PageFrameCapture } from '@parity/product-lab/browser-playwright';
import { FlowCapture } from '../../lab/flows/recording.ts';

it('the actual createSession and create methods record actor timing and all six page-video descriptors', async () => {
  const text = readFileSync(new URL('../../lab/flows/session.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('session.ts', text, ts.ScriptTarget.Latest, true);
  const methods = new Map<string, ts.MethodDeclaration[]>();
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name) {
      const name = node.name.getText(source);
      methods.set(name, [...(methods.get(name) ?? []), node]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const base = mkdtempSync(join(tmpdir(), 'flow-session-capture-'));
  try {
    const capture = new FlowCapture(base), file = join(base, 'flow-capture.json');
    const identities = new Map<string, { game: string }>(), pages = new Map(), appUrls = new Map();
    const actors: Array<{ id: string; name: string }> = [], sessions: unknown[] = [], cleanups: unknown[] = [];
    let clock = 1000, port = 29901;
    const names = ['Alice', 'Bob', 'Carol'];
    type Actor = { id: string; name: string; identity?: unknown };
    type Request = { actor: Actor; app: { id: string } };
    const navigation = { open: async (_actor: Actor, _app: string, _path: string) => {} };
    const scope = { capture, PageFrameCapture, join, identities, pages, appUrls, actors, sessions, cleanups, names, navigation,
      context: { root: base }, routes: {}, environment: { endpoints: {} }, signal: new AbortController().signal,
      processes: {}, range: { from: 29901, to: 29999 }, system: { appProxies: {}, ports: { reserve: async () => port++ } },
      Date: { now: () => clock++ }, selectedHost: { sha256: 'offline-host' }, hostActors: new Map(),
      sourceAppDeclarations: () => ({ peopl: {}, dim2: {} }), plainAppUrl: (url: string) => url,
      serveApp: async (options: { ports: { devServer: number } }) => ({ url: `http://127.0.0.1:${options.ports.devServer}/`, proxy: { bridge: () => {} }, stop: async () => {} }),
      watchNavigations: async function* () {},
      baseProvider: { createSession: async (request: Request) => ({ ...request, evidence: { runDir: base }, stop: async () => {},
        page: async () => ({ recordedVideo: async () => ({ name: `page@${request.actor.id}-${request.app.id}.webm`, openedAt: 2000 + names.indexOf(request.actor.name) * 100 + (request.app.id === 'dim2' ? 1000 : 0) }) }),
        account: async () => ({ address: identities.get(request.actor.id)!.game }),
      }) },
      provisioner: { provision: async ({ actor }: { actor: Actor }) => {
        expect(existsSync(file), 'actorStarted must persist before provisioning begins').toBe(true);
        expect(JSON.parse(readFileSync(file, 'utf8')).actorsStartedAt).toBe(1000);
        return { entropy: new Uint8Array(32), liteUsername: actor.name, evidence: { identityAddress: 'offline' } };
      }, host: async () => ({ binarySha256: 'offline-host' }) },
      Sr25519ProductAccounts: class { productAccount(_entropy: Uint8Array, app: string, index: number) { return { address: `${app}-${index}` }; } },
      flowActorSession: (actor: { id: string; name: string }) => actor,
    };
    function bind(name: string) {
      expect(methods.get(name), `one actual ${name} method must be present`).toHaveLength(1);
      const method = methods.get(name)![0]!;
      const javascript = ts.transpileModule(`({ ${method.getText(source)} })`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
      return new Function(...Object.keys(scope), `return ${javascript}`)(...Object.values(scope))[name] as (request: unknown) => Promise<unknown>;
    }
    const createSession = bind('createSession');
    navigation.open = async (actor, app) => { await createSession({ actor, app: { id: app } }); };
    const create = bind('create');
    for (const name of names) {
      const actor = await create(name) as Actor;
      expect(actor.id).toBe(name.toLowerCase());
      await createSession({ actor, app: { id: 'dim2' } });
    }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data.actorsStartedAt).toBe(1000);
    expect(data.actorsFinishedAt, 'actorReady must persist after all actor creations').toBe(1005);
    expect(data.videos).toHaveLength(6);
    for (const [index, name] of names.entries()) for (const app of ['peopl', 'dim2']) {
      expect(data.videos).toContainEqual({ actor: name.toLowerCase(), app, file: `videos/page@${name.toLowerCase()}-${app}.webm`,
        openedAt: 2000 + index * 100 + (app === 'dim2' ? 1000 : 0), mediaType: 'video/webm', source: 'headless-page' });
    }
    expect(sessions).toHaveLength(6);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
