# The live bots

Jollity's live end-to-end bots: real games on PreviewNet, played by scripted
personas. Jollity's guide, [`apps/jollity-app/AGENTS.md`](../../apps/jollity-app/AGENTS.md),
applies here too. Paths below are from the repository root.

## They import the app

The bots import `apps/jollity-app/lib/`, such as the copy of the permission
gate, but their CI check runs only when `scripts/e2e-live/**` changes. After a
change to anything they import, run both by hand:

```bash
npm run typecheck:e2e-live     # the live bots, which import the app's lib/
npm run test:e2e-live          # the unit tests of the live bots
```

PR 846 deleted strings the bot read, and only a local `typecheck:e2e-live`
caught it.

## Keep the PreviewNet crew catalogue current

Every new or renamed live-E2E profile, role, guard, or PreviewNet identity must update the public crew catalogue in the same change. Scenario parameters, evidence wording, identity bindings, and overlay actions derive from `scripts/e2e-live/profiles.json` and the executable plans; never copy them into JSON. A new identity also needs its prose entry and WebP portrait under `scripts/e2e-live/crew/`. Run `npm run e2e-live:crew-doc`, commit the regenerated `docs/e2e-live-previewnet-crew.md`, and run the crew tests plus `typecheck:e2e-live`. Do not land a new persona or test scenario with a stale generated catalogue.

The complete catalogue runs nightly at **03:17 Europe/Zurich**. Keep the nightly schedule, the active-suite admission for ordinary games, the identity-safe wave plan, annotation/Pages admission, generated crew document, and `.claude/skills/bot-e2e/SKILL.md` consistent whenever a persona, profile, guard, or execution wave changes. The workflow contracts must cover both CEST and CET and must keep scheduled and ad-hoc PreviewNet games in one non-replacing execution lane.

## This repository is public

Run logs and artifacts are world-readable, so:

- **Secrets:** a mnemonic picked out of a pool secret is masked where it is parsed (`mask.ts`, and the workflows' mask steps).
- **Other players:** a non-bot account or username is masked the moment a bot process prints or reads it, and `redact-players.mts` replaces it with `player-<hash>` in every text file before an upload (`player-privacy.ts`). The bots' own names stay readable.
- **Content:** `npx tsx scripts/e2e-live/public-sweep.mts` must stay clean (CI runs it). Run it with `--usernames <map>` and `--private-terms <file>` from where those private lists are kept; never copy them here. Fixtures are invented or anonymised, never raw captures.
- **Artifacts** are kept 3 days.
