# QA checklist — lbd3

Automated in real headless Chromium 131 via Playwright (`tools/qa_run.py`), not a DOM shim. Each row is an assertion that must hold or the run fails.

## Automated results

- states captured: **12** (01_splash, 02_gameplay_initial, 03_tutorial_tap_two_trays, 04_one_tray_selected, 05_two_trays_selected, 06_check_prompt, 07_correct_match, 08_after_match_hidden, 09_round2_prompt, 10_correct_match_2, 11_two_trays_left, 12_yesno_question)
- controllers started: **2/4**
- analytics events recorded: **0**
- JavaScript exceptions / console errors: **1**
- `node --check` on every JS file: **pass**
- asset audit: **pass**

### GridLayoutGroup placement (computed vs Unity algorithm)

| Node | left | top | w | h |
|---|---|---|---|---|
| Tray1 | 99 | 84 | 572 | 266 |
| Tray2 | 675 | 84 | 572 | 266 |
| Tray3 | 1251 | 84 | 572 | 266 |
| Tray4 | 99 | 350 | 572 | 266 |
| Tray5 | 675 | 350 | 572 | 266 |
| Tray6 | 1251 | 350 | 572 | 266 |

## Responsive matrix (original Expand scaler — superseded)

Kept for the record. These numbers describe the *original* CanvasScaler
behaviour, where the stage grew past 1920×1080 on non-16:9 viewports
(1920×1440 at 4:3, 2337×1080 on a phone, 1920×4155 in portrait). The canvas is
now **locked** to 1920×1080 — see the locked-canvas table further down for the
current measurements.

## Fix pass — re-verified in headless Chromium via Playwright

Full playthrough driven with synthetic Pointer Events, asserting state after
every step. All figures below were observed, not assumed.

| Check | Result |
|---|---|
| End-to-end run: splash → intro → wrong → retry → match → round 2 → yes/no wrong → retry → yes/no correct → key | passes |
| Both valid pairs in either order (Tray2+Tray4 first, then Tray1+Tray5) | passes |
| Tray selection sprite actually swaps (`default → selected → incorrect → default`) | passes |
| Hint hands visible simultaneously | never more than 1 (first appears at 5.5 s) |
| Dialogue panels mounted simultaneously | never more than 1 |
| Voice-over channels playing simultaneously | never more than 1 |
| Music vs voice-over levels | bg.mp3 loops at 0.20, voice-over at 1.00 |
| Asset preload | 29/29 settled, 0 failures, no `ERR_INSUFFICIENT_RESOURCES` |
| Duplicate `data-id` nodes after a full playthrough | 0 |
| Page errors / console errors | 0 |
| Rapid repeat taps on Check / Try Again / Yes / next | no double-fire, no state drift |
| Deselect: un-pick from 1 and from 2, then complete a real match | passes |
| Third pick while two are held | refused |
| God Mode shortcut | opens on `Shift+G`; `g` / `G` / `Ctrl+G` / `Alt+Shift+G` are no-ops, and it is ignored while typing in its own fields |
| God Mode repeated open/close ×5 | panel/badge/root stay at 1 each; overrides reverted; game still playable |
| God Mode built-in checks | 11 passed, 0 failed |
| Frame rate, gameplay | 62 fps with 38 animated sparkles, drifting trays and pulsing buttons (was 21 fps when the ambient effect ran on a per-frame canvas) |
| Correct badge covering tray items | fixed — the tray item container is hidden while the card is up, and restored after |
| Correct badge scale | authored 0.611 (a tween to a flat 1 had made it 164% and washed the screen out) |

### Responsive re-check — locked canvas (measured, all clean)

The canvas now reports **1920×1080 at every viewport**, so the composition is
identical everywhere and only the letterbox/pillarbox bars change. Uniform tray
sizes, even gaps, nothing outside the viewport, plate aspect preserved, Check
button centred and in view:

| Viewport | scale | canvas | bars |
|---|---|---|---|
| 1920×1080 | 1.000 | 1920×1080 | none |
| 1366×768 | 0.711 | 1920×1080 | none |
| 1280×720 | 0.667 | 1920×1080 | none |
| 1024×768 (4:3) | 0.533 | 1920×1080 | letterbox |
| 1180×820 tablet | 0.615 | 1920×1080 | letterbox |
| 844×390 phone landscape | 0.361 | 1920×1080 | pillarbox |
| 800×600 | 0.417 | 1920×1080 | letterbox |
| 390×844 phone portrait | — | — | rotate prompt shown |
| 820×1180 tablet portrait | 0.427 | 1920×1080 | letterbox, no prompt |

### Compression pass

| | Before | After |
|---|---|---|
| `assets/img` | 21.7 MB (PNG) | 4.9 MB (WebP q0.9) — **−77%** |
| Shipped build (excl. `reports/`) | ~24.6 MB | **7.6 MB** |
| `engine.js` | 1,563 lines | 1,436 lines |

Dead code removed after verifying against the scene data that nothing reaches
it: Horizontal/Vertical layout groups (123 lines — zero such components),
9-slice border-image, atlas cropping, tiled and filled image types, rounded
corners, and the unused CanvasScaler modes. All 60 images in both scenes are
type 0 (simple) with no border and no crop.

Asset audit: no orphaned files in `assets/`, and every referenced path resolves.
All 29 assets preload with 0 failures.

## Manual checks still outstanding

These need a human with the Unity original side by side:

- [ ] voice-over lines match the on-screen text word for word
- [ ] audio index mapping and delays match the original timing
- [ ] particle density and colour read the same as Unity
- [ ] TextMeshPro baselines and wrap points at 1920×1080
- [ ] touch interaction on a real phone and tablet
- [ ] the synthesised SFX cues (`js/sfx.js`) suit the brand's audio direction