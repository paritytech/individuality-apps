// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SDK SHAPES WE BUILD ON, PINNED.
 *
 * This suite is the tripwire for an `@parity/product-sdk-*` bump. It fails
 * loudly and names the package, the symbol and what changed, so a bump is a
 * red test someone reads — never a silent behaviour change in a user's console.
 *
 * Two things are pinned, both of which the app relies at runtime:
 *
 *  1. The exact version in every workspace manifest that declares a
 *     product-sdk package. CLAUDE.md: these move together, never one alone.
 *     The expected version is the ROOT manifest's, so a bump is one edit there
 *     plus the manifests — never a third table to remember.
 *  2. Every symbol the shipped sources take from those packages at VALUE
 *     level, with its arity. A missing export is a crash; an arity change is a
 *     changed call shape. Types are erased at compile time and are covered by
 *     `npm run typecheck`, not here.
 *
 * The symbol set is SCANNED from the sources, not hand-listed: the scanner
 * below walks the app (`lib/`, `app/`, `components/`), the worker (`apps/jollity-worker/src`)
 * and every workspace package, and reads both static
 * `import … from "@parity/product-sdk*"` and dynamic `import("@parity/…")`
 * forms. The table below only records the shape each scanned symbol must have,
 * and the scan asserts it is a SUBSET of the table — so a new import cannot
 * arrive un-pinned, and a rename cannot ship with this suite green.
 *
 * When this goes red on a deliberate bump: verify the call sites named in each
 * message, then move the recorded value WITH the bump in the same commit.
 */
import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import ts from "typescript"

// the repo root: the workspace manifests and the hoisted node_modules live there
const ROOT = new URL("../../../../", import.meta.url)

type Manifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  workspaces?: string[]
}

const readManifest = (path: string) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8")) as Manifest
const allDeps = (manifest: Manifest) => ({
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
  ...manifest.devDependencies,
  ...manifest.dependencies,
})
const installed = (name: string) =>
  (JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, ROOT), "utf8")) as { version: string }).version

/**
 * The pin, as CLAUDE.md states it: one exact version per package, in every
 * manifest that declares it. The ROOT manifest is the source of truth — a
 * caret range there would let a release drift in, and a bump is one edit here
 * plus the manifests, never a second table.
 */
const ROOT_MANIFEST = readManifest("package.json")
const PINS = Object.fromEntries(
  Object.entries(allDeps(ROOT_MANIFEST)).filter(([name]) => name.startsWith("@parity/product-sdk")),
) as Record<string, string>

/** Every workspace manifest, discovered from the root's `workspaces` globs
 *  (`packages/*`, `chat`) instead of a hand-kept list. */
function workspaceManifests(): string[] {
  const paths = ["package.json"]
  for (const pattern of ROOT_MANIFEST.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const dir = pattern.slice(0, -2)
      const parent = new URL(`${dir}/`, ROOT)
      if (!existsSync(parent)) continue
      for (const entry of readdirSync(parent).sort()) {
        if (existsSync(new URL(`${dir}/${entry}/package.json`, ROOT))) paths.push(`${dir}/${entry}/package.json`)
      }
    } else if (existsSync(new URL(`${pattern}/package.json`, ROOT))) {
      paths.push(`${pattern}/package.json`)
    }
  }
  return paths
}

const MANIFESTS = workspaceManifests()

describe("the product-sdk pins move together", () => {
  it("the root manifest declares the product-sdk pins this suite records", () => {
    expect(
      Object.keys(PINS).sort(),
      "The root package.json no longer declares any @parity/product-sdk-* package, so there is no pin to check against. " +
        "Restore the dependencies: this suite derives every expected version from the root manifest.",
    ).not.toEqual([])
  })

  it.each(Object.entries(PINS))("%s is pinned to exactly %s in every manifest that declares it", (name, version) => {
    for (const path of MANIFESTS) {
      const declared = allDeps(readManifest(path))[name]
      if (declared === undefined) continue
      expect(
        declared,
        `${path} declares ${name} "${declared}" but the repo's pin (from package.json) is "${version}". ` +
          `The product-sdk packages are pinned exactly and move together: an SDK release is a runtime upgrade. ` +
          `Update every manifest in ONE commit, never a caret range.`,
      ).toBe(version)
    }
  })

  it.each(Object.entries(PINS))("%s in node_modules is the pinned %s, so the lockfile agrees with the manifests", (name, version) => {
    expect(
      installed(name),
      `${name} resolves to a different version than the manifest pin "${version}". ` +
        `Run \`npm ci\`; if the lockfile itself disagrees, the pin was moved in one manifest only.`,
    ).toBe(version)
  })
})

type Shape = "function" | "object"
type SymbolPin = [name: string, shape: Shape, arity?: number]

/**
 * Value-level symbols taken by the app (lib/, app/, components/), the worker
 * (apps/jollity-worker/src) and the workspace packages. Recorded arity is the call shape the
 * code is written against; an added trailing optional parameter is still a red
 * test on purpose, because someone must confirm the call sites before it ships.
 *
 * These tables are the SHAPE record; WHICH symbols are needed comes from the
 * scan below, which fails when a scanned symbol is missing here.
 */
const HOST: SymbolPin[] = [
  ["ChainNotSupportedError", "function", 1],
  ["deriveEntropy", "function", 1],
  ["findRingVrfKeyHandle", "function", 2],
  ["formatHostError", "function", 1],
  ["fromHex", "function", 1],
  ["getAccountsProvider", "function", 0],
  ["getChatManager", "function", 0],
  ["getHostChainInfo", "function", 1],
  ["getHostLocalStorage", "function", 0],
  ["getHostProvider", "function", 1],
  ["getNotificationManager", "function", 0],
  ["getPaymentManager", "function", 0],
  ["getPreimageManager", "function", 0],
  ["getRendererManager", "function", 0],
  ["getStatementStore", "function", 0],
  ["getThemeProvider", "function", 0],
  ["getTruApi", "function", 0],
  ["isInsideContainerSync", "function", 0],
  ["navigateTo", "function", 1],
  ["requestDevicePermission", "function", 1],
  ["requestPermission", "function", 1],
  ["requestResourceAllocation", "function", 1],
  ["subscribeConnectionStatus", "function", 1],
  ["toHex", "function", 1],
]

const INDIVIDUALITY: SymbolPin[] = [
  // lib/game-source.ts and the engine's group arithmetic
  ["groupSeats", "function", 3],
  ["numberOfGroups", "function", 2],
  ["ringCollectionId", "function", 1],
  // packages/jollity-game-chain: the chain engine the app runs
  ["airdropVrfTranscript", "function", 1],
  ["buildLiteAliasBindTx", "function", 2],
  ["claimPrizeTx", "function", 2],
  ["fromPapi", "function", 2],
  ["gameAirdropEventId", "function", 1],
  ["gameAirdropEventIds", "function", 1],
  ["litePeopleRing", "function", 1],
  ["mintAccountAirdropVrfs", "function", 2],
  ["mintAliasAirdropVrfs", "function", 2],
  ["peopleRing", "function", 1],
  ["readAirdropDraw", "function", 2],
  ["readGameSignUpRequirement", "function", 2],
  ["readCommunicationIdentifier", "function", 2],
  ["readGroupMembers", "function", 2],
  ["readLiteSignUpRequirement", "function", 2],
  ["readPlayerIndices", "function", 2],
  ["readScoreContext", "function", 1],
  ["readSignUpFunds", "function", 2],
  ["reportTx", "function", 2],
  ["signUpWithAccountTx", "function", 2],
  ["signUpWithLiteInviteTx", "function", 2],
  ["toCurrentGame", "function", 1],
  ["watchCurrentGame", "function", 3],
  ["watchPlayer", "function", 4],
  ["withLiteAlias", "function", 2],
  ["withScoreParticipant", "function", 1],
  // apps/jollity-worker/src: the worker's chain reads
  ["confirmClaim", "function", 2],
  ["PERSONHOOD_CONTEXT_INDEX", "object"],
  ["peopleAirdropsRegisterCalls", "function", 2],
  ["readCurrentGame", "function", 1],
  ["readPeopleAirdropsSigning", "function", 2],
  ["readPeopleAirdropsStanding", "function", 2],
  ["readPersonhoodState", "function", 2],
  ["readPrizeStatus", "function", 1],
  ["withAsPerson", "function", 2],
  // packages/individuality-*: the shared packages' sign-up and usernames
  ["bindGameSeat", "function", 3],
  ["displayUsername", "function", 1],
  ["GameRegistrationError", "function", 3],
  ["GameSeatBindError", "function", 3],
  ["holdsLiteKey", "function", 3],
  ["lookupUsername", "function", 2],
  ["readGameSeat", "function", 2],
  ["registerForGame", "function", 3],
  ["registrationRetryDelay", "function", 1],
]

const NFTS: SymbolPin[] = [
  ["gatewaySource", "function", 1],
  ["getApprovedCollections", "function", 1],
  ["getClaimableCollections", "function", 1],
  ["getClaims", "function", 2],
  ["getCollectionItems", "function", 2],
  ["getVerifiedArtwork", "function", 2],
  ["preimageSource", "function", 1],
  ["previewClaim", "function", 2],
]

// lib/host/sign-up.ts (the sign-up's capabilities) and lib/host/turn-proof.ts (the TURN proof's keys), from a host
const INDIVIDUALITY_HOST: SymbolPin[] = [
  ["hostGameRegistrationCapabilities", "function", 1],
  ["hostPersonhoodProver", "function", 1],
]

const TX: SymbolPin[] = [["submitAndWatch", "function", 3]]
const APP: SymbolPin[] = [["createApp", "function", 0]]
const TESTING: SymbolPin[] = [["localAirdropVrfSigner", "function", 1]]
const DESCRIPTORS: SymbolPin[] = [
  ["paseo_individuality", "object"],
  ["previewnet_individuality", "object"],
]

/** Humanity's Asset Hub client (`packages/humanity-shared/src/chain/asset-hub-client.ts`). */
const ASSET_HUB_DESCRIPTORS: SymbolPin[] = [["paseo_asset_hub", "object"]]

/** module specifier -> the shape table that must cover it */
const PIN_LISTS: Record<string, SymbolPin[]> = {
  "@parity/product-sdk": APP,
  "@parity/product-sdk-host": HOST,
  "@parity/product-sdk-individuality": INDIVIDUALITY,
  "@parity/product-sdk-individuality/host": INDIVIDUALITY_HOST,
  "@parity/product-sdk-individuality/testing": TESTING,
  "@parity/product-sdk-nfts": NFTS,
  "@parity/product-sdk-tx": TX,
  "@parity/product-sdk-descriptors/paseo-individuality": DESCRIPTORS,
  "@parity/product-sdk-descriptors/previewnet-individuality": DESCRIPTORS,
  "@parity/product-sdk-descriptors/paseo-asset-hub": ASSET_HUB_DESCRIPTORS,
}

const isSdk = (specifier: string) => specifier === "@parity/product-sdk" || specifier.startsWith("@parity/product-sdk-")

/**
 * Where a namespace import is handed to something else whole, its members
 * cannot be enumerated statically. Each entry below must name the one member
 * that consumer reads, so the scan still covers it. Keep this list short and
 * justified — it is the one hole in the scan.
 */
const UNTRACED_ALLOWED: Record<string, string> = {
  // waitForHostReconnect(source) reads only source.subscribeConnectionStatus,
  // which is pinned in HOST above.
  "apps/jollity-app/lib/host/safe-call.ts": "@parity/product-sdk-host",
}

/** The app, the worker, and the workspace packages the two compose. Not
 *  `scripts/`: they are not shipped, and pinning them would
 *  turn a dev tool's convenience import into a release gate. */
const SOURCE_ROOTS = ["apps/jollity-app/lib", "apps/jollity-app/app", "apps/jollity-app/components", "apps/jollity-worker/src", "packages"]

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (relative: string) => {
    const url = new URL(relative + "/", ROOT)
    if (!existsSync(url)) return
    for (const entry of readdirSync(url).sort()) {
      const child = `${relative}/${entry}`
      if (statSync(new URL(child, ROOT)).isDirectory()) {
        if (entry !== "node_modules" && entry !== ".next") walk(child)
      } else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.(test|spec)\.(ts|tsx|mts)$/.test(entry)) {
        files.push(child)
      }
    }
  }
  for (const root of SOURCE_ROOTS) walk(root)
  return files
}

export type Scan = { imports: Map<string, Map<string, Set<string>>>; untraced: string[] }

/** The module specifier of an `import("…")` call, or undefined for any other node. */
function dynamicSpecifier(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined
  const [argument] = node.arguments
  return argument && ts.isStringLiteral(argument) && isSdk(argument.text) ? argument.text : undefined
}

/** The name a destructuring element binds: `{ a }` / `{ b: c }` -> a / c, and
 *  a nested pattern or a rest element has no single name to pin. */
function boundName(element: ts.BindingElement): string | undefined {
  if (element.propertyName) return ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined
  return ts.isIdentifier(element.name) ? element.name.text : undefined
}

/** Climb out of `await` and parentheses to the expression the enclosing
 *  statement actually consumes: `(await import("…")).foo`, `await import("…")`. */
function outermost(node: ts.Node): ts.Node {
  let current = node
  while (current.parent && (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent))) {
    current = current.parent
  }
  return current
}

/**
 * Read every value-level product-sdk symbol the shipped sources take, from both
 * import forms, and name the file each comes from. Static named imports are
 * read directly; a dynamic `import()` is followed through its binding — a
 * namespace (`sdk.foo`), a destructuring (`{ foo } = await import()`), or an
 * array destructure of `Promise.all([...])`. A `type X = typeof import("pkg")`
 * alias is followed too, so a value declared with that type (`sdk` injected as
 * a parameter) still has its members read.
 */
function scanSources(): Scan {
  const imports = new Map<string, Map<string, Set<string>>>()
  const untraced: string[] = []
  const add = (pkg: string, symbol: string, file: string) => {
    if (!imports.has(pkg)) imports.set(pkg, new Map())
    const symbols = imports.get(pkg)!
    if (!symbols.has(symbol)) symbols.set(symbol, new Set())
    symbols.get(symbol)!.add(file)
  }

  for (const file of sourceFiles()) {
    const text = readFileSync(new URL(file, ROOT), "utf8")
    if (!text.includes("@parity/product-sdk")) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const namespaces = new Map<string, string>() // local binding -> package
    const pendingArrays: { pkg: string; node: ts.ArrayLiteralExpression; index: number }[] = []
    // `type HostSdk = typeof import("@parity/product-sdk-host")`, then a value
    // declared with that type: its members are value reads too (this is how
    // `getStatementStore` reaches the app, through an injected sdk argument).
    const sdkTypeAliases = new Map<string, string>()
    for (const statement of source.statements) {
      // `typeof import("pkg")` parses as an ImportTypeNode with isTypeOf set
      if (!ts.isTypeAliasDeclaration(statement) || !ts.isImportTypeNode(statement.type)) continue
      const query = statement.type
      if (!ts.isLiteralTypeNode(query.argument) || !ts.isStringLiteral(query.argument.literal)) continue
      const specifier = query.argument.literal.text
      if (isSdk(specifier)) sdkTypeAliases.set(statement.name.text, specifier)
    }
    if (sdkTypeAliases.size) {
      const typed = (node: ts.Node) => {
        if (
          (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
          ts.isIdentifier(node.name) &&
          node.type &&
          ts.isTypeReferenceNode(node.type) &&
          ts.isIdentifier(node.type.typeName) &&
          sdkTypeAliases.has(node.type.typeName.text)
        ) {
          namespaces.set(node.name.text, sdkTypeAliases.get(node.type.typeName.text)!)
        }
        ts.forEachChild(node, typed)
      }
      typed(source)
    }

    const bind = (pkg: string, node: ts.Node) => {
      const parent = outermost(node).parent
      if (!parent) return
      if (ts.isVariableDeclaration(parent)) {
        if (ts.isIdentifier(parent.name)) {
          namespaces.set(parent.name.text, pkg)
          return
        }
        if (ts.isObjectBindingPattern(parent.name)) {
          for (const element of parent.name.elements) {
            if (element.dotDotDotToken) continue
            const property = boundName(element)
            if (property) add(pkg, property, file)
          }
          return
        }
      }
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(parent.left)) {
        namespaces.set(parent.left.text, pkg)
        return
      }
      untraced.push(`${file} -> ${pkg}`)
    }

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isSdk(node.moduleSpecifier.text)) {
        const pkg = node.moduleSpecifier.text
        const clause = node.importClause
        if (clause && !clause.isTypeOnly) {
          if (clause.name) namespaces.set(clause.name.text, pkg)
          const bindings = clause.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, pkg)
          else if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (element.isTypeOnly) continue
              const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
              add(pkg, imported, file)
            }
          }
        }
      }
      const pkg = dynamicSpecifier(node)
      if (pkg) {
        const holder = outermost(node)
        const parent = holder.parent
        if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === holder) {
          // (await import("pkg")).member
          add(pkg, parent.name.text, file)
        } else if (parent && ts.isArrayLiteralExpression(parent)) {
          // Promise.all([import(a), import(b)])
          pendingArrays.push({ pkg, node: parent, index: parent.elements.findIndex((element) => element === holder) })
        } else {
          bind(pkg, node)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)

    // `const [{ a }, ns] = await Promise.all([import(p1), import(p2)])`
    for (const { pkg, node, index } of pendingArrays) {
      const call = node.parent
      const awaited = call && ts.isCallExpression(call) ? call.parent : undefined
      const declaration = awaited && ts.isAwaitExpression(awaited) ? awaited.parent : undefined
      if (
        call &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "all" &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isArrayBindingPattern(declaration.name)
      ) {
        const element = declaration.name.elements[index]
        if (element && ts.isBindingElement(element)) {
          if (ts.isIdentifier(element.name)) namespaces.set(element.name.text, pkg)
          else if (ts.isObjectBindingPattern(element.name)) {
            for (const binding of element.name.elements) {
              const property = boundName(binding)
              if (property) add(pkg, property, file)
            }
          }
          continue
        }
      }
      untraced.push(`${file} -> ${pkg}`)
    }

    // Follow namespace bindings to the members read off them.
    const members = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
        add(namespaces.get(node.expression.text)!, node.name.text, file)
      }
      ts.forEachChild(node, members)
    }
    members(source)
  }

  return { imports, untraced: [...new Set(untraced)] }
}

const SCAN = scanSources()

function assertShape(mod: Record<string, unknown>, pkg: string, [name, shape, arity]: SymbolPin) {
  const value = mod[name]
  expect(
    value,
    `${pkg} no longer exports \`${name}\`. The app or the worker imports it at value level, so this is a build/runtime ` +
      `break, not a type drift. Find the call sites with \`grep -rn "${name}" apps/jollity-app/lib packages apps/jollity-worker/src\` and move them ` +
      `with the bump, or restore the export.`,
  ).toBeDefined()
  expect(
    typeof value,
    `${pkg}#${name} changed from a ${shape} to a ${typeof value}. The code calls it as a ${shape}; update the call sites.`,
  ).toBe(shape)
  if (shape === "function") {
    expect(
      (value as (...args: unknown[]) => unknown).length,
      `${pkg}#${name} changed arity from ${arity} to ${(value as (...args: unknown[]) => unknown).length}. ` +
        `That is a changed call shape: check every call site before moving this number, and move it in the same commit as the bump.`,
    ).toBe(arity)
  }
}

async function expectPackage(pkg: string, pins: SymbolPin[]) {
  const mod = (await import(/* @vite-ignore */ pkg)) as Record<string, unknown>
  for (const pin of pins) assertShape(mod, pkg, pin)
}

describe("every product-sdk value import in the shipped sources is in the shape table", () => {
  it("the scan found imports at all, so an empty result cannot pass silently", () => {
    expect(
      [...SCAN.imports.keys()].sort(),
      "The scan found no @parity/product-sdk imports. Either the source roots moved or the scanner stopped parsing " +
        "them; an empty scan would make every assertion below vacuous.",
    ).toEqual(expect.arrayContaining(["@parity/product-sdk-host", "@parity/product-sdk-individuality", "@parity/product-sdk-nfts"]))
  })

  it("every namespace handed to another function is covered by an allowlist entry", () => {
    expect(
      SCAN.untraced.filter((entry) => !(entry.split(" -> ")[0] in UNTRACED_ALLOWED)),
      "A product-sdk namespace import escapes into a value the scanner cannot follow, so its members are un-pinned. " +
        "Read the member through the namespace (`sdk.foo`) instead, or add the file to UNTRACED_ALLOWED with the member it reads.",
    ).toEqual([])
  })

  it("scanned ⊆ listed, naming any symbol the table is missing", async () => {
    const missing: string[] = []
    for (const [pkg, symbols] of SCAN.imports) {
      const listed = new Set((PIN_LISTS[pkg] ?? []).map(([name]) => name))
      for (const [symbol, files] of symbols) {
        if (!listed.has(symbol)) missing.push(`${pkg}#${symbol} (imported by ${[...files].join(", ")})`)
      }
    }
    expect(
      missing.sort(),
      "A shipped source imports a product-sdk symbol this suite does not pin. Add it to the matching table above with " +
        "its arity (the export is in node_modules; `node -e \"console.log(require('pkg').name.length)\"` gives it). " +
        "Until then a rename of it would ship a crash with this suite green.",
    ).toEqual([])
  })
})

describe("every product-sdk value export we import is still there, with its signature", () => {
  it("@parity/product-sdk-host", () => expectPackage("@parity/product-sdk-host", HOST))
  it("@parity/product-sdk-individuality", () => expectPackage("@parity/product-sdk-individuality", INDIVIDUALITY))
  it("@parity/product-sdk-individuality/host", () => expectPackage("@parity/product-sdk-individuality/host", INDIVIDUALITY_HOST))
  it("@parity/product-sdk-individuality/testing", () => expectPackage("@parity/product-sdk-individuality/testing", TESTING))
  it("@parity/product-sdk-nfts", () => expectPackage("@parity/product-sdk-nfts", NFTS))
  it("@parity/product-sdk-tx", () => expectPackage("@parity/product-sdk-tx", TX))
  it("@parity/product-sdk", () => expectPackage("@parity/product-sdk", APP))
  it.each([
    ["@parity/product-sdk-descriptors/paseo-individuality", "paseo_individuality"],
    ["@parity/product-sdk-descriptors/previewnet-individuality", "previewnet_individuality"],
    ["@parity/product-sdk-descriptors/paseo-asset-hub", "paseo_asset_hub"],
  ])("%s still exports %s, the descriptor pin the chain engine rides", async (pkg, name) => {
    const mod = (await import(/* @vite-ignore */ pkg)) as Record<string, unknown>
    const descriptor = mod[name] as { genesis?: unknown; descriptors?: unknown } | undefined
    expect(descriptor, `${pkg} no longer exports \`${name}\`; packages/jollity-game-chain/src/chain/client.ts and lib/draw/name-link.ts build their TypedApi from it.`).toBeDefined()
    expect(
      typeof descriptor?.genesis,
      `${pkg}#${name}.genesis is the chain identity the descriptor was generated for; without it the engine cannot key a client.`,
    ).toBe("string")
    expect(
      typeof descriptor?.descriptors,
      `${pkg}#${name}.descriptors carries the pallet calls the chain engine submits; a missing one is a build break in game-chain.`,
    ).toBe("object")
  })
})