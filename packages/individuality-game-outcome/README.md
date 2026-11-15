# @individuality/game-outcome

What a game gave the player, as it lands on the People chain: the player's
attendance (decided early, or at the settle), the wait for the settle, reads
repeated before it, and the credits the game earned. Which collectable a
credit becomes, and its art, stays in the product. Jollity's app, its chat
worker and the chain report scripts use it.

## Entry points

- `.` (`src/index.ts`), pure reads with no SDK in the import graph:
  - attendance: `attendanceInGame`, `attendanceStatus`, `deriveAttendance`,
    `attendanceWatch`;
  - the settle: `settleWait`, `isSettled`, `SETTLE_POLL_MS`,
    `SETTLE_TIMEOUT_MS`;
  - reads before the settle: `readBeforeSettle`, `readUntilSettle`,
    `BEFORE_SETTLE_REREAD_MS`, `UNTIL_SETTLE_BACKSTOP_MS`;
  - credits: `gameCredits`, with the types `Credit`, `CreditState`,
    `GameCredits`.
- `./chain` (`src/chain/index.ts`): `readGameCredits` and `claimsChain`, the
  credits read on the chain pair the nfts SDK reads. It is a subpath of its
  own so that a screen that only needs the pure reads does not bundle the
  nfts SDK.

## Used by

`apps/jollity-app` and `apps/jollity-worker`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm. Peer dependencies: `polkadot-api` and `@parity/product-sdk-nfts`.

Rules for changing this package: [`AGENTS.md`](AGENTS.md).

## Testing

From the repository root:

```bash
npm test -w @individuality/game-outcome
npm run typecheck -w @individuality/game-outcome
```

`npm run test:shared` runs the tests of every `individuality-*` package.
