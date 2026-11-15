// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Read-only DotNS resolver probe — a faithful port of `brevity_chain::dotns`
 * (brevity-dozer/core/crates/brevity-chain/src/dotns.rs).
 *
 * Answers whether a deployed name holds a contenthash, and which of the
 * `executable` / `manifest` text records it carries — the same records a
 * host reads to resolve a product. Works against any DotNS name; useful for
 * confirming a deploy actually published before trusting a gateway URL.
 *
 * The `.li` HTTPS gateway cannot answer this: it is a client-side resolver and
 * serves byte-identical HTML for registered and unregistered labels alike.
 *
 *   npm run humanity:dotns:resolve -- peopl.dot
 *   DOTNS_NET=previewnet npm run humanity:dotns:resolve -- peopl.dot
 *
 * Names are passed in canonical `.dot` spelling and re-spelled onto the
 * deployment TLD, exactly as `DotnsConfig::chain_name` does.
 */
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { blake2b } from "@noble/hashes/blake2.js";

const NETWORKS = {
  "paseo-next-v2": {
    rpc: "https://paseo-asset-hub-next-rpc.polkadot.io",
    tld: "paseo",
  },
  previewnet: {
    rpc: "https://previewnet.substrate.dev/asset-hub",
    tld: "testnet",
  },
};

const NET = process.env.DOTNS_NET ?? "paseo-next-v2";
const network = NETWORKS[NET];
if (!network) {
  console.error(
    `unknown DOTNS_NET ${NET}; expected one of ${Object.keys(NETWORKS).join(", ")}`,
  );
  process.exit(2);
}

/** DotnsContentResolver — the same address on both deployments. */
const CONTENT_RESOLVER = "7F74D7CD50f5a834270E2ad395a01b01891AB37d";
const CONTENTHASH_SLOT = 0n;
const TEXT_RECORDS_SLOT = 1n;
const TEXT_KEYS = ["manifest", "executable"];

/**
 * `twox128("Revive")` and `twox128("AccountInfoOf")`.
 *
 * Precomputed so this tool needs no xxhash64 implementation and runs under the
 * repo's plain `tsx`/node. They are constants of the Substrate storage layout,
 * not of any deployment. Verified against the live chain: they produce the
 * trie id that resolves `browse.dot`.
 */
const REVIVE_ACCOUNT_INFO_OF_PREFIX = hexToBytes(
  "735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc",
);

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const toHex = (bytes) =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

const utf8 = (text) => new TextEncoder().encode(text);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const blake2_256 = (data) => blake2b(data, { dkLen: 32 });

/** ENS-style namehash: keccak-256 per label, applied in reverse. */
function namehash(name) {
  let node = new Uint8Array(32);
  if (name === "") return node;
  for (const label of name.split(".").reverse()) {
    node = keccak_256(concat(node, keccak_256(utf8(label))));
  }
  return node;
}

function uint256(value) {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(24, value, false);
  return out;
}

/** `mapping(bytes32 => T)` at `slot`: `keccak256(key ++ uint256(slot))`. */
const mappingSlot = (key, slot) => keccak_256(concat(key, uint256(slot)));

/**
 * `mapping(bytes32 => mapping(string => T))`. Solidity hashes a `string` key as
 * RAW utf-8 — no length prefix, no padding to 32. Padding it here would read an
 * unrelated slot and report every record as unset.
 */
const nestedStringMappingSlot = (outerKey, innerKey, outerSlot) =>
  keccak_256(concat(utf8(innerKey), mappingSlot(outerKey, outerSlot)));

function addToSlot(slot, offset) {
  const bytes = Uint8Array.from(slot);
  let carry = BigInt(offset);
  for (let i = 31; i >= 0 && carry > 0n; i -= 1) {
    const sum = BigInt(bytes[i]) + (carry & 0xffn);
    bytes[i] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return bytes;
}

let requestId = 1;
async function rpc(method, params) {
  const response = await fetch(network.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function rpcStorage(method, params) {
  const result = await rpc(method, params);
  return typeof result === "string" ? hexToBytes(result) : null;
}

/** Minimal SCALE compact-length decode (trie ids are short). */
function compactLen(bytes) {
  const first = bytes[0];
  switch (first & 0b11) {
    case 0:
      return [first >> 2, 1];
    case 1:
      return [((bytes[1] << 8) | first) >> 2, 2];
    case 2:
      return [
        ((bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | first) >>> 2,
        4,
      ];
    default:
      throw new Error("oversized compact length");
  }
}

/** `Revive::AccountInfoOf[contract]` → child trie id, or null if undeployed. */
async function resolveTrieId(contract, at) {
  const key = concat(REVIVE_ACCOUNT_INFO_OF_PREFIX, hexToBytes(contract));
  const info = await rpcStorage("state_getStorage", [toHex(key), at]);
  if (!info) return null;
  // AccountInfo.account_type enum: tag 0x00 = Contract(ContractInfo);
  // ContractInfo.trie_id is its first field, a SCALE `Vec<u8>`.
  if (info[0] !== 0x00) return null;
  const rest = info.subarray(1);
  const [length, consumed] = compactLen(rest);
  return rest.subarray(consumed, consumed + length);
}

const childPrefixedKey = (trieId) =>
  concat(utf8(":child_storage:default:"), trieId);

/** One 32-byte child-trie slot (`Key::Fix` = `blake2_256(slot_key)`). */
async function readSlot(trieId, slotKey, at) {
  const value = await rpcStorage("childstate_getStorage", [
    toHex(childPrefixedKey(trieId)),
    toHex(blake2_256(slotKey)),
    at,
  ]);
  if (!value) return null;
  const word = new Uint8Array(32);
  word.set(value.subarray(0, 32));
  return word;
}

/**
 * Solidity dynamic `bytes`/`string`: short values live inline with
 * `lowest = 2 * length`; long values set the low bit and span consecutive slots
 * from `keccak256(base_slot)`.
 */
async function readDynamicBytes(trieId, baseSlot, at) {
  const word = await readSlot(trieId, baseSlot, at);
  if (!word || word.every((byte) => byte === 0)) return null;

  const lowest = word[31];
  if ((lowest & 1) === 0) {
    const length = Math.floor(lowest / 2);
    return length === 0 ? null : word.subarray(0, Math.min(length, 31));
  }

  let value = 0n;
  for (const byte of word.subarray(16)) value = (value << 8n) | BigInt(byte);
  const length = Number((value - 1n) / 2n);
  if (length === 0) return null;

  const dataSlot = keccak_256(baseSlot);
  const out = new Uint8Array(length);
  for (let offset = 0; offset * 32 < length; offset += 1) {
    const chunk = await readSlot(trieId, addToSlot(dataSlot, offset), at);
    if (!chunk) break;
    out.set(chunk.subarray(0, Math.min(32, length - offset * 32)), offset * 32);
  }
  return out;
}

/** Canonical `.dot` identity → this deployment's TLD (`chain_name`). */
const chainName = (name) =>
  name.endsWith(".dot") ? `${name.slice(0, -4)}.${network.tld}` : name;

export function assertPublicationReadback(
  results,
  expectedExecutables,
  requiredContenthashes,
) {
  const byName = new Map();
  for (const result of results) {
    if (byName.has(result.name)) {
      throw new Error(`resolver returned duplicate results for ${result.name}`);
    }
    byName.set(result.name, result);
  }

  for (const [name, expected] of expectedExecutables) {
    const result = byName.get(name);
    if (result === undefined) {
      throw new Error(`resolver did not return ${name}`);
    }
    if (result.records.executable !== expected) {
      throw new Error(`executable readback did not match for ${name}`);
    }
  }

  for (const name of requiredContenthashes) {
    const result = byName.get(name);
    if (result === undefined || result.contenthash === null) {
      throw new Error(`contenthash readback is missing for ${name}`);
    }
  }
}

function parseArgs(argv) {
  const names = [];
  const expectedExecutables = new Map();
  const requiredContenthashes = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--expect-executable") {
      const name = argv[index + 1];
      const value = argv[index + 2];
      if (name === undefined || value === undefined) {
        throw new Error("--expect-executable requires <name.dot> <value>");
      }
      if (expectedExecutables.has(name)) {
        throw new Error(`duplicate executable expectation for ${name}`);
      }
      expectedExecutables.set(name, value);
      index += 2;
      continue;
    }
    if (argument === "--require-contenthash") {
      const name = argv[index + 1];
      if (name === undefined) {
        throw new Error("--require-contenthash requires <name.dot>");
      }
      requiredContenthashes.add(name);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    }
    names.push(argument);
  }

  return { names, expectedExecutables, requiredContenthashes };
}

async function probe(name, trieId, at) {
  const node = namehash(chainName(name));
  const contenthash = await readDynamicBytes(
    trieId,
    mappingSlot(node, CONTENTHASH_SLOT),
    at,
  );

  const records = {};
  for (const key of TEXT_KEYS) {
    const raw = await readDynamicBytes(
      trieId,
      nestedStringMappingSlot(node, key, TEXT_RECORDS_SLOT),
      at,
    );
    records[key] = raw ? new TextDecoder().decode(raw) : null;
  }
  return { contenthash, records };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const { names, expectedExecutables, requiredContenthashes } = args;
  if (names.length === 0) {
    console.error(
      "usage: npm run humanity:dotns:resolve -- <name.dot> [name.dot ...]\n" +
        "       DOTNS_NET=previewnet npm run humanity:dotns:resolve -- <name.dot>",
    );
    process.exitCode = 2;
    return;
  }

  const at = await rpc("chain_getFinalizedHead", []);
  const trieId = await resolveTrieId(CONTENT_RESOLVER, at);
  if (!trieId) {
    console.error(`RESOLVER_MISSING 0x${CONTENT_RESOLVER} on ${NET}`);
    process.exitCode = 1;
    return;
  }

  console.log(`network:  ${NET} (${network.rpc}, .${network.tld})`);
  console.log(`head:     ${at}`);
  console.log(`resolver: 0x${CONTENT_RESOLVER}`);
  console.log("");

  const results = [];
  for (const name of names) {
    const { contenthash, records } = await probe(name, trieId, at);
    results.push({ name, contenthash, records });
    const resolved = contenthash !== null || records.executable !== null;
    console.log(
      `${resolved ? "RESOLVED " : "NOT_FOUND"}  ${name}  (as ${chainName(name)})`,
    );
    console.log(`    contenthash    ${contenthash ? toHex(contenthash) : "<unset>"}`);
    for (const key of TEXT_KEYS) {
      console.log(`    text[${key}]${" ".repeat(11 - key.length)}${records[key] ?? "<unset>"}`);
    }
    console.log("");
  }

  try {
    assertPublicationReadback(
      results,
      expectedExecutables,
      requiredContenthashes,
    );
  } catch (error) {
    console.error(
      `READBACK_FAILED ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const missing = results.some(
    ({ contenthash, records }) =>
      contenthash === null && records.executable === null,
  );
  process.exitCode = missing ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
