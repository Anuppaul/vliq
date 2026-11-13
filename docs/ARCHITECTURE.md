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
