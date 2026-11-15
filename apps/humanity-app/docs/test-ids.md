# Test ids

Some elements carry `data-testid` and `data-*` attributes so end-to-end
readers, such as a browser test harness, can find them without depending on
class names or copy. They carry no behaviour: nothing in the app reads them,
and changing one changes nothing a person sees.

They ship in every build, deployed ones included; nothing strips them at build
time.

## Naming

- Test ids are kebab-case, `feature-element`: `card-username`, `home-notice`.
- State values go in their own `data-*` attribute named for the value:
  `data-card-state`, `data-score`.
- Add a hook next to the existing class, never instead of it, and list it
  below.

## Current hooks

| Hook | On | Value |
| --- | --- | --- |
| `data-testid="humanity-home"`, `data-card-state` | the member home column (`MemberHomeScreen`) | the card state's `kind` |
| `data-testid="membership-card"`, `data-card-state` | the card root (`MemberCard`) | the card state's `kind` |
| `data-account` | the card root | the username's owner account, read at the finalized block; absent when the name has no owner |
| `data-score` | the card root | the score, on a `candidate` card only |
| `data-misses` | the card root | the misses, on a `caution` card only |
| `data-streak` | the card root | `activeWeeks`, on `membership-ready`, `member` and `caution` cards only |
| `data-testid="card-username"` | the name on the card | |
| `data-testid="card-label"` | the card's screen-reader status label | |
| `data-testid="card-badge"` | the Caution/Suspended pill, when shown | |
| `data-testid="card-qr"` | the code on the card's back, when there is one | |
| `data-testid="home-notice"` | the line under the card (`UnderCard`) | |
