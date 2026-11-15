# The Pocket card

The product's Pocket card: a live face drawn by the worker, and static faces for the host's approval
sheet.

- `src/pocket-card.ts` registers the card with `getPocketManager().drawCard` and draws it while the
  host has its render open.
- `@humanity/shared/pocket/humanity-face.ts` builds the tree. **One module for both surfaces.**
- `public/pocket/*.json` are generated from it — `npm run humanity:pocket:faces` from the repo root. Never
  edit them by hand; the sheet must not disagree with the card it offers.

Vite copies `public/` into `dist/` verbatim, so the faces land at `pocket/*.json` inside the worker
archive — where a published `pocket.cards[].preview` path resolves from. No build config change.

## Publishing it

The Polkadot app pins a `humanity` card for the `peopl` product on its own, drawn from a face bundled
with the app: the dark "Humanity / Proof of personhood" placeholder. A host asks this worker to draw
the card only once the worker's record on `worker.<label>.<tld>` lists it, which is the worker entry in
`apps/humanity-app/deploy/bulletin-deploy.config.ts`:

```ts
includes: { chat: false, pocket: true },
pocket: { cards: [{ id: "humanity", title: "Humanity", preview: "pocket/devicehood.json" }] },
```

bulletin-deploy 0.19.x publishes `includes` but drops `pocket`, so `npm run humanity:setup` follows the CLI
with `apps/humanity-app/scripts/publish-pocket-cards.mts`, which adds the cards to the record the CLI just wrote, signed
with the same key. Every deploy runs both; the CLI's next publish removes the cards and this puts them
back a few seconds later. `npm run humanity:pocket:publish -- --env preview --dry-run` (with
`DEPLOY_DOMAIN=<label>.testnet`) shows what is published and what it would write, without signing.
`npm run humanity:dotns:resolve -- worker.<label>.<tld>` shows the live record.

## Simulating a standing

The app's debug panel (`#/debug`, in a build with `VITE_DEBUG_PANEL=true`) writes the picked card
scenario to the product's host storage, and a worker built with the same flag polls it every two
seconds while its card is on screen, so **Candidate**, **Caution** and the rest show up on the
native card as well as in the app. With **Candidate** picked, the panel's **Score** and
**Threshold** steppers move the progress stripe, its heat and the home copy on both cards (past
twelve point is a tenth of the threshold's share of the stripe). **Read from chain** clears it. A
worker built without the flag compiles that read out, so picking a state in the panel then leaves
the card alone.

A host caches the worker bundle and keeps the worker warm, so after a rebuild restart the host app
before looking at the card again.

## What the format is

A renderer tree, `{ "tag": ..., "value": { modifiers, props, children } }` per node. The vocabulary
is fixed and small: `Nil`, `String`, `Box`, `Column`, `Row`, `Spacer`, `Text`, `Button`, `TextField`,
`Image`, `Effect`.

Two rules that catch most first attempts:

- `Padding` and `Margin` need **`top` and `end`**. `bottom` defaults to `top`, `start` to `end`, so
  `{ "top": 20, "end": 20 }` is 20 all round. Omitting `end` is a missing-field error.
- Sizes are non-negative whole numbers. `16.5` is refused rather than rounded.

## How close to the app's card this gets, state by state

The face is the app's card (`MemberCard.tsx`, `card-materials.ts`, `idcard.css` on `main`) drawn
in the host's vocabulary: same anatomy, same material per state. The vocabulary names no colours,
but opacity composes: an opaque `BgSurfaceMain` ground under `FgPrimary` at a chosen opacity is any
neutral grey in the dark theme. Each material is one solid grey, its ramp read halfway down. Its
ramp is what the app's card **measures on a device** at 30/55/80% of its height (sheen included),
and a flat colour cast stands in for a coloured sheen. `npm run humanity:pocket:faces` writes one file per
row.

| State | Measured, app / face | Not carried over |
| :-- | :-- | :-- |
| not enrolled, devicehood | | the diagonal sheen |
| candidate | `#CCBDA5` / `#CABDA5` | the stripe's lean and width-sharing segments |
| membership ready, member (weeks 2-3) | `#EDBFDC` / `#DEC7CF` | the lilac and peach bands and the diagonal sheen |
| member 13-51 wk | | the tier's diagonal sheen |
| member 52+ wk | | conic, blurred holo (the rainbow is linear) |
| caution | `#AFB1B5` / `#ABACAE` | the ribbon's 33deg turn across the corner |
| suspended | `#828487` / `#808183` | the same |

The candidate's stripe is ten segments on both cards (`packages/humanity-shared/src/card/progress-stripe.ts`),
filled by the share of the threshold covered, the last lit one partway: a point is always the same
length of it, whatever the threshold. On the app's card it sweeps in on mount and slides when the
standing moves, in CSS. On the Pocket face the worker draws the frames: the host shows the card's
last face before the worker runs, so the worker keeps the share it last drew (`pocket:last-fill` in
the product's storage) and eases from there. An unchanged standing holds still, a moved one eases
across, and a card that has never drawn a stripe fills in from empty.

What matches exactly: the caution and suspended edges (the app's `--warning` and `--error` are the
dark theme's `FgWarning` and `FgError`), the suspended card's mark and wordmark fades and the
stripe's inset. The Pocket face departs from the app's card on purpose in two places: the Polkadot
mark (`pocket/card-mark.webp`, 44x45dp, so the name starts 6dp further left than beside the app's
50dp avatar) stands where the app has the avatar's initial, and a QR glyph (`pocket/qr-code.png`)
sits in the top-right corner, as on the host's own identity card, moved under the ribbon on a
caution or suspended card. What comes close through
composition: every ramp, the candidate's heat cast (the rank's colour at a sixth over the plastic,
amber for spark/ignition, amber-over-red for flame, red for fire, red under ground for blaze), the
membership rose, the black card's light edge.

### Gaps to take to the renderer

What the app's card does that no product face can, as of `@parity/product-sdk-renderer` 0.2.0
against the Android host. Each is a protocol change (`truapi` `custom_renderer`), not something to
fake here, and has been raised with the host:

- **Colour.** Nine theme-bound tokens and no literal colour. Greys are reachable only by stacking
  two tokens with opacity, which inverts in a light theme (`BgSurfaceMain` and `FgPrimary` swap
  ends, so white plastic draws dark), and hues are limited to red, amber and green: no lilac for
  the foil. The Android host already models a
  `FG_STATIC_WHITE` the core enum cannot reach.
- **Gradients.** None, so each material is a solid fill (stacked bands faking a ramp drew lines on iOS); vertical, diagonal and conic
  gradients, and the diagonal sheen, are out of reach. `Effect::Rainbow` is a single fixed
  six-colour linear gradient drawn over its children.
- **Typography.** Five presets: no serif and nothing above 32sp (the wordmark is an image in the archive for that reason),
  no weight choice (the name is 700), no letter-spacing (the status word and ribbon are tracked
  0.14-0.2em), no `text-transform`, no `maxLines`/ellipsis/alignment.
- **Transforms.** No rotate, skew or offset: the ribbon lies flat instead of crossing the corner at
  33deg, the stripe does not lean, the wordmark cannot bleed off the left edge.
- **Layout.** No flex weight or fractional fill, so stripe segments are sized for a 330dp card and
  spread with `SpaceBetween` rather than sharing the width. No per-corner radius, no `Clip`.
- **Filters and shadows.** No blur (holo), no drop shadow under the card, no inset shadow (the
  hairlines are 1dp boxes).
- **Image formats.** Android decodes SVG, iOS does not (SwiftUI `AsyncImage`), so a face ships
  PNG or WebP only. The wordmark and QR glyph are rendered at 3x from the SVGs in
  `apps/humanity-worker/assets/pocket/`, which do not ship; re-render them there after editing a source.
- **Images in a dev loop.** `Image` resolves only from Bulletin or the *published* worker archive,
  so a face served from a laptop draws none, and the grain texture cannot be iterated on
  from there.
- **Animation.** None in the format. The stripe's fill is eased by the worker sending about fifteen
  trees over 0.9s (`apps/humanity-worker/src/pocket-card.ts`), which the host decodes, redraws and keeps
  one by one: it works for a short fill, and could not carry anything continuous. The parallax
  tilt has no home.
- **What the worker knows** (ours, not the renderer's). `createPocketCardDeps` in `src/host-deps.ts`
  reads the same card as the app (`readHumanityCard`) and turns it into a face with `pocketFaceOf`
  (`@humanity/shared/pocket/pocket-face-state.ts`), the function the app uses too, so the name and
  the state agree with the app's card. See "Keeping the face current" below.

## Keeping the face current

Two sources feed the face while the host has its render open, and the later read wins:

1. **The worker's own read**, once a minute (`REFRESH_INTERVAL_MS` in `src/pocket-card.ts`), and
   fresh each time the host opens a render. This is what keeps the card current while the app is
   closed.
2. **The app's read**, handed over through the product's host storage under `pocket:face-hint`
   (`@humanity/shared/pocket/pocket-face-hint.ts`). The app writes `{ face, readAt }` whenever a live
   card read made since the page mounted changes what the face would show (`useHumanityCard` →
   `usePocketFaceHint`). The app reads the card every 12s while it is open, and again right after a
   registration or a name claim lands, since those flows invalidate the card query; it writes only
   when the face changes. The worker polls the key every 2s
   (`STORAGE_POLL_INTERVAL_MS`) and draws a hint only when its `readAt` is newer than its own read.

The worker writes the faces of its own reads to the same key, and a write never replaces a later
read's, so the key holds the newest face either side has read (two writers can still interleave
within one storage round trip). A failed read writes nothing and never replaces a face from a read
that worked: its devicehood floor is drawn only while there is nothing better. When the host opens a render again, after the card was off screen or the app
in the background, the worker draws that face at once and its own chain read follows it.

When the face can change at all is the host's call (truapi's Pocket-modality and worker-lifecycle
rules): only an open render can change it, the host opens one only while the card
is on screen, and there is no background wake. On Android the render, and the worker with it,
stops about five seconds after the Pocket leaves the screen or the app goes to the background; on
iOS the worker runs for the session while the card is held, but a face is drawn only while a card
view is visible. Between those, the host shows the last face it stored.

Storage has no change notification and the SDK has no product-initiated redraw, so the poll is
the fastest the app can reach the card. A face changes only when one of the two reads changes
it, and an unchanged face is never sent again: the host stores every face it is sent.
