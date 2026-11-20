# VLIQ Architecture

## Product contract

VLIQ is a GNOME Shell material replacement, not a replacement desktop UI.

The VLIQ Orb remains with its full radial launcher, tooltips, running indicators, live app previews, drag behavior and idle hide/fade. The separate floating dock and unrelated desktop-replacement paths are retired.

For every supported Shell surface VLIQ preserves:

- native geometry and content;
- native controls and hit targets;
- native GNOME animation and interaction;
- accessibility semantics.

VLIQ changes the painted material underneath that content.

## Rendering backends

VLIQ has two independently selected render paths. **Auto** attempts the vendored compositor/GPU renderer. If startup or a confirmed shader/COGL compilation fails, the runtime retires that backend and enables **NativeCssIntegration** without replacing or rewriting the selected Liquid/Frosted/Milky preference. The explicit **Native CSS** setting skips importing the vendored shader modules. NativeCssIntegration reuses TopBarIslands in `forceCssOnly` mode; it doesn't instantiate a LiquidEffect, WindowCloneManager, capture texture or shader-specific stage callback. Native GNOME Shell still needs a functioning compositor, which can be a software renderer. It does not claim to recreate optical refraction in CSS. Both backends import the same pure `milkyPaint.js` fixed-role material calculations: header/taskbar `rgba(0,0,0,0.60)` and native Calendar/Quick Settings `rgba(245,249,255,0.92)`. No Milky slider is consumed or grain image generated. The retired `milky-black`, `milky-opacity`, `milky-border`, `milky-grain`, and `milky-whiteness` keys remain in the schema only to preserve existing profiles. **Both rendering backends also synchronize direct `St.Widget.set_style()` color/opacity/rim overrides** on the native paint owners (panel, active islands, Date/Quick Settings menus) from the same canonical settings; unlike the optional grain stylesheet this does not rely on `St.Theme` CSS reload priority. Old inline styles are restored only if VLIQ still owns the last value; the Bottom-only GNOME Dark Style exception is retained. No new actors, shaders, or permanent frame callbacks are introduced. NativeCssIntegration watches the Milky GSettings keys, loads a scoped lightweight St CSS override for its native panel and menus, and reverts safely to color-only CSS if optional grain-image loading fails. GNOME color-scheme Dark Style, native panel actors and focus ownership are unaffected.

Backend switch and disable clean up fullscreen guards, panel/taskbar actors, CSS classes, GSettings subscriptions and any staged shader health observer. Native popups are painted through GNOME CSS selectors without changing their content/interaction ownership. Fixed Milky uses the existing **Liquid Glass surface inventory** as its target list, replacing the optical material with native 92% milky white while retaining GNOME Header/Taskbar black at 60%. GPU-backed notifications require an additional lifecycle-safe native `St.Widget.set_style()` override because their original transparent inline paint outranks any stylesheet; Liquid/Frosted restore that prior style and adaptive text. The Native CSS backend uses equivalent native menu/banner/dialog/OSD/Dock class rules and no new compositor shader. The CSS-only Bottom Taskbar still has its native anti-flicker/position guard. The automatic failure monitor acts only on explicit shader-load errors or repeated Cogl initialization failures; it does not infer GPU speed from missing paint samples.

## Fixed wallpaper tint

The previous VLIQ Atmosphere five-channel shader and its preset/sliders
are retired. The Wallpaper page now exposes **Milky White** (default) and
**Original**. The fixed color is rgba(245,249,255,0.24), matching
native panel/taskbar hover cards. Legacy preset choices and numeric keys
remain in the GSettings schema for compatibility but are never read by the
new wallpaper shader; legacy non-Original selections resolve to Milky White.

WallpaperAtmosphereManager retains the established actor lifecycle:
it observes genuine Meta.BackgroundActor sources in the desktop, shared glass
mirror and App Grid backgrounds. It allocates one native Clutter.Actor
color quad per actor *before* the background image is loaded. A Cogl.Color
sets the Milky shade (245, 249, 255, alpha 61/255), avoiding St CSS material
resolution and GLSL shader compilation. Geometry follows the source via
Clutter.BindConstraint; source opacity and visibility are mirrored by
GObject property bindings during wallpaper fades. Original writes alpha=0
to the same quad, while Milky restores the fixed shade synchronously in
the GSettings callback. No actor hide/show, style reparse, or reallocation is
needed on a mode toggle. Tint manager initialization precedes asynchronous
Liquid Glass vendor loading. Cleanup destroys overlays and unbinds source
properties. No noise, blur, extra shader, screenshot, frame callback or
window capture is introduced. On-device first-paint timing is unverified.

## Renderer

The vendored production renderer provides:

- shared wallpaper source through BackgroundMirror;
- Gaussian and Dual-Kawase blur;
- half/quarter-resolution blur and cache/reuse;
- LiquidEffect refraction and chromatic fringe;
- tint, brightness, contrast and saturation;
- rim/specular/shadow terms;
- clipping/culling and GNOME-native actors/effects.

Normal Shell cards prefer the wallpaper-oriented path. Live window/UI cloning is reserved for renderer components that genuinely require dynamic scene capture.

## Generic PopupMenu adapter

GNOME Shell 50 creates a PopupMenu as:

    menu.actor = BoxPointer
      -> BoxPointer.bin = St.Bin
           -> menu.box = St.BoxLayout(.popup-menu-content)

Ubuntu/Yaru paints the normal popup card on .popup-menu-content. Date Menu adds .datemenu-popover primarily for its radius.

VLIQ therefore does not place a second card in Main.uiGroup and chase popup geometry.

PopupGlassManager patches PopupMenu.PopupMenu.prototype.open. On first open it safely transforms:

    BoxPointer.bin
      -> original menu.box

into:

    BoxPointer.bin
      -> overlay (Clutter.BinLayout)
           -> wallpaper-backed LiquidEffect material
           -> original menu.box

The original box gets only the vliq-liquid-popup-content class, which removes background/border/shadow paint but does not alter radius, padding or content.

Because the material is inside BoxPointer, GNOME automatically carries native position, scale, translation, opacity and open/close animation.

The wallpaper clone is counter-transformed during paint so the sampled wallpaper remains fixed in stage space while the glass surface itself follows BoxPointer animation.

Disable/cleanup first reparents menu.box back into BoxPointer.bin, then destroys the VLIQ overlay. This prevents native Shell content from being destroyed with the extension actor.

## Coverage

The generic PopupMenu adapter covers:

- Date / Calendar menu;
- Quick Settings outer menu;
- panel/status menus;
- application/context/background menus implemented as PopupMenu;
- future standard PopupMenu instances created while VLIQ is enabled.

Nested PopupSubMenu content sits inside the parent glass and receives a light translucent material treatment instead of another expensive blur layer.

Notifications use the proven notificationGlass manager.

ShellCardGlassManager recursively watches the Shell UI actor tree through native child-added, child-removed and destroy signals (no polling) and applies the same wallpaper-only material to non-PopupMenu Shell cards whose native paint owner is a known GNOME class:

- modal-dialog;
- switcher-list (Alt-Tab);
- workspace-switcher;
- screenshot-ui-panel;
- app-folder-dialog;
- resize-popup.

The material is inserted as a no-layout sibling directly below the native actor, so it inherits the same parent transform while leaving native layout untouched.

Top panel, OSD and native Ubuntu Dock/Dash-to-Dock continue to use the vendored production renderer.

## Performance rules

- no permanent JS polling loop for PopupMenu surfaces;
- shared wallpaper source instead of CPU readback;
- Dual-Kawase for popup material;
- renderer downscale/cache settings remain available;
- property writes are avoided when values have not changed;
- popup material exists only after a PopupMenu is actually opened;
- native GNOME animation owns transforms;
- removed Shell actor subtrees are released after one idle turn, preserving synchronous native GNOME reparenting while disconnecting genuinely detached nodes;
- taskbar notification handlers are released on destroy, removal or count reconciliation, rather than waiting for the entire notification source to disappear;
- Calendar contrast analysis is separate from the GPU glass renderer: one bounded Shell.Screenshot CPU luminance sample on open (520ms delay) and, while the Date Menu stays open, a 12-second refresh for changing backdrops. Quick Settings remains sampled on open/expansion only. This is a deliberate readability/performance tradeoff, **not** evidence of measured FPS savings.

## Orb

orbThemeRuntime.js owns only the Orb and the Liquid Glass integration.

The Orb is draggable, supports idle hide/fade, toggles GNOME Applications on click, and opens its radial application launcher on hover. The radial launcher retains tooltips, running indicators and live app previews. There is no separate floating dock.

## GTK/libadwaita boundary

A GNOME Shell extension cannot transparently replace the internal rendering of arbitrary GTK/libadwaita applications. VLIQ's Shell material layer covers Shell-owned surfaces. A separate GTK/libadwaita theme layer is required for matching application interiors.


## Optical source

Full refraction requires source pixels to bend. VLIQ does not read the framebuffer back to the CPU and does not create screenshot cards. Popup, notification and generic Shell-card surfaces use the vendored WindowCloneManager, which composes the shared wallpaper mirror with live compositor Meta.WindowActor clones entirely in the Clutter/Mutter GPU scene graph.

LiquidEffect receives optical sampling headroom around the native card. The shader mask still equals the exact native GNOME card bounds, so the extra source region is invisible but allows the edge lens, dispersion, shadow and rim terms to sample beyond the card boundary.
