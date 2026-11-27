// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export function selectDemos(recordings: unknown[], options?: { failed?: boolean; journeyStatus?: string }): Array<{ id: string; actor: string; role: string; data: unknown; streams: unknown[]; failed: boolean }>;
export function videoSegments(job: unknown): Array<{ file: string; start: number; end: number; offsetMs: number; durationMs: number }>;
export function cutDemos(options: { runsDir: string; out: string; workDir: string; failed?: boolean; plan?: boolean }, run?: unknown): { demos: unknown[]; errors: string[]; skipped: string[] };
