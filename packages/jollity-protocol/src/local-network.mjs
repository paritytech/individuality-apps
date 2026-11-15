// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Validate the complete local configuration at build time and at runtime. */
export function resolveLocalNetwork(env) {
  const required = (name) => {
    const value = env[name]?.trim() ?? ""
    if (!value) throw new Error(`${name} is required when NEXT_PUBLIC_NETWORK_NAME=local`)
    return value
  }
  const url = (name, protocols) => {
    const value = required(name)
    let parsed
    try { parsed = new URL(value) } catch { /* reported below */ }
    if (!parsed || !protocols.includes(parsed.protocol) || !value.startsWith(`${parsed.protocol}//`) ||
        !parsed.hostname || parsed.username || parsed.password || /\s/.test(value) || value.includes("#")) {
      throw new Error(`${name} must be a valid ${protocols.join(" or ")} URL without credentials or a fragment`)
    }
    return value
  }
  const hash = (name) => {
    const value = required(name)
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be 0x followed by 64 hexadecimal characters`)
    return value.toLowerCase()
  }
  const people = url("NEXT_PUBLIC_PEOPLE_WS", ["ws:", "wss:"])
  const peopleGenesis = hash("NEXT_PUBLIC_PEOPLE_GENESIS")
  const assetHub = url("NEXT_PUBLIC_ASSET_HUB_WS", ["ws:", "wss:"])
  const assetHubGenesis = hash("NEXT_PUBLIC_ASSET_HUB_GENESIS")
  const backend = url("NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL", ["http:", "https:"])
  const name = "NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS"
  const ids = required(name).split(",").map((part) => part.trim())
  if (ids.some((id) => !/^(0|[1-9][0-9]*)$/.test(id) || Number(id) > 0xffffffff)) {
    throw new Error(`${name} must be a comma-separated list of unsigned 32-bit collection ids`)
  }
  return {
    dotnsTLD: "testnet",
    productAccount: "dim2",
    deviceUniquenessBackendUrl: backend.replace(/\/$/, ""),
    genesis: { people: peopleGenesis, hubNextV2: assetHubGenesis },
    endpoints: { people, assetHub },
    approvedCollections: [...new Set(ids.map(Number))],
  }
}
