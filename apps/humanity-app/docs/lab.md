# Humanity source opening

From the repository root, on Node 24 or later:

```sh
npm ci
npm run humanity:lab:check
npm run humanity:lab:prepare -- --engine locked
npm run humanity:e2e:opening -- --fresh
npm run humanity:e2e:opening -- --fresh --negative-control
```

The opening starts a full local Paseo fork, creates Ada through the real CLI
host and identity backend, and serves this checkout's `@humanity/app`. It checks
the visible home, membership card, provisioned username and semantic Person
label, then reloads and checks them again. Finalized People and Asset Hub heads
must advance; their runtime versions and code hashes are recorded. This tests
source, not the deployed `peopl.paseo` release. Current source hides its inline
card because the native host normally draws a Pocket card. The CLI host has no
Pocket, so the scenario opens the existing panel with **Ctrl/Cmd+D**, selects
**Shown** in its Card controls, and closes the panel. This controls presentation
only: it selects no simulated
scenario and the card still reads the provisioned identity and live fork. The
choice persists across the reload. This does not test Pocket or the worker.
It does not exercise membership,
DIM2 gameplay, prize claims or the worker.

The wrong-card control claims that Ada has a Member card. It must fail at the
last card assertion with `screen-mismatch`; the control harness returns zero
only for the expected failure. A setup crash is not a passing control.
`humanity:lab:check` checks types, offline controls, config and feature bindings;
its dry runs execute no live assertions.

## Ownership and dependencies

The app owns `lab/opening`, `e2e/humanity-opening*.feature`, the lab wrapper and
`tests/lab`. Nothing imports another checkout. The root npm lock owns the exact
product-lab 0.6.0 dependency. The scoped WASM host override to 0.27.0 permits one
truapi 0.27.0; the existing sdk-host 0.31.0 override remains. Host provisioning
and source launch use the same attested official CLI binary, 0.31.0 since the
A3 username fix (trinity-user-agents#1974); the npm truapi packages stay 0.27.0. The host
lock's `localNetwork` capability was probed with loopback genesis RPCs; each
real launch verifies the complete fork routing again (product-lab 0.4.0 gives a 0.30.0 or later host the copy through `--stack`). No installed package is
patched. Origin and adaptations are in `../lab/opening/IMPORTED.json`.

The app uses its ordinary dev server and host bridge. The adapter runs the
root npm workspace through the public `serveApp` and `truapiCliHost` APIs.
The host connects only to validated loopback chain and identity-backend routes.
No deploy credentials are needed. Do not put a wallet phrase or a production
endpoint in this command's environment.

## State, downloads and cleanup

`.product-lab` under the app is ignored. Every run creates fresh player state
and a separate fork directory. It imports no saved players and exports none.
The wrapper closes the host, app, browser and owned processes, removes identity
state and the run's fork, and preserves test reports. Cleanup failures fail the
command. A crashed run can be reaped with:

```sh
node_modules/.bin/tsx apps/humanity-app/scripts/lab/opening.mts cleanup
```

A repository lock serializes prepare/run. On a shared developer machine, wrap
all installs, checks, preparation and runs in that machine's shared lock as
well. Never remove an active owner's lock. `PRODUCT_LAB_PORTS`,
`PRODUCT_LAB_SESSION_PORTS` and `PRODUCT_LAB_FORK_PORT_BASE` can assign an owned
port block. The repository contains no machine-specific lock path.

Preparation downloads verified Engine tools, the attested host and Chromium.
The first fork needs about 1.26 GB of compressed network state plus tool downloads.
Start with at least 30 GB free and stop below the 25 GB reserve. Opening estimates
are 10–30 minutes with tooling/bundle cached or 40–60 minutes cold; these are
planning estimates, not measurements of this source or Linux runner.

CI uses fresh bundle selection. For explicit local qualification with an already
verified immutable fork bundle, set `PRODUCT_LAB_FORK_BUNDLE=keep`; `--fresh`
still means new fork state and new players. Product-lab 0.1.0's background
prefetch ignored keep, so the documented consumer shim in `session.ts` refuses
Engine release-asset reads in that mode. It does not intercept the application's
requests. The pinned 0.1.2 honours keep (it reads only the release record and
downloads nothing); the shim stays as a second guard until it is removed on its own. A kept run needs
the complete verified bundle already installed in its owned Engine workspace.

## Manual workflow

`humanity-lab.yml` runs when dispatched and on pull requests. A dispatch runs the
positive opening by default; `negative_control` selects the separate control.
A pull request runs the positive opening only, and only when Humanity CI's
preview gate says Humanity sources changed or the opening's own lab files or
workflow changed. A root lock change alone does not boot a fork. A new push to
the same pull request cancels its running opening. It is not a required check.
No schedule or deployment is added. The workflow has `contents: read`; only its
small file-list job adds `pull-requests: read`. A separate advisory comment job
has only `pull-requests: write`, without a checkout or personal credential.
It runs only for same-repository pull requests and cannot fail the opening.
It receives no deploy, gist or
publication secret. Sanitized summaries are retained for 14 days. Raw wallets,
fork state and host logs are never uploaded.

Before a failed run deletes its fork tree, the wrapper writes a bounded Engine
bootstrap extract for the full or light layout to the same sanitized folder.
It includes known port numbers, an allowed error class and fixed descriptions
of recognized errors, including prefixed relay/service port refusals. Parent
exit code, signal and registry error are unavailable: the framework clears them
during its stop, before this wrapper regains control. The extract says
`unavailable: cleared by framework stop`; a logged `zombie-cli` exit is only that
native child's result. It also includes up to four
referenced prepare logs. Unrecognized lines, credentials and URLs are dropped;
raw logs and the process registry are not uploaded. Missing logs are recorded
as `no log`. Diagnostic failure does not replace the opening error or stop cleanup.

CI sets `PRODUCT_LAB_FORK_PORT_BASE=10000`, so both fork layouts use 10000–10999,
below the runner's observed Linux ephemeral range of 15000–65000. The capacity
step records the actual kernel range. This uses the same port-base setting as
local profiles, with a CI-specific block; the local flow's 27000 profile would
overlap this runner's wider ephemeral range. Named Engine services and dynamic
node ports stay inside the fork block, separate from the ordinary app ports
and the framework's default lab/session claim range of 20000–32699. Existing
free-port preflight still refuses an occupied block.

The runner is `vars.HUMANITY_LAB_RUNNER` or `ubuntu-24.04`. The cap is 75
minutes. Linux capacity is still to be qualified. Point the variable at a larger
runner only for measured capacity failures or repeated capacity-related overruns. A spot interruption
is an infrastructure retry, not a failed assertion or an automatic size upgrade.

Lab-only paths do not trigger Humanity previews or push-main publishing. Mixed
lab and production changes still do. Both product CI
jobs remain applicable to the root dependency change.

## Recordings and demos

Each live command now passes `--video` and puts its recording in a unique
directory below `PRODUCT_LAB_RECORDINGS_DIR` (locally, `.product-lab/opening-recordings`).
The explicit `Ada opens peopl at /` step gives the framework a recorded navigation;
the session exposes its real page through the public `PageFrameCapture` adapter.
The custom assertions continue to read that page. Host-log capture is disabled.

After the run, cut the last opening's recording with:

```sh
node_modules/.bin/tsx apps/humanity-app/scripts/lab/opening.mts demo
# For a failed opening or the wrong-card control:
node_modules/.bin/tsx apps/humanity-app/scripts/lab/opening.mts demo --failed
```

Add `--plan` to write only the edit and captions. A demo still needs a recording
with video, even in plan mode. Product-lab 0.1.2 holds each step's saved after-state
for at least 2 seconds in a 1280×960 video (1280×720 app plus captions), with a
midpoint PNG per step and no 60-second fit. Rendering needs `ffmpeg` and `ffprobe`;
the workflow installs Ubuntu's `ffmpeg` package if either command is absent.

The workflow always attempts the cut and uploads `humanity-lab-demo` (MP4,
WebVTT, `demo.json`, and PNG/HTML slide) and `humanity-lab-videos` (raw videos),
both for 14 days. Demo/tool failures do not change the opening's verdict.
One sticky comment per pull request links the run and all three artifact sets,
using each upload's direct artifact URL. It shows the job result, scenario and
step verdicts from `sanitized/scenario-steps.json`; absent evidence is explicitly
unavailable. A failed job can have passing scenario steps if a later phase failed.
The [comment contract](../../../.github/README.md) documents the shared marker,
workflow sections, serialization and retry rules. The opening token stays read-only.
A burst of comment writers can leave one workflow's section on its previous run
until it runs again; the run page stays authoritative.
Failures and negative controls use `--failed`; if a scenario passed but its
wrapper failed, the wrapper refuses a misleading passing demo. It never falls
back to an older recording. Wallets, fork state and host logs are not uploaded.

Local video qualification completed on 2026-11-02 at `288f85c2`: seven positive
steps passed and the five-step control failed exactly at the Member-card check.
Both demos rendered and their videos and slides were visually reviewed. Measured
payloads before upload compression:

| Artifact | Positive | Failed control |
| --- | ---: | ---: |
| `humanity-lab-demo` | 319,587 bytes | 310,637 bytes |
| `humanity-lab-videos` | 159,916 bytes | 191,168 bytes |

Each cut is 2.4 seconds; raw footage is 6.04 seconds positive and 6.56 seconds
control. The planner's roughly 0.6-second span is not the raw recording duration.
The short cuts compress custom-step captions and omit later action footage,
including the positive reload. They show the app and the pass/fail result, but
structured reports remain the evidence for assertions and finality. The failed
cut and slide visibly carry the exact card-mismatch error. Capture scanning found
no key material. Remaining gates:
Linux execution, workflow dispatch and the pull-request opening are still
unqualified.
