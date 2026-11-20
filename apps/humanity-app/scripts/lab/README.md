# Lab entry scripts

The opening and flow wrappers check, prepare and run local fork journeys. Both prepare wrappers use
`locked-dot-cli.mts` to verify the root manifest, lockfile and installed `polkadot-cli` 1.24.0, then link its
`dot` executable into the public Engine setup path before fetch. An older CLI link is replaced; missing or
mismatched installs refuse with an `npm ci` instruction. No unlocked CLI installation is needed. `scenarios-ci.mts` pins a bundle by
asset and manifest digest, verifies per-leg copies, and projects scenario summaries and capacity metrics.

Dependents are `.github/workflows/humanity-lab.yml`, the local wrappers and `tests/lab`, `tests/flow` and
`tests/scenarios`. `tsconfig.scenarios.json` includes all
`.mts` scripts here. Run the relevant Vitest suites under Node and type-check that config before committing.
See the root `lab/cross-app/README.md` for commands, the measured/unmeasured timing boundary, cache cleanup and C6's
schedule switch. Scripts write evidence locally; the workflow's token-scoped comment job handles its comment.

Cross-app build, run and report scripts now live at root `lab/cross-app/scripts/`. The opening, flow and scenario wrappers stay here and import shared helpers from root `lab/shared/`. All wrappers require the single root product-lab 0.4.0 pin and the scoped `@parity/truapi-host` 0.27.0 override; the CLI host each lab runs comes from its `host.lock.json`.
