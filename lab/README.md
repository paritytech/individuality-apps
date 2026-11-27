# Local product labs

This private npm workspace owns the cross-app Humanity and Jollity E2E lab and
the helpers used by both product labs. It has no publish script. Product-lab
0.4.0 is installed once at the repository root; the qualified CLI host is
0.31.0 for Humanity and the cross-app lab, and 0.27.0 for Jollity. Product-lab
0.4.0 routes a 0.30.0 or later host to the local copy through `--stack` and an
older one through its routing file, so both hosts run from the same install. Both products keep their existing features and tests, except that the
cross-app tests move here.

| Lab | Config from the repository root | Coverage |
| :-- | :-- | :-- |
| Humanity scenarios | `apps/humanity-app/lab.scenarios.config.ts` | A1-A6 and wrong attendance |
| Humanity flow | `apps/humanity-app/lab.flow.config.ts` | Three players from Humanity through DIM2, plus wrong credits |
| Humanity opening | `apps/humanity-app/lab.opening.config.ts` | New actor, card and reload, plus wrong card |
| Jollity scenarios | `apps/jollity-app/lab/scenarios/config.ts` (root selector only) | B1-B6, with exact pending capability reasons and wrong-home control |
| Jollity opening | `apps/jollity-app/lab.opening.config.ts` | New actor, host account and reload, plus wrong state |
| Cross-app | `lab/cross-app/lab.cross-app.config.ts` | C1-C6, B1-B3 and U3-U4, with the same rows and timing evidence |

Run setup and launch from the repository root with Node 24:

```sh
npm ci
npm run lab:check
npm run --workspace @humanity/app humanity:lab:check
npm run jollity:lab:check
npm run lab
PRODUCT_LAB_LAB=cross-app npm run lab
node_modules/.bin/product-lab --config apps/jollity-app/lab.opening.config.ts
```

The MCP default is `lab.config.ts`. Its `PRODUCT_LAB_LAB` selector defaults to
`humanity-scenarios` and rejects unknown names. CLI and MCP tools can also name
a config explicitly. Product configurations retain their original app roots;
cross-app state and fresh copies belong to the repository root. CLI `check`,
`lint`, `coverage` and dry-run commands start no chain. A live launch needs the
prepared Engine, a cached complete Paseo bundle, Chromium and the locked CLI host.
Use an owned cache through `PRODUCT_LAB_CACHE_DIR`, `PRODUCT_LAB_FLAKY_LOG` for
its flake log and `PRODUCT_LAB_FORK_BUNDLE=keep` to refuse bundle downloads during
local qualification. Follow the product wrappers' prepare commands only when
preparation is intended; preparation may fetch tooling and bundles.

`shared/` exports chain planning/reads, session setup, network observation,
fresh-copy refusal, host cleanup, source launchers and browser observations.
Both product labs and `cross-app/` consume these TypeScript files directly.
`shared/upstream/` keeps the imported adapters and their original provenance in
`apps/humanity-app/lab/flows/UPSTREAM.json`; patches are sealed in
`patches/humanity-jollity-scarcity-e2e/manifest.json`. No framework source is copied
or changed. Humanity-only sentences, card checks, flows and purse reporting stay
in Humanity. Jollity's opening and `scenarios/` stay in Jollity.

The framework allocates ports. Product wrappers retain their existing port
profiles and host attestation. Cross-app version-gate experiments keep their
existing fixed loopback port 49791. All routes remain loopback and owned.
See [cross-app/README.md](cross-app/README.md) for topology, run selection,
commit-keyed builds, timing boundaries and sanitized CI evidence. Retention is
14 days. Nothing in this workspace is imported by a shipping application.

`npm test --workspace @individuality/lab` runs the moved 165 cross-app tests and
eight root-selector cases. Humanity keeps its 1,732 app tests, including 552
flow/lab/scenarios tests. `npm run lab:check` also typechecks, lints, verifies
provenance and the single package pin, checks both runtime kits and reads both
root/default and cross-app plans. The browser callback guard remains in
Humanity's `tests/scenarios/browser-bodies.test.ts` and scans the moved helpers.
Dated verification records are not kept in this repository; each CI run's summary and artifacts are the record.

`PRODUCT_LAB_LAB=jollity-scenarios` selects Jollity alone. See
[the scenario guide](../apps/jollity-app/lab/scenarios/README.md) for setup and pending limits.
