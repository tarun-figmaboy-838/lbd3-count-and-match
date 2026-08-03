# Behaviour audit - lbd3

Every live MonoBehaviour and where it went. Instance counts come from GUID occurrences in the scene, so nothing is ported speculatively and nothing live is skipped.

| Unity script | Instances | Ported to | Behaviour preserved |
|---|---|---|---|
| `GameManager.cs` | 1 | `Game.GameManager` | 6 trays, max 2 selections, hand hint at 5 s then pair hint at 7 s (Tray1<->Tray5, Tray2<->Tray4), correct hold 1.5 s, DOShakePosition 1 s / strength 10 / vibrato 10 / randomness 90, extra 0.5 s incorrect hold |
| `PlateItem.cs` | 6 | `Game.PlateItem` | 6 instances, itemCount 3/4/5/4/3/6, default / selected / incorrect sprite swap, tray number reveal |
| `TutorialDialogue.cs` | 2 | `Game.TutorialDialogue` | 3 tutorial sets / 13 messages, typingSpeed 0.05, 9 clips, waitForCondition gating, onMessageComplete UnityEvents (StoreButtonId, SetButtonValue) |
| `GridLayoutManager.cs` | 1 | `Game.GridLayoutManager` | FixedRowCount drops 2 -> 1 once two or fewer trays remain active, and the grid re-flows |
| `JumpAndScaleUI.cs` | 1 | `Game.JumpAndScaleUI` | Key: scale 0 -> 0.6 over 0.4 s easeOutBack, jump +50 px up over 0.3 s easeOutQuad then back down easeInQuad |
| `TypewriterEffect.cs` | 1 | `Game.TypewriterEffect` | incorrectDialogueBox types "Oops! The trays don't have the same number of items!" at 0.05 s per char, on OnEnable |
| `WebGLFocusHandler.cs` | 1 | `(intentionally inert)` | sets AudioListener.pause on focus loss; browsers already suspend audio for a backgrounded tab, so no equivalent action is taken |
| `SplashScreenLoader.cs` | 1 | `Game.SplashScreenLoader` | as LBD-1 |

## Scene-wired UnityEvents

Button behaviour is driven by the serialized `m_OnClick` lists, in scene order, not by re-reading the C#. Persistent (Inspector) listeners and runtime `AddListener` calls are tracked separately, because Unity's `RemoveAllListeners()` removes only the runtime ones.

Each tray fires four listeners in this exact order:

1. `TutorialDialogue.OnTrayButtonClicked(thisButton)`
2. `PlateItem.OnClicked()`
3. `TutorialDialogue.playaudio(1)`
4. `GameManager.OnPlateClicked(thisPlate)`

This ordering matters because `PlateItem.OnClicked()`'s own call to `OnPlateClicked` is commented out in the C# source.

## Lifecycle

`Awake` runs only for objects active in the hierarchy at scene load. `Start` runs once, on first activation. `OnEnable` / `OnDisable` can repeat. Controllers on inactive objects do not run until their object is shown, which is what stops delayed hints and dialogue audio leaking across rounds.

Every timer and tween belongs to a cancellable task group, so `StopAllCoroutines` and `DOTween.Kill` semantics hold: a delayed hint from a previous round cannot fire during the next one.
