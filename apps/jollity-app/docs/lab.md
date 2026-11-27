# DIM2 source opening

From the repository root, with Node 24 or later:

```sh
nice -n 10 npm ci
npm run jollity:lab:check
npm run jollity:lab:prepare -- --engine locked
npm run jollity:e2e:opening -- --fresh
npm run jollity:e2e:opening -- --fresh --negative-control
```

The opening boots an owned local Paseo fork, schedules one empty game and creates Ada through the attested CLI host. It schedules play after the full registration, shuffle and post-shuffle-margin durations plus 120 seconds of inclusion slack, reading time after the phase-setting transaction finalizes. It serves `apps/jollity-app` from this checkout, using the root's hoisted Next and `next dev --webpack` with a 180-second start timeout. Each run has its own Next output, generated tsconfig, fork and identity. It records the repository SHA, tree, app tree, working diff digest and root lock digest. This is source evidence; it makes no claim about a released bundle.

The checks require advancing finalized People and Asset Hub heads, a visible home from the host's index-1 DIM2 account, the status badge and Register control, and a readable nonempty lite ring-VRF proof through the same host. The person does not register. The reload repeats the home and proof checks and verifies that the product account is unchanged. Chromium uses synthetic media and the ordinary permission screen. The stale-build check is off in this source opening: no version file is configured (`NEXT_PUBLIC_VERSION_URL` is unset, and inherited `NEXT_PUBLIC_*` variables are stripped). It does not test version-file freshness or whether an old build is blocked. `gate.ts` still refuses an update screen if one appears.

The wrong-state feature deliberately expects `data-registered="true"`. It counts only when the final assertion fails with `screen-mismatch` and `DIM2 registered "false" does not match "true"`, after successful setup, proof and heads checks and with successful cleanup. Missing scenarios, setup failures, skipped assertions, a different error and cleanup failures are rejected.

## On the local dev chain (Previewnet from genesis)

```sh
npm run jollity:lab:prepare -- --environment previewnet-genesis
npm run jollity:e2e:opening -- --environment previewnet-genesis --fresh
```

The opening's lab also declares product-lab's `previewnet-genesis`: Engine's Previewnet People, Asset Hub and Bulletin started from genesis on this machine, a new network every run, on Engine's default ports (one Engine network per machine at a time). `prepare` fetches its node-workspace Engine checkout into the opening's cache. The copy stays the default, and every command without `--environment` is unchanged.

product-lab prepares People's rings for new people once the network is ready, so Ada is onboarded by the same CLI-host provisioner as on the copy. Before the app is built, `collection.ts` makes one claimable Scarcity collection on Asset Hub, which a genesis network lacks: //Alice signs `Scarcity.create_collection`, `Scarcity.define_item` (transferable) and `NftClaims.set_collection_minter` (random), with no sudo. Its finalized state is checked and its receipts are kept under `opening-reports/sanitized/collection-*.json`. `fixture.ts` then schedules the same empty game as on the copy, with People's sudo key //Alice.

A genesis DotNS has no `peopl.testnet` record, so the CLI host finds no Humanity manifest granting DIM2 `context` and refuses DIM2's lite proof with a key peopl owns (`NotAllowlisted`). On this environment only, the opening gives the host `lab/opening/peopl.testnet.product-config.json` through its `--product-config` (product-lab's `productConfigs`): Humanity's own grant to `dim2`, `["context", "storage"]`, as `apps/humanity-app/deploy/bulletin-deploy.config.ts` publishes it (a test keeps the two equal). The copy never gets it: its forked Asset Hub carries the real `peopl.paseo` record, which is what it tests. Set `JOLLITY_LAB_HOST_LOG_DIR` to keep the host's session logs of a local run; CI never sets it.

On Previewnet routes `app.ts` builds DIM2 for its `local` network: the People and Asset Hub endpoints and genesis hashes from the routes, the identity backend's origin, `NEXT_PUBLIC_PRODUCT_DOTNS=dim2.testnet` and the new collection in `NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS`. The values are checked by the app's own `resolveLocalNetwork` before the server starts. Every other route keeps the Paseo build and its guard.

Known limits on genesis: dub (Engine's v0.7.0) does not serve `turn/issue-with-proof`, so DIM2's video cannot get TURN credentials; DotNS product names such as `dim2.testnet` are not registered; the collection holds no credits until a game is played. The Paseo-only shared helpers (`lab/shared/build.ts`, `scenario-app.ts`, `ci-bundle.ts`) serve the cross-app and scenario labs, not this opening, and are unchanged.

## CI and local ownership

The advisory `Jollity fork opening` job targets PRs into `main` and runs only while they carry `run-dim2-opening`. Adding `run-dim2-opening`, synchronizing or reopening a labelled PR reruns it. Unrelated label events skip the job and cannot cancel an in-flight opening, because concurrency is scoped to the admitted job. PRs from forks are refused. Dispatch offers a boolean `negative_control`; PRs run the positive feature only. The default runner is `parity-int-ubuntu`, overridable with `JOLLITY_LAB_RUNNER`; the cap is 75 minutes. No other workflow depends on this job. Ordinary Jollity CI runs the lab typecheck and offline `tests/lab` controls without the label. Only the prepare and opening steps receive the read-only `GH_TOKEN`.

Every run downloads a fork bundle. The wrapper forces its own app-local tooling cache and removes current, staged and partial Paseo bundles before and after the run. Prepared Engine binaries may be reused locally; bundle bytes may not. There is no Actions cache step, setup-node cache, release CID cache access or saved-player reuse. Engine may read public release metadata and binaries, but every chain endpoint and identity backend route must be loopback. No PAS is spent and no previewnet is used. Fixture calls are labelled and retain public transaction receipts under `opening-reports/sanitized/fixture-*.json` before validation, including the transaction/block identifiers and outer/inner dispatch results. The strict Sudo check is unchanged.

The workflow retains a demo, raw feature videos and sanitized results for 14 days, including failures. Demo rendering is advisory and never changes the opening verdict. `opening.mts demo --failed` is required for a control or failed run. Wallets, raw host logs and fork directories are never uploaded. `opening.mts cleanup` reaps only owned processes.

Same-repository PRs get one sticky comment shared with Humanity, with a separate
Jollity section showing the run, job result, scenario and step verdicts and
direct demo, videos and results artifact links. The separate comment job has
only `pull-requests: write`, checks out no source and tolerates failures.
Dispatches and skipped openings never comment. Its shared PR concurrency group
serializes creation and section updates; each update re-reads before writing
and verifies the saved body, retrying conflicts. Steps come only from the
sanitized feature-name/status projection, written before cleanup. Missing
evidence is unavailable. A burst of comment writers can leave one workflow's
section on its previous run until it runs again; the run page stays
authoritative. See the [comment contract](../../../.github/README.md).

On shared development machines, acquire the machine lock before prepare/run using the local machine-lock helper; queue outside the lock and detach the long command. The app-local lock prevents two wrappers in this checkout. Before a fork run at least 30 GB must be free. Resource reports sample process-tree RSS, CPU, free disk, system memory and Linux cgroup OOM events every 15 seconds.

## Scope and qualification

Lab-only app paths do not count as bundle or visual sources and are excluded from main deploy triggers. Mixed source changes still deploy. The existing hermetic Playwright suite remains in place. The root script additions and app tsconfig exclusions are build-tooling changes and can still trigger normal source classifiers on this initial PR.

product-lab is pinned to 0.6.0, the scoped WASM host override to 0.27.0, truapi to 0.27.0 and sdk-host to 0.31.0. Provisioning and launch must acquire the same attested official CLI 0.27.0 binary. The copied lock is digest-checked against `IMPORTED.json` (Humanity's lock moved to 0.31.0 separately); no installed package is patched. Provenance: `../lab/opening/IMPORTED.json`.

This does not test registration, gameplay, credits, the worker or another app. Linux timing and 16 GB capacity remain unmeasured until one positive and one control run. The planning estimate, including a download per run, is 20-35 minutes, this is an estimate, not a measured result. Escalate capacity only after an OOM, sustained swapping with under 1 GiB available for 60 seconds, or two valid runs over the cap.

The source launcher executes `node` from PATH (Node 24 is supplied by setup-node in CI). Its declaration is parsed offline before preparation or fresh fork setup, so a machine-specific absolute command fails before expensive startup.

Owned session lookup is shared across the CommonJS config and ESM custom-step module instances; each actor entry is removed when the environment closes. The offline suite exercises that mixed-loader create/open/heads sequence.

## Jollity scenarios

The root selector `jollity-scenarios`, with its config module `lab/scenarios/config.ts`, covers the Jollity-only
B1-B6 plan. It uses a cached full Paseo copy and the shared network and chain helpers. The
opening's fresh-download policy above applies only to the opening. Scenario CI pins one archive
for its legs, checks its hash on installation and creates a fresh copy for each leg. See
[the scenario guide](../lab/scenarios/README.md).
