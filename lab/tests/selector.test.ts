// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { isOptionsEnvironment, type EnvironmentStartContext, type LabDefinition, type SessionContext } from '@parity/product-lab';
import humanityOpening from '../../apps/humanity-app/lab.opening.config.ts';
import humanityFlow from '../../apps/humanity-app/lab.flow.config.ts';
import jollityScenarios from '../../apps/jollity-app/lab/scenarios/config.ts';
import jollityOpening from '../../apps/jollity-app/lab.opening.config.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { labNames, selectLab } from '../select.ts';
import { repositoryRoot } from '../shared/paths.ts';

it.each(labNames)('selects %s with repository paths and the product environment/session roots', async name => {
  const config = selectLab(name);
  expect(config.features.length).toBeGreaterThan(0);
  for (const file of [...config.features, ...config.steps]) expect(existsSync(resolve(repositoryRoot, file)), file).toBe(true);
  const original = ({ 'humanity-opening': humanityOpening, 'humanity-flow': humanityFlow, 'jollity-opening': jollityOpening, 'jollity-scenarios': jollityScenarios } as Record<string, LabDefinition>)[name];
  if (!original) return;
  const root = resolve(repositoryRoot, name.startsWith('jollity-') ? 'apps/jollity-app' : 'apps/humanity-app');
  const entry = original.environments['paseo-copy'];
  if (!isOptionsEnvironment(entry)) {
    if (!('start' in entry)) throw Error('Expected a runnable copy');
    const start = vi.spyOn(entry, 'start').mockRejectedValue(Error('root probe'));
    try {
      const selected = selectLab(name).environments['paseo-copy'];
      if (!('start' in selected)) throw Error('Expected the selected copy provider');
      await expect(selected.start({ root: 'wrong-root' } as EnvironmentStartContext)).rejects.toThrow('root probe');
      expect(resolve(start.mock.calls[0]![0].root)).toBe(root);
    } finally { start.mockRestore(); }
    const sessions = vi.spyOn(original, 'sessions').mockRejectedValue(Error('root probe'));
    try {
      await expect(config.sessions({ root: 'wrong-root' } as SessionContext)).rejects.toThrow('root probe');
      expect(resolve(sessions.mock.calls[0]![0].root)).toBe(root);
    } finally { sessions.mockRestore(); }
    return;
  }
  const session = vi.spyOn(original, 'sessions').mockRejectedValue(Error('root probe'));
  try {
    for (const [index, choice] of entry.choices.entries()) {
      if (!('start' in choice.environment)) throw Error('Expected a runnable copy provider');
      const start = vi.spyOn(choice.environment, 'start').mockRejectedValue(Error('root probe'));
      try {
        const selected = selectLab(name).environments['paseo-copy'];
        if (!isOptionsEnvironment(selected)) throw Error('The selector dropped the environment choices');
        const provider = selected.choices[index]!.environment;
        if (!('start' in provider)) throw Error('The selector dropped the copy provider');
        await expect(provider.start({ root: 'wrong-root' } as EnvironmentStartContext)).rejects.toThrow('root probe');
        expect(resolve(start.mock.calls[0]![0].root)).toBe(root);
      } finally { start.mockRestore(); }
    }
    await expect(config.sessions({ root: 'wrong-root' } as SessionContext)).rejects.toThrow('root probe');
    expect(resolve(session.mock.calls[0]![0].root)).toBe(root);
  } finally { session.mockRestore(); }
});
it('defaults to Humanity scenarios and accepts the explicit shell selector', async () => {
  vi.stubEnv('PRODUCT_LAB_LAB', undefined);
  try {
    expect(selectLab().name).toBe(selectLab('humanity-scenarios').name);
    const root = await import('../../lab.config.ts');
    expect((await root.default()).name).toBe(selectLab('humanity-scenarios').name);
    vi.stubEnv('PRODUCT_LAB_LAB', 'jollity-opening');
    expect(selectLab().name).toBe(selectLab('jollity-opening').name);
  } finally { vi.unstubAllEnvs(); }
});
it('@negative-control rejects an unknown lab name and inherited object property names', () => {
  for (const name of ['missing-lab', '__proto__', 'constructor']) expect(() => selectLab(name)).toThrow('Unknown lab');
});
