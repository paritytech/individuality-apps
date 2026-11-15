// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export const localEnv = {
  NEXT_PUBLIC_NETWORK_NAME: "local",
  NEXT_PUBLIC_PEOPLE_WS: "ws://127.0.0.1:9944",
  NEXT_PUBLIC_PEOPLE_GENESIS: `0x${"12".repeat(32)}`,
  NEXT_PUBLIC_ASSET_HUB_WS: "ws://127.0.0.1:9945",
  NEXT_PUBLIC_ASSET_HUB_GENESIS: `0x${"34".repeat(32)}`,
  NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: "http://localhost:8080",
  NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: "17,18",
}
