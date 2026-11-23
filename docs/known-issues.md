# Known issues and limits

What the products cannot fix on their own side and handle on purpose: host
behaviour they work around, limits of the design, and the host versions the
code relies on. Each entry says what the player sees, why, and where the code
handles it, so it can be removed once the cause is gone.

Paths under `lib/` are in `apps/jollity-app/`.

## Host behaviour the apps work around

**The host loses its chain subscription.** Some hosts drop the chain
subscription at boot, and every host drops it while the app sits in the
background, reconnecting within a minute or so of the return. Jollity shows a
restart card. A loss seen soon after a return from the background waits like
a network switch before it advises anything. From the second app open in a
row that finds the chain lost, the card stops prescribing a plain restart and
says to switch to mobile data and close the app fully.
`lib/chain-health.ts`, `lib/chain-lost-streak.ts`, `lib/background-return.ts`.

**The host's channel to the page dies.** The bridge is one `MessagePort`;
once it closes, later host calls hang or fail until a reload attaches a fresh
port. Jollity reloads the page when the channel has stayed down for 2 s
(`HOST_RELOAD_GRACE_MS` in `lib/game-source.ts`).
The reloads Jollity starts for a dead channel, a long suspension or a product
the player left share one budget of 3 per 10 minutes, counted in session
storage, so a channel that keeps dropping cannot reload the page forever
(`lib/self-reload.ts`). A crash reloads outside that budget, on its own
backoff (`lib/crash-reload.ts`).

**A product cannot close itself.** The host offers no call for it, and the
Android host brings a tab back as it was. After the chest hands the player to
their Humanity card, the first return to Jollity starts the app over at the
home on a fresh load (`lib/start-over.ts`).

**A host call can go unanswered.** truapi gives up on a request only after
120 s, and `@parity/product-sdk-host` does not pass that failure, or its
answer to a call truapi rejects, on to the caller. So every host call is
bounded, and a deadline counts as a refusal:
- chain reads get 15 s per attempt and two retries (`lib/read-retry.ts`);
- the sign-up's host reads and route steps have their own deadlines
  (`packages/individuality-sign-up/src/sign-up-flow.ts`);
- the worker bounds each sign-up host call at 30 s (`boundedHostCall` in
  `apps/jollity-worker/src/host.ts`).

This was last confirmed on product-sdk-host 0.24. The workspace pins 0.35.0
today and has not been rechecked, so recheck it when the SDK moves. The bounds
are harmless once the SDK forwards the failures.

**`openLink` overrides a host refusal.** When the host's `navigateTo` throws
(it refused or failed), `openLink` in `lib/host/navigate.ts` navigates the
webview itself (`window.location.href = url`), inside a container too. Its one
caller passes links the app builds (the Humanity card, a Pocket card), so this
is not an open redirect today. A fork that passes a link from anywhere else
(a URL, storage, another product) should restrict the fallback to "not in a
container".

**iOS `navigateTo` drops the path.** Older iOS hosts open a product's root
whatever path the link carries, and silently ignore a relative link. The chat
worker therefore navigates by the product's own DotNS name, and hands the
tutorial request to the app through host storage (`TUTORIAL_KEY`) for hosts
that drop the path (`apps/jollity-worker/src/state.ts`).

**iOS draws a Secondary button white on white** on a chat card. The worker
sends every button as Primary and keeps the variant in its tree
(`apps/jollity-worker/src/renderer.ts`).

**The host reads worker JavaScript as Latin-1**, and caps a chat icon at
64 KiB. The worker bundle is built ASCII-only and the icon's size is checked
at build time (`apps/jollity-worker/scripts/build.mjs`).
`isAcceptableChatIcon` in `apps/jollity-worker/src/state.ts` mirrors the
host's whole icon rule for the worker's tests.

## Limits of the design

**Web and native players cannot share a group.** The native game clients of
the Polkadot app are discontinued, but the wire keeps their shape
(`lib/webrtc/mesh.ts`). One turn is 2 + 8 + 2 s on both, but the web plays one
turn per seat of the group cap, so a round always lasts
`HOST_FULL_CYCLE × max_group_size`, while the native clients played one turn
per player and stretched each turn to fill the round. The two would disagree
on who hosts when (`packages/jollity-game-chain/src/game/constants.ts`).

**TURN needs a personhood proof.** The TURN issuer
(`/api/v1/turn/issue-with-proof` on the network's device-uniqueness backend)
takes a proof from the host. A device that cannot prove gets STUN only, which
in practice connects only peers on one LAN (`lib/webrtc/ice.ts`). See
[deploying.md](deploying.md) for the backend a build uses.

**Statement proofs use a deprecated host call.** Jollity proves its
signalling statements as the player with `truApi.statementStore.createProof`,
which is deprecated upstream in favour of the authorized path. The pallet
gives the statement allowance to the player's account, not the product's, so
the authorized path does not fit yet (`lib/host/statement-store.ts`). A host
that removes `createProof` breaks in-game signalling.

**Humanity signs one proof unwatermarked.** The lite username upgrade and the
DotNS claim sign 32 raw bytes with deprecated host calls, because the runtime
does not yet accept a watermarked proof. The module's security note says why
it is safe there and what to do when the calls go
(`apps/humanity-app/src/features/card/chain/sign-lite-identity-proof.ts`).

**The Daily Dollar in Jollity's chat has three limits** (by design for now):
the worker never binds the person's alias (Humanity does, when it is opened);
its registry lives in Jollity's storage, apart from Humanity's; and the
scratch happens in Humanity (`apps/jollity-worker/src/daily-dollar/worker.ts`).

**Host reminders exist only for `dim2`**, and the products' ids are fixed. See
[deploying.md](deploying.md#product-names-are-protocol-ids).

## Minimum host versions

| Feature | Needs | Below it | Where |
| :-- | :-- | :-- | :-- |
| Any host call | a host on the lockfile's `@parity/truapi` minor (0.32 today) | the handshake fails: `Malformed protocol error payload` | [host-wire.md](host-wire.md) |
| Sign-up and every signed transaction, card button presses, the prize top-up, the room footer | a host on truapi 0.32 | the host cannot read the V2 request, so the call fails | `apps/jollity-worker/src/hostStack.test.ts` |
| Jollity's transactions (sign-up, report) with the SDK's stock signer | truapi-host 0.23.0 | older hosts assembled the transaction one slot short | `lib/game-source.ts` |
| Cross-product grants (`trustedProducts`) read from a manifest | truapi-host 0.17.0, and bulletin-deploy 0.19.0 to write them | no grants: the host refuses one product the other's keys (Jollity's free seat, the Daily Dollar in Jollity's chat) | `apps/humanity-app/deploy/bulletin-deploy.config.ts` |
| Humanity's lite identity proof signed by its own product account | truapi-host 0.17 | falls back to the legacy-account call, which prompts | `sign-lite-identity-proof.ts` |
| The host's version in logs and telemetry | truapi 0.27 | reported as "older than truapi 0.27" | `lib/host/host-info.ts`, `apps/jollity-worker/src/host.ts` |
