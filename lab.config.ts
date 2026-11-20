// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The repository root stays CommonJS. Load the ESM lab graph asynchronously so
// Cucumber's child process uses the SDK's import-only package exports too.
export default async function rootLab() {
  const { selectLab } = await import('./lab/select.ts');
  return selectLab();
}
