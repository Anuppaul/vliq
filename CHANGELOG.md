# Changelog

All notable project changes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release versioning will be documented when the first public tagged release is prepared.

## [Unreleased]

### Added

- Adjustable Milky Glass Micro-grain using a static, repeatable native CSS noise tile (no added shader, animation or frame loop).
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

- Milky Glass replaces the old White Balance slider with a persistent White/Black color switch. Its opacity remains independent (0–100) and its deterministic grain uses **black particles only** in both color modes. No additional shader or animation.

- README contributor entry points now link to the full community and development resources.
- Reduced recurring Calendar text-contrast screenshot sampling from 3.2 seconds to 12 seconds while preserving the first-open sample and dynamic-backdrop contrast updates.

### Fixed

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
