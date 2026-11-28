// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { BUILD_REFRESH_PATH, type LoadedApp } from "./build-refresh"
import { MissingContenthashError, assertTestTagBridge, commitFromBundle, pinnedCid, requirePrPreview, resolveCid, bundleNamesProduct, bundleSendsToProject, cidFromContenthash, cidString, contentType, decodePb, extractSite, injectBridge, lookup, namehash, parseAppName, parseCar, runTarget, patchTestTag, productFor, serveSite, stripSentryDsns, versionFromBundle } from "./deployed-app"

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (t: string) => Uint8Array.from(t.match(/../g) ?? [], (x) => parseInt(x, 16))

describe("names", () => {
  it("accepts the three names the deploy publishes", () => {
    for (const n of ["dim2next.paseo", "dim2.paseo", "dim2-pr12-sandbox00.paseo", "DIM2.Paseo", "dim2.testnet"]) expect(parseAppName(n)).toBe(n.toLowerCase())
  })
  it("refuses anything else, local included", () => {
    for (const n of ["dim2", "dim2.polkadot", "http://x.paseo", "a b.paseo", "-x.paseo", ""]) expect(() => parseAppName(n)).toThrow(/\.testnet or \.paseo dotNS name/)
  })
  it("dim2next is built for dim2.paseo; every other name is its own product; an override wins", () => {
    expect(productFor("dim2next.paseo")).toBe("dim2.paseo")
    expect(productFor("dim2.paseo")).toBe("dim2.paseo")
    expect(productFor("dim2-pr12-sandbox00.paseo")).toBe("dim2-pr12-sandbox00.paseo")
    expect(productFor("dim2next.paseo", " other.paseo ")).toBe("other.paseo")
  })
  it("previewnet has no staging leg: dim2.testnet is its own product", () => expect(productFor("dim2.testnet")).toBe("dim2.testnet"))
})

describe("runTarget: the network is chosen, the app follows", () => {
  it("defaults to previewnet and its dim2.testnet", () => expect(runTarget({})).toEqual({ network: "previewnet", app: "dim2.testnet" }))
  it("paseo-next-v2 (or its short forms) defaults to dim2next.paseo", () => {
    expect(runTarget({ E2E_NETWORK: "paseo-next-v2" })).toEqual({ network: "paseo-next-v2", app: "dim2next.paseo" })
    expect(runTarget({ E2E_NETWORK: "paseo" }).network).toBe("paseo-next-v2")
  })
  it("an explicit app on the chosen network is kept, lower-cased", () => {
    expect(runTarget({ E2E_NETWORK: "nextv2", E2E_APP: "Dim2.Paseo" })).toEqual({ network: "paseo-next-v2", app: "dim2.paseo" })
  })
  it("local takes the chosen network", () => {
    expect(runTarget({ E2E_APP: "local" })).toEqual({ network: "previewnet", app: "local" })
    expect(runTarget({ E2E_APP: "local", E2E_NETWORK: "paseo-next-v2" }).network).toBe("paseo-next-v2")
  })
  it("an app of another network's TLD fails early, naming both", () => {
    expect(() => runTarget({ E2E_APP: "dim2next.paseo" })).toThrow(/dim2next\.paseo is not on previewnet.*\.testnet/)
    expect(() => runTarget({ E2E_NETWORK: "paseo-next-v2", E2E_APP: "dim2.testnet" })).toThrow(/not on paseo-next-v2/)
  })
  it("an unknown network or app is an error", () => {
    expect(() => runTarget({ E2E_NETWORK: "mainnet" })).toThrow(/not one of/)
    expect(() => runTarget({ E2E_APP: "x.example" })).toThrow(/dotNS name/)
  })
})

describe("dotNS", () => {
  it("namehash is EIP-137", () => {
    expect(hex(namehash(""))).toBe("0".repeat(64))
    expect(hex(namehash("eth"))).toBe("93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae")
    expect(hex(namehash("foo.eth"))).toBe("de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f")
  })
  it("decodes a real contenthash result into the CID the gateway knows (live: app.dim2next.paseo)", () => {
    const result =
      "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000026e3010170122079dc46cb3687111aaa31c0f3190db1160ec45beca93239cc671da39ce80726740000000000000000000000000000000000000000000000000000"
    expect(cidFromContenthash(result)).toBe("bafybeidz3rdmwnuhcenkumoa6mmq3miwb3cfx3fjgi44yzy5uoooqbzgoq")
  })
  it("an unset contenthash is null, a non-ipfs one is an error", () => {
    expect(cidFromContenthash("0x")).toBeNull()
    expect(cidFromContenthash("0x" + "00".repeat(31) + "20" + "00".repeat(32))).toBeNull()
    expect(() => cidFromContenthash("0x" + "00".repeat(31) + "20" + "00".repeat(31) + "02" + "e5" + "01")).toThrow(/not ipfs-ns/)
  })
  it("cidString is lower-case base32 with the b prefix", () => {
    expect(cidString(unhex("017012200000000000000000000000000000000000000000000000000000000000000000"))).toMatch(/^bafybei[a-z2-7]+$/)
  })
})

// a tiny CAR by hand: root dir { index.html (raw), _next/a.js (dag-pb file of two raw chunks) }
const varint = (n: number) => {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return Uint8Array.from(out)
}
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]))
const field = (f: number, v: Uint8Array) => cat(varint((f << 3) | 2), varint(v.length), v)
const unixfs = (type: number, data?: Uint8Array) => cat(varint(8), varint(type), ...(data ? [field(2, data)] : []))
const link = (cid: Uint8Array, name: string) => field(2, cat(field(1, cid), field(2, enc(name))))
const pb = (links: Uint8Array[], type: number, data?: Uint8Array) => cat(...links, field(1, unixfs(type, data)))
const cid = (codec: number, tag: number) => cat(Uint8Array.from([1, codec, 0x12, 0x20]), new Uint8Array(32).fill(tag))
const section = (c: Uint8Array, data: Uint8Array) => cat(varint(c.length + data.length), c, data)

function buildCar(): Uint8Array {
  const raw1 = cid(0x55, 1), raw2 = cid(0x55, 2), raw3 = cid(0x55, 3)
  const file = cid(0x70, 4), nextDir = cid(0x70, 5), root = cid(0x70, 6)
  // CBOR header {roots:[tag42 bytes(00+cid)], version:1}
  const rootBytes = cat(Uint8Array.from([0]), root)
  const header = cat(Uint8Array.from([0xa2, 0x65]), enc("roots"), Uint8Array.from([0x81, 0xd8, 0x2a, 0x58, rootBytes.length]), rootBytes, Uint8Array.from([0x67]), enc("version"), Uint8Array.from([1]))
  return cat(
    varint(header.length),
    header,
    section(root, pb([link(raw1, "index.html"), link(nextDir, "_next")], 1)),
    section(raw1, enc('<html><head></head><body>hi</body></html>')),
    section(nextDir, pb([link(file, "a.js")], 1)),
    section(file, pb([link(raw2, ""), link(raw3, "")], 2)),
    section(raw2, enc("const v=")),
    section(raw3, enc('"x";')),
  )
}

describe("CAR and UnixFS", () => {
  it("reads the root and the blocks", () => {
    const car = parseCar(buildCar())
    expect(car.roots).toHaveLength(1)
    expect(car.roots[0]).toBe(hex(cid(0x70, 6)))
    expect(car.blocks.size).toBe(6)
  })
  it("walks directories and joins a chunked file", () => {
    const files = extractSite(parseCar(buildCar()))
    expect([...files.keys()].sort()).toEqual(["_next/a.js", "index.html"])
    expect(dec(files.get("_next/a.js")!)).toBe('const v="x";')
  })
  it("decodes a dag-pb node's links and unixfs type", () => {
    const node = decodePb(pb([link(cid(0x55, 1), "index.html")], 1))
    expect(node.type).toBe(1)
    expect(node.links).toEqual([{ cid: hex(cid(0x55, 1)), name: "index.html" }])
  })
  it("refuses a CAR with no root", () => {
    expect(() => parseCar(cat(varint(2), Uint8Array.from([0xa0, 0x00])))).toThrow(/no root/)
  })
})

describe("serving", () => {
  const files = new Map<string, Uint8Array>([
    ["index.html", enc("<html>")],
    ["game.html", enc("g")],
    ["chest/index.html", enc("c")],
    ["_next/static/a.js", enc("a")],
    ["404.html", enc("nope")],
  ])
  it("routes like a static export host", () => {
    expect(lookup(files, "/")).toEqual({ path: "index.html", status: 200 })
    expect(lookup(files, "/game?preview=x")).toEqual({ path: "game.html", status: 200 })
    expect(lookup(files, "/chest/")).toEqual({ path: "chest/index.html", status: 200 })
    expect(lookup(files, "/_next/static/a.js")).toEqual({ path: "_next/static/a.js", status: 200 })
    expect(lookup(files, "/missing")).toEqual({ path: "404.html", status: 404 })
  })
  it("never leaves the bundle", () => {
    expect(lookup(files, "/../etc/passwd")).toBeNull()
    expect(lookup(files, "/%2e%2e/x")).toBeNull()
  })
  it("puts the bridge first in <head>, or first of the document", () => {
    expect(injectBridge("<html><head><title>x</title></head>", "http://127.0.0.1:9955/bootstrap.js")).toBe(
      '<html><head><script src="http://127.0.0.1:9955/bootstrap.js"></script><title>x</title></head>',
    )
    expect(injectBridge("<p>", "b")).toBe('<script src="b"></script><p>')
  })
  it("types the files a Next export holds", () => {
    expect(contentType("a/b.js")).toMatch(/javascript/)
    expect(contentType("x.woff2")).toBe("font/woff2")
    expect(contentType("x.unknown")).toBe("application/octet-stream")
  })

  const loaded = (cid: string, version: string): LoadedApp => ({ app: "dim2.testnet", product: "dim2.testnet", cid, version, files: 1 })
  const site = (body: string) => new Map<string, Uint8Array>([["index.html", enc(`<html><head></head><body>${body}</body></html>`)]]);

  it("atomically replaces one slot's served build and reports its final provenance", async () => {
    const old = loaded("bafyold", "a".repeat(64))
    const next = loaded("bafynew", "b".repeat(64))
    const server = await serveSite({ loaded: old, files: site("old") }, 0, "bridge", async () => ({ loaded: next, files: site("new") }))
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toContain("old")
      expect(await (await fetch(`http://[::1]:${server.port}/`)).text()).toContain("old")
      expect(await (await fetch(`http://localhost:${server.port}/`)).text()).toContain("old")
      const response = await fetch(`http://127.0.0.1:${server.port}${BUILD_REFRESH_PATH}`, { method: "POST" })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: "updated", from: old, to: next })
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toContain("new")
      expect(server.current()).toEqual(next)
    } finally {
      server.close()
    }
  })

  it.each(["EADDRNOTAVAIL", "EAFNOSUPPORT"])("keeps serving over IPv4 when IPv6 fails with %s", async (code) => {
    const old = loaded("bafyold", "a".repeat(64))
    const bindIpv6 = async () => {
      throw Object.assign(new Error("IPv6 disabled"), { code })
    }
    const server = await serveSite({ loaded: old, files: site("old") }, 0, "bridge", undefined, bindIpv6)
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toContain("old")
    } finally {
      server.close()
    }
  })

  it("fails the slot for unexpected IPv6 listen errors", async () => {
    const old = loaded("bafyold", "a".repeat(64))
    const bindIpv6 = async () => {
      throw Object.assign(new Error("port collision"), { code: "EADDRINUSE" })
    }
    await expect(serveSite({ loaded: old, files: site("old") }, 0, "bridge", undefined, bindIpv6)).rejects.toMatchObject({ code: "EADDRINUSE" })
  })

  it("does not swap or claim a reload when dotNS still resolves the current CID", async () => {
    const old = loaded("bafysame", "a".repeat(64))
    const server = await serveSite({ loaded: old, files: site("old") }, 0, "bridge", async () => ({ loaded: { ...old, version: "b".repeat(64) }, files: site("wrong") }))
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${BUILD_REFRESH_PATH}`, { method: "POST" })
      expect(await response.json()).toMatchObject({ status: "unchanged", from: old, to: old })
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toContain("old")
      expect(server.current()).toEqual(old)
    } finally {
      server.close()
    }
  })

  it("keeps the old build and fails visibly when the replacement cannot be loaded", async () => {
    const old = loaded("bafyold", "a".repeat(64))
    const server = await serveSite({ loaded: old, files: site("old") }, 0, "bridge", async () => {
      throw new Error("new bundle names the wrong product")
    })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${BUILD_REFRESH_PATH}`, { method: "POST" })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: "new bundle names the wrong product" })
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toContain("old")
      expect(server.current()).toEqual(old)
    } finally {
      server.close()
    }
  })
})

describe("what the bundle says", () => {
  const V = "8bd8ae98e98e3d9f4896abde424d9ff6ab06975431ac98a9378d0dc5537d9d8e"
  const files = () =>
    new Map<string, Uint8Array>([
      ["_next/a.js", enc(`x={release:\`jollity@\${S.APP_VERSION}\`,testTag:"",y:1};a="${V}";b="${V}";c="${"f".repeat(64)}"`)],
      ["_next/b.js", enc(`const PRODUCT="dim2.paseo";testTag:""`)],
      ["index.html", enc('"dim2-other.paseo"')],
    ])
  it("reads the build stamp: the 64-hex literal the bundle repeats most", () => {
    expect(versionFromBundle(files())).toBe(V)
    expect(versionFromBundle(new Map())).toBeNull()
  })
  it("reads the exact build commit marker", () => {
    const f = new Map([["_next/c.js", enc(`const marker="jollity-build-commit:${"a".repeat(40)}"`)]] )
    expect(commitFromBundle(f)).toBe("a".repeat(40))
    expect(commitFromBundle(new Map())).toBeNull()
  })
  it("finds the product as a string literal in the JS only", () => {
    expect(bundleNamesProduct(files(), "dim2.paseo")).toBe(true)
    expect(bundleNamesProduct(files(), "dim2-other.paseo")).toBe(false)
  })
  it("tells whether the bundle bakes a DSN of the given Sentry project", () => {
    expect(bundleSendsToProject(files(), "4500000000000002")).toBe(false)
    const f = new Map([["_next/c.js", enc('test:"https://k@o1.ingest.de.sentry.io/4500000000000002",')]])
    expect(bundleSendsToProject(f, "4500000000000002")).toBe(true)
    expect(bundleSendsToProject(f, "4500000000000001")).toBe(false)
  })
  it("sets the empty Sentry tag in the served bytes and counts the places", () => {
    const f = files()
    expect(patchTestTag(f, "e2e-bot")).toBe(2)
    expect(dec(f.get("_next/b.js")!)).toContain('testTag:"e2e-bot"')
    expect(dec(f.get("_next/b.js")!)).not.toContain('testTag:""')
    expect(patchTestTag(f, "e2e-bot")).toBe(0)
    expect(() => assertTestTagBridge(true, 0, "dim2-pr961-sandbox00.testnet", "bafyold")).toThrow(/page devlog harness.*test-tag bridge/i)
    expect(() => assertTestTagBridge(true, 2, "dim2-pr961-sandbox00.testnet", "bafynew")).not.toThrow()
    expect(() => assertTestTagBridge(false, 0, "dim2-pr961-sandbox00.testnet", "bafyold")).not.toThrow()
  })
  it("strips baked Sentry DSNs from a private served bundle without changing other URLs", () => {
    const production = "https://public@o1.ingest.de.sentry.io/4500000000000001"
    const test = "https://test@o1.ingest.de.sentry.io/4500000000000002"
    const ordinary = "https://example.com/4500000000000002"
    const f = new Map<string, Uint8Array>([
      ["_next/a.js", enc(`a=${JSON.stringify(production)};b=${JSON.stringify(test)};c=${JSON.stringify(ordinary)}`)],
      ["index.html", enc(production)],
    ])

    expect(stripSentryDsns(f)).toBe(2)
    expect(dec(f.get("_next/a.js")!)).toBe(`a="";b="";c=${JSON.stringify(ordinary)}`)
    expect(dec(f.get("index.html")!)).toBe(production)
    expect(stripSentryDsns(f)).toBe(0)
  })
})

describe("resolveCid", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  it("retries an RPC hiccup (HTTP 5xx, a thrown fetch) three times, then names the last failure", async () => {
    let calls = 0
    const f = (async () => (++calls, json({}, 502))) as unknown as typeof fetch
    await expect(resolveCid("x.paseo", {}, f, 1)).rejects.toThrow(/failed 3 times: HTTP 502/)
    expect(calls).toBe(3)
    const g = (async () => {
      throw new Error("boom")
    }) as unknown as typeof fetch
    await expect(resolveCid("x.paseo", {}, g, 1)).rejects.toThrow(/boom/)
  })
  it("asks the RPC of the name's network, and E2E_DOTNS_RPC overrides it", async () => {
    const urls: string[] = []
    const f = (async (url: string) => (urls.push(url), json({ result: "0x" }))) as unknown as typeof fetch
    await resolveCid("dim2.testnet", {}, f, 1).catch(() => {})
    await resolveCid("dim2.paseo", {}, f, 1).catch(() => {})
    await resolveCid("dim2.testnet", { E2E_DOTNS_RPC: "http://x" }, f, 1).catch(() => {})
    expect(urls).toEqual(["https://previewnet.substrate.dev/eth-rpc", "https://eth-rpc-paseo-next.polkadot.io", "http://x"])
  })
  it("an empty contenthash is an answer, not retried", async () => {
    let calls = 0
    const f = (async () => (++calls, json({ result: "0x" }))) as unknown as typeof fetch
    await expect(resolveCid("x.paseo", {}, f, 1)).rejects.toBeInstanceOf(MissingContenthashError)
    expect(calls).toBe(1)
  })
  it("recovers when a retry answers", async () => {
    let calls = 0
    const f = (async () => (++calls === 1 ? json({}, 503) : json({ result: "0x" }))) as unknown as typeof fetch
    await expect(resolveCid("x.paseo", {}, f, 1)).rejects.toThrow(/has no contenthash/)
    expect(calls).toBe(2)
  })
})

describe("requirePrPreview: a PR preview must exist before a bot run waits on it (#924)", () => {
  const word = (n: number) => n.toString(16).padStart(64, "0")
  /** an eth_call answer of ABI bytes of length 0: the name has no contenthash */
  const empty = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + word(32) + word(0) }))) as unknown as typeof fetch
  const viaFetch = (fetchFn: typeof fetch) => (name: string) => resolveCid(name, {}, fetchFn, 0, 1000, 1)

  it("does not look up a name that is not a PR preview", async () => {
    let called = false
    await expect(requirePrPreview("dim2.testnet", "previewnet", async () => { called = true; return "b" })).resolves.toBeNull()
    expect(called).toBe(false)
  })
  it("passes when the preview resolves", async () => {
    await expect(requirePrPreview("dim2-pr924-sandbox00.testnet", "previewnet", async () => "bafyx")).resolves.toBe("bafyx")
  })
  it("fails with the label hint when the name serves nothing", async () => {
    await expect(requirePrPreview("dim2-pr924-sandbox00.testnet", "previewnet", viaFetch(empty)))
      .rejects.toThrow("PR 924 has no preview on previewnet: add the deploy-preview label (or deploy-paseo) and wait for its Deploy run")
  })
  it("names the network it checked", async () => {
    await expect(requirePrPreview("dim2-pr7-sandbox00.paseo", "paseo-next-v2", viaFetch(empty)))
      .rejects.toThrow(/^PR 7 has no preview on paseo-next-v2:/)
  })
  it("lets an RPC failure through as itself, never as 'no preview'", async () => {
    const down = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch
    await expect(requirePrPreview("dim2-pr924-sandbox00.testnet", "previewnet", viaFetch(down))).rejects.toThrow(/failed 1 times: HTTP 502/)
  })
  it("does not relabel an RPC error that merely mentions no contenthash", async () => {
    const rpcError = new Error("dotNS eth_call for app.dim2-pr924-sandbox00.testnet: provider says has no contenthash right now")
    await expect(requirePrPreview("dim2-pr924-sandbox00.testnet", "previewnet", async () => { throw rpcError })).rejects.toBe(rpcError)
  })
  it("does not relabel a generic error that copies the old missing-contenthash text", async () => {
    const generic = new Error("app.dim2-pr924-sandbox00.testnet has no contenthash: unrelated wrapper failure")
    await expect(requirePrPreview("dim2-pr924-sandbox00.testnet", "previewnet", async () => { throw generic })).rejects.toBe(generic)
  })
  it("the actual probe path reuses a PR preview CID and resolves a non-PR app only later", async () => {
    const probe = readFileSync(new URL("./probe.mts", import.meta.url), "utf8")
    const playAt = probe.indexOf('if (verdict.decision === "play")')
    const guardAt = probe.indexOf("await requirePrPreview(APP, NETWORK)")
    const botPlanningAt = probe.indexOf("const rawBots =")
    const freshPoolAt = probe.indexOf("const fresh =")
    expect(playAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(playAt)
    expect(guardAt).toBeLessThan(botPlanningAt)
    expect(guardAt).toBeLessThan(freshPoolAt)
    expect(probe).toContain('const previewCid = verdict.decision === "play"')
    expect(probe).toContain("appCid = previewCid ?? await resolveCid(APP)")

    const calls: string[] = []
    const lookup = async (name: string) => {
      calls.push(name)
      return name.includes("-pr") ? "bafy-pr" : "bafy-main"
    }
    const prApp = "dim2-pr924-sandbox00.testnet"
    const previewCid = await requirePrPreview(prApp, "previewnet", lookup)
    const pinnedPreviewCid = previewCid ?? await lookup(prApp)
    const mainApp = "dim2.testnet"
    const ordinaryPreviewCid = await requirePrPreview(mainApp, "previewnet", lookup)
    const pinnedMainCid = ordinaryPreviewCid ?? await lookup(mainApp)

    expect({ pinnedPreviewCid, pinnedMainCid }).toEqual({ pinnedPreviewCid: "bafy-pr", pinnedMainCid: "bafy-main" })
    expect(calls).toEqual([prApp, mainApp])
  })
})

describe("pinnedCid", () => {
  it("is null when unset, the CID when set, an error when malformed", () => {
    expect(pinnedCid({})).toBeNull()
    expect(pinnedCid({ E2E_APP_CID: " " })).toBeNull()
    expect(pinnedCid({ E2E_APP_CID: "bafybeidz3rdmwnuhcenkumoa6mmq3miwb3cfx3fjgi44yzy5uoooqbzgoq" })).toMatch(/^bafy/)
    expect(() => pinnedCid({ E2E_APP_CID: "nope" })).toThrow(/not a CID/)
  })
})
