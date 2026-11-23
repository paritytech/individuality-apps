# Claiming a username against a local host

How the lite→full username claim works, and how to run it end to end against a stock
`truapi-host` CLI. No patched host and no local host build are involved.

## Requirements

- `truapi-host` on PATH, at the version of `@parity/truapi` in `package-lock.json` (they ship in one
  trinity-user-agents release and speak one wire codec; `npm run humanity:dev:host` warns on a
  skew). The proof below needs the unwatermarked signing calls added in
  [trinity-user-agents#731](https://github.com/paritytech/trinity-user-agents/pull/731).
- Nothing unreleased: the SPA calls those signing methods on the truAPI client itself, so no
  `@parity/product-sdk` change is required. The lockfile resolves a single `@parity/truapi`
  `0.32.0` copy, the one `@parity/product-sdk-host` 0.35 also resolves to, and
  `apps/jollity-worker/src/hostStack.test.ts` fails on a second. One copy matters: two
  would give the Desktop webview two `MessagePort` handler sets.
- A disposable identity. Claiming a name permanently links the lite and full identities in public.
  Never paste a real wallet mnemonic into logs, issues, or this document.

## How the proof is produced

`Resources.register_person` takes `lite_identity_proof`: the account that owns the current lite
username signing the **raw 32-byte Resources alias** of the account that submits the call. The
host's ordinary message signing wraps its payload in `<Bytes>…</Bytes>`, which the runtime rejects
until it accepts a watermarked proof, so the claim uses the host's unwatermarked signing call
instead:

- `resolveUpgradeAccounts` (`features/card/chain/username-upgrade-preflight.ts`) resolves the lite
  owner, then exposes `signLiteIdentityProof`, which calls
  `signLiteIdentityProofUnwatermarked` (`features/card/chain/sign-lite-identity-proof.ts`) →
  `truApi.signing.signRawUnwatermarkedDeprecated({ account: peopl.<tld>/0, payload })`, with the
  raw alias as the `{ tag: "Bytes" }` payload. The lite owner is `peopl.<tld>/0` (RFC-0028), so
  this signs without a prompt when the app runs as `peopl.<tld>`; on a `dev.peopl.*` subname or a
  preview the host refuses it with `PermissionDenied` and the function falls back to
  `signRawUnwatermarkedDeprecatedWithLegacyAccount({ signer, payload })`, which matches the signer
  by address against the session identity account (also `peopl/0`).
- `upgradeLiteUsername` (`features/card/chain/upgrade-lite-username.ts`) signs the alias through
  that function, then `verifyLiteIdentityProof` verifies the signature locally over the unwrapped
  alias. A host that still watermarks fails there with `incompatible-proof`, before anything is
  broadcast.
- The claim is submitted by the product account with `VerifyMultiSignature: Disabled` and the SDK's
  `withAsPerson(..., AliasWithAccount)`, which sets `RestrictOrigins` as the runtime requires.

The host call is deprecated upstream. It disappears once the runtime accepts a watermarked
proof; at that point `signLiteIdentityProof` reverts to the ordinary signer's `signBytes`.

## The dotNS half: `DotnsGateway.register_name`

`Resources.register_person` records the full username on the People chain, but dotNS on Asset Hub
is the source of truth for names: every host verifies a username it finds (DUB search, chat
contacts) against `DotnsGateway.AccountNames`, and People's copy is being removed. A name that only exists on People is one nobody can find. So the claim
has a second transaction, and it runs on its own whenever the live card shows a full username the
gateway does not hold — the claim just made here, or one made before the app registered names in
dotNS at all:

- `useDotnsNameClaim` (`features/card/hooks/use-dotns-name-claim.ts`) reads the gateway's record
  for the card's account in its own query (`readDotnsGatewayNames`, off the card's critical path)
  and fires `claimDotnsName` (`features/card/chain/claim-dotns-name.ts`) when `full` is empty. The
  gate is `dotnsClaimGate` (`features/card/domain/dotns-name-claim.ts`): one attempt at a time, a
  30 s backoff after a transient failure (`host-missing`, `ring-not-synced`, `proof`, `signing`,
  `timeout`, `finalized-error`), no retry after `not-lite-owner` or `account-already-registered`.
- `registerDotnsName` (`@humanity/shared/chain/dotns-gateway/register-name.ts`) does the chain
  work: it checks `LiteLabelOwner[lite] == who` and that `who` holds no `AccountAlias`, builds the
  ring-VRF proof in the `dotnsGateway` personhood context over
  `blake2_256(SCALE((who, label, Link::LiteUsername(lite))))` (`proof-message.ts`), waits for
  Asset Hub's `MembersSubscriber.RingRoots` to hold the People ring revision the host built the
  proof against, and submits a **General (v5) transaction** authorized by the `AsDotnsGateway`
  extension (`as-dotns-gateway-signer.ts`): `RegisterFullName { proof, ring_index, revision,
  signature }`, where `signature` is the lite owner's sr25519 signature over the blake2-256 of the
  inherited implication, produced by the same unwatermarked signing call as the People proof. The
  wrapped product-account signer signs nothing: `VerifyMultiSignature` is `Disabled`,
  `RestrictOrigins` is `true`.
- Debug → Actions → "Register dotNS name" runs the same attempt by hand and shows the gateway's
  lite/full labels, the gate's last decision and the stored claim record.

Verified on paseo-next-v2 for an identity that had claimed through the old path: the
transaction left `AccountNames[who] = { lite: <name>.NN, full: <name> }`, and the DUB result for
the full name then passed the hosts' dotNS check.

## Reproduce on paseo-next-v2

1. Install dependencies and start the SPA against a local host with a fresh session:

   ```sh
   npm ci
   truapi-host --version                 # must match the lockfile's @parity/truapi version
   HOST_SESSION=username-claim-demo npm run humanity:dev:host -- --network paseo-next-v2
   ```

   A new `HOST_SESSION` value is a fresh wallet; reusing one restores the same wallet. Wait for the
   lite registration and ring setup, then open the app URL the script prints. Ports are picked
   automatically.

2. Open `<printed-app-url>/#/claim-username`. Before faucet promotion it must show "Your Humanity
   name isn't ready to claim yet."

3. Read the full-personhood public key registered for this exact app session, in the SPA's DevTools
   console. `host-api.ts` lives in `@humanity/shared`, outside the app's Vite root, so the dev
   server serves it under the `/@id/` prefix:

   ```js
   const { getAccountsProvider } = await import('/@id/@humanity/shared/chain/host-api.ts');
   const accounts = await getAccountsProvider();
   const keys = await accounts.listRingVrfKeys('peopl.paseo', 'PublicKey').match(
     value => value,
     error => { throw error; },
   );
   keys.map(key => ({
     rings: key.rings,
     publicKey: key.publicKey && '0x' + Array.from(key.publicKey,
       byte => byte.toString(16).padStart(2, '0')).join(''),
   }));
   ```

   Choose the entry for the full-People collection (the ring location `ring-membership.ts` uses).
   If there is no entry, investigate the host error; never substitute an unrelated account's public
   key. Disclosing the public key may need host approval.

4. Submit that key to a Membership (full-personhood) faucet for the network, if the network
   offers one — as a **Bandersnatch** public key — and wait until it is finalized and in the ring.
   Do not use a lite-personhood faucet.

5. Reload the dedicated claim route. It now offers the name form, with the lite name minus its
   numeric suffix prefilled and editable; no game score is required. Availability is checked on
   submission, not while typing, so a name that is owned or sitting in the reservation queue is
   rejected with "That name is taken. Try another." and leaves the form editable. Names are 6–32
   lowercase ASCII letters.

6. Click **Claim this name** and approve the host's requests. The host shows a stronger warning for
   the unwatermarked signature than for ordinary message signing. The field and button lock until
   the transaction finalizes; a sent/pending notification is not success.

   If the Resources alias is not bound yet, the claim binds it first and reuses it on any retry.

## Verifying a claim

A complete pass needs all of:

- A finalized `Resources.register_person` with `Resources.PersonRegistered`.
- `Resources.UsernameOwnerOf(newName)` equal to the original lite owner's address.
- `Resources.Consumers(liteOwner).full_username` equal to the new name, `credibility = Person`,
  `demoted = false`.
- `Resources.AccountOfAlias(resourcesAlias)` equal to the lite owner.
- **Back to Humanity** shows the new name, and reloading `/#/claim-username` reports "You already
  have a full Humanity name." with no form and no duplicate transaction.

The card reads the finalized linked name from `Resources.Consumers` rather than the host's
`getUserId`, because the host may keep returning the cached lite username after the claim
finalizes. That is an upstream host issue the SPA compensates for; nothing about the session is
faked.

Home auto-routing opens the claim subscreen for game-qualified members, after any available Daily
Dollar scratch action. Faucet-only ring eligibility is resolved on the dedicated claim page, not on
home, so use the explicit hash route for a faucet-only demo.

## Runtime and host references

- The Resources pallet's `register_person_inner` verifies the signature against the unwrapped
  alias and otherwise returns `InvalidProofOfOwnership`.
- The People runtime wires `OffchainSignature` to `Signature` (`people.rs`), ultimately
  `sp_runtime::MultiSignature`: there is no app-specific wrapped-message verifier.
- The deprecated unwatermarked calls stay until the runtime accepts a watermarked proof; that is
  their permanent replacement.
