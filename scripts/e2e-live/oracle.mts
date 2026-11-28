// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE ACCOUNT ORACLE and FREE-ROUTE READINESS for one live-E2E player, in one
 * short-lived signing host, independent of the app under test.
 *
 *   HOST_CLI_SIGNER_MNEMONIC=… npx tsx scripts/e2e-live/oracle.mts --base-path <fresh dir> --expect-user jollityeea.09
 *   npx tsx scripts/e2e-live/oracle.mts --base-path .truapi-host/e2e-1 --session jollityeea.09   # desk slot
 *
 * It prints ONE line `ORACLE {json}` on stdout (and progress on stderr):
 *   pairedAs   the username the host paired as ("✓ Paired with …"); with
 *              --expect-user, anything else is an error: a mnemonic that
 *              registered a NEW lite person is a different person
 *   account    the playing account, product account <product> index 1 (--product,
 *              default dim2.<tld>; the product a deployed bundle is built for) — the
 *              way scripts/player-status.mts derives it, never from the UI
 *   liteProof  "ok" when dim2 may mint the lite ring-VRF proof under peopl's
 *              grant (the mint of scripts/lite-key.mts --as dim2), else the
 *              refusal
 *   seat       PeopleLite.AccountToAlias and the lite sign-up blockers
 *
 * WHY NOT scripts/lite-key.mts / player-status.mts: both spawn the host with
 * `--session`, and truapi-host refuses `--session` when
 * HOST_CLI_SIGNER_MNEMONIC is set ("--session cannot be used when --mnemonic
 * or HOST_CLI_SIGNER_MNEMONIC is set", 0.23.0), and lite-key also requires a
 * current-session file a fresh base path lacks. CI runs in mnemonic mode on a
 * fresh base path, so this spawns the host itself. The mint below is
 * lite-key.mts's, kept in step with it.
 *
 * READ-ONLY: no bind, no sign-up, no transaction. A proof mint is not a tx.
 * The mnemonic reaches the CLI through the inherited env alone and is never
 * printed; the CLI's own lines are forwarded only when they match a short
 * allowlist.
 */
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { AccountId } from "polkadot-api"
import { createPeopleClient } from "@jollity/game-chain"
import { liteAliasBinding, litePeopleRingOf, readLiteSignUp, readScoreContextOf } from "../lib/lite-chain.mts"
import { hostErrorText } from "../../apps/jollity-app/lib/host/error-detail"
import { connectProductSdk, sleep } from "../lib/host-session.mts"
import { NETWORKS, freePort, networkFromArgs } from "../lib/host-slot.mjs"

const LITE_KEY_INDEX = 1
/** lib/game-source.ts SIGNUP_ACCOUNT_INDEX: the app signs up with index 1 on this network (#85). */
const SIGNUP_ACCOUNT_INDEX = 1

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const network = networkFromArgs(args) as keyof typeof NETWORKS // default previewnet, like every host-slot tool
const tld = NETWORKS[network].tld
const basePath = flag("--base-path")
const session = flag("--session")
const expectUser = flag("--expect-user")
const mnemonicMode = !!process.env.HOST_CLI_SIGNER_MNEMONIC?.trim()
if (!basePath) {
  console.error("usage: oracle.mts --base-path <dir> [--session <name> | HOST_CLI_SIGNER_MNEMONIC in env] [--expect-user <name>] [--port <n>] [--product <dotNS name>]")
  process.exit(2)
}
if (!mnemonicMode && !session) {
  console.error("desk mode needs --session <paired username> (or set HOST_CLI_SIGNER_MNEMONIC)")
  process.exit(2)
}
mkdirSync(basePath, { recursive: true })
// the product the app under test is built for (deployed-app.ts productFor): `dim2.<tld>` unless told otherwise
const gameProductId = flag("--product") ?? `dim2.${tld}`
const personhoodProductId = `peopl.${tld}`
const port = Number(flag("--port") ?? (await freePort("ORACLE_HOST_PORT", 9975)))
const message = new TextEncoder().encode("jollity lite proof check")
const t0 = Date.now()
const log = (line: string) => process.stderr.write(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${line}\n`)
const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

log(`${mnemonicMode ? "mnemonic mode" : `session ${session}`} · ${network} · host as ${gameProductId} · port ${port}`)

const child = spawn(
  "truapi-host",
  [
    "signing-host",
    "--network", network,
    "--base-path", basePath,
    ...(mnemonicMode ? [] : ["--session", session!]),
    "--product-id", gameProductId,
    "--frame-listen", `127.0.0.1:${port}`,
    "--serve",
    "--auto-accept",
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TRUAPI_HOST_NO_UPDATE: "1" } },
)
let pairedAs: string | undefined
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("truapi-host not ready in 180 s")), 180_000)
  const onLine = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const paired = /Paired with (\S+)/.exec(line)
      if (paired) pairedAs = paired[1]
      if (/Paired|Signing host ready|granted|allowlist|error|warn/i.test(line)) log(`[truapi-host] ${line.trim().slice(0, 300)}`)
      if (line.includes("Signing host ready")) {
        clearTimeout(timer)
        resolve()
      }
    }
  }
  child.stdout?.on("data", onLine)
  child.stderr?.on("data", onLine)
  child.on("error", (error) => {
    clearTimeout(timer)
    reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("truapi-host not found on PATH") : error)
  })
  child.on("exit", (code) => reject(new Error(`truapi-host exited with ${code} before it was ready`)))
})

interface OracleResult {
  pairedAs: string | null
  account: string | null
  liteProof: string
  seat: { alias: string | null; blockers: string[]; canSignUp: boolean } | null
  error?: string
}
const result: OracleResult = { pairedAs: pairedAs ?? null, account: null, liteProof: "not tried", seat: null }
const client = createPeopleClient(NETWORKS[network].peopleWs)
let exitCode = 0
try {
  if (expectUser && pairedAs !== expectUser) {
    throw new Error(`paired as ${pairedAs ?? "nobody"}, expected ${expectUser}: this is a different person`)
  }
  const sdk = await connectProductSdk(`ws://127.0.0.1:${port}`)
  const accounts = await sdk.getAccountsProvider()
  if (!accounts) throw new Error("the host offers no accounts provider")

  const game = await accounts.getProductAccount(gameProductId, SIGNUP_ACCOUNT_INDEX).match(
    (a) => a,
    (e) => {
      throw new Error(`getProductAccount(${gameProductId}, ${SIGNUP_ACCOUNT_INDEX}): ${hostErrorText(e)}`)
    },
  )
  result.account = AccountId().dec(game.publicKey)
  log(`playing account ${gameProductId} #${SIGNUP_ACCOUNT_INDEX} = ${result.account}`)

  // the mint, as scripts/lite-key.mts --as dim2 does it
  const ring = await litePeopleRingOf(client)
  const score = await readScoreContextOf(client)
  if (score.tag !== "ProductDerived") throw new Error("Score.score_context is not product-derived")
  const keys = (await accounts.listRingVrfKeys(personhoodProductId, "PublicKey")).match(
    (k) => k,
    (e) => {
      log(`listRingVrfKeys(${personhoodProductId}) → ${hostErrorText(e)}`)
      return []
    },
  )
  log(`listRingVrfKeys(${personhoodProductId}) → ${keys.length} key(s)`)
  const withPallet = { chainId: ring.chainId, junctions: [{ tag: "PalletInstance", value: 67 }, ...ring.junctions] } as typeof ring
  const matched = [ring, withPallet]
    .map((candidate) => ({ candidate, found: sdk.findRingVrfKeyHandle(keys, candidate) }))
    .find((m) => m.found)
  const handle =
    matched?.found ??
    ({ dotNsIdentifier: personhoodProductId, derivationIndex: { tag: "Index", value: LITE_KEY_INDEX } } as unknown as NonNullable<
      NonNullable<typeof matched>["found"]
    >)
  const context = { productId: score.productId, suffix: { tag: "Index", value: 0 } } as const
  const proof = await accounts.createRingVRFProof(handle, context, matched?.candidate ?? ring, message)
  proof.match(
    (p) => {
      result.liteProof = "ok"
      log(`createRingVRFProof → OK: ring ${p.ringIndex} revision ${p.ringRevision}, alias ${hex(p.contextualAlias.alias)}`)
    },
    (e) => {
      exitCode = 1
      result.liteProof = `refused: ${hostErrorText(e)}`
      log(`createRingVRFProof → REFUSED: ${hostErrorText(e)}`)
    },
  )

  const binding = await liteAliasBinding(client.api, result.account)
  const req = await readLiteSignUp(client, result.account)
  result.seat = {
    alias: binding ? String(binding.ca.alias) : null,
    blockers: req.blockers.map((b) => b.tag),
    canSignUp: req.canSignUp,
  }
  log(`seat: AccountToAlias ${binding ? "bound" : "unbound (the app binds it in the background)"} · blockers [${result.seat.blockers.join(", ") || "none"}]`)
} catch (error) {
  exitCode = 1
  result.error = error instanceof Error ? error.message : String(error)
  log(`✗ ${result.error}`)
} finally {
  console.log(`ORACLE ${JSON.stringify(result)}`)
  client.client.destroy()
  await sleep(300)
  if (!child.killed) child.kill("SIGTERM")
}
process.exit(exitCode)
