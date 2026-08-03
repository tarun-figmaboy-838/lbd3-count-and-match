# Matching Trays — static HTML build

`lbd3` from *Kabir and the Lost Princess*, rebuilt from the Unity project as a
dependency-free static site. Six trays hold 3, 4, 5, 4, 3 and 6 items. The learner taps two trays with equal counts and presses Check; the last two trays drive a yes/no comparison question and the final key reveal.

## Run it

```bash
cd lbd3
python3 -m http.server 8000
# open http://localhost:8000
```

No build step, no npm install, no server-side code. It also runs from `file://`
because the layout and configuration are embedded in `js/data.js` rather than
fetched.

## Deploy it

Upload the folder as-is to Vercel, Netlify, GitHub Pages, S3 or any static host.
There is no build step and nothing to configure.

**Vercel:** import the repository and accept the defaults — `vercel.json` already
declares no framework and no build command, serves the repo root, and sets cache
headers (30 days on `assets/`, always revalidate on the HTML and the scripts, so a
code change goes live immediately while the 4.8 MB of artwork stays cached).

Nothing in the build is environment-specific, so a preview deployment behaves
exactly like production.

## Folder structure

```
lbd3/
├── index.html
├── favicon.png
├── css/style.css        @font-face + stage scaling + node classes
├── js/
│   ├── data.js          embedded window.LAYOUT / SPLASH_LAYOUT / CONFIG
│   ├── engine.js        uGUI runtime (layout, tweens, audio, particles)
│   ├── analytics.js     window.quizAnswerSubmitted wrapper
│   ├── sfx.js           synthesised game-feel cues (WebAudio)
│   ├── controllers.js   one function per ported MonoBehaviour
│   └── main.js          boot + scene flow
├── assets/{img,audio,fonts}   images are WebP (see below)
├── god-mode/            QA layer, opens with Shift+G
└── reports/             extraction, behaviour, QA and approximation notes
```

## Source

| | |
|---|---|
| Unity version | 2022.3.23f1 |
| Reference resolution | 1920 × 1080 |
| Colour space | Linear |
| Scenes ported | `Assets/Scenes/Main.unity`, `Assets/Scenes/LBD_3.unity` |
| Canvas | Screen Space – Camera; **locked** to 1920×1080 here (see below) |
| DOM nodes at runtime | 122 |

## Canvas & responsiveness

The canvas is **locked** to 1920×1080, scaled by `min(w/1920, h/1080)` and
centred, so every device renders a pixel-identical composition inside letterbox
or pillarbox bars. Nothing ever stretches, crops or rearranges.

Unity's scaler was set to *Expand*, which keeps that same scale factor but grows
the canvas in the shorter axis — the stage became 1920×1440 at 4:3 and 2337×1080
on a phone, so edge-anchored elements drifted and the layout differed per aspect
ratio. Locking trades that for one guaranteed layout; it is the single
intentional deviation in the renderer.

Portrait phones get a "turn your device sideways" prompt rather than a reflowed
composition: a 16:9 canvas in a tall viewport leaves the game a couple of
centimetres high, which is unusable for small fingers. The prompt only appears
on short/narrow portrait viewports, so desktop windows and tablets are
unaffected.

## Analytics contract

This game makes **no** analytics calls. `WebGLAnalytics` is not referenced by
`GameManager`, `PlateItem` or `TutorialDialogue` in the Unity source, so no
`quizAnswerSubmitted` events are emitted. `js/analytics.js` is still included so
the contract is available if you later wire it up.

## Browser support

Chrome / Edge 88+, Firefox 94+, Safari 15.4+. Requires CSS
`background-blend-mode`, Pointer Events, WebAudio and **WebP** — all four are
available across that whole matrix. Audio starts on the learner's first
interaction, as browsers require; the visible flow is unchanged.

## Assets

Artwork ships as **WebP** at quality 0.9, which took `assets/img` from 21.7 MB
to 4.9 MB (−77%) with alpha preserved and no change to any pixel dimension —
except the splash background, which was 3840×2160 and is capped at 1920×1080
because nothing is ever drawn larger than the canvas. The one animated asset
(the tutorial hand) stays a GIF. There are no orphaned or missing assets: every
file in `assets/` is referenced, and every reference resolves.

## Fidelity

This is a second implementation in a different renderer, not a Unity export, so
it is not bit-identical. Layout, timings, easing curves, dialogue, audio order
and answer values are taken from the scene YAML and the C# rather than
re-authored. See `reports/known-approximations.md` for the specific gaps and
`reports/visual-verification.md` for what was and was not measured.
