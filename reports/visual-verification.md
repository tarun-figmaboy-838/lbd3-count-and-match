# Visual verification — lbd3

## What could not be done

The brief asks for a pixel diff against frames captured from the Unity original.
**That was not possible here and no such numbers are reported.** This environment
has no Unity Editor and no Unity licence, so ground-truth frames cannot be
produced, and a WebGL reference build cannot be made either. Any "diff score
against Unity" in this report would be invented, so there is none.

## What was done instead

1. **Layout verified against the algorithm, not against a screenshot.**
   RectTransform placement is computed as
   `size = (aMax-aMin)*P + sizeDelta` and
   `corner = aMin*P + anchoredPosition - sizeDelta*pivot`, per axis
   independently. Layout-group placement was hand-computed from Unity's
   `SetChildrenAlongAxis` / GridLayoutGroup source and compared with the
   rendered DOM.

   LBD-3's tray grid is the strongest check: `FixedRowCount = 2`, cell
   `571.95×265.6`, spacing `4.03`, `MiddleCenter`. Hand-computing Unity's
   GridLayoutGroup gives Tray6 at `left ≈ 1250.7, top ≈ 349.6`. The rendered
   build reports `1251, 350, 572, 266`.

2. **State-machine coverage in real Chromium.** 12 states were driven
   and screenshotted, with assertions on counts, attempt numbers, analytics
   payloads and button availability. Screenshots are in the delivery under
   `reports/screenshots/`.

3. **Responsive matrix.** All eight required viewports were loaded and checked
   for page errors, scrolling and correct scale factor. Results are in
   `qa-checklist.md`.

4. **Regression signal for the sprite-tint path.** An earlier revision applied
   Unity's Image tint with `mask-image` plus a flat background colour. That
   replaced artwork with a silhouette and masked child objects — post-shake
   frames collapsed to 14–24 sampled colours. After switching to a dedicated
   sprite layer with `background-blend-mode: multiply`, the same frames carry
   1,944–6,696 unique colours. Colour diversity per state is used as a cheap
   guard against that class of failure returning.

## To close the remaining gap

Send screenshots of the Unity original at the states listed in the brief's
Phase 10.2, captured at 1920×1080, and they can be diffed against the matching
HTML states with per-region mismatch percentages and overlays. Sending a
screenshot of the original beside the HTML at the same state is also the fastest
way to get any specific mismatch fixed.
