# @individuality/name-link

The player's name on the prize draw: the DotNS reader of a username and its
note, the link of that name to the playing account (with its deposit in PGAS
or the native deposit), and the gate a sign-up waits on until the name is
linked. `@individuality/sign-up` takes the gate, the Jollity app reads names
for the draw wheel, and both products link a player's name through it.

## Entry points

`.` (`src/index.ts`):

- `dotns-names.ts`: `dotnsNames`, `peopleNames`, `usernameOwner`,
  `fullUsernameSet`, `reviveCall`, `DOTNS_CONTRACTS` (the pinned CREATE3
  addresses of the DotNS contracts, the same on every supported network),
  and the types `NameLookup`, `NameReason`,
  `PeopleName`, `ContractCall`.
- `link.ts`: `linkName`, with `LinkOutcome`, `LinkStage`, `NameLink`.
- `name-gate.ts`: `createNameGate`, its timing constants
  (`NAME_LINK_GRACE_MS`, `NAME_LINK_TIMEOUT_MS`, `NAME_TAP_RETRY_MS`,
  `NAME_TAP_WAIT_MS`, `NAME_UNOWNED_RECHECK_MS`, `NAME_UNOWNED_RETRY_MS`) and
  its types (`NameGate`, `NameGateOptions`, `NameLinkResult`,
  `NameLinkTrigger`).

## Used by

`apps/jollity-app`, `apps/jollity-worker`, `apps/humanity-app` and
`@individuality/sign-up`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm. Peer dependencies: `polkadot-api`, `@polkadot-api/signers-common` and
`@parity/product-sdk-individuality`.

Rules for changing this package: [`AGENTS.md`](AGENTS.md).

## Testing

From the repository root:

```bash
npm test -w @individuality/name-link
npm run typecheck -w @individuality/name-link
```

`npm run test:shared` runs the tests of every `individuality-*` package.
