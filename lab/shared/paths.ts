// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from 'node:url';
export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const humanityRoot = fileURLToPath(new URL('../../apps/humanity-app/', import.meta.url));
