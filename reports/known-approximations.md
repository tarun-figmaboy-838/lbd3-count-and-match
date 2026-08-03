# Known approximations

Everything below is a place where this hand re-implementation cannot be
bit-identical to Unity, or where the original project itself contains something
odd that has been reproduced rather than corrected.

## Rendering

| Area | What Unity does | What this build does |
|---|---|---|
| ParticleSystem | Full GPU simulation from ~4,700 lines of serialized modules per system | Split by role. Always-on **backdrop** emitters become a CSS-animated sparkle field (four-point stars, drifting, colour-varied) built once — simulating them on a canvas cost ~40ms/frame for the whole session. One-shot **bursts** (the confetti) still run on a canvas, honouring `rateOverTime: 0` as burst-only. Always-on emitters nested inside a scaled object (the key's glow aura) are dropped and that object is styled directly, because the effect layer sits outside its transform and its offsets landed in the wrong place. |
| Reward key | Particle glow aura + Animator | A CSS treatment instead: 3D `rotateY` spin with perspective, a sway, a breathing radial halo, and two counter-rotating rings of orbiting stars. A rotating conic-gradient starburst was tried and abandoned — it cost ~160ms/frame (62fps to 6fps). The orbit stars are real masked elements, not `box-shadow`s: a box-shadow can only be a round dot, and round dots read as bubbles rather than magic. |
| Effect palette | — | Warm Arabian night: lamp gold, amber, cream, rose and a little Persian teal. Cool blue was removed — it read as generic sparkle rather than as this story's magic. |
| Animator / AnimationClip | State machine with curves | Only the states actually reached by these scenes are reproduced, as explicit tweens. No generic bounce has been substituted for a real clip. |
| TextMeshPro glyph layout | SDF text with font-intrinsic metrics, per-glyph kerning | Browser text layout with the original TTF, `letter-spacing` from `m_characterSpacing` and `line-height` from `m_lineSpacing`. Sub-pixel baseline and wrap points can differ by a pixel or two. |
| 9-slice, atlas crop, tiled and filled image types | Supported by uGUI | **Not implemented.** Verified against the scene data: all 60 images in both scenes are type 0 (simple) with no border and no crop, so these code paths were removed rather than carried as dead weight. |
| Linear colour space | Composites in linear, converts on output | Serialized colours are converted linear to sRGB before being emitted as `rgba()`, so tints match. Blending of overlapping translucent layers still happens in the browser's sRGB pipeline. |

## Deliberate deviations

Three places intentionally differ from Unity, all signed off: tray **deselect**
(see "Reproduced original quirks" below), the **correct-answer beat**, and the
**pacing** below.

### Pacing for young children

The Unity timings run fast for 4-6 year olds, and one line could auto-advance
before its own voice-over had finished. Measured against the real clips:

| line | types in | voice-over | old advance |
|---|---|---|---|
| "Let me help you!" | 0.80 s | 1.57 s | 1.80 s |
| "Tap two trays…" | 2.20 s | 4.49 s | waits for a tap |
| "Great counting!" | 0.75 s | **1.99 s** | **1.75 s — clipped** |

"Great counting!" was cut off mid-word by the next line's voice-over every
single round. Three changes:

- the typewriter runs at 0.0625 s/char instead of 0.05 (16 chars/sec)
- an auto-advancing line now **waits for its voice-over to actually finish**
  (`Engine.waitForChannel`, capped at 9 s so a failed clip can never hang the
  flow) before the authored delay
- a 0.55 s read beat follows, so the sentence can be taken in

The correct-answer hold is 2.35 s and the wrong-answer hold 0.9 s, both up from
the original, to give a child time to look at the numbered items.

### The correct-answer beat

`Frame_19` / `Frame_236` / … are not badges — each is a full card: a large glow,
its own plate, and baked-in text ("That's correct! / 4 Gems"). The art is built
to **replace** the tray, so it cannot coexist with the tray's contents:

- drawn over the items, it buries the very things the learner just counted
- drawn under them, three layers of text collide and none of it is readable
- shown *after* them, the items still have to vanish to make room

All three break the one rule that matters in a counting game: the learner must be
able to see what they counted. **So the card is not used.** The match is confirmed
on the tray itself:

- the tray glows green and gets a burst of star sparks
- the tray's own number labels count the items off 1..N, and the items stay
- a brass count tag below the tray names it in words: "✦ 4 Gems ✦" -- the same
  copy the scene's card carries, at a size a five-year-old can read at arm's
  length, and small enough to bury nothing
- the count is spoken ("Great counting!")

Nothing is lost but the card artwork, and the number labels arguably teach the
count better than a label reading "4 Gems" ever did.

Two earlier attempts are recorded here because both look plausible and both are
wrong: tweening the card to a flat scale of `1` ignores its authored 0.611 and
renders it 164% oversized, washing the screen yellow; and leaving the tray's
green glow on underneath tints the card's golden glow so two adjacent cards merge
into one flat green wash.

### Tray row spacing

The grid was authored with **zero** vertical spacing between its two rows. Each
tray's number labels are anchored high and render about 50px *above* its cell, so
the top row's count tag had nowhere to sit -- it landed straight on the bottom
row's digits.

The grid box is 699px tall and two 265.6px rows need only 531px, so 168px was
simply unused. 96px of it is now vertical spacing, which opens a clear lane under
each row for its tag. The grid keeps its middle-centre alignment, so nothing
shifts off-centre, and the bottom row still clears the Check button. When the
board drops to a single row for the final question the spacing is irrelevant.

Asserted in the audit: the tag never overlaps a number label, an item, or the
Check button.

## Reproduced original quirks

These are faithful to the Unity project and are deliberately **not** "fixed".

- `PlateItem.OnClicked()` has its `gameManager.OnPlateClicked(this)` call commented out. The scene supplies it instead: each tray fires four listeners in this order — `TutorialDialogue.OnTrayButtonClicked(btn)`, `PlateItem.OnClicked()`, `TutorialDialogue.playaudio(1)`, `GameManager.OnPlateClicked(plate)`. Reproduced exactly.
- ~~`PlateItem`'s deselect branch is unreachable: selecting a tray sets its Button non-interactable, so a second click cannot fire.~~ **Deliberately changed.** Selecting no longer disables the tray, so the author's existing deselect branch now runs: tapping a picked tray un-picks it, retracts Check and rewinds the spoken instruction one step. In Unity a wrong first tap forced the learner through a wrong answer plus Try Again with no way to change their mind; this was signed off as an intended deviation. Locking after the second pick covers only the four *unpicked* trays, so a third pick is still refused.
- `AssignListenersToTrayButtons` and `RemoveListenersFromTrayButtons` have empty bodies.
- In `ShowNextMessage`, `SetButtonValue(true)` runs *after* the recursive `ShowNextMessage()` call when a tutorial set ends. Ordering preserved.
- Two sprite GUIDs referenced by the scene do not exist anywhere in the project — genuinely broken references in the original. Unity renders nothing for them and neither does this build.
- `GridLayoutManager.Update()` switches the tray grid from two rows to one once two or fewer trays remain active, which is why the final Tray3/Tray6 comparison sits on a single centred row.
- This game emits no analytics events.
