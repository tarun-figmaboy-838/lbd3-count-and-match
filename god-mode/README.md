# God Mode — Matching Trays QA layer

A hidden debug, QA and design-review layer for the `lbd3` "Matching Trays"
build. It lets you jump between screens, force any feedback state, inspect and
nudge any element, and run automated checks — without touching the learner
build.

## Open it

**Shift + G**, at any time. (`Ctrl + Shift + G` works too.)

There is no button and no menu entry, and the shortcut is never a bare key, so
normal gameplay cannot open it by accident -- the game reads no keyboard input
at all. A bare `g` / `G` and `Ctrl+G` are verified no-ops, and the shortcut is
ignored while you are typing in one of the panel's own fields.

## Remove it

Delete these three lines from `index.html`:

```html
<script>window.GOD_MODE_ENABLED = true;</script>
<link rel="stylesheet" href="god-mode/god-mode.css">
<script src="god-mode/god-mode.js"></script>
```

Or set `window.GOD_MODE_ENABLED = false` to ship the files but keep the layer
inert. Either way the learner build is unchanged — God Mode reads the game
through `Engine` / `Game` public methods and never patches them.

## Files

| File | Role |
|---|---|
| `god-mode.js` | Everything: activation, panel, screen jumps, inspector, checks. Exposes `window.GodMode`. |
| `god-mode.css` | All styles. Panels are `position: fixed`, outside the scaled `#stage`, so they stay crisp at any zoom. |

## Panel

Drag it by its header (clamped so it can never be lost off-screen); `−`
minimises to the header bar.

**State** — live screen/state name, tutorial set + message index, matches, trays
picked, free tray pool, typing flag, resolving flag, active override count.

**Screen & level** — jump to `splash · intro · round 1 · round 2 · yes/no
question · complete/key`, plus Prev / Next / Restart screen and Reset whole
game. Jumps are driven by the game's own methods (`showNextMessage`,
`tryCompare`, `onClickTryAgain`, …), never by editing the DOM.

**Trigger** — Correct, Wrong, Retry, Reward, Complete, Stop VO. *Correct* and
*Wrong* pick a real matching / non-matching pair from the trays still on the
board, so they exercise the actual comparison path.

**Control** — Pause VO + animations (freezes tweens, holds CSS sparkles, pauses
audio), Lock input, and overlays: Bounds, Hitboxes, Drop zones, Center lines,
Safe area, Grid.

**Inspector** — turn on *Pick element* and click anything, or search by
selector / `data-name` / `data-id` / id / class. Shows name, selector, parent,
x, y, width, height, scale, rotation, opacity, z-index.

- Drag the selection frame to move it (hold **Shift** to snap to 10px)
- **Arrows** nudge 1px · **Shift+Arrows** 10px · **Alt+Arrows** resize
- **Ctrl/Cmd+C** copies the CSS block
- Copy values / CSS / selector / computed styles
- Reset one · Reset all · Save temp · Load temp · Clear temp
  (`localStorage` key `lbd3GodLayout`)

All geometry is reported in **stage space** — the 1920×1080 design grid — so a
copied value pastes straight into the source regardless of browser zoom or the
fit-to-viewport scale:

```
stageScale   = stageWidth / 1920
stageRect(el) = { x: (el.left − stage.left) / stageScale, … }
```

Edits are inline-style overrides held in memory. **Nothing is written to the
stylesheet** — you copy values out and apply them by hand. Closing God Mode
reverts every override.

**Runtime** — active audio per channel (clip, position, duration, loop,
volume), SFX context state, outstanding timers/tweens by owner, pointer state,
CSS animation count, input-lock state, sparkle and fx-canvas counts, node count.

**Event log** — state transitions, jumps, selections, copies, resets.

## Automated checks

*Run checks* asserts, against the live DOM and game state:

1. no duplicate `data-id` nodes
2. six unique trays, none duplicated
3. at most one hint hand visible
4. at most one dialogue panel mounted (they share the same rect)
5. no overlapping voice-over on the `vo` channel
6. every mounted image loaded
7. no interactive element outside the viewport
8. every live tap target ≥ 80px in stage space
9. scene root count matches the two scene trees (catches double init)
10. never more than two trays picked
11. tray pool + picked == visible trays

*Copy report* puts a timestamped result on the clipboard.

Headless-friendly:

```js
window.GodMode.runChecks()   // opens if needed, returns the report text
window.GodMode.screen()      // current state name
window.GodMode.jump('question')
window.GodMode.log()
```

## Open / close contract

Opening pauses the simulation and locks input, so what you inspect is what was
on screen and a stray click cannot advance the game underneath you. Closing
restores input, resumes the simulation, reverts every layout override, clears
every overlay class, unchecks every toggle and hides the badge. Listeners are
registered once, guarded by `window.__godModeLoaded`.
