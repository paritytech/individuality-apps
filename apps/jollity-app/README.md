# Jollity

Jollity is this Next.js 16 app, the chat worker in
[`apps/jollity-worker`](../jollity-worker), and the packages in `packages/jollity-*`. On chain
it plays as the DotNS product `dim2` (`dim2.<tld>`; see [CONTEXT.md](CONTEXT.md)). Two of
those packages are self-contained engines:

- **`@jollity/statement-core`** (`packages/jollity-statement-core`) — People-chain statement-store engine: statement primitives, the store seam, and WebRTC signalling over statements. Chain-agnostic, no papi descriptors.
- **`@jollity/game-chain`** (`packages/jollity-game-chain`) is the Game pallet engine for the individuality People chain: the chain `GameEngine` over `@parity/product-sdk-individuality` and its descriptors at spec 3004000, pure game math, and the player's key derivation. It has two entry points. The barrel, `@jollity/game-chain`, carries the chain client and pulls papi with it. `@jollity/game-chain/game` is the pure half, holding the constants and the round state machine, with papi nowhere in its import graph.

The engines never import each other. The app composes them, proving statements through the host (`lib/host/statement-store.ts`); `keypairStatementProver` is a local prover, used by statement-core's tests.

The repository is shared with Humanity; the [root README](../../README.md) maps it and says what a
run needs, and [CONTRIBUTING.md](../../CONTRIBUTING.md) lists the checks.

Paths below that start with `app/`, `components/`, `lib/` or `public/` are in this
folder; every other path is from the repository root. Run the commands from the root:

```bash
npm ci
npm run dev                    # the Next app
npm run dev:host               # …hosted by a local truapi-host
npm run test:statement-core    # engine tests, individually…
npm run test:game-chain
npm run test:engines           # …or both
```

## Networks and local builds

`NEXT_PUBLIC_NETWORK_NAME` is required: `paseo`, `previewnet` or `local`. There is no
default network. `paseo` and `previewnet` use the endpoints and backends built into
`packages/jollity-protocol/src/config.ts`; the [env example](.env.example) selects
`previewnet`. Only the exact value `local` selects local mode.

Put settings in `apps/jollity-app/.env.local`. The Next app reads this folder's env
files. The chat worker reads them only when the network is `local`; for `paseo` and
`previewnet` it reads exported shell variables only. Exported shell variables take
precedence, as they do for `next build`. On `local`, all six values below are required
before either executable bundles, and checked again by the shared runtime config.
Missing, blank or malformed values throw an error naming the variable.

| Variable | Local value |
| :-- | :-- |
| `NEXT_PUBLIC_PEOPLE_WS` | Explicit People `ws://` or `wss://` endpoint |
| `NEXT_PUBLIC_PEOPLE_GENESIS` | People genesis, `0x` plus 64 hexadecimal characters |
| `NEXT_PUBLIC_ASSET_HUB_WS` | Explicit Asset Hub `ws://` or `wss://` endpoint |
| `NEXT_PUBLIC_ASSET_HUB_GENESIS` | Asset Hub genesis, `0x` plus 64 hexadecimal characters |
| `NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL` | Explicit identity/TURN backend, `http://` or `https://` |
| `NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS` | Nonempty comma-separated collection IDs on this Asset Hub, each an unsigned 32-bit integer |

URLs cannot contain credentials, whitespace or fragments. Values are trimmed and
validated genesis hashes are lowercased. These are public build settings, so credentials
belong in neither the URLs nor env values.
Local names use `.testnet` (`dim2.testnet`, `peopl.testnet`, `stash.testnet`), independently
of public previewnet. App engine and draw reads use the supplied WebSocket endpoints,
even inside a host; the draw skips its suffix-keyed public endpoint table. The name-link
root signature uses the SDK descriptor with the explicit local People genesis, so its
username-owner lookup runs through the host for that local chain. The QuickJS
worker uses the host provider for the explicit genesis hashes, without discovery.
Configure that host to serve these local chains; these variables do not configure the
host's RPC routes. Signing, personhood keys and storage still require a host.

The identity/TURN backend is required, because the personhood proof and the relay flow
work the same way locally. Point it at a service that knows these local People rings
and serves `/api/v1/turn/issue-with-proof`. Both executables build that proof against
the explicit local People genesis. TURN servers and credentials come only from that
backend's response; there is no hosted issuer fallback. STUN discovery uses the same
Google and Cloudflare servers as the hosted networks. Collectible art falls back to the
public Bulletin IPFS gateway (`paseo-bulletin-next-ipfs.polkadot.io`) when the host
preimage is unavailable or outside a host. The artwork bytes are content-hash checked
before display; this content gateway selects no chain. Local mode does not promise
offline WebRTC or artwork.

The collection list is the operator's local approval list. It bypasses the SDK's hosted
network registry, then filters the SDK's on-chain claimable collections to those IDs.
It does not create collections or make an unclaimable collection mintable. Keep the list
consistent with the Stash build that will mint these claims. Local mode needs no change
to the SDK package.

After setting the variables, build both executables:

```bash
npm run build
PRODUCT_DOTNS=local npm run build:chat
```

`PRODUCT_DOTNS=local` builds a never-deployed development worker that bakes no product
name, so its card buttons fall back to navigating to `/`. Chain fixtures, a host launcher for local, backend provisioning
and deployment are outside this mode; the deploy commands target `previewnet` and `paseo`
only.

## The app

A proof-of-personhood video game as a Polkadot PAPP: you play a round of
copy-the-gesture on camera with five strangers, vote on who was human, and the
chain decides the rest. Host-only — outside a Polkadot host container the app
shows a gate, with `NEXT_PUBLIC_PEOPLE_WS` as a read-only dev override.

| Route | What it is |
|---|---|
| `/` | The one home screen, descending through time bands: no game → scheduled → register → you're in → starting → waiting room → final minute |
| `/permissions` | The one-time gate — camera, network, peer connections, game messages |
| `/game` | 12 turns across 2 rounds. Copy the host, tap tiles to vote, confirm |
| `/chest` | The reveal: the bubble (carried in from the draw when you held there) finds your claims as they land, pops, and your collectables float in the frame wrapped in glass shells you break by hand. Broken-open pieces float up to the top; tapping one opens the hologram picker over it. Once every piece is open, the scene gives way to a grid of their cards. The collection picked there is kept in host storage, so the next visit deals the same item. Dragging the Pocket's cover across puts them away, and the screen hands you over to your Humanity card by itself |
| `/prize-draw` | The prize draw: the wheel replays the chain's draw and lands on its winners, and its timeline takes you back to any point of the spin. A won prize is claimed by itself. Holding anywhere gathers the draw into the collectables' bubble and carries it on to `/chest` |

### Architecture

See [docs/architecture.md](../../docs/architecture.md) for what runs where.

Two doorways, and everything else is downstream of them:

- **`lib/game-source.ts`** — the one doorway to chain state, over the
  `GameEngine` that `lib/engine.ts` (the only module that value-imports
  `@jollity/game-chain`) builds. Views (`GameStatus`, `ChestView`,
  `PrizeDrawView`) in, no papi out.
- **`lib/host/*`** + `lib/permissions.ts` — the host's capabilities: the
  permissioned name (`requestLogin` → `getUserId`), navigation between
  products, device and remote permissions.

Screens read one view value and render it. Animation logic is framework-free
and lives in `lib/` (`chest-scene/engine.ts`, `draw/wheel/*`, `draw/hold/*`,
`pocket/*`, `coin3d/*`, `wrapping/*`, `game-session.ts`); components are hosts that pass params and
forward gestures. The full rules, and the two working guides — UI vs. the
game — are in [AGENTS.md](AGENTS.md).

### Working on the UI

Start with `npm run dev`, then follow "Working on UI" and "Working on the game itself" in
[AGENTS.md](AGENTS.md).

## Deploying

A deploy publishes the **chain build**: the static export in `out/` and the chat worker,
with the manifest in [`deploy/`](../../deploy/bulletin-deploy.config.ts). The product name is
compiled into both, so build for the name you publish to: the deploy refuses a worker built for
another name. Set `DEPLOY_DOMAIN` to that name; `DEPLOY_TRUSTED_PRODUCTS` lists the products you
trust with this one's storage or context (none by default).

From the repository root, with `DOTNS_MNEMONIC` exported:

```bash
DOMAIN=<label>.testnet npm run deploy -- jollity previewnet
```

Previewnet serves `.testnet` names at `https://<label>.testnet.li`, and paseo serves
`.paseo` names at `https://<label>.paseo.li`. The script pins `bulletin-deploy` 0.25.0;
[`DEPLOYMENT.md`](../../DEPLOYMENT.md) has the networks, the settings and what each step does.

The deployed name is not just an address — it appears in three places and they
must agree, so set all three from one name:

- the manifest's `domain` (`deploy/bulletin-deploy.config.ts`), which the CLI
  compares against its positional argument verbatim
- `NEXT_PUBLIC_PRODUCT_DOTNS`, the key the host derives the **product account**
  from ([lib/game-source.ts](lib/game-source.ts)) — wrong name, wrong account,
  no signing
- the worker's baked-in copy, since a product cannot ask the host for its own
  identity at runtime

## Composition modes

| | standalone (browser / Node) | hosted (truapi container, via `@parity/product-sdk-host`) |
|---|---|---|
| chain access | `createPeopleClient(wsUrl)` | `createPeopleClientFromProvider(getHostProvider(genesisHash))` |
| statement store | `nodeStatementStore(rpc, prover)` | `getStatementStore` is a valid `ResolveStore` as-is; the app passes a store that proves as the player instead (`lib/host/statement-store.ts`) |
| signing | mnemonic `//candidate` keys | RFC-10 product account, host-side |

## `@jollity/statement-core` — API

### Signalling transport (the policy layer)

| Export | Kind | What it does |
|---|---|---|
| `statementTransport(options)` | function | Builds a `CreateTransport`: WebRTC signalling over the statement store — one desc statement per negotiation generation, coalesced+debounced candidate slot, generation gating, 2-slot submit backpressure, heartbeat presence + TTL, opt-in ECDH/deflate sealing |
| `StatementTransportOptions` | interface | `resolveStore`, `namespace`, `labelPrefix?` (default `"rtc"`; `"jollity:rtc-v2"` interoperates with builds that use the v2 label), `encrypt?`, `log?` |
| `CreateTransport` / `SignalTransport` / `SignalHandlers` / `TransportConfig` | types | The transport seam a WebRTC mesh consumes (`send`, `close`, `stats`; roster + signal callbacks) |
| `SignalStats` | interface | Health snapshot: submits ok/failed, frames sent/recv, inflight, sign timeouts, last error |
| `RtcPayload` / `isRtcPayload` | type / guard | The opaque SDP/ICE envelope relayed between peers |

### The store seam

| Export | Kind | What it does |
|---|---|---|
| `StatementStoreLike` | interface | What every policy layer talks to: `createProofAuthorized`, `submit`, `subscribe` — structurally equal to product-sdk-host's `HostStatementStore` |
| `ResolveStore` | type | `() => Promise<StatementStoreLike \| null>`; `getStatementStore` from product-sdk-host satisfies it directly |
| `nodeStatementStore(rpc, prover)` | function | Standalone implementation over the raw node RPCs with local signing |
| `WireStatement` / `StatementPage` / `StatementSubscription` | types | Hex-boundary statement shape and subscription types |
| `toHex` / `fromHex` | functions | Boundary conversions |

### Statement primitives (the native game clients' wire format)

| Export | Kind | What it does |
|---|---|---|
| `buildSignedStatement(prover, fields)` | function | Prove + SCALE-encode a statement, returns `{ statement, hash }` |
| `encodeStatement` / `decodeStatement` / `statementHash` / `encodeSignaturePayload` / `statementSizeForData` | functions | SCALE encode/decode and signing-payload helpers |
| `StatementProver` / `keypairStatementProver(keypair)` | interface / function | The proving seam + its local sr25519 implementation |
| `timestampExpiry` / `nextExpiry(previous, now)` | functions | Session expiry scheme |
| `StatementFields` / `StatementProof` / `SigningKeypair` / `DecodedStatement` | types | Field/proof shapes |
| `StatementData` / `encodeRequestData` / `encodeResponseData` / `decodeStatementData` | codec / functions | Request/response payload codec |
| `MAX_STATEMENT_BYTES` / `PROTOCOL_EPOCH_SECONDS` | constants | Wire limits |

### Node RPC layer

| Export | Kind | What it does |
|---|---|---|
| `createStatementRpc(transport, options?)` | function | `submit` (with retry on retryable rejections) + `subscribeStatements` over `statement_submit` / `statement_subscribeStatement` |
| `providerTransport(provider)` | function | Adapt a papi-style WS `JsonRpcProvider` into a `StatementRpcTransport` |
| `substrateClientTransport(client)` | function | Adapt an existing papi client (`_request`) — submit-only path |
| `SubmitResult` / `isSubmitSuccess` / `isChannelPriorityTooLow` | type / guards | Submit outcome handling |

### Shared submitter helpers

| Export | Kind | What it does |
|---|---|---|
| `nextSlotExpiry()` | function | Packed TTL+LWW slot expiry (strictly rising; each overwrite outranks the last) |
| `classifySignError` / `SIGN_TIMEOUT_PREFIX` | function / constant | Attribute a hung sign step to the signer, distinctly from store failures |
| `storeUnavailableError` / `isStoreUnavailable` / `STORE_UNAVAILABLE_PREFIX` | functions / constant | "Store never constructed" vs "submit failed", as data |
| `sha256` / `withTimeout` / `errMessage` | functions | Label hashing, timeouts, robust error stringification |
| `SUBMIT_TIMEOUT_MS` / `SIGN_TIMEOUT_MS` / `TTL_S` | constants | One tuning point for every submitter |

## `@jollity/game-chain` — API

The reads and builders themselves come from `@parity/product-sdk-individuality`:
the roster, reports, sign-up and its funds, and the game and player watches.
Claims come from `getClaims` in `@parity/product-sdk-nfts`. This package keeps
what the SDK does not do yet.

### Client and engine

| Export | Kind | What it does |
|---|---|---|
| `createPeopleClient(wsUrl?)` | function | papi client and typed api for the People chain over its own WebSocket, typed by the SDK descriptors |
| `createPeopleClientFromProvider(provider)` | function | Same over a caller-supplied provider (host bridge) |
| `createChainEngine(client)` | function | The protocol `GameEngine`, answered through the SDK |
| `PREVIEW_PEOPLE_WS` | constant | Default endpoint |
| `withCustomExtensions(options)` / `bindTx` / `withExtrinsicLogging` | functions | `VerifyMultiSignature` for a signer that holds its key, and transaction binding and logging |
| `PeopleApi` / `PeopleClient` / `WsConnectionStatus` | types | Typed api handles |

### Prize draws

| Export | Kind | What it does |
|---|---|---|
| `fetchAirdropDraw(s)` | functions | The draws of a game with every winning ticket and the prize decimals, which the SDK read leaves out |
| `claimEligibility` / `evaluateClaimEligibility` | functions | The personhood and attendance gates of a claim, per game |

### Game math (pure, no chain)

| Export | Kind | What it does |
|---|---|---|
| `calculateSnapshot` / `roundDuration` / `roundStart` / `gameDuration` | functions | Wall-clock game state machine (waiting-room / round / between-rounds / reporting) |
| `HOST_FULL_CYCLE` / `PRE_CONNECTION_TIME` / `WAITING_ROOM_AVAILABLE_BEFORE` / … | constants | Round timing |

### Keys

| Export | Kind | What it does |
|---|---|---|
| `commKeysFromEntropy` | function | Signalling keys from host-derived entropy (RFC-0007, hosted mode) |
| `CANDIDATE_PATH` / `GAME_ENCRYPTION_PATH` | constants | The derivation paths, byte-exact with the native game clients |

## Layout and conventions

See [AGENTS.md](AGENTS.md) for the structure, the hard rules, the test commands and the gotchas, and the root [AGENTS.md](../../AGENTS.md) for the rules both products share. The engines never import each other, the SDK pins move together, this app's tsconfig follows imports into the packages and the worker, and standalone scripts under the root `scripts/` are `.mts`.
