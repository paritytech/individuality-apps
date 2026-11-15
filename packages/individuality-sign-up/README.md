# @individuality/sign-up

Signing a player up for a People chain game, the same from every surface. The
product SDK (`@parity/product-sdk-individuality`) decides the seat and its
route, binds the free seat and files the sign-up with its draw entries; this
package is what a product does around those calls: the gates before a sign-up
goes, the retry policy and the words of its failures, the registration record
another surface reads, the communication key, and Jollity's draw rule. The
Jollity app, its chat worker and Humanity's card all run the same flow.

## Entry points

- `.` (`src/index.ts`):
  - the flow: `createSignUpFlow`, with `SignUpFlow`, `SignUpFlowOptions`,
    `SignUpStep`, `SignUpJourney` and related types (`sign-up-flow.ts`);
  - the retry policy: `signupWithRetry`, `startSignupRetry`,
    `stepSignupRetry`, `classifyRetry`, `backoffMs` and its constants
    (`signup-retry.ts`);
  - the seat and its funds: `namedSeat`, `SeatUnfundedError`, `shortfall`,
    `formatAmount`, `BIND_TIMEOUT_MS`, `readSequence`;
  - the game reminder: `remindNextGame`, `cancelNextGame`, `askUnderWay`,
    `askUnderClaim`, `joinAtMs`, `JOIN_LEAD_S`;
  - draw tickets: `drawResult`, `drawTicketCanPay`, `gamesToMembership`;
  - the communication key: `freshCommunicationKey`, `communicationKeyFrom`,
    `communicationKeyRecord`, `reusableCommunicationKey` and related helpers;
  - `signupFailureReason`.
- `./chain` (`src/chain/index.ts`): `signUpFlowChain`, the SDK's game
  registration in the shape the flow reads, and `verifyVrf`, the check of a
  draw ticket's VRF. A subpath of its own so the pure gates do not bundle the
  SDK and papi.
- `./failure` (`src/signup-failure.ts`): `signupFailureReason` alone.
- `./reminder` (`src/reminder.ts`): the reminder helpers alone, plus
  `hostPillUp` and `HOST_PILL_LEAD_S`.

## Used by

`apps/jollity-app`, `apps/jollity-worker`, `apps/humanity-app`,
`@jollity/game-chain` and `@jollity/protocol`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm. Peer dependencies: `polkadot-api` and
`@parity/product-sdk-individuality`.

Rules for changing this package: [`AGENTS.md`](AGENTS.md).

## Testing

From the repository root:

```bash
npm test -w @individuality/sign-up
npm run typecheck -w @individuality/sign-up
```

`npm run test:shared` runs the tests of every `individuality-*` package.
