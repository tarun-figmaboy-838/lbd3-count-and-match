# Known approximations

Everything below is a place where this hand re-implementation cannot be
bit-identical to Unity, or where the original project itself contains something
odd that has been reproduced rather than corrected.

## Rendering

| Area | What Unity does | What this build does |
|---|---|---|
| ParticleSystem | Full GPU simulation from ~4,700 lines of serialized modules per system | Split by role. Always-on **backdrop** emitters become a CSS-animated sparkle field (four-point stars, drifting, colour-varied) built once — simulating them on a canvas cost ~40ms/frame for the whole session. One-shot **bursts** (the confetti) still run on a canvas, honouring `rateOverTime: 0` as burst-only. Always-on emitters nested inside a scaled object (the key's glow aura) are dropped and that object is styled directly, because the effect layer sits outside its transform and its offsets landed in the wrong place. |
| Reward key | Particle glow aura + Animator | A CSS treatment instead: 3D `rotateY` spin with perspective, a sway, and a breathing radial halo. A rotating conic-gradient starburst was tried and abandoned — it cost ~160ms/frame (62fps to 6fps). |
| Animator / AnimationClip | State machine with curves | Only the states actually reached by these scenes are reproduced, as explicit tweens. No generic bounce has been substituted for a real clip. |
| TextMeshPro glyph layout | SDF text with font-intrinsic metrics, per-glyph kerning | Browser text layout with the original TTF, `letter-spacing` from `m_characterSpacing` and `line-height` from `m_lineSpacing`. Sub-pixel baseline and wrap points can differ by a pixel or two. |
| 9-slice, atlas crop, tiled and filled image types | Supported by uGUI | **Not implemented.** Verified against the scene data: all 60 images in both scenes are type 0 (simple) with no border and no crop, so these code paths were removed rather than carried as dead weight. |
| Linear colour space | Composites in linear, converts on output | Serialized colours are converted linear to sRGB before being emitted as `rgba()`, so tints match. Blending of overlapping translucent layers still happens in the browser's sRGB pipeline. |

## Deliberate deviations

Two places intentionally differ from Unity, both signed off: tray **deselect**
(see "Reproduced original quirks" below) and the **correct-answer beat**.

### The correct-answer beat

`Frame_19` / `Frame_236` / … are not badges — each is a full card: a large glow,
its own plate, and baked-in text ("That's correct! / 4 Gems"). The art is built
to **replace** the tray, so it cannot coexist with the tray's contents:

- drawn over the items, it buries the very things the learner just counted
- drawn under them, three layers of text collide and none of it is readable

In a counting game neither is acceptable, so the reward now plays as two
non-overlapping beats:

1. **0.75 s** — the matched trays glow green and the tray's own number labels
   count the items that are still on screen, confirming the answer in place.
2. **1.15 s** — items and numbers step aside and the reward card pops in at its
   authored scale.

The card's own scale (0.611) is respected. An earlier build tweened it to a flat
`1`, rendering it 164% oversized and washing the screen out in yellow.

## Reproduced original quirks

These are faithful to the Unity project and are deliberately **not** "fixed".

- `PlateItem.OnClicked()` has its `gameManager.OnPlateClicked(this)` call commented out. The scene supplies it instead: each tray fires four listeners in this order — `TutorialDialogue.OnTrayButtonClicked(btn)`, `PlateItem.OnClicked()`, `TutorialDialogue.playaudio(1)`, `GameManager.OnPlateClicked(plate)`. Reproduced exactly.
- ~~`PlateItem`'s deselect branch is unreachable: selecting a tray sets its Button non-interactable, so a second click cannot fire.~~ **Deliberately changed.** Selecting no longer disables the tray, so the author's existing deselect branch now runs: tapping a picked tray un-picks it, retracts Check and rewinds the spoken instruction one step. In Unity a wrong first tap forced the learner through a wrong answer plus Try Again with no way to change their mind; this was signed off as an intended deviation. Locking after the second pick covers only the four *unpicked* trays, so a third pick is still refused.
- `AssignListenersToTrayButtons` and `RemoveListenersFromTrayButtons` have empty bodies.
- In `ShowNextMessage`, `SetButtonValue(true)` runs *after* the recursive `ShowNextMessage()` call when a tutorial set ends. Ordering preserved.
- Two sprite GUIDs referenced by the scene do not exist anywhere in the project — genuinely broken references in the original. Unity renders nothing for them and neither does this build.
- `GridLayoutManager.Update()` switches the tray grid from two rows to one once two or fewer trays remain active, which is why the final Tray3/Tray6 comparison sits on a single centred row.
- This game emits no analytics events.
