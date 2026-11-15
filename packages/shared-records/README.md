# @individuality/shared-records

The records Jollity and Humanity share: the ones one product keeps in its host
storage for the other to read through a `trustedProducts` storage grant. Both
products import each record's shape, storage key and lifetimes from here, so
neither mirrors the other. The package depends on neither product and on no
host SDK; each product hands the store its own storage handle.

## Entry points

`.` (`src/index.ts`):

- `game-registration.ts`: the game registration record a surface writes while
  a sign-up is on its way, so another surface does not start a second one.
  `GAME_REGISTRATION_KEY`, its lifetimes (`REGISTERING_TTL_MS`, `SENT_TTL_MS`,
  `ENDED_TTL_MS`, `REGISTRATION_WATCH_MS`, `MAX_CLOCK_SKEW_MS`),
  `registrationInFlight`, `liveGameRegistration`, `latestGameRegistration`,
  and the types `GameRegistration`, `RegistrationPhase`,
  `RegistrationSurface`.
- `game-registration-store.ts`: `gameRegistrationStore`, `decodeStoredJSON`,
  with `GameRegistrationStore` and `JSONStorage`.
- `game-timing.ts`: `TURN_SECONDS`, `ROUND_GAP_SECONDS`, `playEndsSeconds`,
  `registrationOpensSeconds`, with `GameClock` and `ScheduledWindow`.
- `communication-key.ts`: the stored communication key
  (`COMMUNICATION_KEY_KEY`, `COMMUNICATION_KEY_VERSION`,
  `parseCommunicationKey`, `matchCommunicationKey`, `communicationKeyStore`,
  `toHex`, `fromHex`).

## Used by

`apps/jollity-app`, `apps/jollity-worker`, `apps/humanity-app` and
`@individuality/sign-up`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its main entry is `src/index.ts`); it is not published to
npm. It has no dependencies. It has no typecheck script of its own; the
consumers' typechecks compile it through their imports.

## Testing

From the repository root:

```bash
npm run test:shared-records
```

A change here affects both products: run `npm test` and
`npm run humanity:test` as well.
