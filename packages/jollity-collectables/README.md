# @jollity/collectables

The collectables of a Jollity player: which claims the player holds, the item
each one would mint in every collection it can be claimed from, the item's
rarity, and the verified art. The app draws this on its chest screen and the
chat worker on the results card, so both read it from one place and never
disagree. Nothing here imports React or a host; the caller passes how art is
read.

## Entry points

`.` (`src/index.ts`, which re-exports every module):

- `chest.ts`: `readChest`, `readChestPinned`, `ChestReadError`, and the types
  `ChestView`, `ChestItem`, `ChestChoice`, `ChestRarity`, `ChestLog`,
  `ScarcityChain`, `ReadChestOptions`. Reads go through
  `@parity/product-sdk-nfts`, pinned to one Asset Hub block.
- `picks.ts`: the collection picked for each claim, under Jollity's key and
  the Stash's, whose picks win (`JOLLITY_PICKS_KEY`, `STASH_PICKS_KEY`,
  `parseChestPicks`, `collectionFor`, `defaultCollectionFor`, `indexFor`,
  `chestValue`, `normalizeCreditHash`, `storedJSON`).
- `with-picks.ts`: `withPicks`, `canChangePick`.
- `rarity.ts`: `DEFAULT_RARITIES`, `parseRarities`, `rarityName`,
  `compareRarities`, `effectiveRarities`, `rarerThanCommonest`, `Tier`.
- `manifest.ts`: `manifestPicture`, `ManifestAsset`.

## Used by

`apps/jollity-app` and `apps/jollity-worker`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its main entry is `src/index.ts`); it is not published to
npm. It depends on `@jollity/protocol` and `@parity/product-sdk-nfts`. It has
no typecheck script of its own; the app's and the worker's typechecks compile
it through their imports.

## Testing

From the repository root:

```bash
npm run test:collectables
```

The root `npm test` does not include these tests; run the command above
separately.
