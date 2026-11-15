// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Single facade over `@parity/product-sdk/host`. Every Humanity module
 * imports host primitives through here, never `@parity/product-sdk/host`
 * directly: the SDK owns a module-level cached TruAPI client, and bundling
 * multiple physical copies makes the Desktop webview `MessagePort` handlers
 * clobber each other and drop handshake responses. For the same reason the
 * workspace resolves a single `@parity/truapi` copy, shared with
 * `@parity/product-sdk-host`: the username claim's proof is signed on the
 * `getTruApi` client directly.
 *
 * The handle-returning entry points are traced (`host-call-log.ts`): every
 * call made through a handle obtained here shows up in the debug panel's
 * truAPI section with its outcome. The handles themselves are untouched —
 * the proxy only listens.
 */
import * as sdk from "@parity/product-sdk/host";
import * as localStorageSdk from "@parity/product-sdk/local-storage";

import { traceHostCall, traceHostObject } from "./host-call-log.ts";

export {
  ChainNotSupportedError,
  findRingVrfKeyHandle,
  formatHostError,
  HostCallFailedError,
  fromHex,
  isInsideContainerSync,
  newPaymentId,
  toHex,
  type AccountsProvider,
  type ChatBotRegistrationResult,
  type ChatManager,
  type ChatMessageContent,
  type ChatRoomRegistrationResult,
  type ContextualAlias,
  type DevicePermissionKind,
  type HexString,
  type HostPaymentBalanceSubscribeItem,
  type HostSubscription,
  type NotificationManager,
  type PaymentManager,
  type PaymentTopUpSource,
  type ProductAccount,
  type ProductProofContext,
  type PushNotificationInput,
  type RegisteredRingVrfKey,
  type RingLocation,
  type RingVRFProof,
  type RingVrfKeyHandle,
  type ThemeMode,
  type TruApi,
} from "@parity/product-sdk/host";
export type {
  LocalKvStore,
  LocalKvStoreOptions,
} from "@parity/product-sdk/local-storage";
export type { HostLocalStorage } from "@parity/product-sdk/host";

function traced<T extends object>(prefix: string, handle: T | null): T | null {
  return handle == null ? null : traceHostObject(prefix, handle);
}

/** The PAPI 3 transaction creator the host signs a product account's transactions with. */
export type ProductAccountSigner = ReturnType<sdk.AccountsProvider["getProductAccountSigner"]>;

export const getAccountsProvider: typeof sdk.getAccountsProvider = () =>
  traceHostCall("host.getAccountsProvider", () => sdk.getAccountsProvider()).then((provider) =>
    traced("accounts", provider),
  );

export const getTruApi: typeof sdk.getTruApi = (...args) =>
  traceHostCall("host.getTruApi", () => sdk.getTruApi(...args), args).then((truApi) =>
    traced("truApi", truApi),
  );

export const getPaymentManager: typeof sdk.getPaymentManager = () =>
  traceHostCall("host.getPaymentManager", () => sdk.getPaymentManager()).then((payments) =>
    traced("payment", payments),
  );

export const getHostProvider: typeof sdk.getHostProvider = (...args) =>
  traceHostCall("host.getHostProvider", () => sdk.getHostProvider(...args), args);

export const navigateTo: typeof sdk.navigateTo = (...args) =>
  traceHostCall("host.navigateTo", () => sdk.navigateTo(...args), args);

/** This product's raw host storage (unprefixed keys), the one other products
 *  read through a `trustedProducts` storage grant; null outside a host. */
export const getHostLocalStorage: typeof sdk.getHostLocalStorage = () =>
  traceHostCall("host.getHostLocalStorage", () => sdk.getHostLocalStorage()).then((storage) =>
    traced("hostLocalStorage", storage),
  );

export const createLocalKvStore: typeof localStorageSdk.createLocalKvStore = (...args) =>
  traceHostCall("host.createLocalKvStore", () => localStorageSdk.createLocalKvStore(...args)).then(
    (store) => traceHostObject("localStorage", store),
  );

export const getNotificationManager: typeof sdk.getNotificationManager = () =>
  traceHostCall("host.getNotificationManager", () => sdk.getNotificationManager()).then(
    (notifications) => traced("notifications", notifications),
  );

export const getChatManager: typeof sdk.getChatManager = () =>
  traceHostCall("host.getChatManager", () => sdk.getChatManager()).then((chat) =>
    traced("chat", chat),
  );

export const getPocketManager: typeof sdk.getPocketManager = () =>
  traceHostCall("host.getPocketManager", () => sdk.getPocketManager()).then((pocket) =>
    traced("pocket", pocket),
  );

export const requestDevicePermission: typeof sdk.requestDevicePermission = (...args) =>
  traceHostCall("host.requestDevicePermission", () => sdk.requestDevicePermission(...args), args);

export const getThemeProvider: typeof sdk.getThemeProvider = () =>
  traceHostCall("host.getThemeProvider", () => sdk.getThemeProvider()).then((theme) =>
    traced("theme", theme),
  );
