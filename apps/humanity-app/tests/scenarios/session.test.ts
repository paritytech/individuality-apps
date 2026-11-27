// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionContext } from '@parity/product-lab';
import { paseoCopy, serveApp } from '@parity/product-lab/composition';
import { engineRoutes, validateEngineSession } from '@parity/product-lab/env-engine';
import { humanityScenarioSessions, scenario } from '../../../../lab/shared/session.ts';

vi.mock('@parity/product-lab/composition', async original => ({
  ...await original<object>(), serveApp: vi.fn(async () => ({ stop: vi.fn() })),
}));
vi.mock('@parity/product-lab/host-truapi-cli', () => ({
  truapiCliHost: vi.fn(() => ({ dispose: vi.fn() })),
  truapiCliProvisioner: vi.fn(() => ({ provision: vi.fn(async () => { throw Error('offline fixture: no provisioning'); }) })),
}));
vi.mock('@parity/product-lab/chain-papi', () => ({ PapiChainAccess: { connect: vi.fn(() => ({ close: vi.fn() })) } }));
vi.mock('../../../../lab/shared/upstream/lab/steps/games/chain.ts', () => ({ connectGamesPeople: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock('../../../../lab/shared/upstream/lab/chain/people.ts', () => ({ peopleTransactions: vi.fn(() => ({})) }));
vi.mock('../../../../lab/shared/network.ts', async () => {
  const { ConsoleHistory } = await import('../../../../lab/shared/console-history.ts');
  return { ScenarioNetwork: class { launch = vi.fn(async () => ({ close: vi.fn() })); consoleHistory = new ConsoleHistory(); forActor = vi.fn(); } };
});
beforeEach(() => vi.clearAllMocks());

function fixture(local: boolean | undefined) {
  const root = mkdtempSync(join(process.cwd(), '.scenario-session-'));
  const chain = (port: number) => ({ ws: `ws://127.0.0.1:${port}`, genesis: '0x' + (port % 256).toString(16).padStart(2, '0').repeat(32),
    initialFinalized: { hash: 'h1', number: '1' }, finalized: { hash: 'h2', number: '2' },
    runtime: { specName: 'offline', specVersion: 1, transactionVersion: 1 }, codeHash: '0x' + '22'.repeat(32), observedAt: '2026-11-05T00:00:00Z' });
  const saved = validateEngineSession({ schemaVersion: 1, runId: '11111111-1111-1111-1111-111111111111',
    network: 'paseo-next-v2', namespace: 'paseo', ownership: 'owned', mode: 'fork', createdAt: '2026-11-05T00:00:00Z',
    identityBackend: 'http://127.0.0.1:27013', engine: { dashboard: 'http://127.0.0.1:27014',
      spawn: { spawnedAt: '2026-11-05T00:00:00Z', network: 'paseo-next-v2', mode: 'fork' } },
    chains: { people: chain(27010), 'asset-hub': chain(27011), bulletin: chain(27012) } });
  writeFileSync(join(root, 'session.json'), JSON.stringify(saved));
  // 0.1.0 saved-fork.js:258-291 returns routes/provenance but no offer.
  const environment: SessionContext['environment'] = {
    routes: engineRoutes(saved), endpoints: { people: saved.chains.people.ws, 'asset-hub': saved.chains['asset-hub'].ws, bulletin: saved.chains.bulletin.ws },
    provenance: { workspace: { directory: root } }, close: vi.fn(async () => undefined),
  };
  // Use the real provider declaration, without starting it. start-lab-environment.js:117,
  // :177-181 resolves running.offer ?? provider.offer and passes it beside environment.
  const provider = paseoCopy({ cacheDir: join(root, 'unused-cache') })['paseo-copy']!;
  const offer = environment.offer ?? provider.offer;
  const context: SessionContext = {
    signal: new AbortController().signal, environmentId: 'paseo-copy', environment,
    // Undefined intentionally probes a malformed runtime offer; it must fail closed.
    offer: (local === true ? offer : { ...offer, local }) as SessionContext['offer'], root, apps: {}, unavailable: [], hosts: {},
    hostRegistry: {} as SessionContext['hostRegistry'], services: {} as SessionContext['services'], secrets: {} as SessionContext['secrets'],
    sessionPorts: { from: 28000, to: 28099, source: 'declared', note: 'offline fixture' },
    system: { processes: { open: () => ({ close: vi.fn(), stopAll: vi.fn() }) }, commands: {},
      ports: { reserve: vi.fn(async () => 28001) }, locks: {}, appProxies: {} } as unknown as SessionContext['system'],
    browsers: { launch: vi.fn(async () => ({ close: vi.fn() })) } as unknown as SessionContext['browsers'],
  };
  return { context, root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

it('admits the owned Paseo copy with the provider offer on context and no running offer', async () => {
  const f = fixture(true);
  try {
    expect(f.context.environment).not.toHaveProperty('offer');
    expect(f.context.offer.local).toBe(true);
    const session = await humanityScenarioSessions(f.context);
    try {
      expect(serveApp).toHaveBeenCalledOnce();
      expect(scenario().chain.target.offer).toMatchObject(f.context.offer);
      expect(scenario().chain.target.humanity?.network.kind).toBe('owned');
      expect(session.actors()).toEqual([]);
    } finally { await session.close(); }
    expect(() => scenario()).toThrow('No owned Humanity scenario session');
  } finally { f.remove(); }
});

it.each([false, undefined])('refuses a context offer with local=%s rather than assuming local', async local => {
  const f = fixture(local);
  try {
    await expect(humanityScenarioSessions(f.context)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Humanity scenarios require an owned local chain' })],
    });
    expect(serveApp).not.toHaveBeenCalled();
  } finally { f.remove(); }
});

it('starts each new Ada with an empty console history, so a failed step never shows an earlier Ada\'s lines', async () => {
  const f = fixture(true);
  try {
    const session = await humanityScenarioSessions(f.context);
    try {
      const { network } = scenario();
      // Provisioning is offline here, so each create stops right after it has chosen the next Ada.
      await expect(session.createActor!({ name: 'Ada' })).rejects.toThrow('offline fixture: no provisioning');
      network.consoleHistory.record('ada-1', 'context-1/page-1', 'error', 'ada-1 failed to claim');
      expect(network.consoleHistory.evidence()).toHaveLength(1);
      await expect(session.createActor!({ name: 'Ada' })).rejects.toThrow('offline fixture: no provisioning');
      expect(network.forActor).toHaveBeenLastCalledWith('ada-2');
      expect(network.consoleHistory.evidence()).toEqual([]);
    } finally { await session.close(); }
  } finally { f.remove(); }
});
