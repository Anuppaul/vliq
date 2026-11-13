# Changelog

All notable project changes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release versioning will be documented when the first public tagged release is prepared.

## [Unreleased]

### Added

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

- README contributor entry points now link to the full community and development resources.
- Reduced recurring Calendar text-contrast screenshot sampling from 3.2 seconds to 12 seconds while preserving the first-open sample and dynamic-backdrop contrast updates.

### Fixed

- Bottom Taskbar notification destroy/remove events now release per-notification references and signal handlers immediately, including count-only GNOME providers.
- Brightness software dimming no longer retains a compositor inhibition lease when a foreign effect occupies its name or the host lookup fails.
- Detached GNOME Shell card subtrees now release tracked actor signals and surfaces after a deferred reparenting-safe reconciliation.

### Security

- Added a dedicated security policy covering GNOME Shell extension-specific risks, private reporting and coordinated disclosure.

[Unreleased]: https://github.com/Anuppaul/vliq/commits/main
