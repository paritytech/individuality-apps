# Cross-product game registration (bind via PeopleLite, sign-up via DIM2)

How a person gets into the weekly game when the game (Jollity, `dim2.<tld>`)
and the personhood card (Humanity, `peopl.<tld>`) are two products. The flow
is specified in
[product-sdk#354](https://github.com/paritytech/product-sdk/issues/354) and
shipped in `@parity/product-sdk-individuality` 0.4.0. Each product runs its
own legs; neither signs a transaction as the other.

## The flow

Three legs, split across the two products by design:

1. **Bind — Humanity (`peopl.<tld>`) runs this.**
   `PeopleLite.set_alias_account(account, valid_at_block)` is an
   **unsigned** V5 general extrinsic with origin `None`, authorized by a
   `PeopleLiteAuth::AsLiteAliasWithProof` minted from `Score.score_context`.
   `account` is a plain call parameter, not a signer: Humanity submits an
   unsigned, proof-authorized call that vouches for DIM2's account address.
2. **Sign-up — the game (`dim2.<tld>`) runs this.**
   `Game.sign_up_with_account_lite_invite(account, identifier_key, airdrops)`
   must be **signed by `account`** itself, under
   `AsLiteAliasWithAccount(nonce)`. `Game.CommunicationIdentifiers[account]`
   binds the communication key to whoever plays, i.e. DIM2's account, so
   Humanity never generates or owns that key.
3. **Register — once the score is in.** `Score.register` follows after play
   produces a score, completing the loop back to the `score_context` that
   authorized the bind in leg 1.

## Why Humanity cannot sign the sign-up itself

The host refuses a transaction signed with another product's account. A
`create_transaction` call from the Humanity session with signer
`ProductAccountId { dot_ns_identifier: "dim2.<tld>", derivation_index: … }`
fails at once with `Domain.V1.PermissionDenied`: no prompt is shown, and the
call is rejected before any permission or confirmation step. The host checks
that the signer's DotNS identifier is the calling product's own (or the
`localhost` dev wildcard) first, and unconditionally. `sign_raw` and
`sign_payload` are gated the same way, and AutoSigning covers only the
calling product's own accounts.

The one way past that check is a grant from the account's owner (below).
Without one, only a session running as the DIM2 product can produce a
signature the host accepts for the sign-up, and only that product holds the
communication key.

## Grants: `trustedProducts`

RFC-0024 restricts a foreign product's use of another product's keys
(`createAccountProof`, `ringVrfSign`, and acting as its account) to the
products the owner lists in its root manifest under `trustedProducts`.
Hosts on `truapi-host` 0.17.0 or newer resolve it from the on-chain
manifest, and `bulletin-deploy` 0.19.0 or newer writes it.

- `context` lets the named product act as the owner's account: its identity,
  signatures and ring-VRF proofs.
- `storage` lets it read the owner's host storage.

For the game, Humanity's manifest grants `dim2` `context` (and `storage`),
so the game can mint the lite person's proof with `peopl`'s key and a lite
person signs up from the game in one tap instead of hitting
`NotAllowlisted`. A grant is one-directional: it says what the named product
may do *to* the owner, nothing about the reverse. Humanity's own bind leg
still runs as `peopl.<tld>`.

### What a deployer configures

- Set `HUMANITY_TRUSTED_PRODUCTS` when deploying Humanity, for example
  `{"dim2":["context","storage"]}`. Unset, a deploy grants nothing
  ([README](../README.md#product-manifest)).
- The grant takes effect on a network once a deploy that carries it has
  landed there; hosts cache the manifest for a while
  ([data-flow.md](data-flow.md)).
- Keys are bare labels (`dim2`, never `dim2.paseo`). Grant only products you
  own or trust: whoever owns a label on that network controls what it runs.
- A game served under another name than `dim2` needs grants for that name,
  and from `dim2`'s owner to play as `dim2`'s account; see
  [`docs/deploying.md`](../../../docs/deploying.md) at the repository root.

## RFC position

The RFCs live at https://github.com/paritytech/truapi under `docs/rfcs/`
([index with statuses](https://github.com/paritytech/truapi/blob/main/docs/rfcs/_index.md)).
They explain why transaction signing stays product-local:

- **[RFC-0020 create_transaction](https://github.com/paritytech/truapi/blob/main/docs/rfcs/0020-create-transaction.md) (accepted)**:
  the signer is a typed `ProductAccountId`, and delegation signs only for
  the caller's own product account.
- **[RFC-0022 account derivations](https://github.com/paritytech/truapi/blob/main/docs/rfcs/0022-account-derivations.md) (draft)**:
  keys at `//product//{productId}/{index}`, with a **hard** junction at
  `//{productId}` as the firewall between products. This is why Humanity
  never generates or holds DIM2's communication key.
- **[RFC-0010 allowance/AutoSigning](https://github.com/paritytech/truapi/blob/main/docs/rfcs/0010-allowance.md) (accepted)**:
  AutoSigning hands over only the calling product's subtree key; allowance
  accounts are separate hard derivations for submission and fees.
- **[RFC-0023 sign_vrf](https://github.com/paritytech/truapi/blob/main/docs/rfcs/0023-account-sign-vrf.md) (draft)**:
  allows cross-product VRF signing behind a prompt. A VRF signature is not a
  transaction signature, so it cannot stand in for the sign-up.
- **[RFC-0024 personhood](https://github.com/paritytech/truapi/blob/main/docs/rfcs/0024-personhood-as-product.md) (draft)**:
  cross-product use of ring-VRF member keys through the owner's
  `trustedProducts` allowlist, with no prompt fallback.
- **[RFC-0002 permission model](https://github.com/paritytech/truapi/blob/main/docs/rfcs/0002-permission-model.md) (accepted)**:
  `RemotePermission::ChainSubmit` gates broadcasting only; it cannot
  authorize signing with another product's key.

## Summary

| Mechanism | Cross-product? | Produces a transaction signature? |
| :-- | :-- | :-- |
| `create_transaction` / `sign_raw` / `sign_payload` | Only with the owner's `context` grant | Yes |
| `sign_vrf` (RFC-0023, draft) | Yes, with a prompt per call | No (VRF only) |
| Ring-VRF / personhood keys (RFC-0024) | Yes, with the owner's `context` grant, no prompt | No |
| AutoSigning (RFC-0010) | No, own subtree only | Own product only |
| Allowance / allocations (RFC-0010) | No, per-product fee and submit keys | No |
| `ChainSubmit` permission | Not applicable (broadcast only) | No |

RFC-0022, 0023 and 0024 are drafts and may change this picture.
