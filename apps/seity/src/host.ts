// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The one place Seity imports `@parity/product-sdk/host`.
 *
 * The host module keeps a module-level TruAPI client. Two bundled copies of it
 * make the webview's MessagePort handlers clobber each other, so every module
 * goes through here. Humanity has the same rule
 * (`packages/humanity-shared/src/chain/host-api.ts`), and
 * `getPreimageManager` is the one entry point it would add for profiles.
 */
export {
  getAccountsProvider,
  getPreimageManager,
  type AccountsProvider,
  type PreimageManager,
  type ProductAccount,
} from "@parity/product-sdk/host";
