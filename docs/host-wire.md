# Host compatibility

Both products talk to their Polkadot host over one wire: the frames of
`@parity/truapi`, which `@parity/product-sdk-host` bundles. This page says
which host to run against, what the tests pin, and how to read a host's logs
when a call fails.

## Match the host to the lockfile

`@parity/truapi` changes its frame envelope between minor versions (each
`0.x` minor can carry a new wire codec). A peer on another codec is refused
at the handshake: it is not negotiated in band. The first host call then
fails with `Malformed protocol error payload`, or with errors that read like
"not in a host" or like a denied permission.

So run the `truapi-host` CLI whose version is the `@parity/truapi` that
`package-lock.json` resolves:

```bash
node -p 'require("./package-lock.json").packages["node_modules/@parity/truapi"].version'
curl -fsSL https://raw.githubusercontent.com/paritytech/trinity-user-agents/main/scripts/truapi-host-installer.sh \
  | TRUAPI_HOST_VERSION=<that version> bash
export TRUAPI_HOST_NO_UPDATE=1   # keep the CLI's self-update from moving it
```

`npm run dev:host` and `npm run humanity:dev:host` read the same version from
the lockfile (`scripts/lib/truapi-host-version.mjs`). They print this install
command when no CLI is on `PATH`, and warn when the installed CLI's
major.minor differs from the lockfile's. Jollity's launcher also sets
`TRUAPI_HOST_NO_UPDATE=1` for the CLI it starts; Humanity's does not.

The same applies to the Polkadot app a player runs: a host whose truapi minor
differs from the products' may refuse them. The minimum host versions the
code relies on are listed in [`known-issues.md`](known-issues.md#minimum-host-versions).

## What the tests pin

`apps/jollity-worker/src/hostStack.test.ts` reads the lockfile and the
installed `@parity/truapi`, and fails when:

- a `@novasamatech/*` host package appears in the worker's or the app's
  manifest, in a source file at the top of `apps/jollity-worker/src` (not its
  subfolders) or anywhere in the lockfile (an older, incompatible host stack);
- the workspace resolves more than one `@parity/product-sdk-host` or more
  than one `@parity/truapi`, since the app and the worker share one wire;
- `@parity/truapi` is not the pinned version;
- `TRUAPI_CODEC_VERSION` or `TRUAPI_WIRE_SCHEMA_HASH` changes;
- truapi stops throwing a `RangeError` when it decodes the `HostInfo` answer
  of an older host. The app (`readHostInfoResult`) and the worker
  (`hostInfo`) label an older host by that error.

`apps/jollity-app/lib/contracts/host-wire.test.ts` also checks that the
`@parity/truapi` that `@parity/product-sdk-host` declares is the one the
lockfile resolves.

When a deliberate SDK bump turns these red, move the pins in the same change,
for the app and the worker together, and install the matching CLI. The SDK
packages themselves are pinned exactly at the root's version
(`apps/jollity-app/lib/contracts/sdk-contract.test.ts`).

A green test means the bundled stack agrees with itself. It does not prove
that a given host speaks the same bytes: the native mobile hosts implement
parts of the host API in their own code, so the same version number does not
guarantee the same encoding. When a call fails against a paired phone, read
the full decode error, find the field it names, and compare that type in the
host's implementation.

## Reading host logs

**Polkadot Desktop** forwards every product's console to its log file
(`~/Library/Logs/polkadot-desktop/polkadot-desktop.log` on macOS). Worker
lines are tagged `[sandbox:<product>.<tld>]` and app lines `[<product>.<tld>]`,
so `grep` beats DevTools when one broken worker writes thousands of lines a
minute:

```bash
LOG=~/Library/Logs/polkadot-desktop/polkadot-desktop.log
grep -a "\[permissions\]" "$LOG" | tail
grep -a "Transport error" "$LOG" | sed -E 's/.*\[sandbox:([^]]*)\].*/\1/' | sort | uniq -c
grep -a "\[truapi\] auth state" "$LOG" | tail
```

- **The file keeps only the first line of each entry.** A decode error that
  names the offending field several levels down reaches the log as its first
  line only. The full chain is in the product's own DevTools console.
- **A `Disconnected → Connected` auth-state cycle** means every webview open
  across it holds a dead channel. It times out waiting for
  `window.__HOST_API_PORT__` until it reloads.
- **App or worker?** Stack frames through `module-asyncify` or
  `emscripten-module` are QuickJS, so they come from the worker.

**The `truapi-host` CLI** (`npm run dev:host`) writes its log to the terminal
it runs in, interleaved with `next dev`'s.

## Hand-written mirrors

The worker's tests check its chat icons with `isAcceptableChatIcon`
(`apps/jollity-worker/src/state.ts`), a hand-written copy of the host's own
icon rule. It catches regressions on this side, not a change in the host.
Prefer an exported rule from the host or the SDK over a copy when one exists.
