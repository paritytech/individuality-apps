// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE DEPLOYED APP, LOADED THE WAY A HOST LOADS IT (#284): the live E2E's bots
// test what dotNS serves under a NAME (`dim2.testnet` = previewnet, `dim2next.paseo`
// = what main deployed on paseo, `dim2.paseo` = the release, `dim2-pr<N>-sandbox00.paseo`
// = a PR's preview), not a `next dev` of the checked-out commit. The network is the run's
// explicit knob (E2E_NETWORK, default previewnet; host-slot.mjs NETWORKS); a name
// of another network's TLD is refused.
//
// WHAT A HOST DOES, and what this does the same:
//   1. dotNS: the content resolver's `contenthash(namehash("app.<name>"))` is
//      the CID of the product's bundle (bulletin-deploy --js-merkle publishes the
//      whole static export as ONE CAR file, so the CID is that file's);
//   2. fetch the CAR from the network's IPFS gateway;
//   3. read the site out of it (a UnixFS directory tree) and serve it.
// The truapi-host CLI cannot do 1-3 itself (`truapi-host dev` only wraps a dev
// server), and the paseo.li web gateway is dotli's own browser host, with its
// own signer, so the bots' mnemonic would never reach it. This is therefore a
// local static server over the SAME bytes, with the host's bridge script
// (`<script src=http://127.0.0.1:<host port>/bootstrap.js>`) put into every HTML
// page, which is what app/layout.tsx does in development.
//
// PURE where it can be (vitest pins it): the name rules, the contenthash decode,
// the CAR and UnixFS readers, the route lookup, the bridge injection. The two
// network calls (resolveCid, fetchCar) are thin.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { NETWORKS, networkFromEnv } from "../lib/host-slot.mjs"
import { BUILD_REFRESH_PATH, type BuildRefreshResult, type LoadedApp } from "./build-refresh"

export type { LoadedApp } from "./build-refresh"

// --- the name -------------------------------------------------------------

export type NetworkName = keyof typeof NETWORKS
/** `E2E_APP=local`: a `next dev` of this checkout. */
export const LOCAL_APP = "local"

/** A dotNS name the bots may load: lower-case labels, ending `.paseo` or `.testnet` (a network's TLD in host-slot.mjs). */
export function parseAppName(raw: string): string {
  const name = raw.trim().toLowerCase()
  const tlds = Object.values(NETWORKS).map((n) => n.tld).join("|")
  if (!new RegExp(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.(${tlds})$`).test(name)) {
    throw new Error(`app "${raw}" is not a .${Object.values(NETWORKS).map((n) => n.tld).join(" or .")} dotNS name (e.g. dim2.testnet, dim2next.paseo, dim2.paseo, dim2-pr12-sandbox00.paseo)`)
  }
  return name
}

/** THE RUN'S NETWORK and APP from the env: the network is E2E_NETWORK (any alias, default previewnet); the app is
 *  E2E_APP or that network's default (dim2.testnet / dim2next.paseo), or "local" (a `next dev` of the checkout).
 *  A named app whose TLD is another network's is an error, here, before anything boots. */
export function runTarget(env: Record<string, string | undefined> = process.env): { network: NetworkName; app: string } {
  const network = networkFromEnv(env) as NetworkName
  const raw = env.E2E_APP?.trim().toLowerCase() || NETWORKS[network].defaultApp
  if (raw === LOCAL_APP) return { network, app: LOCAL_APP }
  const app = parseAppName(raw)
  const tld = NETWORKS[network].tld
  if (!app.endsWith(`.${tld}`)) throw new Error(`app ${app} is not on ${network} (its names end .${tld}): set E2E_NETWORK to the app's network, or pick a .${tld} app`)
  return { network, app }
}

/** The network a deployed name's TLD belongs to (for resolving it); previewnet for anything unknown. */
const networkOfName = (name: string): NetworkName => (Object.keys(NETWORKS) as NetworkName[]).find((n) => name.endsWith(`.${NETWORKS[n].tld}`)) ?? "previewnet"

/** The PRODUCT ID baked into the bundle published under `name` (deploy.yml "Determine domain"): the name itself,
 *  except that paseo's dim2next staging leg is built for dim2.paseo, so the release can be promoted without a
 *  rebuild (previewnet has no staging leg). The host derives the player's account from it, and a mismatch is
 *  silent (reads work, signing fails PermissionDenied). `E2E_APP_PRODUCT` overrides. */
export function productFor(name: string, override?: string): string {
  if (override?.trim()) return override.trim()
  return name === "dim2next.paseo" ? NETWORKS["paseo-next-v2"].productId : name
}

// --- dotNS: name -> CID ---------------------------------------------------

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
const unhex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16))
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** ENS namehash (EIP-137). */
export function namehash(name: string): Uint8Array {
  let node = new Uint8Array(32)
  for (const label of name === "" ? [] : name.split(".").reverse()) node = keccak_256(concat(node, keccak_256(new TextEncoder().encode(label))))
  return node
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567"
/** multibase base32 (lower case, no padding) of `bytes`, with the `b` prefix. */
export function cidString(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return "b" + out
}

/** The CID in an `eth_call` result of `contenthash(bytes32)` (ABI `bytes`,
 *  EIP-1577 `e3 01` ipfs prefix then the CID bytes); null when unset. */
export function cidFromContenthash(resultHex: string): string | null {
  const raw = unhex(resultHex.replace(/^0x/, ""))
  if (raw.length < 64) return null
  const length = Number(BigInt("0x" + hex(raw.slice(32, 64))))
  if (length === 0) return null
  const bytes = raw.slice(64, 64 + length)
  if (bytes[0] !== 0xe3 || bytes[1] !== 0x01) throw new Error(`contenthash is not ipfs-ns (starts ${hex(bytes.slice(0, 2))})`)
  const cid = bytes.slice(2)
  if (cid[0] !== 0x01) throw new Error("contenthash holds a CIDv0; only CIDv1 is handled")
  return cidString(cid)
}

/** `app.<name>`'s contenthash on dotNS, as a CID (what release.yml promotes with
 *  `dotns content set app.<name>`). */
export async function resolveCid(
  name: string,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
  retryMs = 2000,
  attemptTimeoutMs = 30_000,
  attempts = 3,
): Promise<string> {
  const network = networkOfName(name)
  const rpc = env.E2E_DOTNS_RPC?.trim() || NETWORKS[network].ethRpc
  const to = env.E2E_DOTNS_RESOLVER?.trim() || NETWORKS[network].contentResolver
  const data = "0xbc1c58d1" + hex(namehash(`app.${name}`)) // contenthash(bytes32)
  let last = ""
  // an RPC hiccup (HTTP 5xx, a timeout, a non-JSON body) is retried; an answer (error or empty contenthash) is final
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await fetchFn(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      })
      if (!r.ok) {
        last = `HTTP ${r.status}`
      } else {
        const res = (await r.json()) as { result?: string; error?: { message: string } }
        if (res.error) throw new Error(`dotNS eth_call for app.${name}: ${res.error.message}`)
        const cid = cidFromContenthash(res.result ?? "0x")
        if (!cid) throw new MissingContenthashError(name, network)
        return cid
      }
    } catch (error) {
      if (error instanceof MissingContenthashError || (error instanceof Error && error.message.startsWith("dotNS eth_call"))) throw error
      last = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, retryMs * attempt))
  }
  throw new Error(`resolving app.${name} on ${rpc} failed ${attempts} times: ${last}`)
}

/** A successful dotNS answer whose contenthash is empty, distinct from RPC and decoding failures. */
export class MissingContenthashError extends Error {
  constructor(name: string, network: NetworkName) {
    super(`app.${name} has no contenthash: that name serves nothing on ${network} (is it deployed? paseo PR previews are dim2-pr<N>-sandbox00.paseo)`)
    this.name = "MissingContenthashError"
  }
}

/** A per-PR preview name (deploy.yml "Determine domain"): dim2-pr<N>-sandbox00.<tld>. */
export const PR_PREVIEW = /^dim2-pr(\d+)-sandbox00\./

/** Fails fast when `app` is a PR preview that was never published on `network`. Since #924 a PR deploys its
 *  preview only when its deployed sources change, or on the deploy-preview / deploy-paseo label, so a bot run
 *  against a PR can find nothing there; say so in the probe's first second, not as a boot failure that reads
 *  like an app bug. ONE dotNS read, the same one resolveCid makes to pin the build; an RPC failure is not
 *  "no preview" and passes through as itself. */
export async function requirePrPreview(
  app: string,
  network: NetworkName,
  resolve: (name: string) => Promise<string> = (name) => resolveCid(name),
): Promise<string | null> {
  const pr = PR_PREVIEW.exec(app)?.[1]
  if (!pr) return null
  try {
    return await resolve(app)
  } catch (error) {
    if (error instanceof MissingContenthashError) {
      throw new Error(`PR ${pr} has no preview on ${network}: add the deploy-preview label (or deploy-paseo) and wait for its Deploy run`)
    }
    throw error
  }
}

/** E2E_APP_CID: the CID the PROBE resolved once for the whole run, so every runner loads the same build even when a
 *  deploy lands mid-dispatch. Empty = resolve it here (a desk run). A malformed one is an error, never ignored. */
export function pinnedCid(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.E2E_APP_CID?.trim()
  if (!v) return null
  if (!/^baf[a-z2-7]{20,}$/.test(v)) throw new Error(`E2E_APP_CID="${v}" is not a CID`)
  return v
}

/** The whole CAR the CID names, from `network`'s IPFS gateway. */
export async function fetchCar(
  cid: string,
  network: NetworkName,
  env: Record<string, string | undefined> = process.env,
  attemptTimeoutMs = 120_000,
  attempts = 4,
  retryMs = 3000,
): Promise<Uint8Array> {
  const gateway = env.E2E_IPFS_GATEWAY?.trim() || NETWORKS[network].ipfsGateway
  let last = ""
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${gateway}/ipfs/${cid}`, { signal: AbortSignal.timeout(attemptTimeoutMs) })
      if (res.ok) return new Uint8Array(await res.arrayBuffer())
      last = `HTTP ${res.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, retryMs * attempt))
  }
  throw new Error(`fetching ${cid} from ${gateway}: ${last}`)
}

// --- CAR v1 and UnixFS ----------------------------------------------------

function varint(buf: Uint8Array, at: number): [value: number, next: number] {
  let value = 0
  let scale = 1
  for (;;) {
    if (at >= buf.length) throw new Error("truncated varint")
    const byte = buf[at++]
    value += (byte & 0x7f) * scale
    if (byte < 0x80) return [value, at]
    scale *= 128
  }
}

/** Length of the CID that starts `buf[at]`: CIDv0 (`12 20` + 32) or CIDv1. */
function cidLength(buf: Uint8Array, at: number): number {
  if (buf[at] === 0x12 && buf[at + 1] === 0x20) return 34
  let p: number
  ;[, p] = varint(buf, at) // version
  ;[, p] = varint(buf, p) // codec
  ;[, p] = varint(buf, p) // multihash code
  const [size, end] = varint(buf, p)
  return end + size - at
}

export interface Car {
  roots: string[]
  /** CID bytes (hex) -> block data */
  blocks: Map<string, Uint8Array>
}

/** Read a CARv1: header (CBOR, only its first root is needed), then sections. */
export function parseCar(buf: Uint8Array): Car {
  const [headerLength, afterHeaderLength] = varint(buf, 0)
  const header = buf.slice(afterHeaderLength, afterHeaderLength + headerLength)
  // The root CID sits in the header as a CBOR tag 42 byte string: d8 2a 58 <len> 00 <cid>. One root is all bulletin-deploy writes.
  const roots: string[] = []
  for (let i = 0; i + 4 < header.length; i++) {
    if (header[i] === 0xd8 && header[i + 1] === 0x2a && header[i + 2] === 0x58) {
      const length = header[i + 3]
      roots.push(hex(header.slice(i + 5, i + 4 + length)))
    }
  }
  const blocks = new Map<string, Uint8Array>()
  let at = afterHeaderLength + headerLength
  while (at < buf.length) {
    const [sectionLength, start] = varint(buf, at)
    const end = start + sectionLength
    const cidLen = cidLength(buf, start)
    blocks.set(hex(buf.slice(start, start + cidLen)), buf.slice(start + cidLen, end))
    at = end
  }
  if (roots.length === 0) throw new Error("the CAR names no root")
  return { roots, blocks }
}

function* fields(buf: Uint8Array): Generator<[number, number | Uint8Array]> {
  let at = 0
  while (at < buf.length) {
    let key: number
    ;[key, at] = varint(buf, at)
    const wire = key & 7
    if (wire === 0) {
      let v: number
      ;[v, at] = varint(buf, at)
      yield [key >> 3, v]
    } else if (wire === 2) {
      let len: number
      ;[len, at] = varint(buf, at)
      yield [key >> 3, buf.slice(at, at + len)]
      at += len
    } else throw new Error(`unsupported protobuf wire type ${wire}`)
  }
}

interface PbNode {
  links: { cid: string; name: string }[]
  /** UnixFS: 1 directory, 2 file, 5 HAMT shard; 0 for raw leaves */
  type: number
  data: Uint8Array
}

/** dag-pb (codec 0x70) block with its UnixFS payload. */
export function decodePb(block: Uint8Array): PbNode {
  const node: PbNode = { links: [], type: 2, data: new Uint8Array(0) }
  for (const [field, value] of fields(block)) {
    if (field === 2) {
      const link = { cid: "", name: "" }
      for (const [f, v] of fields(value as Uint8Array)) {
        if (f === 1) link.cid = hex(v as Uint8Array)
        else if (f === 2) link.name = new TextDecoder().decode(v as Uint8Array)
      }
      node.links.push(link)
    } else if (field === 1) {
      for (const [f, v] of fields(value as Uint8Array)) {
        if (f === 1) node.type = v as number
        else if (f === 2) node.data = v as Uint8Array
      }
    }
  }
  return node
}

/** A raw-codec block (0x55) is its own bytes; anything else is dag-pb. */
const isRaw = (cidHex: string): boolean => cidHex.startsWith("0155")

function readFile(car: Car, cidHex: string): Uint8Array {
  const block = car.blocks.get(cidHex)
  if (!block) throw new Error(`block ${cidHex} is not in the CAR`)
  if (isRaw(cidHex)) return block
  const node = decodePb(block)
  return concat(node.data, ...node.links.map((l) => readFile(car, l.cid)))
}

/** Every file under the root directory, by path ("_next/static/…", "index.html"). */
export function extractSite(car: Car): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const walk = (cidHex: string, prefix: string): void => {
    const block = car.blocks.get(cidHex)
    if (!block) throw new Error(`block ${cidHex} is not in the CAR`)
    if (isRaw(cidHex)) return void files.set(prefix.replace(/\/$/, ""), block)
    const node = decodePb(block)
    if (node.type === 1 || node.type === 5) {
      for (const link of node.links) {
        // a HAMT shard prefixes every name with a 2-hex bucket id; a name that is only the prefix is a sub-shard
        const shard = node.type === 5
        const name = shard ? link.name.slice(2) : link.name
        walk(link.cid, shard && name === "" ? prefix : `${prefix}${name}${isDirectory(car, link.cid) ? "/" : ""}`)
      }
    } else files.set(prefix.replace(/\/$/, ""), readFile(car, cidHex))
  }
  walk(car.roots[0], "")
  return files
}

function isDirectory(car: Car, cidHex: string): boolean {
  if (isRaw(cidHex)) return false
  const block = car.blocks.get(cidHex)
  if (!block) return false
  const type = decodePb(block).type
  return type === 1 || type === 5
}

// --- serving it -----------------------------------------------------------

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wasm: "application/wasm",
  glb: "model/gltf-binary",
}
export const contentType = (path: string): string => TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"

/** The file a URL path serves, the way a static export is hosted: the exact
 *  file, then `<path>.html`, then `<path>/index.html`; the 404 page (status 404)
 *  otherwise. */
export function lookup(files: ReadonlyMap<string, Uint8Array>, urlPath: string): { path: string; status: number } | null {
  let path: string
  try {
    path = decodeURIComponent(urlPath.split("?")[0].split("#")[0])
  } catch {
    return null
  }
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "")
  if (clean.split("/").includes("..")) return null
  const candidates = clean === "" ? ["index.html"] : [clean, `${clean}.html`, `${clean}/index.html`]
  const hit = candidates.find((c) => files.has(c))
  if (hit) return { path: hit, status: 200 }
  return files.has("404.html") ? { path: "404.html", status: 404 } : null
}

/** `<script src=bridge>` as the first thing in `<head>`: it parks the host's
 *  MessagePort on window.__HOST_API_PORT__ before any app script runs, which is
 *  what a native webview host does and what app/layout.tsx's dev-only script does. */
export function injectBridge(html: string, bridgeUrl: string): string {
  const tag = `<script src="${bridgeUrl}"></script>`
  const head = /<head[^>]*>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html
}

/** The build stamp the app inlines (lib/debug/flag.ts APP_VERSION = the source
 *  hash deploy.yml computes, 64 hex): the one 64-hex string literal that sits next
 *  to the release name the telemetry builds (`jollity@`), else null. */
export function versionFromBundle(files: ReadonlyMap<string, Uint8Array>): string | null {
  const decoder = new TextDecoder()
  const found = new Map<string, number>()
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue
    for (const m of decoder.decode(bytes).matchAll(/["'`]([0-9a-f]{64})["'`]/g)) found.set(m[1], (found.get(m[1]) ?? 0) + 1)
  }
  // the version is inlined at each use (telemetry release, debug sheet, stale-build check): the most repeated one
  const ranked = [...found].sort((a, b) => b[1] - a[1])
  return ranked[0]?.[0] ?? null
}

/** Exact source-control provenance stamped by deploy.yml. The explicit marker
 * prevents another incidental 40-hex literal from being mistaken for a head. */
export function commitFromBundle(files: ReadonlyMap<string, Uint8Array>): string | null {
  const decoder = new TextDecoder()
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue
    const match = /jollity-build-commit:([0-9a-f]{40})/.exec(decoder.decode(bytes))
    if (match) return match[1]
  }
  return null
}

/** Does the bundle name `product` as a string literal? A bundle built for another
 *  name derives another account and signs nothing, silently (deploy.yml). */
export function bundleNamesProduct(files: ReadonlyMap<string, Uint8Array>, product: string): boolean {
  const decoder = new TextDecoder()
  const needles = [`"${product}"`, `'${product}'`, `\`${product}\``]
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue
    const text = decoder.decode(bytes)
    if (needles.some((n) => text.includes(n))) return true
  }
  return false
}

/** Does the bundle bake a DSN of Sentry project `projectId` (an ingest URL
 *  ending in "/<id>" inside a JS string)? A bundle built before the test DSN
 *  existed still sends a bot's events to production (this is only said in
 *  the boot log). */
export function bundleSendsToProject(files: ReadonlyMap<string, Uint8Array>, projectId: string): boolean {
  const decoder = new TextDecoder()
  const needle = new RegExp(`ingest[^"'\x60]*/${projectId}["'\x60]`)
  for (const [path, bytes] of files) if (path.endsWith(".js") && needle.test(decoder.decode(bytes))) return true
  return false
}

/**
 * A deployed static export already has both public Sentry DSNs compiled into
 * its JavaScript. Bot runs serve a private in-memory copy of those bytes, so an
 * opt-out must clear the baked DSNs as well as the runner environment. Match
 * only Sentry ingest URLs: ordinary application URLs are left byte-for-byte.
 */
export function stripSentryDsns(files: Map<string, Uint8Array>): number {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const dsn = /https:\/\/[^"'`\\\s]+@[^"'`\\\s]+\.ingest(?:\.[a-z0-9-]+)?\.sentry\.io\/\d+/gi
  let changed = 0
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue
    const text = decoder.decode(bytes)
    const matches = text.match(dsn)
    if (!matches) continue
    files.set(path, encoder.encode(text.replace(dsn, "")))
    changed += matches.length
  }
  return changed
}

/** A deployed bundle bakes the Sentry tag EMPTY (deploy.yml: a deploy leg is real
 *  traffic), so a bot's events would carry no `test.tag` and the guards and the
 *  gather queries could not tell them from a phone's. The one literal in the
 *  telemetry init, `testTag:""`, is set to the bot's tag in the bytes THIS RUN
 *  SERVES (never in what dotNS holds). Returns how many it changed: 0 means the
 *  bundle's telemetry init has another shape and the caller must say so. */
export function patchTestTag(files: Map<string, Uint8Array>, tag: string): number {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let changed = 0
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue
    const text = decoder.decode(bytes)
    if (!text.includes('testTag:""')) continue
    files.set(path, encoder.encode(text.split('testTag:""').join(`testTag:${JSON.stringify(tag)}`)))
    changed += text.split('testTag:""').length - 1
  }
  return changed
}

export function assertTestTagBridge(required: boolean, changed: number, app: string, cid: string): void {
  if (required && changed === 0) throw new Error(`page devlog harness requires the deployed test-tag bridge, but ${app} (${cid}) has no patchable testTag:\"\"`)
}

export interface DeployedBuild {
  loaded: LoadedApp
  files: ReadonlyMap<string, Uint8Array>
}

export interface ServedSite {
  close(): void
  current(): LoadedApp
  port: number
}

type SiteServer = ReturnType<typeof createServer>
type Ipv6Listener = (server: SiteServer, port: number) => Promise<void>

const listenIpv6: Ipv6Listener = (server, port) => new Promise<void>((done, fail) => (server.once("error", fail), server.listen(port, "::1", done)))
const unavailableIpv6 = (error: unknown): boolean => ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((error as NodeJS.ErrnoException)?.code ?? "")

/** Serve one slot's current deployed build. The private POST endpoint models a
 *  real player's restart: re-resolve the name, validate the new bundle, swap
 *  it atomically, then let Playwright reload the same page and host context. */
export async function serveSite(
  initial: DeployedBuild,
  port: number,
  bridgeUrl: string,
  refresh?: () => Promise<DeployedBuild>,
  bindIpv6: Ipv6Listener = listenIpv6,
): Promise<ServedSite> {
  let current = initial
  let refreshing: Promise<BuildRefreshResult> | null = null
  const refreshBuild = () => {
    if (refreshing) return refreshing
    const started = Date.now()
    const from = current.loaded
    refreshing = (async () => {
      if (!refresh) throw new Error("this served app has no deployed-build refresher")
      const candidate = await refresh()
      if (candidate.loaded.cid === from.cid) return { status: "unchanged", from, to: from, seconds: (Date.now() - started) / 1000 } as const
      current = candidate
      return { status: "updated", from, to: candidate.loaded, seconds: (Date.now() - started) / 1000 } as const
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === BUILD_REFRESH_PATH) {
      if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end()
      void refreshBuild().then(
        (answer) => {
          const body = Buffer.from(JSON.stringify(answer))
          res.writeHead(200, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" }).end(body)
        },
        (error: unknown) => {
          const body = Buffer.from(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          res.writeHead(502, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" }).end(body)
        },
      )
      return
    }
    const hit = lookup(current.files, req.url ?? "/")
    if (!hit) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found")
    const bytes = current.files.get(hit.path)!
    const type = contentType(hit.path)
    const body = type.startsWith("text/html") ? Buffer.from(injectBridge(new TextDecoder().decode(bytes), bridgeUrl)) : Buffer.from(bytes)
    res.writeHead(hit.status, { "content-type": type, "content-length": body.length, "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : body)
  }
  // The page must keep the localhost origin used by the host. Listen on both
  // loopback families so either localhost resolution works, without exposing
  // the private refresh control endpoint on a non-loopback interface.
  const ipv4 = createServer(handle)
  await new Promise<void>((done, fail) => (ipv4.once("error", fail), ipv4.listen(port, "127.0.0.1", done)))
  const address = ipv4.address()
  if (!address || typeof address === "string") throw new Error("served app has no TCP port")
  const ipv6 = createServer(handle)
  let ipv6Listening = false
  try {
    await bindIpv6(ipv6, address.port)
    ipv6Listening = true
  } catch (error) {
    if (!unavailableIpv6(error)) {
      ipv4.close()
      throw error
    }
    console.log(`served app: IPv6 loopback unavailable (${(error as NodeJS.ErrnoException).code}); using 127.0.0.1 only`)
  }
  return {
    close: () => {
      ipv4.close()
      if (ipv6Listening) ipv6.close()
    },
    current: () => current.loaded,
    port: address.port,
  }
}
