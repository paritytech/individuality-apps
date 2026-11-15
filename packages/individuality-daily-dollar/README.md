# @individuality/daily-dollar

The Daily Dollar, the same in every product: the people-airdrop draw and a
person's standing in it, and the registry core that keeps a product's draw
records (parsing untrusted storage, folding in the chain standing, the
registration gate, and the registration, scratch and cancel reducers). A
product instantiates the registry over its own record and keeps its own
defaults, planners, storage key and chain calls. Humanity and Jollity's chat
worker both use it.

## Entry points

`.` (`src/index.ts`):

- `draw.ts`: `claimableDraw`, `pendingRegistrations`, and the types
  `AirdropDraw`, `AirdropDrawStatus`, `AirdropParticipation`,
  `AirdropStanding`, `Hex32`.
- `registry.ts`: `createDailyDollarRegistry`, `COMMON_RECORD_FIELDS`,
  `DAILY_DOLLAR_REGISTRY_VERSION`, and the record and reducer types
  (`DailyDollarRegistry`, `DrawRecord`, `DrawRegistration`,
  `RegistrationOutcome`, `ScheduledNotification`, `TickResult` and others).

## Used by

`apps/humanity-app`, `packages/humanity-shared` and `apps/jollity-worker`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm. It has no dependencies and no peer dependencies.

Rules for changing this package: [`AGENTS.md`](AGENTS.md).

## Testing

From the repository root:

```bash
npm test -w @individuality/daily-dollar
npm run typecheck -w @individuality/daily-dollar
```

Both `npm run test:shared` and `npm run humanity:test` include these tests.
