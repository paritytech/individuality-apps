# Jollity scenarios

Only Jollity is served or opened. Each scenario retires the previous hosts and drains imported games;
every actor gets fresh lite identity keys, a username and its own app proxy. Setup uses the shared
owned-fork chain executor and finalized receipts. No Humanity UI is served or driven.

The root selector `jollity-scenarios` selects `config.ts` in this folder. There is no app-root config:
`apps/jollity-app/tsconfig.json` is a deploy bundle source, so this group never touches it. The private run directory
lives below this app's `.product-lab/scenarios`; allocated ports come from product-lab. Network policy,
registration and fork ownership use `lab/shared` at the repository root. `session.ts` supplies sessions,
`setup.ts` supplies transactions, and `home.ts` reads the DOM independently of shipping app code.

B1 includes six rows. PlayerProcess remains pending: the existing helpers complete processing before
returning and provide no stable phase fixture. A pending result is never counted as a pass.
Run Node 24 `npm run jollity:lab:check` and the scenario checks in `tests/lab/`.
Live execution belongs to CI, on a fresh full Paseo copy. No cache downloads or chains start on import.
There are no upstream patches in this group.

B2 uses the ordinary Register control and reminder/name gates. The deposit fixture writes a
foreign-context alias through owned root storage and funds the deposit plus fee headroom. The free
fixture keeps the fresh lite seat and gets fee headroom only, below the deposit, so it cannot fall
back to paying. Finalized `Game.Players` plus a successful decoded sign-up extrinsic prove the route;
a route falling back to the other call fails. For the free route, the account's reserved balance at
the sign-up block and its parent must not grow by the deposit; that is a secondary signal, the decoded
call and `Game.SignedUp` are the proof. The row ends on the registered home itself ("You're in",
`data-registered="true"`, the host account), not the opening's check, which waits for a Register
control the registered home hides. Shared `name-funding.ts` supplies only PGAS on Asset Hub;
linking the username remains the app's own work.

B6 binds every sentence but becomes Cucumber pending at the refusal action, with its exact
host limitation attached. The qualified CLI uses fixed approvals; refusal and later recovery
need `request-decisions`. This job changes no host code or patch selection. `pending.ts` restores
the pending return at the bundled Cucumber boundary, without suppressing setup or cleanup errors.

B3 is pending at transaction registration: the existing media helper needs UI registration
to persist the communication private key; synthetic transaction keys cannot signal video.
B4 seeds two real bot reports, verifies two delivered unspent credits, then opens the results
through shared `post-game.ts`. The chest must open before its backstop and offer an enabled Continue. The DOM
has no opened marker, and after the long-wait notice its Continue may come on a bubble that never opened, so
the app's own log decides: the dev build's E2E hook (`window.__jollityHarness.exportLogs()`,
`lib/telemetry/harness.ts`) must hold this page session's chest line `the vessel opened`
(`lib/chest/chest-screen.ts`, logged only when the vessel opens with something collected) within 60 s of
the lab's entry (an earlier line fails). Only its time, cause and counts leave the page. A nothing screen fails. Nothing ties the
shown pieces to Ada's claims, so the step names only what it checks. The lab never taps Continue: it hands
over to Humanity's card. The chest only reads and animates claims (`lib/chest-collect.ts`,
`@jollity/collectables`); credits are read before and again after it and must be the same two unspent
claims. The plan's Claim all action does not exist; this row replaces it (a recorded plan adaptation).
B5 is pending at setup: the existing prize helper is for PeopleAirdrops, not the game's
Game.claim_airdrop. A winner fixture and exact finalized game-claim proof are missing.
Unreached actions fail unsupported rather than passing if called out of order.

CI extends `jollity-lab.yml`: the lab tests job runs when a pull request changes a lab path (shipping
Jollity tests stay in `ci.yml`); a bundle job pins one verified Paseo archive, and each scenario leg
gets its own fresh full copy. The strict classifier checks every expected row, all setup/cleanup
hooks, and each exact pending step and attached reason. It writes "N passed, M pending" and the
pending rows to the run summary, so a green leg with pending rows says so.
An unexpected failure, missing row, unknown pending or cleanup failure fails the job. The
wrong-home control is dispatch-only. Existing label opt-in behavior is retained for PRs.
Reports and videos have 14-day retention; there is no new publication/comment job.
