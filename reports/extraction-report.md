# Extraction report — lbd3

Source scenes: `Assets/Scenes/Main.unity`, `Assets/Scenes/LBD_3.unity`

Unity 2022.3.23f1, colour space Linear


## Scene contents

| Scene | GameObjects | Docs parsed |
|---|---|---|
| Main | 8 | 43 |
| LBD_3 | 114 | 464 |

## Live MonoBehaviour instances

Only scripts whose GUID actually appears in a scene or prefab are ported. Editor-only and never-instantiated scripts are skipped.

| Scene | Script | Instances |
|---|---|---|
| Main | `SplashScreenLoader` | 1 |
| LBD_3 | `GameManager` | 1 |
| LBD_3 | `GridLayoutManager` | 1 |
| LBD_3 | `JumpAndScaleUI` | 1 |
| LBD_3 | `PlateItem` | 6 |
| LBD_3 | `TutorialDialogue` | 2 |
| LBD_3 | `TypewriterEffect` | 1 |
| LBD_3 | `WebGLFocusHandler` | 1 |

## Assets

- referenced by layout/config: **41**
- files copied: **41** ({'img': 29, 'audio': 11, 'fonts': 1})
- atlas-cropped sprites: 0
- 9-sliced sprites carrying border data: 0
- missing: 0 | zero-byte: 0 | runtime path violations: 0
- runtime asset paths checked: 104, all relative and under `assets/`
- Unity project paths present as provenance labels only (Animator controller names, ScriptableObject sources): 7 — none is fetched at runtime

## Pipeline

1. `tools/unity_yaml.py` splits the multi-document YAML on `--- !u!<class> &<fileID>`, quotes scalars that YAML would otherwise coerce to booleans (Unity writes bools as `0`/`1`, so a literal `Yes`/`No`/`True` is always a string — LBD-3's Yes/No buttons depend on this), then `yaml.safe_load`s each document.
2. PrefabInstance (1001) documents are expanded: the `.prefab` is loaded, `m_Modification` entries are applied by `propertyPath`, fileIDs are remapped to `P<instance>_<original>`, and stripped scene documents are merged back so scene-side references resolve.
3. Components are classified by **serialized field signature first**, GUID second. Two engine GUIDs in the initial table were wrong (CanvasScaler/GraphicRaycaster were swapped, and HorizontalLayoutGroup was labelled RawImage); field signatures caught both.
4. Sprites resolve to a path plus crop rect, 9-slice border and pivot from the importer `.meta`.
5. ScriptableObject references (`LevelData_*.asset`) are inlined.