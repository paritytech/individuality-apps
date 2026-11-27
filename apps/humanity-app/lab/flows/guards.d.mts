// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface View { markers: Array<{ id: string; attrs: Record<string,string> }>; buttons: Array<{ disabled: boolean; text: string; aria: string }>; card?: { status?: string }; text: string }
export interface Source { actor: string; account?: string; via: string }
export function cardReady(card: View): boolean;
export function cardState(card: View): string | null;
export function firstAppFailure(text: string, source?: Source): string | null;
export function holdBindRetries(hold: ((entry: unknown, source?: Source) => boolean) | null): void;
export function bindRetryWatch(options: { readAlias(account: string): Promise<{ value: unknown; readAt: number; block: unknown; key?: unknown; raw?: unknown }>; aliasContext: string; record(value: unknown): void; accountFor(actor: string): string | undefined; signal?: AbortSignal; now?: () => number; wait?: (ms: number) => Promise<void>; pollMs?: number; windowMs?: number }): { hold(entry: unknown, source?: Source): boolean; observe(text: string, source: Source): void; overdue(): void; idle(): Promise<void> };
