# Seity

A minimal product that shows, publishes and removes a person's **avatar** with
`@parity/product-sdk/profile`. It is the reference for adding avatars to
Humanity.

> **Standalone, on a dev SDK.** The profile module is only in
> `@parity/product-sdk@0.48.0-dev.537.1`. Seity has its own `package.json` and
> lockfile and is not a workspace of this repository, so neither product moves
> to a dev SDK. Fold it in once the module ships in a stable release.

## Run

Needs Node 24 and `truapi-host` 0.33.0, the version of `@parity/truapi` in the
lockfile:

```sh
curl -fsSL https://raw.githubusercontent.com/paritytech/trinity-user-agents/main/scripts/truapi-host-installer.sh | TRUAPI_HOST_VERSION=0.33.0 bash
```

```sh
cd apps/seity
npm install
npm run dev:host                         # paseo-next-v2; add -- --network previewnet for previewnet
```

The first run creates a test person, `seityavatar.NN`, which takes about a
minute. Wait for `Paired with …`, then open **http://localhost:5190/**. The host
accepts loopback origins only, so open it on this machine.

- **A fresh person:** `HOST_SESSION=<name> npm run dev:host`. The name needs at
  least 6 lowercase letters. Each session keeps its state in
  `.truapi-host/<name>/`; delete that folder to start that person over.
- **Without a host:** `npm run typecheck` and `npm run build`.

The launcher stops the CLI from updating itself (`TRUAPI_HOST_NO_UPDATE`),
because the CLI and the bundled `@parity/truapi` must speak the same wire
version.

## How it works

**Who signs.** The profile is a text record under the person's DotNS name, and
only the name's owner may write it. That owner is the identity account,
`peopl.<tld>/0` (RFC-0028). Seity runs as `peopl.<tld>`, as Humanity does, so
the identity account is its own account 0. It signs with the host's product
signer on transaction pipeline 1, so Asset Hub takes the fee in PGAS.

**Who pays.** The identity account pays the fee and the record's storage
deposit in PGAS. When it is short, Seity asks the host for a PGAS allowance on
account 0 (with Bulletin in the same request), then waits for it to land. No
other account and no transfer are involved.

**Publishing.** Publishing follows the SDK's order, with one check at each step:

1. read the record (`getProfileRecord`)
2. build the avatar entry and rewrite the record, keeping every other entry
   (`profileAvatar`, `rewriteProfileRecord`)
3. fund the account
4. dry-run the write (`prepareSetProfile`, which also refuses an account that
   does not own the name)
5. upload the image to Bulletin (`submitAvatar`)
6. read the record again, and stop if someone else changed it
7. submit and wait for inclusion (`submitAndWatch`; pass `waitFor: "finalized"` to wait
   out a reorg)
8. confirm the chain holds what was sent (`verifyPublishedProfile`)

Removing the avatar is the same, with `{ avatar: null }` and no upload.

**Reading.** `getProfile` answers `Found`, `NoProfile` (clear what you show) or
an error (keep what you show). `loadAvatar` fetches the image through the host
and checks it against its CID; no gateway is involved. Only its `Loaded` answer
carries bytes; anything else shows the placeholder.

## Files

| File | What it does |
| :-- | :-- |
| `src/profile/owner.ts` | the username and the identity account's signer |
| `src/profile/funding.ts` | the PGAS allowance, and the wait for it to land |
| `src/profile/publish.ts` | the publish and remove steps above |
| `src/profile/read.ts` | the current avatar |
| `src/profile/image.ts` | the image format, from the file's bytes (the SDK trusts the declared format; `profileAvatar` enforces the 2 MiB limit) |
| `src/chain.ts` | Asset Hub, the contract runtime, and PGAS balances |
| `src/host.ts` | the only import of `@parity/product-sdk/host` |
| `src/App.tsx` | the screen, which lists each publish step as it runs |
| `scripts/dev-host.mjs` | the local host launcher |

## Porting to Humanity

- `owner.ts` maps onto what Humanity has: its identity account from
  `resolve-lite-owner.ts`, signed with `getProductAccountSigner(account, { txExtVersion: 1 })`.
- Add `getPreimageManager` to `packages/humanity-shared/src/chain/host-api.ts`.
- Take `funding.ts`, `publish.ts`, `read.ts` and `image.ts` as they are, with
  Humanity's Asset Hub client in place of `chain.ts`.
- Show the image in `MemberCard`'s `.idcard-avatar`, keeping the initial
  letter while there is no avatar or it has not loaded.

## Limits

- Tested on `dev:host` with paseo-next-v2 only; not yet on a phone or Desktop
  host.
- No tests yet. The SDK's `examples/profile-example` has offline fixtures to
  start from.
- The build includes every network's chain metadata; Humanity strips it with
  `stripStaticMetadata` in its `vite.config.ts`.
- No deploy manifest; Seity runs only under `dev:host`.
