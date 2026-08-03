# Known approximations

Everything below is a place where this hand re-implementation cannot be
bit-identical to Unity, or where the original project itself contains something
odd that has been reproduced rather than corrected.

## Rendering

| Area | What Unity does | What this build does |
|---|---|---|
| ParticleSystem | Full GPU simulation from ~4,700 lines of serialized modules per system | A Canvas 2D approximation driven by the extracted emission rate, lifetime, start size/speed/colour and shape radius. Positions and timing are close; individual particle paths are not identical. |
| Animator / AnimationClip | State machine with curves | Only the states actually reached by these scenes are reproduced, as explicit tweens. No generic bounce has been substituted for a real clip. |
| TextMeshPro glyph layout | SDF text with font-intrinsic metrics, per-glyph kerning | Browser text layout with the original TTF, `letter-spacing` from `m_characterSpacing` and `line-height` from `m_lineSpacing`. Sub-pixel baseline and wrap points can differ by a pixel or two. |
| 9-sliced sprite with a non-white tint | Multiplies the sliced sprite by the colour | `border-image` cannot blend with a background colour, so a tint on a 9-sliced sprite is applied as opacity only. Only one sliced sprite exists in these projects and it is untinted, so this path is currently unused. |
| Linear colour space | Composites in linear, converts on output | Serialized colours are converted linear to sRGB before being emitted as `rgba()`, so tints match. Blending of overlapping translucent layers still happens in the browser's sRGB pipeline. |

## Reproduced original quirks

These are faithful to the Unity project and are deliberately **not** "fixed".

- `PlateItem.OnClicked()` has its `gameManager.OnPlateClicked(this)` call commented out. The scene supplies it instead: each tray fires four listeners in this order — `TutorialDialogue.OnTrayButtonClicked(btn)`, `PlateItem.OnClicked()`, `TutorialDialogue.playaudio(1)`, `GameManager.OnPlateClicked(plate)`. Reproduced exactly.
- ~~`PlateItem`'s deselect branch is unreachable: selecting a tray sets its Button non-interactable, so a second click cannot fire.~~ **Deliberately changed.** Selecting no longer disables the tray, so the author's existing deselect branch now runs: tapping a picked tray un-picks it, retracts Check and rewinds the spoken instruction one step. In Unity a wrong first tap forced the learner through a wrong answer plus Try Again with no way to change their mind; this is the one intended-mechanics deviation in the build, and it was signed off. Locking after the second pick covers only the four *unpicked* trays, so a third pick is still refused.
- `AssignListenersToTrayButtons` and `RemoveListenersFromTrayButtons` have empty bodies.
- In `ShowNextMessage`, `SetButtonValue(true)` runs *after* the recursive `ShowNextMessage()` call when a tutorial set ends. Ordering preserved.
- Two sprite GUIDs referenced by the scene do not exist anywhere in the project — genuinely broken references in the original. Unity renders nothing for them and neither does this build.
- `GridLayoutManager.Update()` switches the tray grid from two rows to one once two or fewer trays remain active, which is why the final Tray3/Tray6 comparison sits on a single centred row.
- This game emits no analytics events.
