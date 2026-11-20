// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom
/** A hook integration proof only: a record delivered by host storage changes the real
 * page assembly and current-game query together. This does not qualify a host's storage grant. */
import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GameRegistration } from '@individuality/shared-records';

const state = vi.hoisted(() => ({
  record: null as GameRegistration | null,
  queries: [] as Array<{ queryKey: unknown[]; refetchInterval: number }>,
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (query: { queryKey: unknown[]; refetchInterval: number }) => {
    state.queries.push(query);
    return { data: query.queryKey[0] === 'host' ? state.record : undefined,
      error: null, isPending: false, dataUpdatedAt: Date.now(), errorUpdatedAt: 0 };
  },
}));
vi.mock('@features/card/hooks/use-humanity-card.ts', () => ({
  useHumanityCard: () => ({ data: { kind: 'card', playerIdentities: { accountAddress: '5Candidate' },
    snapshot: { membershipRing: null } }, error: null, isPending: false }),
}));
vi.mock('@features/debug/use-debug-card-override.ts', () => ({ useDebugCardOverride: <T,>(value: T) => value }));
vi.mock('@features/airdrops/hooks/use-airdrop-standing.ts', () => ({
  useAirdropStanding: () => ({ data: undefined, error: null, isPending: false }),
}));
vi.mock('@features/airdrops/hooks/use-auto-register-draws.ts', () => ({ useAutoRegisterDraws: () => ({}) }));
vi.mock('@humanity/shared/logging/logger.ts', () => ({ loggerFor: () => ({ debug: vi.fn() }) }));

import { useAirdropPrizePageData } from '@features/prize/hooks/use-airdrop-prize-page.ts';

afterEach(() => { state.record = null; state.queries.length = 0; });

it.each(['registering', 'sent', 'registered'] as const)('uses 3 s reads for Jollity app phase %s', phase => {
  state.record = { gameIndex: 1, phase, surface: 'app', at: Date.now(), attempt: 1 };
  renderHook(() => useAirdropPrizePageData(true));
  expect(state.queries.find(q => q.queryKey[0] === 'host')?.refetchInterval).toBe(2_000);
  expect(state.queries.find(q => q.queryKey[1] === 'current-game')?.refetchInterval).toBe(3_000);
});

it.each(['absent', 'failed'] as const)('negative control: keeps 30 s reads when the record is %s', kind => {
  state.record = kind === 'failed' ? { gameIndex: 1, phase: 'failed', surface: 'app', at: Date.now(), attempt: 1 } : null;
  renderHook(() => useAirdropPrizePageData(true));
  expect(state.queries.find(q => q.queryKey[1] === 'current-game')?.refetchInterval).toBe(30_000);
});
