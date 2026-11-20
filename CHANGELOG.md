# Changelog

All notable project changes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release versioning will be documented when the first public tagged release is prepared.

## [Unreleased]

### Fixed

- Replaced the wallpaper tint's `St.Widget` CSS-paint surface with a native `Clutter.Actor` `Cogl.Color` quad. Original/Milky now update native background color alpha (0/24%) without hiding or remapping the overlay; native GNOME wallpaper opacity/visibility are property-bound during fades. This removes a potential CSS first-paint latency path but requires real GNOME 50 visual verification.

- Addressed the remaining delayed Milky wallpaper toggles: apply GSettings style changes synchronously instead of queuing an idle callback, reuse already allocated wallpaper tint actors across Original/Milky switches, and track native source visibility separately from the user's selection. Initialize the wallpaper tint manager before asynchronous Liquid Glass vendor loading. Added lifecycle and no-idle regression assertions; live compositor paint still requires device verification.

- Removed late first-paint wallpaper tint shader attachment: native compositor paint overlays now apply the fixed Milky White shade as soon as each GNOME wallpaper source is ready. No GLSL compilation or GPU shader warm-up is required for the tint; source geometry follows Mutter background actors and overlays are cleaned up on wallpaper changes.

- Fixed the earlier Milky surface-scope regression: all existing Liquid Glass surfaces now receive the same hardcoded 92% Milky White (notifications dropping from the top, app/status menus, Shell dialogs, Alt+Tab, previews, Orb, Dock, Spotlight, OSD and Overview controls). Only the Full/3-Part/Bottom Header remains pure black at 60%. No Milky controls, grain, or new effect actors.
- Notification banner's old transparent inline style no longer overrides white Milky paint; text becomes dark and native adaptive-text behavior returns on Liquid/Frosted. Native CSS fallback now styles untargeted GNOME classes and emits valid stylesheet newlines.

### Changed

- Replaced the five wallpaper Atmosphere effects (Filmic, Vignette, Ambient, Grain, Contrast) with a fixed Milky White tint matching native hover cards: rgba(245,249,255,0.24). Wallpaper preferences now offer Milky White or Original only; retired keys remain for compatibility. The tint is scoped to real GNOME wallpaper actors and retains image transparency, with no grain, blur or animation.
- Simplified **Milky Glass** into a fixed surface-scoped material: Full/3-Part/Bottom Headers are black at 60% opacity; Calendar and Quick Settings are hardcoded milky white at 92% opacity. All Milky-specific Preferences controls and Grain rendering are retired. Legacy GSettings keys remain only for profile compatibility.
- Removed Milky-only styling from Orb, notifications, overview buttons, preview cards, OSD and floating Ubuntu Dock; Liquid/Frosted materials remain independently configured. GNOME Dark Style does not alter Milky's 60% header opacity.

### Added

- Earlier adjustable Milky micro-grain implementation (superseded by the fixed no-grain Milky preset).
- Automatic GPU-renderer failure recovery and an explicit shader-independent Native CSS backend, selectable in Performance settings, with native Full/3-Part/Bottom layouts and per-session status reporting.
- Native CSS backend preserves the selected material preference and cleans up its GNOME actors/signals when switching back to GPU rendering.
- Contributor guide, contributor map and local development guide.
- Community hub, contributor recognition guide and Code of Conduct.
- Structured bug, feature, contributor and idea templates.
- Pull request review checklist.
- Security policy and responsible-disclosure routing.
- Good-first-issue and help-wanted contributor backlog.
- README SVG diagrams for project architecture and contribution flow.
- Governance, support, roadmap, release and triage documentation.
- Repository health checks for pull requests and pushes.

### Changed

- Previous Milky White/Black switch and black-grain controls (now superseded by the fixed preset above).

- README contributor entry points now link to the full community and development resources.
- Reduced recurring Calendar text-contrast screenshot sampling from 3.2 seconds to 12 seconds while preserving the first-open sample and dynamic-backdrop contrast updates.

### Fixed

- Quick Settings arrow-expanded Wired/Wi-Fi/Bluetooth/Power lists now use the same fixed **92% Milky White** opacity as the outer menu. Style the native sibling `.quick-toggle-menu` paint owner instead of leaving its background at transparent/18%; keep the overlay container transparent to prevent stacked opacity, and make text readable without changing native menu interaction.

- Milky Glass now updates real GNOME native `St.Widget` inline materials (Bottom/Full Header, active 3-Part islands, Calendar and Quick Settings), independent of dynamic stylesheet reload ordering. Preserve original inline styles and restore them on renderer/material/layout changes; keep GNOME Dark Style's Bottom Taskbar behavior unchanged.

- Native CSS renderer now observes Milky appearance GSettings, regenerates scoped native card styling on changes to Opacity, White/Black color, Edge Highlight and Micro-grain, and cleans up its theme handlers/resources on exit. The GPU-backed renderer uses the same pure paint helpers. A failed optional grain image no longer blocks all color controls.
- Milky Glass now displays the existing `milky-opacity` setting as **Milky Opacity**. White/Black color changes now preserve user-controlled opacity, including at 100%, and black-only grain is not disabled by color selection.
- Dynamic Milky header selectors now match the runtime stylesheet's specificity so Full Header and Bottom Taskbar honor the live white-balance/opacity values.


- Quick Settings opens its native menu immediately on the first click; heavy glass preparation runs on an idle turn while a lightweight card remains visible until the first successful shader composite.
- Prioritize Quick Settings during startup material prewarming, avoiding a full Calendar-first delay.
- Position VLIQ as a Windows-style Bottom Taskbar enhancement in the README and add a real desktop screenshot highlighting native GNOME Calendar and notifications.

- Bottom Taskbar notification destroy/remove events now release per-notification references and signal handlers immediately, including count-only GNOME providers.
- Brightness software dimming no longer retains a compositor inhibition lease when a foreign effect occupies its name or the host lookup fails.
- Detached GNOME Shell card subtrees now release tracked actor signals and surfaces after a deferred reparenting-safe reconciliation.

### Security

- Added a dedicated security policy covering GNOME Shell extension-specific risks, private reporting and coordinated disclosure.

[Unreleased]: https://github.com/Anuppaul/vliq/commits/main
