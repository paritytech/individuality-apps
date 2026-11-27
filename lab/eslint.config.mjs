// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import config from '../apps/humanity-app/eslint.config.mjs';
export default [...config, { files: ['**/*.ts', '**/*.mts'], languageOptions: config[1].languageOptions, plugins: config[1].plugins, rules: config[1].rules }, { files: ['shared/upstream/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } }];
