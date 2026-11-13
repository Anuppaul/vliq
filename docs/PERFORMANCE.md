# VLIQ performance baseline

This opt-in, read-only sampler runs as a separate Python process. It does not patch GNOME Shell, restart it, add runtime timers, install packages, or require root.

## Capture repeatable scenarios

Run these commands from the repository root, one at a time. A five-second delay gives you time to open the requested surface. Return to the terminal only after 20 seconds of recording:

```bash
python3 tools/vliq_perf.py capture --label desktop-idle --seconds 20
python3 tools/vliq_perf.py capture --label overview --seconds 20
python3 tools/vliq_perf.py capture --label app-grid --seconds 20
python3 tools/vliq_perf.py capture --label orb-all-apps --seconds 20
# Use Ubuntu Dock Panel Mode with its Liquid Glass backdrop enabled:
python3 tools/vliq_perf.py capture --label panel-idle --seconds 20
# While recording, repeatedly reveal/hide the native dock panel:
python3 tools/vliq_perf.py capture --label panel-motion --seconds 20
# Select Desktop Layout -> Bottom Taskbar before these optional captures:
python3 tools/vliq_perf.py capture --label bottom-taskbar-idle --seconds 20
# During recording, hover and click running apps, then minimize/restore:
python3 tools/vliq_perf.py capture --label bottom-taskbar-clicks --seconds 20
```

During idle, keep the desktop still. During Overview/App Grid, leave the surface open. For Orb All Apps, keep a representative page open and still. Record a separate run for paging or rapid transitions. All reports are local at dist/vliq-perf/ (ignored by Git) as CSV and summary JSON.

## Comparison

Repeat the same scenario before and after a change, matching screen resolution, GNOME version, session, workload, power state and other GPU-intensive programs:

```bash
python3 tools/vliq_perf.py compare path/to/before.csv path/to/after.csv
python3 -m unittest discover -s tools -p 'test_vliq_perf.py'
```

Use --pid PID if multiple same-user gnome-shell processes exist, --delay 10 to give yourself more time, --output PATH to control the destination, and --no-gpu for systems without NVIDIA.

## What this does and does not measure

- CPU% is GNOME Shell process usage: 100% equals one fully busy CPU core; multi-threaded values can exceed 100%.
- RSS is the whole GNOME Shell process, not the extension alone.
- NVIDIA utilization, VRAM and power are **device-wide**, including other programs. They cannot be attributed solely to GNOME Shell or VLIQ.
- Sampling nvidia-smi creates a small, external overhead. Compare runs under the same sampling settings.
- No FPS, compositor paint duration, dropped-frame rate, motion quality or per-effect GPU timing is measured. Use a GNOME Sysprof/compositor trace for those.
- Inspect reports before sharing: timestamps, PIDs and system workload may reveal information about your machine.

## Rendering budgets (source-level, not measured benchmarks)

- The native panel follows its geometry every compositor frame. A stationary panel skips repeated transformed-position queries until its existing 24 FPS window-clone deadline; geometry changes (autohide/reveal or mode handoff) bypass the shortcut so capture bounds stay aligned. No extra background GLib timer is installed.
- Orb's small, single-batch surface still samples every compositor frame. Expanded, **stationary** All Apps pages (>16 visible regions) cap geometry/hover scans at 30 FPS; while translation/scale/opacity transitions are active, region placement follows **every compositor frame**. The window-clone scene keeps its original 24 FPS cap. Newly scanned/revealed regions get an immediate pass.
- The existing native-Dock 180 px monitor-thickness guard, stage clipping, fallback veil and no-fullscreen-panel-FBO architecture are unchanged. This optimization does not claim measured CPU, GPU, FPS or latency gains: capture the same desktop scenarios and compositor traces before attributing improvements.

### Bottom Taskbar rendering safeguards (source-level)

- The native GNOME Shell 50 `panelBox` is reused, not duplicated. A single panel-height LiquidEffect paints behind native controls while the old Ubuntu Dock root, background sibling and input actor remain concealed.
- A cached `WeakMap` tracks the native Dock root for normal compositor frames; cache entries are invalidated on monitor rebuild or actor-parent replacement. The per-frame guard still detects a reappearing Dock and hides it before paint, rather than throttling visual correctness. Destroyed native Dock actors are removed immediately from the suppression/restoration registries to avoid retaining disposed GObjects after native rebuilds.
- Popup arrow reconciliation responds to native panel child-added signals and runs a fallback scan at most once per **350 ms** during an active compositor frame. A stationary panel avoids a menu-tree scan every frame.
- Each notification badge update now counts uncleared nonresident notifications **once per MessageTray source**, then shares the results across all taskbar app buttons. Before, every app button scanned every source independently. This is an algorithmic improvement, not a claimed benchmark result.
- Native Ubuntu Dock Panel Mode now skips repeated `PanelGlassSurface.setBounds()` calls for unchanged geometry and opacity, while preserving its existing capped `syncFrame()` path for live wallpaper/window clones. Motion, opacity changes, fullscreen suppression and Bottom Taskbar handoff invalidate the bounds cache immediately.
- Unchanged app IDs keep their native `St.Button`, texture, hover and focus state; app-start/stop only updates the existing 5 px running dot. Same-order app-state events skip redundant Clutter child-order queries. Mode exit releases cached actor references and restores GNOME/Ubuntu Dock state.
- These are **code-path reductions, not measured CPU/FPS gains**. Compare bottom-taskbar-idle and bottom-taskbar-clicks captures to a pre-change build under identical conditions; use Sysprof to measure paint duration or stutter.

Runtime guard checks: `node tools/test_frame_budget.mjs` and `node tools/test_bottom_taskbar.mjs`; VLIQ JS modules are syntax-checked on PRs.

## Transition blink / jump regression checklist

The app launcher uses fixed Clutter slot positions and paint-only `translation_x/y` animations to eliminate per-frame FixedLayout invalidation. Orb page changes reuse cached actor pages without replaying the radial entrance. Creating new shader batches updates the new effects only, keeping the existing Orb-face material intact.

GNOME Overview / Home → Applications keeps a single native wallpaper BlurEffect at the same radius throughout showing, shown, and hiding. No deferred zero-blur-to-full-blur switch runs during the first menu-grid paint.

**Manual GNOME 50 acceptance:**
1. Hover Orb and reveal a short app list; repeat 10 times and verify no initial blink or geometry jump.
2. Select Orb app source = All and open an expanded list with >16 apps. Test each geometry, then move between available pages via scroll. Check that icon glass and the icon themselves move in sync.
3. Open/close Home (Activities) → Show Applications repeatedly. Verify no one-frame sharp-to-blurred pulse, black panel, or overlay flash.
4. Verify dock autohide, native Panel Mode and panel↔dock switching remain unchanged.
5. Switch VLIQ Desktop Layout between 3-Part, Full and Bottom repeatedly. Confirm no duplicate dark Dock pill, and no optical border on Bottom. Use a fast app-icon click/focus/minimize cycle: icons must stay painted without a blink while the running dot changes.
6. While Bottom mode is active, rebuild GNOME monitor/work-area geometry and verify Activities on the left, Start/apps centered, Date/Quick Settings on the right, and menus opening above the bar.
7. Use the performance sampler from above under matching conditions. A CI syntax/unit test alone cannot prove frame-perfect rendering on a real compositor.

CI smoke checks: `node tools/test_frame_budget.mjs` and `node tools/test_orb_transitions.mjs`.

## Liquid Glass optics v9 (GPU cost unchanged by design)

The richer Liquid Glass look is a **material-uniform tune**, not a new rendering pipeline. The canonical `glass-optics-profile-version` migrates from v8 to v9 once, updating only the exact shipped prior optics values in the existing vendored GSettings namespace. Custom Advanced renderer values are kept.

| Uniform | Previous baseline | Liquid v9 |
| --- | ---: | ---: |
| glass-max-z (lens depth) | 118 | 132 |
| glass-displacement-scale (refraction) | 42 | 50 |
| glass-chroma-strength (color splitting) | 1.4 | 1.6 |
| glass-specular-intensity | 0.55 | 0.69 |
| glass-shininess | 62 | 70 |
| glass-rim-width | 2.8 | 3.3 |
| glass-rim-intensity | 0.90 | 1.07 |
| glass-rim-power | 2.3 | 2.15 |
| glass-rim-light-color-intensity | 1.18 | 1.24 |
| glass-sheen-intensity | 0.10 | 0.15 |

Orb hover response rises 0.38 → 0.48; Spotlight hover/focus responses increase modestly. Neutral white body shade, texture grain, user tint and filter, blur radius, GLSL implementation, FBO allocations, capture clipping, native window geometry, and the 24 FPS expensive-scene cap are unchanged. The same shader code executes with different constant uniforms, so no additional pass or texture is introduced; **this is not a measured FPS or GPU-power result**.

For visual acceptance on GNOME Shell 50, compare the exact same wallpaper and window arrangement before and after installing. Check Orb icon edges, Date/Quick Settings cards, Spotlight, Top Panel, and the native Ubuntu Dock in panel/floating modes; verify legibility and that there is no black-frame flash or shimmer. Run:
```bash
node tools/test_liquid_optics.mjs
```
This verifies migration and custom-setting preservation, not on-screen rendering.

## Liquid optics v10 — deeper liquid material

PR #42's v9 look is the baseline. v10 increases the visual liquidity by
tuning the same GPU material uniforms and hover response, not by changing the
render pipeline. The glass remains clear and the accepted milky shade, grain,
blur radius, tint, panel geometry, and Orb/App Grid animation remain intact.

| Optical parameter | v9 | v10 |
| --- | ---: | ---: |
| Lens depth (max_z) | 132 | 144 |
| Refraction (displacement_scale) | 50 | 58 |
| IOR | 1.68 | 1.78 |
| Edge chroma | 1.6 | 1.85 |
| Specular | 0.69 | 0.78 |
| Shininess | 70 | 74 |
| Rim width | 3.3 | 3.7 |
| Rim intensity | 1.07 | 1.15 |
| Fresnel rim power | 2.15 | 2.05 |
| Rim light color intensity | 1.24 | 1.28 |
| Sheen | 0.15 | 0.21 |

Orb hover optical response is 0.48 → 0.62; Spotlight hover/focus is
0.40/0.20 → 0.52/0.28; the shared engagement response is slightly stronger
and smoother. Material v9 migration targets are pinned to their historical
values, so older installs can advance through v9 to v10 deterministically.
Manual Advanced renderer overrides remain untouched.

No additional blur/capture/refraction pass, framebuffer allocation or timer
is introduced. **This is a source-level design claim, not an FPS or GPU power
benchmark.** Check real GNOME Shell 50 transitions, all glass surfaces,
readability and GPU usage before concluding visually or operationally perfect.
Run `node tools/test_liquid_optics.mjs` to verify migration behavior.

## Orb and Ubuntu Dock live-window preview glass

The shared running-window preview card previously used a nearly opaque
`rgba(8, 9, 12, 0.94)` black background. It now uses the same bounded
`ShellCardSurface` LiquidEffect as VLIQ's other premium shell cards:
live desktop/window refraction, 16px native card corners, v10 material optics,
and 104px capture margin around the card rather than a fullscreen effect.

The preview glass manager is **manual-only**: no global GNOME Shell tree scan
or extra recurring timer. It is only used after real, taskbar-visible app
windows are found; the original native `Shell.WindowPreviewLayout` tiles,
hover interactions, click-to-activate, position, opening/closing and fade
animations remain unchanged. Glass is placed **behind** those tiles.
Card destruction releases its WindowCloneManager and stage frame connection.
When the renderer cannot attach, a faint neutral translucent preview card
remains instead of the former opaque black rectangle.

Regression check: `node tools/test_preview_glass.mjs`. On a real
GNOME Shell 50 desktop, test one-, two-, three-, and four-window previews,
Orb hover and native Ubuntu Dock hover; switch windows, close/reopen previews,
drag near each screen edge, and check that glass never turns into a
full-monitor black surface, that the previews remain clickable, and that
idle resource use returns after closing a preview. Mock tests do not
replace compositor/GPU measurement.

## Enlarged Orb and Ubuntu Dock window preview rectangle

The shared running-window preview card is now approximately 25% larger:
both the live native window thumbnails and their surrounding v10 Liquid Glass
rectangle expand together, rather than scaling a painted bitmap.

| Windows | Previous rectangle | Enlarged rectangle |
| --- | --- | --- |
| One | 300 × 196 px | 378 × 248 px |
| Two | 468 × 160 px | 588 × 203 px |
| Three or four | 408 × 268 px | 514 × 338 px |

Values above assume the existing **100% App Preview Size** preference
and adequate display space. Existing 50–180% user preferences continue to
apply, but the layout fits the actual anchor monitor before allocating tiles.
That prevents the larger glass card from exceeding the monitor's visible
bounds on smaller or multi-monitor desktops. Native thumbnail aspect ratios,
click behavior and composited open/close animation are unchanged; the same
bounded preview LiquidEffect handles the larger material.

Run `node tools/test_preview_layout.mjs` for layout, size preference and
multi-monitor fit checks, and verify actual Orb/Dock previews visually on
GNOME Shell 50. Larger rectangles paint more pixels, so real GPU usage and
glass refresh timing should be measured before making performance claims.

## Edge-to-edge preview revision — larger, without side layers

Window preview cards (Orb radial launcher and native Ubuntu Dock hover) now
use a **1.65×** tile multiplier at the existing App Preview Size preference
instead of 1.25×. Their v10 Liquid Glass outer surface remains one material;
the duplicate painted CSS border/shadow and each native thumbnail's frosted
tile plate/border have been removed. Only a minimal neutral fallback remains
if the shader has not attached, and a faint hover highlight retains
clickability feedback. The padding is 6px instead of 14px, the inter-tile gap
8px instead of 10px, and the native live screenshot has only 2px breathing
room per side instead of 6px.

At 100% App Preview Size and a sufficiently large monitor:

| Windows | Previous size | Edge-to-edge size |
| --- | --- | --- |
| 1 | 378 × 248 px | 474 × 302 px |
| 2 | 588 × 203 px | 746 × 243 px |
| 3–4 | 514 × 338 px | 648 × 416 px |

App Preview Size remains fully adjustable (50–180%). Existing monitor-fit
limits, fixed GNOME `Shell.WindowPreviewLayout` click targets, opening and
closing transitions, one existing LiquidEffect per open preview, and lifetime
cleanup are preserved. Run `node tools/test_preview_layout.mjs` and
`node tools/test_preview_glass.mjs` to check the source implementation.
Visual acceptance on GNOME Shell 50 should focus on actual layered rims,
hover and focus visibility, screen-edge fit and larger-preview GPU budget.

## Native preview geometry correction (portrait Terminal / wide Files)

Previously every Orb or Ubuntu Dock live-window preview was laid out in a
**fixed landscape card** (single-window maximum 474 × 302 px), regardless of
the real source window's aspect ratio. A tall Terminal could occupy a narrow
strip in the middle of a huge glass plate and its compositor buffer/decoration
could protrude above or below the card. This was a layout bug, not extra
Liquid Glass shader depth or the previous side CSS border.

The preview now computes a *visible bounds union* from the native
`Meta.Window.get_frame_rect()` plus optional `get_buffer_rect()`. Each
window receives its own proportional live thumbnail size. The outer glass
card is assembled tightly from those tiles and not from fixed landscape
slots. Mixed 2–4-window groups use individual aspect ratios, centered rows
and one monitor-safe scale. The existing user's App Preview Size preference
and the 1.65× requested boost are retained **as upper limits**, not forced
blank-card dimensions.

The `Shell.WindowPreviewLayout` native compositor clone is positioned using
the frame/buffer offset so its paint fits within its tile; the tile and content
clip the final pixels. The frame actor alone does not clip (otherwise window
decorations disappear). Small real windows may scale up to fill their
proportional card, eliminating the old 1:1-size restriction. No new shader
pass, GPU texture, scene poll, or animation is added. v10 Liquid Glass,
preview click/hover and side-layer removal are unchanged.

At 100% settings on a large display, a portrait 600×1050 window now
receives a taller native thumbnail and approximately **302×520 px** of glass
instead of **474×302 px** of largely empty landscape glass. A landscape
1550×980 window still produces ~471×302 px. Portrait previews get up to a
2× extra height budget before the shared monitor-fit limiter. The actual sizes
depend on the source window's buffer and CSD shadow. The original screen
capture revealed the mismatch; mock tests verify the geometry, but a live
GNOME Shell 50 visual check is still required for buffer-clipping behavior.

Run `node tools/test_preview_layout.mjs` and
`node tools/test_preview_glass.mjs`; repeat with a tall Terminal, Files, an
app with mixed portrait/landscape windows, and the native Dock hover path.

## Running-window preview: exact 16:9 and visible Liquid Glass

The owner requested **one fixed 16:9 outer frame** for Terminal, Files and
other running-window previews (Orb and native Ubuntu Dock). Previous v47
followed each source window's aspect ratio; v48 deliberately makes only the
*outer* glass and each thumbnail tile 16:9. The live
`Shell.WindowPreviewLayout` clone still preserves the source window's
original aspect using *contain*, including its native CSD/window buffer.
A portrait Terminal may therefore have glass-visible side bands; unlike a
stretched thumbnail, its text remains proportionate and uncropped.

At 100% App Preview Size and at least a 1920×1080 monitor, the frame is
**784×441 logical pixels, exactly 16:9**, for 1, 2, 3, and 4-window previews.
At 50% it is 384×216. On smaller monitors its width snaps to a 16px unit
so the ratio remains exactly 16:9 after fitting screen boundaries. A single
window uses one 16:9 tile; multiple windows use centered, non-overlapping,
equal-aspect native click targets. The existing 1.65× boost and App Preview
Size preference still drive *overall* size.

The original Liquid Glass preview was inserted as a sibling inside the
desktop's `Clutter.FixedLayout`. This could leave the material invisible or
out of sync with its 120ms parent fade/zoom. The preview-only
`ShellCardSurface` now inserts its **one refractive material as the first
child of the preview card**, below the native live thumbnails. Parent opacity
and scale are inherited once, avoiding accidental squared translucency and
stale sibling allocation. Other shell cards retain their previous sibling
geometry and animation behavior. An 8.5% neutral tint is part of the active
card's CSS body, while an 18% neutral fallback makes the card visible even
before its asynchronous GPU shader loads or if attachment fails. Neither is
a second overlay actor, border, or new shader pass. The shader still drives
the v10 refractive rim, blur and background distortion.

The Orb app-region scanner ignores these nested preview clone subtrees to
avoid expensive recursive walks during hover. Preview destruction still
releases the bounded window-clone manager and its compositor frame callback.

Run `node tools/test_preview_layout.mjs` and
`node tools/test_preview_glass.mjs`. On a real GNOME Shell 50 session, check
Terminal, Files, several simultaneously running windows, the fixed frame
ratio, the visible refractive rim, window activation, native Dock hover,
monitor edges and whether short open/close fades flicker. CI's mocked
GObject/Clutter actors do not certify live GPU shader output.

## Compact fixed 16:9 preview (main update)

The user approved the visible v10 Liquid Glass preview and fixed 16:9 ratio, but requested a smaller overall frame. Reduce the preview multiplier from **1.65× to 1.35×**, giving **640×360 logical px at the existing 100% App Preview Size** (previously 784×441), and **320×180 px at 50%** (previously 384×216), on a sufficiently large monitor. It still obeys 50–180% settings and smaller-monitor safety clamps. No other native preview, glass material, layer, clip, animation or renderer code changes. On GNOME 50 confirm the glass remains visible, the outer frame stays 16:9, and native thumbnail clicks, CSD shadows and Dock hover work.

## Mini 16:9 window preview baseline

Following the approved 640×360 preview, the default 100% Window Preview Size now displays a **480×270 logical-pixel** card on a sufficiently large monitor (a 25% reduction in width and height). The existing 50% size displays **240×135**, and 180% displays **864×486** when screen space permits. A smaller monitor continues to cap the frame to the available space and maintain the exact **16:9** ratio. No changes to the v10 Liquid Glass renderer, visible backdrop, thumbnail aspect-ratio containment, input, preview fades, or resource lifetime are required. The mini-layout test covers the three representative sizes and multiple display geometries; the real compositor appearance still needs on-device validation.

## Remove the remaining preview white layer (single-material glass)

The compact **480×270 exact-16:9** running-window preview already has its own
VLIQ LiquidEffect as the first child of the native card. However, the card
still received a painted translucent white body when glass was active, and
`LiquidGlassIntegration._applyCardAppearanceStylesheet()` applied a generic
`.vliq-liquid-shell-card` **`!important` white-filter override** on top of
all native shell cards, including this preview. A hovered/focused native
thumbnail also received an additional 5.5% white tile fill. These are visual
layers independent of the actual refractive LiquidEffect.

Active preview cards now draw **transparent CSS backgrounds** in both the
static stylesheet and the dynamically generated appearance stylesheet, with
a **preview-specific exception placed after the generic shell-card white
filter**. The generic white filter remains adjustable for other cards.
Thumbnail hover/focus no longer paints a white plate; hit targets, focus
semantics, live window clones and click-to-activate code are unchanged.

If preview glass fails to attach, the non-glass preview still has its existing
neutral 18% CSS fallback, so it never reverts to the original black surface.
No new shader, nested actor, compositor capture or GPU pass was introduced.
Preview dimensions remain **480×270** at 100% and exact **16:9** at all sizes.

Run `node tools/test_preview_glass.mjs` and
`node tools/test_preview_layout.mjs`. Verify the visual appearance in GNOME
Shell 50, particularly running-app hover, thumbnail focus, and dynamic changes
to the global Glass Filter setting; mock tests do not prove the GPU visuals.

## Live material modes: Liquid Glass v10 and Frosted Crystal

VLIQ now retains the original v10 **Liquid Glass** as the default and adds
**Frosted Crystal**, selected from **Extensions → VLIQ → Preferences
→ Appearance → Glass Material**. The selected mode is stored in VLIQ's
canonical `glass-style` GSettings key (`liquid` / `frosted`) and changes
live. Frost Density, Micro-grain and Crystal Edge Glow are independent
0–100 controls; changing modes never modifies a user's existing Advanced
Liquid optics, tint, blur, or Date Menu settings.

### Rendering architecture
- The canonical settings bridge sends a **0.0 (Liquid) or 0–1.0 (Frosted)**
  amount and grain/glow values to new vendored GSettings keys. Every existing
  `MaterialSettings` instance binds them to three added uniforms in the
  **same** LiquidEffect fragment shader. This includes native Dock/Panel,
  Orb, Spotlight, popups, Quick Settings, and the bounded window-preview card.
- **Liquid amount=0 is the identity path**: the original v10 blur radius and
  shader body/highlight/grain are unchanged. Selecting Liquid again uses the
  original saved values, not a reconstructed approximation.
- Frosted uses more of the existing blur (an amount-based addition up to
  12px when the original blur is enabled), desaturates and softens contrast,
  blends toward neutral satin white/cool crystal, raises the amplitude of
  the existing screen-static hash grain and reduces strong specular glints.
  It leaves a subtle single crystalline rim; both flat-interior and full
  refraction paths use the same matte treatment. Explicit user blur=0 stays
  off. Changing only Grain or Glow does **not** reconfigure the blur kernel.
- No second glass actor, GL texture, dedicated blur engine, animated noise
  pass, new framebuffer, CPU screenshot, or extra compositor timer is added.
  Blur radius **can** increase GPU work on the existing pipeline; this is not
  an FPS/performance benchmark.

### Verification and acceptance
Run `node tools/test_frosted_crystal.mjs`, plus existing
`test_liquid_optics.mjs`, `test_preview_glass.mjs` and Shell frame-budget
tests. CI also validates both GSettings schema files and modified vendored
module syntax. Test on GNOME Shell 50:
1. Switch `Liquid → Frosted → Liquid` repeatedly with Quick Settings,
   Calendar, Orb, Spotlight, and native Ubuntu Dock visible, checking that
   no black frame or one-frame white flash appears.
2. Compare identical wallpapers/settings and verify Liquid v10 optics return
   exactly; test custom Advanced optics and explicit blur=0, along with
   the Frosted Density/Grain/Edge controls and their persisted state.
3. Verify the compact **480×270 fixed-16:9** preview's shader, frame, live
   clickable thumbnail and no extra CSS overlay remain intact in both modes.
4. Check text contrast, all monitor edges, panel↔dock handoff, modal menus
   and repeated hover/close cleanup. Measure actual CPU/GPU impact in the
   accepted sampler before claiming performance parity.

## Frosted Crystal v2 — pronounced matte versus Liquid lens

Following GNOME visual feedback that the first Frosted mode was almost
indistinguishable from the v10 Liquid material, this refines the **same shader
and Settings toggle**, retaining the original Liquid identity branch:

- **Opaque-looking matte pearl body:** Frosted now suppresses backdrop
  contrast/chroma and blends toward a cool pale crystal pigment with
  `0.87 * pow(frostAmount, 0.62)` material density (roughly 74% of the
  material color at the older 78% default, and about 80% at the new 88%
  default). This lives INSIDE the shader, not in CSS or another actor;
  backdrop shape, rounded geometry and alpha are unchanged.
- **Much less liquid refraction:** reduce the optical edge displacement
  toward 9% at normal Frosted density while preserving 100% of the
  original v10 displacement in Liquid mode.
- **No rainbow fringe in Frosted:** eliminate edge chromatic separation at
  normal Frosted density and preserve the original RGB separation in Liquid.
  The monochromatic branch also avoids the more expensive three-channel
  samples when the crystal mode is engaged.
- **Micro-etched crystal dust:** in Frosted only, combine the existing
  screen-static 1px hash with a subtle 4px faceted version of the SAME hash,
  scaled by the independent Grain setting. No texture lookup, animated
  grain, extra sampler or extra render pass is introduced. Liquid still uses
  only the previous single hash.
- **Diffused highlights:** strong specular/mirror lighting is heavily
  muted; a soft ice-blue perimeter remains controlled by Crystal Edge Glow.
  Both the flat interior early-out and the full refractive shader path
  apply matching body and grain.
- **Strong single-chain blur:** additional blur scales up to +24px over the
  user's pre-existing radius (formerly +12px), using the EXISTING
  Dual Kawase/Gaussian pipeline. A larger radius *can* use more levels of
  that pipeline for some starting radii; it does not create a second
  blur effect. The user's explicit zero blur is still respected, and
  selecting Liquid restores their original radius exactly.
- **New installations default to** Frost Density 88 and Micro-grain 62
  when Frosted is selected, rather than 78 and 55. Custom GSettings values
  are never rewritten by a migration. Liquid remains the default mode.

**Regression:** `node tools/test_frosted_crystal.mjs` checks
reversible blur, unique mode-specific shader branches, the strong density
curve and identity at frostAmount=0. Existing preview, optics and frame-budget
checks remain. On-device GNOME Shell 50 acceptance remains mandatory for
color/contrast, GPU cost, readability, transition flicker, multi-monitor
and panel/dock visuals.

## Liquid Glass: Frosted-level backdrop blur (later material update)

The Liquid Glass material now retains its original v10 **refraction,
chromatic dispersion, glossy rim and highlights**, while receiving nearly
the same *background diffusion* as Frosted Crystal v2. This is a change to
**effective blur radius only**, not the shader's refractive optics or any
saved user setting.

- When the existing base blur radius is nonzero, **Liquid adds 21px** inside
  the same existing Gaussian/Dual Kawase renderer.
- Frosted continues to add **24px × Frost Density** (at default 88%,
  **21.12px**), so the two modes now have similarly soft backdrops while
  their optical styles remain conspicuously distinct.
- Switching `Liquid → Frosted → Liquid` changes only the effective radius
  and existing per-material shader uniforms; the base blur slider and
  Advanced optics values are preserved. **Blur = 0 remains completely off**
  in either mode.
- Example with an existing base radius of 7: Liquid **28**, Frosted at 88%
  **28.12**, and Frosted at 78% **25.72**. After returning to Liquid, the
  effective radius is still 28 and the saved base radius remains 7.
- Implementation changes only `LiquidEffect._applyVLIQBlurRadius()` and
  its source-based regression tests. No added material actor, blur pass,
  shader uniform, framebuffer, texture, timer or scene-sampling loop.
- **Performance caveat:** a larger radius can select more levels in the
  *existing* Kawase pipeline. Previously light Liquid-only surfaces may
  consume more GPU time. On-device GNOME Shell 50 measurements of normal
  Dock/Panel, Orb hover, Spotlight, Quick Settings, Calendar and window
  previews are still required before claiming equivalent performance.

This section supersedes earlier notes claiming that re-selecting Liquid
restores the **unboosted** effective blur radius. The Liquid user's stored
blur slider value is still restored exactly; only the actual displayed blur
is now deliberately stronger.

## Contrast-adaptive icy-blue contour on every native glass card

Glass cards now use one **thin bluish optical rim** within their existing
LiquidEffect composite shader. It is not a separate CSS border or overlay,
and does not add a repaint loop, frame capture, texture lookup or FBO pass.

- On a **light/white backdrop**, the initial steel-blue contour was
  visually too saturated. Its shader target is now **neutral blue-gray**
  (RGB 0.54, 0.62, 0.70), and its coverage is additionally attenuated to
  **58%** of the dark-side stroke. A near-white preview stays distinguishable
  without reading as a blue sticker or painted CSS border.
- On a **dark/black backdrop**, it chooses a soft **ice blue** (0.76, 0.88, 1.0).
- Both shades are smoothly interpolated using existing blurred backdrop and
  material-body luminance, so Frosted Crystal's white matte surface also gets
  a readable edge without drawing a dark border outside its native geometry.
- A bounded signed-distance band (0–3.1px inward) produces one hairline plus
  soft falloff. No exterior halo: Clutter/Cogl's existing premultiplied-alpha
  `insideMask` still gates output once; the shadow and transparent margin do
  not inherit the edge color. Rounded corners and multi-region shapes remain
  defined by their original SDF rather than a rectangle drawn around a widget.
- The rim is gated by existing `surface_light_enabled`, so real application
  windows that intentionally disable glass highlights remain untouched.
  Liquid mode keeps its original refraction and specular lens. Frosted
  Crystal has a slightly calmer outline and retains its separate user
  `Crystal Edge Glow` control for the broader diffuse glint.
- Full-path rim work is conditional on being within the ~3px boundary.
  The existing flat-interior fast path and large exterior early-out
  are unaffected; no new shader uniform or CPU setting lookup is required.

The source/contrast regression is `node tools/test_adaptive_blue_edge.mjs`.
It checks estimated luminance separation on both white and dark backdrops,
Frosted-matte body contrast, existing edge geometry and masking, and absence
of a second CSS frame. It does **not** prove final GPU pixels. On GNOME 50,
inspect the Dock, Orb, Spotlight, Calendar, Quick Settings, notifications
and the mini 480×270 running-window preview on both bright and dark wallpapers.
Look for invisible white edges, over-bold blue strokes, corner seams,
shadow halos and FPS regressions; measure GPU frame time before claiming
that the additional arithmetic has no material cost.

### Bright-background blue calibration (follow-up)

The light-side blue border was too prominent on white wallpapers. The
follow-up changes **only the bright-side** RGB endpoint and brightness
weight, while leaving the accepted dark `RGB(0.76,0.88,1.0)` endpoint
unchanged. Brightness is recovered from the red channel of the already
selected adaptive color, avoiding duplicate luminance calculations or
another background sample. The contrast test expects a subtle ~0.08–0.15
luminance reduction and less than ~0.075 blue-versus-red channel separation
on almost-white glass, with substantially greater visibility on dark glass.
This remains a local shader adjustment: 3px SDF extent, rounded corners,
premultiplied-alpha coverage, single LiquidEffect and material selection
remain unchanged. GNOME 50 on-device visuals still need confirmation.

## Ubuntu Dock: native auto-hide repair and VLIQ Preferences controls

The native Ubuntu Dock (Dash-to-Dock) retains full ownership of edge-hover,
pressure, `intellihide`, `dock-fixed`, native transitions and click targets.
VLIQ neither adds a second dock nor replaces the native state machine.

### Actual autohide regressions fixed

1. **Nullable JS slide override:** `_applyDockVerticalOffset(entry)`
   previously did `Number(slideOverride)` when the default argument was
   `null`. JavaScript returns **0**, not `NaN`, so a visible dock was
   incorrectly positioned as though its reveal animation were fully hidden
   when VLIQ refreshed it. An omitted override now reads the current native
   `DashSlideContainer.slide-x` property. Explicit 0 overrides still work.
2. **Missing GJS state properties:** the GNOME Shell 50/Ubuntu Dock native
   APIs vary by version: `slide_x`, `slideX`, `get_property('slide-x')`,
   `dockState`, and legacy `_dockState`. A missing/null value no longer
   fabricates `0` (hidden). The true native slider/legacy state is used.
3. **Intelligent hide target drift:** native Ubuntu Dock already maintains
   a stable fully-shown `_staticBox` (see its `_updateStaticBox()`); a
   previously duplicated VLIQ overlap rectangle depended on a moving
   `_box` allocation during native hide/reveal. With zero vertical offset,
   VLIQ now restores Ubuntu Dock's native ActorBox as the authoritative
   overlap rectangle. With an explicit offset, VLIQ copies the stable
   rectangle and applies only the desired Y shift, independent of the native
   slide progress. Panel mode also restores the original native rectangle.
   The old allocation fallback exists only for older native forks without
   a valid static box. Geometry updates are deduplicated and failed native
   `updateTargetBox` calls cannot cache invalid rectangles.
4. **Native settings changes:** changes to Ubuntu Dock's visibility, pressure,
   timing, edge, or multi-monitor settings now schedule one coalesced GLib
   idle callback *after* native handlers have processed the change. VLIQ
   rebinds actors, corrects position/overlap, calls native `sync_hover()`
   and `forceUpdate()`, then updates only glass visibility. It never calls
   native `showDock()/hideDock()` or `_animateIn/_animateOut` and never
   starts a recurring background worker. Settings handlers and idle source
   are disconnected/removed on extension disable.

### Settings integration

The new `nativeDockPreferences.js` is a preferences-only helper copied by
the installer into the canonical and live-register extension directories.
It resolves the real installed
`org.gnome.shell.extensions.dash-to-dock` GSettings schema with Gio;
unsupported individual keys are hidden and an unavailable schema yields a
clear status row. Native bools, enum positions/modes/actions, integer icon
sizes and decimal pressure/timing are two-way live bindings. Opening the
preferences page does **not** write or reset native defaults. The explicit
**Restore Intelligent Auto-hide** action writes related native keys as
one `Gio.Settings.delay()/apply()` batch and never runs automatically.
The existing VLIQ vertical offset remains a separate control.

### CI / on-device acceptance

`node tools/test_native_dock_autohide.mjs` executes actual shipped source
methods and verifies null-vs-hidden slide state, legacy enum fallback, native
staticBox, optional vertical offset, 0/0.5/1 slide transitions, panel restore
and coalesced visibility update without extra animation calls.
`node tools/test_native_dock_settings.mjs` verifies the UI's typed two-way
GSettings binding, no writes at window-open, explicit native restore,
unsupported key fallback and installer packaging.

**These tests cannot reproduce the real GNOME Shell 50 pointer-pressure
barrier, active hot-corner, autohide/FBO compositor timing or Ubuntu Dock
fork-specific hide animations.** After updating, verify both bottom and
side dock orientations, fixed/auto/intelligent hide, edge pressure ON/OFF,
show/hide delays, icon visibility during repeated reveals, maximized/fullscreen
overlap, Overview exit, monitor edges and Panel↔Dock handoff. Record frame
times before attributing any performance benefit; no GPU speed claim is made.

## Calendar glass after Browser → Super → Overview

The reported bug: **Browser → press Super → open Calendar** could make the
Calendar glass show the underlying Browser's original *full-size web page*,
even though GNOME had already hidden desktop windowGroup to present Overview.
GNOME's individual `Meta.WindowActor.visible` can remain `true` while its
ancestor group is no longer the painted stage backdrop. The generic window
clone capture checked only the per-window flag, so the popup cloned a Browser
that was not actually behind the Calendar in the on-screen Overview.

**Fix:** `PopupGlassSurface` now checks `Main.overview.visible` and
`visibleTarget` on stage before-update and before its first full capture.
While Overview is active it temporarily disables only the WindowCloneManager
**desktop-window subtree**. The shared wallpaper mirror and all glass actors
remain allocated and repaintable. The stale Browser pixels are explicitly
invalidated in the existing offscreen source/composite; when Overview closes,
the same clone subtree is made visible and its current window contents
resynchronized. The native Calendar layout, Date-menu inner liquid cards,
adaptive text, keyboard/mouse input, frame budget and popup opening/closing
remain unmodified.

The new `WindowCloneManager.setWindowCaptureEnabled()` defaults to `true`
for **all other consumers** (Dock, Orb, Spotlight, notifications and other
instances) and retains clones in memory, so an Overview transition does not
force a tear-down/recreate or black-first-frame. The gate is a state-change
operation, not a new polling loop, screenshot request or GPU texture. It
switches during `before-update`, never mutates Clutter child actor visibility
from the shader's paint-time geometry hook.

**Test:** `node tools/test_popup_overview_capture.mjs` executes the actual
capture gate and Calendar viewport mode method with mocked GNOME stages.
It checks null-to-Overview transitions, no browser-content paints, the
wallpaper source remaining intact, no repeated work while Overview is stable,
quick restore on Overview exit, clean prewarm and pre-throttle switching.
Run it alongside native Popup/Calendar, preview, material, frame-budget and
package tests.

**Real GNOME 50 acceptance needed:** in a browser with a distinct colored
webpage, press Super, open Calendar while Overview remains visible, and verify
the *original full-size* browser page does not show through the Calendar.
Then close Overview and reopen the Calendar on the desktop: live windows must
again be visible through translucent glass. Repeat with Quick Settings,
window switching, Super transitions and multiple monitors. A popup over
Overview may show the wallpaper-only fallback; it does not attempt to clone
the whole Overview actor subtree, since cloning active Shell/VLIQ glass
there could create recursive compositor capture or a black rectangle.

## Calendar/browser background leak — full repair after Overview timing race

User acceptance showed the previous Overview-only window capture gate was
**insufficient**. GNOME Shell can dismiss Overview before the Calendar popup
opens, so `Main.overview.visible` and `visibleTarget` can both be false
while the Calendar is being painted. The previous rule then **re-enabled
Browser/Meta.WindowActor clones**, showing the full-size webpage inside
Calendar glass. Moreover, the vendored `WindowCloneManager` JS class is
cached within a running GNOME Shell process across VLIQ hot-swaps; the
earlier change to that vendor module could be unavailable until logout.

The robust policy is now **wallpaper-only capture for the native Date/Calendar
menu**, independently of Overview state. Both native `datemenu-popover` style
and `Main.panel.statusArea.dateMenu.menu` identity are recognized.
Before the Calendar's LiquidEffect is constructed, VLIQ disables only the
window-clone subtree of its existing WindowCloneManager. The backdrop is
still the same GPU-rendered, shared wallpaper source; the original outer
and nested Date-menu Liquid/Frosted glass, blur, native date controls,
popups, focus/accessibility, single card edge and screen geometry remain
intact. No CSS painted panel, screenshot, extra shader, frame-buffer,
actor or new timer is introduced.

`PopupGlassSurface._setSceneWindowCapture()` uses the vendor's optimized
capture toggle when available **and directly enforces visibility on the
existing `windowClonesContainer` when the cached vendor is older**.
The latter is essential: older managers do not know the new API, and their
cloned children could otherwise continue to render even with the latest
VLIQ runtime. The same invariant is checked on each pre-existing popup
stage sync so an external GNOME scene/monitor rebuild cannot revive browser
pixels. The fast unchanged-state check does no extra redraw. The existing
Overview gate continues for Quick Settings and other generic popup surfaces,
which still use live-window backdrop capture normally.

The tradeoff is deliberate: Calendar glass blurs/refracts **wallpaper**, not
whatever app window happens to be behind it. This avoids cross-surface
browser/web content entirely and remains consistent across Super → Calendar
and normal desktop opens. On GNOME Shell 50, compare Date/Calendar in both
Liquid and Frosted modes after Browser → Super → Calendar (including when
Overview has already closed before click), and verify that no web content
appears. Check Quick Settings still reflects live desktop content, Calendar
does not flash black or lose its glass edge, and repeated open/close
transitions do not add hidden actors. The new regression covers old vendor
caches and the previously missed Overview-closed-before-popup ordering.

## Calendar: mirror the actual GNOME App Grid while Super/Overview is visible

The prior Calendar wallpaper-only repair (PR #59) correctly stopped the
full-size Browser web page from leaking through its glass, but **lost the
actual foreground App Grid** when Super was held/Overview remained open.
The Date Menu now selects its visual backdrop based on *what GNOME itself
has currently painted*:

- **Super / Overview / App Grid visible:** use ONE lazily visible
  `Clutter.Clone({source: Main.layoutManager.overviewGroup})` inside the
  existing Calendar LiquidEffect's scene tree, **above** its shared wallpaper
  mirror. This captures the original App Grid/Overview content—including
  GNOME's icons and VLIQ's existing native blurred Overview backdrop—
  instead of the original full-size desktop Browser window.
- **Overview closed:** hide that clone; the pre-existing wallpaper mirror
  is the safe Calendar backdrop. Date Menu's live desktop-window clones
  stay disabled regardless of transition timing or old vendored GJS cache.
- **Quick Settings/other popups:** unchanged, retaining normal live-window
  backdrop and the earlier Overview-specific exclusion rule.

The overview source actor is a **sibling** of Calendar's popup root under
the GNOME UI; it is **not** `Main.uiGroup`, the full stage, or any ancestor
of the popup. The code checks the intended source relationship before
attaching it, avoiding recursive self-capture. The cloned Overview content
runs *inside* the existing per-popup LiquidEffect pipeline (same outer
and nested Date-card optics; no additional shader/material/filter actor).
A dedicated stage-coordinate transform matches the real native Overview
group's animated position and scale and accounts for multi-monitor origins.
The popup's existing optical ROI clip still bounds the rendered glass.

The source clone is allocated only once per Date Menu and becomes visible
only when native Overview is both shown (or showing) and mapped. It is
hidden again when GNOME exits Overview, with one compositor scene/FBO
invalidation at each source switch. The established popup `before-update`
loop handles changes; no extra timer or CPU readback is introduced.

**Cost:** a live Overview `Clutter.Clone` asks GNOME to repaint that source
within Calendar's existing scene. This **can** increase GPU cost when both
Overview and Calendar are visible, especially with nested native effects.
No parity claim is made without a real GNOME 50 compositor frame trace.

**Regression:** `node tools/test_calendar_overview_backdrop.mjs` runs the
shipped scene-visibility and monitor-transform methods with GNOME stage
mocks: Super/Overview → Calendar, mapped/unmapped fallback, transition
from visibleTarget→visible, stage scaling and a secondary monitor.
`node tools/test_popup_overview_capture.mjs` separately verifies original
Browser content is never captured by the Date Menu and compatibility with
cached older vendor modules. The existing Liquid/Frosted, preview, Dock,
JS/GSettings and frame-budget suites remain mandatory.

**On-device acceptance:** Open a Browser with a distinctive webpage; press
Super and show the App Grid, then open Calendar **while the grid remains
visible**. The Calendar should reveal the same App Grid icons and Overview
backdrop, blurred and refracted—not the original full-screen webpage and not
wallpaper alone. Close Overview and open Calendar on the desktop: it should
return to the wallpaper-only source without a black first frame. Repeat in
Liquid and Frosted modes, with Quick Settings and on each monitor. If
GNOME hides Overview as a result of opening the native Calendar itself,
there is no longer an on-screen Overview to clone; that state intentionally
falls back to wallpaper rather than faking a stale App Grid screenshot.

## Unified popup backdrop: Calendar, Quick Settings and native menus

The previous three repairs solved only part of the scene problem:
PR #59 forced Calendar to capture wallpaper, so it incorrectly hid a real
Browser behind Calendar on the desktop; PR #60 added native Overview icons
only for Calendar, leaving Quick Settings and other popup menus on a
different background. As requested, **one selection policy** now applies to
every `PopupGlassSurface`.

| Actual GNOME scene behind popup | Scene fed to all supported native popup glasses |
| --- | --- |
| Normal desktop with a Browser/editor/terminal | Live Meta.WindowActor clones in Mutter's order, over shared GPU wallpaper mirror |
| Super → Overview/App Grid is visible/mapped | One native `Main.layoutManager.overviewGroup` clone showing current icons/search/workspaces and its native blurred wallpaper; original full-size desktop Browser clones hidden |
| Desktop with no app covering the popup | Shared wallpaper |
| Overview flagged as active but its actor isn't mapped | Wallpaper-only transitional safe fallback; never sample hidden Browser |

Implementation:
- Every popup uses the same existing `WindowCloneManager`, which manages
  desktop windows plus shared wallpaper, and ONE optional
  `Clutter.Clone({source:overviewGroup})` as a sibling scene actor above
  the mirror in the **same** preexisting LiquidEffect. This is not a second
  shader, CSS overlay or screenshot layer.
- The old `if (_isDateMenu) setSceneWindowCapture(false)` shortcut is
  removed from attachment and reopening. The window-clone gate is now
  **only** a function of the native Overview visible/visibleTarget state
  for Calendar, Quick Settings and other popup menus equally.
- A live Desktop restores `windowClonesContainer` visibility, including
  cached older vendor modules that do not expose the newer
  `setWindowCaptureEnabled` method. GNOME rebuilds are corrected by
  checking the actor's live visibility on each existing frame tick.
- The Overview scene is visible only when GNOME Overview is active and
  its group is visible/mapped. A full-root actor is **never** cloned.
  Coordinate transforms compensate for its animated position and scale
  and the current monitor origin. The native popup visual remains layered
  above both inner and outer glass paint actors.
- Scene switches invalidate one cached source/composite frame; the existing
  stage `before-update` handler and capture FPS budget remain. No new
  timers, polling, wallpaper copies or offscreen render pipelines.
- Liquid Glass, Frosted Crystal, adaptive icy edges, native Calendar cards,
  Quick Settings nested cards and window-preview geometry are unchanged.

**Verification:** `node tools/test_popup_overview_capture.mjs` now tests
ALL three popup kinds on desktop Browser → Super/App Grid → Browser,
including cached vendor fallback, wallpaper fallback and absence of stale
windows during Overview. `node tools/test_calendar_overview_backdrop.mjs`
tests native App Grid source visibility/identity, geometry, transform
changes on two monitors, and Quick Settings source switching with the
same logic. These are source-level GNOME actor mocks—not proof of the
actual GNOME Shell 50 compositor's pixels or FPS.

On a real GNOME 50 desktop, verify on the **same** Browser page:
(1) Calendar and Quick Settings over Browser both show the blurred webpage,
(2) Super → App Grid → Calendar and Quick Settings both show blurred App
Grid icons rather than the original full-size webpage,
(3) closing Overview while leaving Browser open returns both popups to
the Browser behind them, and (4) with no windows they both show wallpaper.
Repeat in Liquid/Frosted modes, on secondary monitor, with nested Quick
toggles, after 10 rapid opens and while video changes behind the popup.
If a popup open action actually dismisses GNOME Overview first, there is
no longer an on-screen App Grid to sample; the live desktop/window
source should be selected instead of showing a stale Overview snapshot.

## VLIQ Atmosphere — native wallpaper-only filmic treatment

The new **Wallpaper** preferences page selects Original (default), Natural,
Cinematic, Atmosphere or Custom. Five user-adjustable 0–100 values control
filmic color, soft vignette, adaptive per-pixel ambient color, screen-static
micro-grain and adaptive contrast. The selected preset and slider values
persist in the canonical VLIQ GSettings schema. Choosing Original detaches
all Atmosphere GPU effects without erasing previously selected intensities.

### Source ownership / double-filter prevention

Original GNOME wallpaper and the three VLIQ wallpaper paint paths must
be treated as separate **source actors**, not as final desktop UI:

1. **GNOME desktop:** `Main.layoutManager._backgroundGroup` contains
   native `Meta.BackgroundActor` instances. Atmosphere adds one native
   `Shell.GLSLEffect` to each loaded wallpaper actor and watches child
   addition/removal across GNOME wallpaper changes and monitor rebuilds.
2. **Liquid/Frosted glass:** the vendor's `lg-bg-mirror-source` owns
   separate mirrored `Meta.BackgroundActor` children with the same shared
   `Meta.Background` image. The Atmosphere manager watches only those
   **mirror children**, never the window clones, GlassEffect or `uiGroup`.
   An existing `BackgroundMirror` is found on setup; new mirrors are
   attached through `uiGroup::child-added`. No extra wallpaper decode.
3. **App Grid/Overview:** VLIQ already creates one native
   `Shell.BlurEffect` wrapper per monitor, containing its own
   `Background.BackgroundManager` wallpaper children. Atmosphere watches
   **the wallpaper actors inside each wrapper**, so the existing blur
   remains the only blur and its app icons/search/controls are not graded.
   The App Grid background manager unregisters observers before it
   destroys/rebuilds the monitor widgets.
4. **Popup/Calendar native scene:** the current App Grid scene clone or
   live desktop windows remain selected by the shared `PopupGlassSurface`
   policy from PR #61. The wallpaper in either scene is graded at its own
   native source only; the Liquid/Frosted output is never processed again.

This design prevents applying a color filter to the full desktop/browser,
duplicated translucent borders or the same wallpaper capture two times.

### Shader / compositor compatibility

`wallpaperAtmosphereEffect.js` selects `Shell.GLSLEffect` on GNOME 50
and supports `Clutter.ShaderEffect` as a future-version fallback. Its
single GLSL snippet performs one source `cogl_sampler0` sample, filmic color
grading, adaptive contrast, radial vignette, ambient warm/cool tint from the
already-sampled wallpaper pixel, and deterministic grain at a fixed pixel
position. Source alpha is preserved in premultiplied form, including
cross-fades and wallpaper transparency. There is no time uniform, external
noise texture, new blur engine, GPU-to-CPU screenshot, image file write or
separate postprocessing timer.

`getAtmosphereEffectClass()` registers the GObject shader class lazily
and caches it in a process-global `Symbol.for` slot. Subsequent hot-swap
runtime imports reuse that type, avoiding GNOME Shell crashes from
re-registering the same GTypeName. Original mode does not even request a
shader class. A `Meta.BackgroundActor` added before its content has a
real Meta.Background is observed but **not painted through the shader**
until `notify::background` confirms it is loaded, preventing a known
Mutter 50 null-background crash.

### Performance and acceptance

The effect adds **one native GPU offscreen color pass per active wallpaper
actor**. A multi-monitor desktop, an app-grid blur and the shared glass
mirror can each use an independent pass. Static wallpaper content can be
cached by the compositor; this is not proof of zero GPU frame cost.
Enabling Original removes the added effect objects and restores the original
native paint path without restarting GNOME.

Mandatory automated source-level regressions:

- `node tools/test_wallpaper_atmosphere.mjs` — Original zero-effect default,
  multi-source isolation, GNOME wallpaper replacement, late loaded image,
  shared glass-mirror creation/removal, App Grid source rebuild,
  coalesced GSettings changes, cleanup, installer and integration.
- `node tools/test_wallpaper_atmosphere_ui.mjs` — preset atomic writes,
  user Custom adjustments, independent Original reset, single GObject
  class registration on hot-reload, static shader source, one sampler and
  premultiplied-alpha transparency.
- Existing Glass material, popup App Grid, native Dock, preview, frame-budget,
  JS syntax and GSettings schema validation suites remain mandatory.

**Real GNOME Shell 50 acceptance (not covered by unit tests):** compare
desktop wallpaper before/after choosing Natural and Atmosphere, switch
Light/Dark wallpaper, test a pure-white and nearly-black picture, open
App Grid and verify icons stay unchanged while the background shares the
same grade, open Liquid/Frosted cards to ensure no double tint, verify
multi-monitor bounds, change GNOME's wallpaper while Atmosphere is on,
toggle Original repeatedly and inspect for blank/black first frames,
and collect CPU/GPU frame times and memory while crossing workspaces and
using native wallpaper cross-fades. If any shader fails to compile or
paint, select Original to remove Atmosphere without touching GNOME's
wallpaper settings.

## Atmosphere visual-strength repair and live runtime instrumentation

The initial Atmosphere values were too subtle to distinguish:
at old `wallpaper-vignette=8`, the maximum corner darkening was
`0.27 × 0.08 = 2.16%`, and at old `wallpaper-ambient=6`, the maximum
ambient addition was `0.095 × 0.06 = 0.57%`. Even a functioning GPU
fragment could therefore appear unchanged. This fix recalibrates both the
**named preset strengths** and the actual filmic/ambient/contrast/vignette
response, without altering Wallpaper Original or GNOME's wallpaper image.

| Preset | Filmic | Vignette | Ambient | Grain | Adaptive |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original | OFF | OFF | OFF | OFF | OFF |
| Natural | 38 | 24 | 22 | 2 | 34 |
| Atmosphere | 62 | 52 | 54 | 3 | 56 |
| Cinematic | 78 | 70 | 34 | 4 | 72 |

The shader's vignette scale is now `0.42`, giving at the outer corners
approximately **10%** darkening for Natural, **22%** for Atmosphere and
**29%** for Cinematic. Its S-curve/contrast and color temperature are
stronger but constrained: a floor proportional to the original sample
retains deep-shadow information; a near-white highlight blend limits
clipping. All profiles retain alpha/premultiplication and one existing
Cogl wallpaper sample. The grain remains a deterministic static signal.

Named profiles are resolved from the current canonical catalog, **not**
from old slider values persistently saved by PR #62. This ensures users
who selected Atmosphere before upgrading see the new profile immediately
without resetting their settings. The Wallpaper page displays these
effective levels. Manually changing any level atomically captures the
entire effective profile before entering Custom; saved Custom settings
remain exactly user-owned. Original continues to remove all effects.

### GNOME hot reload: Shader V2

GNOME registers GObject class names for the lifetime of its Shell process.
The PR #62 effect class was cached as `VLIQAtmosphereShaderEffectV1`.
Merely changing the GLSL source while retaining that name/key could
continue using the OLD invisible shader on VLIQ hot-reload. The
recalibrated shader now uses **`VLIQAtmosphereShaderEffectV2`** and
a separate process-global cache key. Running sessions may allocate the
new type without re-registering V1; GNOME's old effect instances are
removed by the normal manager cleanup path. The fallback for systems
without Shell.GLSLEffect remains Clutter.ShaderEffect.

### Visible activation diagnostics

Wallpaper Preferences now includes **Live Wallpaper Renderer → Shader
attachment**. The GNOME Shell runtime publishes one read-only diagnostic
GSettings status on actual source-actor changes/preset application:
- `Original: no Atmosphere GPU effect attached` — intentional zero-effect
  mode.
- `Shader attached to X/Y loaded wallpaper sources (GPU pixels not
  verified)` — one effect instance was attached to X native source actors.
- `Waiting for GNOME wallpaper background actors` — source lifecycle
  incomplete.
- `Not attached: Y loaded wallpaper sources; inspect GNOME Shell logs` —
  shader was requested but not attached.
- `Not initialized` — the runtime has not reported yet (possibly
  extension not refreshed or a startup issue).

The diagnostic does **not** claim GLSL compilation or actual GPU pixels
were measured. It only reports what the live GNOME actor API says about
attachment. Status updates are coalesced by a single bounded GLib idle,
not a per-frame CPU or GPU polling loop. Disabled/Original removes the
native effect completely. The status key is excluded from the settings
change handler that recalculates presets, preventing feedback loops.

### Quantitative and real-world acceptance

`tools/test_wallpaper_atmosphere_visual_strength.mjs` reproduces the
fragment's static tonal equation with representative cool, warm, white
and near-black wallpaper colors, anchored to shipped GLSL constants.
It checks a visible Original-versus-Atmosphere color delta, ordered
Natural < Atmosphere < Cinematic corner depth and preserved white/black
details. The existing manager/UI regressions cover old preset migration,
live GSettings statuses, Custom slider values, source grouping, texture
sampling, GObject V2 hot-reload and zero effects in Original.

**On a GNOME Shell 50 device:** update VLIQ; select *VLIQ Atmosphere*
and ensure the status reads `Shader attached to X/Y`, with X > 0.
Toggle to Original and back over a colored wallpaper, then switch to
Cinematic: corner depth/color tone should be immediately identifiable.
If X stays 0 or status is Not initialized, inspect Shell warnings rather
than increasing intensity blindly. Even with X > 0, compare actual pixels
and GPU frame time: attachment and numeric tests do not prove the final
on-device visual effect. Check normal desktop, Overview/App Grid and
glass surfaces for incorrect double treatment and performance regressions.
