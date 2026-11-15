# Humanity

The personhood product on the Polkadot People Chain: it shows a person their
card and moves them along a path from a device-proven identity to Membership.
It reads and signs as three products at once — its own, the method a person
qualifies through, and the wallet that vouches for them — so the same person
appears under three names, and this glossary is what keeps them apart.

Terms here are the words to use in code, copy, commits and reviews. Where the
runtime's word and the person-facing word differ, both are listed and the
boundary between them is the point.

This file names the states. [`STATES.md`](./STATES.md) shows how a person moves
between them, which runtime write causes each move, and which storage item this
app reads to see it.

## Language

### The product

**Humanity**:
This product — the card, the path to Membership, and the prizes attached to it.
Reserved product id `peopl`.
_Avoid_: People, the people product, Humanity Prizes, `peopl` used as a name

**Reserved product id**:
The id a product is known by protocol-wide (`peopl`, `dim2`, `fund`),
and the thing an account derives from. Identifies the *product*; the network is
carried separately by the DotNS suffix.
_Avoid_: label, DotNS label, product label

**Personhood product id**:
`peopl.<suffix>` — `peopl.testnet` on previewnet, `peopl.paseo` on
paseo-next-v2. Both the name this app is opened under and the id the person's
ring-VRF keys derive from, on every host. Not `peopl.dot`: on a test network
that literal names a person nobody's device is (older truapi hosts pinned it
for their own reserved keys). The measurement is in `STATES.md`.
_Avoid_: the reserved personhood product (as a name for `peopl.dot`), `peopl.dot`

### Hosts

**Host**:
The wallet a person opens this app inside: it holds the root secret, derives
every key and account from it, names the app by its DotNS name, and answers
the app's calls. Three matter today, and they do not all agree.

**Rust core**:
`truapi`, the host runtime. Runs the `truapi-host` CLI and the iOS
app when its Rust-core switch is on. Has the RFC-0024 key registry — register,
list, sign — and lets a product own the keys under its own id, so this app
owns its person keys there. Its *wallet-internal* keys — the ones it uses for
its own allowance proofs and for the CLI's throwaway people — follow the
network suffix too in releases after `truapi-host` 0.13.1, so a CLI-made
person is a `peopl.<suffix>` person like a phone's.

**Native host**:
The iOS app's own Swift implementation, with the Rust-core switch off. Derives
people under `peopl.<suffix>` like this app, but has no key registry: the
three RFC-0024 calls answer `Unsupported`, and it picks the person key itself
inside a proof. There the card reads the ring by account and shows Devicehood
but, for most people, not Membership.

**Dev host**:
`npm run humanity:dev:host`, the CLI on loopback with a throwaway or a given identity,
serving this app under its deployed name. See [`README.md`](README.md#run) → Run.

### Status

The states a person moves through. Movement is not one-way — Membership can
degrade — and reaching Membership is not the end of the path.

**Devicehood**:
Where a person starts: a key of theirs is in the Devicehood ring. Carries a
numbered username and a limited allowance of Bulletin chain storage and
statement-store space. Reached by a unique device corroborated by an attester,
or by paying a registration fee — so Devicehood names the *state*, not the
proof that got someone there.
_Avoid_: Lite, lite person, people-lite (in anything person-facing)

**Lite person**:
The runtime's word for a person in Devicehood, after its `PeopleLite` pallet.
Chain-facing vocabulary only — never shown to a person.
_Avoid_: using this in UI copy or product discussion

**Enrolled**:
Having a participant record, which a person gets the moment they sign up for a
method — not after their first game. Enrolment is what turns Devicehood into
Candidate.

**Candidate**:
A person enrolled in a method and building a score toward Membership — a
candidate *for* Membership, not for anything else.

**Membership**:
What a person reaches when a key of theirs is in the Membership ring. Carries
an upgraded username, and can be upgraded further.
_Avoid_: Personhood, Recognition, Recognized (in anything person-facing)

**Membership Ready**:
Score cleared, but no key in the Membership ring yet. A real waiting room, not
a rounding error: recognition and ring inclusion are separate steps, so a
person can have earned Membership and still be unable to prove it. The person
is told they are a member here, as DIM2 tells them; what needs the ring key,
the name, waits for it.
_Avoid_: treating this as Membership in anything that needs a proof

**Personhood**:
The chain's and this codebase's concept behind Membership — the score, the
threshold, the runtime's recognition. Never shown to a person.

**Caution**:
A Member who has missed enough games to be at risk of losing Membership.

**Suspended**:
A Member who has lost Membership through missed games.

**Membership origin**:
Which method put a person's key in the Membership ring, and therefore whether
their Membership can degrade. Membership reached through DIM2 is
score-administered: it can become Caution and then Suspended. Membership
reached through another method is permanent as far as the score is concerned —
only the method that granted it can take it away. Not a state, a property of
one.
_Avoid_: permanent Membership (as if it were a separate state)

### Rings

A ring is the chain's answer to "is this person real?", and membership of one
is the only de facto proof of a status. Both rings live in the same `members`
pallet and differ *only* by which collection they are keyed under.

**Ring**:
A set of ring-VRF keys held as one collection. A person proves a status by
proving a key of theirs is in the corresponding ring, without revealing which
key — which is the whole point of a ring rather than a list.

**Membership ring**:
The ring whose keys are proven people. A key here is what makes someone a
Member, and nothing else settles it.
_Avoid_: people ring (in person-facing copy), the People collection

**Devicehood ring**:
The ring whose keys are people in Devicehood.
_Avoid_: lite people ring, people-lite ring (in person-facing copy)

**Ring-VRF key**:
The key that stands for a person inside a ring. A person holds a separate one
per ring, so the Devicehood key and the Membership key are different keys.
Both derive from the personhood product id: `//peopl.<suffix>//index_bytes(0)`
is the Membership key, `index_bytes(1)` the Devicehood key. The host derives
them from the wallet's root secret; a key exists to the host once a product
has registered it, and only the product whose id matches may register, list
without asking, or sign with it — which is why this app, opened as
`peopl.<suffix>`, registers its own.
_Avoid_: bandersnatch key (the curve is not the concept), personhood key

**Ring position**:
Where a key stands with a ring: queued to join, included in it, or suspended
from it. Being recognised and being included are not the same thing — the gap
between them is what Membership Ready names.

### Methods

**Method**:
A route by which a person reaches Membership. Only DIM2 is offered today, so
nothing should assume there is only ever one.
_Avoid_: DIM (as a generic), path, route

**DIM2**:
The method offered today, and the product a Candidate qualifies through.
Reserved product id `dim2`. DIM1 and DIM3 are expected to follow as further
methods.
_Avoid_: Jollity, jollitydemo, jollitynext, "the game" used as this product's
name

**Game**:
One session of DIM2 — the weekly meeting a person attends. DIM2 is the product;
a game is the event inside it. Attendance at games is what moves a Candidate's
score and what a Member can miss.

### Identity

**Numbered username**:
The username Devicehood carries: a name with a trailing number, `jet.42`.
_Avoid_: lite username (in person-facing copy)

**Upgraded username**:
The bare name a Member holds, `jet`, with the number dropped. Claimed in two
transactions: `Resources.register_person` on the People chain, then
`DotnsGateway.register_name` on Asset Hub, which mints it in dotNS — the copy
every host checks a name against. The app registers the dotNS half on its own
whenever the card shows a name the gateway lacks.

**Identity account**:
Account 0 of the personhood product, `//product//peopl.<tld>/0` (RFC-0028). It
owns both of a person's usernames (lite `name.NN` and membership `name`) and is
the only account whose signature the runtime accepts as proof of that identity.
There is no separate identity product: `uid` is retired.
_Avoid_: wallet product, lite identity product, `uid` account

## Not yet settled

Deliberately absent, rather than guessed at:

- The prize surfaces (the daily dollar, airdrops, draws) have no agreed
  vocabulary here yet.
- Person-facing copy for the state where someone holds Devicehood and has not
  enrolled in DIM2. The path to Membership needs advertising there, and that
  screen does not exist yet.
- Person-facing copy for the difference between Membership that can degrade
  and Membership that cannot. The distinction is real on chain and the card
  says nothing about it.
- **Two different suspensions share one word.** A key can be suspended from a
  ring, and a participant can be suspended for missing games. Whether those
  are one event or two is unsettled, and until it is, "Suspended" alone is
  ambiguous — say which one.
