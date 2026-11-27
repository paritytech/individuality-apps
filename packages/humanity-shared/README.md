# @humanity/shared

The code both Humanity executables run: the app (`apps/humanity-app`) and the
worker that draws the Pocket card (`apps/humanity-worker`). It holds the
People chain client and reads, the personhood card's data and state, the
identity and product-domain rules, the Daily Dollar's chain side, the Pocket
card face, logging, telemetry and configuration.

## Entry points

There is no barrel. The package exports every source file by path
(`"./*": "./src/*"`), and consumers import the file they need with its `.ts`
extension, for example:

```ts
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
```

The folders under `src/`:

| Folder | What it holds |
| :-- | :-- |
| `chain/` | The People chain and Asset Hub clients, networks, ring and VRF reads, signing pipelines, transaction submission, the DotNS gateway |
| `card/` | The Humanity card's data, state and username claim |
| `identity/` | The product domain, the personhood ring key, the game account |
| `airdrops/` | The Daily Dollar's chain calls, registry and storage, over `@individuality/daily-dollar` |
| `pocket/` | The Pocket card face and its hand-off between the app and the worker |
| `renderer/` | The renderer-tree builders the Pocket face is drawn with |
| `config/`, `logging/`, `telemetry/`, `theme/`, `storage/`, `domain/`, `utils/` | Environment, logs, Sentry, the host theme, host-backed key-value storage, prize amounts, timeouts and a monotonic clock |

## Used by

`apps/humanity-app` and `apps/humanity-worker`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace; it is not published to npm. Its `postinstall` generates both People descriptors from the SCALE files in
`.papi/metadata/`. Previewnet and local builds use `@polkadot-api/descriptors`.
Paseo Next V2 uses the package-local output configured in `.papi/paseo.json`.

## Testing

From the repository root:

```bash
npm run test -w @humanity/shared
npm run typecheck -w @humanity/shared
npm run lint -w @humanity/shared
```

`npm run humanity:test`, `npm run humanity:typecheck` and
`npm run humanity:lint` run these together with the app and the worker.
