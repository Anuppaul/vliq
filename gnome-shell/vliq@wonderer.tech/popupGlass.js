import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    GLASS_TEXT_PALETTE,
    VLIQ_GLASS_ADAPTERS,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
    resolveGlassInteractionTarget,
    stepGlassInteraction,
} from './glassMaterialSystem.js';

const GLASS_CLASS = 'vliq-liquid-popup-content';
const SHELL_CLASS = 'vliq-liquid-popup-shell';
const DATE_SHELL_CLASS = 'vliq-liquid-date-menu-shell';
const QUICK_SHELL_CLASS = 'vliq-liquid-quick-menu-shell';
const QUICK_ROOT_CLASS = 'vliq-liquid-quick-menu-root';
const DEFAULT_RADIUS = 18;
const GLASS_EDGE_PAD = 20;
const SAMPLE_MARGIN_MIN = 64;
const SAMPLE_MARGIN_MAX = 200;
// GNOME's PopupMenuManager switches panel menus immediately on pointer ENTER
// using PopupAnimation.FADE. Do not build a new GPU glass stack for a menu the
// pointer merely crosses on the way to another indicator.
const HOVER_SWITCH_GLASS_DWELL_MS = 120;
const DEFAULT_PANEL_MENU_HOVER_DWELL_MS = 300;

const DATE_INNER_CARD_CLASSES = new Set([
    'datemenu-today-button',
    'calendar',
    'events-button',
    'world-clocks-button',
    'weather-button',
    'message',
    'message-list-clear-button',
]);
const DATE_INNER_CARD_PRIORITY = new Map([
    ['datemenu-today-button', 0],
    ['calendar', 1],
    ['events-button', 2],
    ['world-clocks-button', 3],
    ['weather-button', 4],
    ['message-list-clear-button', 5],
    ['message', 6],
]);
const QUICK_INNER_CARD_CLASSES = new Set([
    'quick-toggle-has-menu',
    'quick-toggle',
    'quick-slider',
    'quick-toggle-menu',
]);
const DATE_INNER_PAD = 20;
const MAX_INNER_GLASS_REGIONS = 16;
const DATE_INNER_SCAN_INTERVAL_US = 500000;
const DATE_TEXT_LIGHT_CLASS = 'vliq-date-text-light';
const DATE_TEXT_DARK_CLASS = 'vliq-date-text-dark';
const DATE_CARD_TEXT_LIGHT_CLASS = 'vliq-date-card-text-light';
const DATE_CARD_TEXT_DARK_CLASS = 'vliq-date-card-text-dark';
const QUICK_CARD_TEXT_LIGHT_CLASS = 'vliq-quick-card-text-light';
const QUICK_CARD_TEXT_DARK_CLASS = 'vliq-quick-card-text-dark';
const QUICK_ACTIVE_CLASS = 'vliq-quick-active';
const DATE_LIGHT_TEXT = GLASS_TEXT_PALETTE.light;
const DATE_DARK_TEXT = GLASS_TEXT_PALETTE.dark;
const DATE_TEXT_SWITCH_ADVANTAGE = 1.18;
const DATE_MIN_READABLE_CONTRAST = 4.5;
const DATE_CARD_SAMPLE_GRID = 28;

function finiteRect(values) {
    return values.every(Number.isFinite) &&
        values[2] > 1 &&
        values[3] > 1;
}

function readRadius(actor) {
    try {
        actor.ensure_style?.();
        const node = actor.get_theme_node?.();
        const values = [
            St.Corner.TOPLEFT,
            St.Corner.TOPRIGHT,
            St.Corner.BOTTOMRIGHT,
            St.Corner.BOTTOMLEFT,
        ].map(corner => node?.get_border_radius?.(corner) ?? 0);
        const radius = Math.max(...values);
        if (Number.isFinite(radius) && radius > 0)
            return radius;
    } catch {
        // Theme-derived fallback below.
    }
    return DEFAULT_RADIUS;
}

function actorClasses(actor) {
    return String(
        actor?.get_style_class_name?.() ??
        actor?.style_class ??
        ''
    ).split(/\s+/).filter(Boolean);
}

function dateCardClass(actor) {
    for (const name of actorClasses(actor)) {
        if (DATE_INNER_CARD_CLASSES.has(name))
            return name;
    }
    return null;
}

function quickCardClass(actor, inSystemItem = false) {
    const classes = actorClasses(actor);

    for (const name of classes) {
        if (QUICK_INNER_CARD_CLASSES.has(name))
            return name;
    }

    if (inSystemItem && classes.includes('icon-button'))
        return 'system-icon-button';

    return null;
}

function hasPseudo(actor, name) {
    try {
        return Boolean(
            actor?.has_style_pseudo_class?.(name)
        );
    } catch {
        return false;
    }
}

function actorIsDescendantOf(actor, ancestor) {
    if (!actor || !ancestor)
        return false;

    let current = actor;
    let guard = 64;
    while (current && guard-- > 0) {
        if (current === ancestor)
            return true;
        current = current.get_parent?.() ?? null;
    }

    return false;
}

function quickCardState(actor) {
    let pressed = false;
    let selected = false;
    let hovered = false;
    let focused = false;

    const walk = node => {
        if (!node)
            return;

        pressed ||= hasPseudo(node, 'active');
        selected ||=
            node?.checked === true ||
            node?.get_checked?.() === true ||
            hasPseudo(node, 'checked') ||
            hasPseudo(node, 'selected');
        hovered ||= hasPseudo(node, 'hover');
        focused ||= hasPseudo(node, 'focus');

        if (pressed && selected && hovered && focused)
            return;

        for (const child of node.get_children?.() ?? [])
            walk(child);
    };

    walk(actor);

    return {
        pressed,
        selected,
        engaged: pressed || hovered || focused,
    };
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function srgbToLinear(channel) {
    const n = channel / 255;
    return n <= 0.04045
        ? n / 12.92
        : Math.pow((n + 0.055) / 1.055, 2.4);
}

function rgbLuminance(r, g, b) {
    return (
        0.2126 * srgbToLinear(r) +
        0.7152 * srgbToLinear(g) +
        0.0722 * srgbToLinear(b)
    );
}

function hexLuminance(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return rgbLuminance(
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    );
}

function trimmedMean(values, trimRatio = 0.30) {
    if (!values.length)
        return null;

    const sorted = values.slice().sort((a, b) => a - b);
    const trim = Math.min(
        Math.floor(sorted.length * trimRatio),
        Math.floor((sorted.length - 1) / 2)
    );
    const start = trim;
    const end = sorted.length - trim;

    let sum = 0;
    for (let i = start; i < end; i++)
        sum += sorted[i];

    return sum / Math.max(1, end - start);
}

function contrastRatio(a, b) {
    return (
        (Math.max(a, b) + 0.05) /
        (Math.min(a, b) + 0.05)
    );
}

const DATE_LIGHT_LUMA = hexLuminance(DATE_LIGHT_TEXT);
const DATE_DARK_LUMA = hexLuminance(DATE_DARK_TEXT);

/**
 * Standard GNOME PopupMenu Liquid Glass.
 *
 * Native hierarchy stays untouched:
 *
 *   Main.uiGroup
 *     └─ menu.actor = BoxPointer
 *          └─ BoxPointer.bin
 *               └─ menu.box (.popup-menu-content)
 *
 * VLIQ adds a separate, unpickable, full-monitor paint layer directly below
 * menu.actor in Main.uiGroup. Its shader mask follows menu.box's transformed
 * stage rect. This avoids participating in BoxPointer layout/allocation at all.
 */
class PopupGlassSurface {
    constructor(manager, menu) {
        this._manager = manager;
        this._vendor = manager._vendor;
        this._settings = manager._settings;
        this._menu = menu;
        this._box = menu?.box ?? null;
        this._boxPointer = menu?._boxPointer ?? menu?.actor ?? null;
        this._bin = menu?._boxPointer?.bin ?? null;
        this._paintRoot = null;
        this._nativeBoxPointerBorder = null;
        this._nativeBoxPointerBorderOpacity = null;

        this._root = null;
        this._liquidBox = null;
        this._sceneManager = null;
        // Every native popup uses the same scene-selection pipeline:
        // Overview/App Grid when present, otherwise real desktop windows
        // above the shared wallpaper. This source is always a sibling,
        // never an ancestor of this popup.
        this._overviewSceneClone = null;
        this._overviewSceneSource = null;
        this._lastOverviewSceneGeometryKey = '';
        this._filterLayer = null;
        this._effect = null;

        // Date Menu and Quick Settings share one nested multi-region
        // LiquidEffect. It clones the already-rendered outer glass and
        // refracts that clone inside the native card/pod bounds: the exact
        // same glass-on-glass pipeline for both surfaces.
        this._dateInnerRoot = null;
        this._dateInnerLiquidBox = null;
        this._dateInnerClone = null;
        this._dateInnerEffect = null;
        this._dateCardActors = [];
        this._dateCardResponses = new Map();
        this._dateCardTextState = new Map();
        this._quickSelectedState = new Map();
        this._dateInnerRegionCount = 0;
        this._dateInnerRadius = 16;
        this._lastDateCardScanUs = 0;
        this._lastQuickOverlayOpen = false;
        this._quickRegionDirty = true;
        this._quickNeedsRescan = true;
        this._quickSignalEntries = [];
        this._quickThemeContext = null;
        this._quickThemeChangedId = 0;
        this._quickPatchedMenus = new Map();

        this._dateScreenshot = null;
        this._dateTextSampleSourceId = 0;
        this._dateTextGeneration = 0;

        this._radius = DEFAULT_RADIUS;
        this._destroyed = false;
        this._openStateId = 0;
        const popupClasses = String(
            this._box?.get_style_class_name?.() ??
            this._box?.style_class ??
            ''
        ).split(/\s+/);

        this._isDateMenu =
            popupClasses.includes('datemenu-popover') ||
            // Some GNOME 50 themes do not preserve the canonical style
            // class throughout an Overview/popup menu handoff. The native
            // Date Menu object is the authoritative owner in that case.
            Boolean(
                this._menu &&
                this._menu === Main.panel?.statusArea?.dateMenu?.menu
            );
        this._isQuickSettings =
            popupClasses.includes('quick-settings');

        this._lastFullSyncUs = 0;
        this._fullSyncDirty = true;

        this._surfaceAdapter =
            this._isDateMenu
                ? VLIQ_GLASS_ADAPTERS.dateMenu
                : (
                    this._isQuickSettings
                        ? VLIQ_GLASS_ADAPTERS.quickMenu
                        : VLIQ_GLASS_ADAPTERS.popupMenu
                );
        this._lastSceneSyncUs = 0;
        this._overviewWindowCaptureEnabled = null;

        this._lastShaderX = NaN;
        this._lastShaderY = NaN;
        this._lastShaderW = NaN;
        this._lastShaderH = NaN;
        this._lastEffectResolutionW = 0;
        this._lastEffectResolutionH = 0;
        this._lastInnerResolutionW = 0;
        this._lastInnerResolutionH = 0;
        this._lastInnerRegions = [];
        this._lastFullGeometryX = NaN;
        this._lastFullGeometryY = NaN;
        this._lastFullGeometryW = NaN;
        this._lastFullGeometryH = NaN;
        this._lastPaintOpacity = NaN;
        this._lastFullOpacity = NaN;
        this._lastShadowMaxRadius = NaN;
        this._sceneCaptureRect = null;
        this._lastMonitorX = NaN;
        this._lastMonitorY = NaN;
        this._lastScreenW = 0;
        this._lastScreenH = 0;
        this._lastFullGeometryX = NaN;
        this._lastFullGeometryY = NaN;
        this._lastFullGeometryW = NaN;
        this._lastFullGeometryH = NaN;
        this._lastPaintOpacity = NaN;
        this._lastFullOpacity = NaN;
        this._sceneCaptureRect = null;
    }

    _suppressNativeBoxPointerBorder() {
        const border =
            this._boxPointer?._border ??
            null;
        if (!border)
            return;

        if (!this._nativeBoxPointerBorder) {
            this._nativeBoxPointerBorder = border;
            this._nativeBoxPointerBorderOpacity =
                border.opacity ?? 255;
        }

        // BoxPointer._border is a St.DrawingArea that paints GNOME/Yaru's
        // own full rounded popover outline. Keeping it allocated but fully
        // transparent preserves native geometry while removing the second
        // visible card edge behind VLIQ's LiquidEffect rim.
        if (border.opacity !== 0)
            border.opacity = 0;
        border.queue_repaint?.();
    }

    _resolvePaintRoot() {
        let root =
            this._boxPointer ??
            this._menu?.actor ??
            null;

        let guard = 32;
        while (
            root?.get_parent?.() &&
            root.get_parent() !== Main.layoutManager.uiGroup &&
            guard-- > 0
        ) {
            root = root.get_parent();
        }

        return (
            root?.get_parent?.() === Main.layoutManager.uiGroup
                ? root
                : null
        );
    }

    attach() {
        if (
            this._destroyed ||
            !this._box ||
            !this._bin ||
            !this._boxPointer ||
            this._root
        ) {
            return Boolean(this._root);
        }

        // Recover stale wrapper/direct-material remnants from older VLIQ
        // revisions before installing the stage-level material.
        const currentChild = this._bin.get_child?.() ?? null;
        if (
            currentChild !== this._box &&
            currentChild?.get_name?.() === 'vliq-popup-glass-stack' &&
            this._box.get_parent?.() === currentChild
        ) {
            try {
                currentChild.remove_child(this._box);
                this._bin.set_child(this._box);
                currentChild.destroy?.();
            } catch (error) {
                console.error(
                    '[VLIQ][PopupGlass] stale wrapper recovery failed: ' +
                    error
                );
                return false;
            }
        }

        for (const child of this._boxPointer.get_children?.() ?? []) {
            if (
                child !== this._bin &&
                child.get_name?.() === 'vliq-popup-glass-material'
            ) {
                try {
                    child.destroy?.();
                } catch {
                    // Best-effort recovery from an older runtime.
                }
            }
        }

        if (this._bin.get_child?.() !== this._box)
            return false;

        this._radius = readRadius(this._box);
        this._paintRoot = this._resolvePaintRoot();

        const root = new this._vendor.UnpickableActor({
            name: 'vliq-popup-material-root',
            reactive: false,
        });
        root.set_size(1, 1);
        root.hide();

        const liquidBox = new this._vendor.UnpickableActor({
            name: 'vliq-popup-liquid-box',
            reactive: false,
        });
        liquidBox.set_clip_to_allocation(true);
        liquidBox.set_position(0, 0);
        liquidBox.set_size(1, 1);
        root.add_child(liquidBox);

        // One scene-selection policy for ALL native popups:
        // - desktop: live Meta.WindowActor clones over shared wallpaper;
        // - Overview/App Grid: GNOME's actual native overviewGroup pixels,
        //   including VLIQ's existing blurred Overview backdrop/icons;
        // - empty desktop: just the shared wallpaper.
        //
        // Do NOT clone Main.uiGroup/global.stage: those contain popup
        // roots and would create recursive offscreen captures. The
        // overviewGroup is a separate subtree (a sibling of our popup root).
        // The existing WindowCloneManager and its wallpaper mirror remain
        // the sole source owner; one native Overview Clutter.Clone is an
        // additional source *within the same LiquidEffect*, not a new
        // rendering effect or a CSS overlay.
        const sceneManager =
            new this._vendor.WindowCloneManager(
                liquidBox,
                null,
                'vliq-popup-scene'
            );

        let overviewSceneClone = null;
        let overviewSceneSource = null;
        const overview =
            Main.layoutManager.overviewGroup ?? null;
        let ancestor = liquidBox;
        let recursive = false;
        while (ancestor) {
            if (ancestor === overview) {
                recursive = true;
                break;
            }
            ancestor = ancestor.get_parent?.() ?? null;
        }

        if (overview && !recursive) {
            try {
                overviewSceneClone = new Clutter.Clone({
                    source: overview,
                    reactive: false,
                });
                overviewSceneClone.set_name?.(
                    'vliq-popup-native-overview-scene'
                );
                overviewSceneClone.set_no_layout?.(true);
                overviewSceneClone.set_position(0, 0);
                overviewSceneClone.set_size(1, 1);
                overviewSceneClone.hide();
                // WindowCloneManager already placed the wallpaper first,
                // windows second. The native Overview clone stays above
                // both but is visible ONLY when GNOME paints Overview.
                // At that point live desktop-window clones are hidden.
                liquidBox.add_child(overviewSceneClone);
                overviewSceneSource = overview;
            } catch (error) {
                try { overviewSceneClone?.destroy?.(); } catch {}
                overviewSceneClone = null;
                console.warn(
                    '[VLIQ][PopupGlass] Overview scene clone unavailable: ' +
                    error
                );
            }
        }

        const breaker = new this._vendor.UnpickableActor({
            name: 'vliq-popup-optimization-breaker',
            reactive: false,
        });
        breaker.set_size(1, 1);
        breaker.set_opacity(0);
        liquidBox.add_child(breaker);

        const effect = new this._vendor.LiquidEffect({
            extensionPath: this._vendor.root,
            settings: this._settings,
            owner: 'vliq-popup',
        });
        effect.setPadding?.(
            this._surfaceAdapter?.shaderPadding ??
            GLASS_EDGE_PAD
        );
        effect.setIsDock?.(false);
        effect.setSurfaceLightEnabled?.(true);
        effect.setCornerRadius?.(this._radius);
        effect.setBlurMethod?.(1);
        liquidBox.add_effect(effect);

        const filterLayer = new St.Widget({
            name: 'vliq-popup-white-filter',
            style_class: 'vliq-glass-white-filter',
            reactive: false,
        });
        root.add_child(filterLayer);

        let dateInnerRoot = null;
        let dateInnerLiquidBox = null;
        let dateInnerClone = null;
        let dateInnerEffect = null;

        if (this._isDateMenu || this._isQuickSettings) {
            dateInnerRoot = new this._vendor.UnpickableActor({
                name: 'vliq-popup-inner-material-root',
                reactive: false,
            });
            dateInnerRoot.set_size(1, 1);
            dateInnerRoot.hide();

            dateInnerLiquidBox = new this._vendor.UnpickableActor({
                name: 'vliq-popup-inner-liquid-box',
                reactive: false,
            });
            dateInnerLiquidBox.set_clip_to_allocation(true);
            dateInnerLiquidBox.set_position(0, 0);
            dateInnerLiquidBox.set_size(1, 1);
            dateInnerRoot.add_child(dateInnerLiquidBox);

            // Safe non-recursive source: dateInnerRoot is a sibling ABOVE
            // root, while the clone points DOWN to root. root never contains
            // dateInnerRoot, so this cannot form a paint cycle.
            dateInnerClone = new Clutter.Clone({
                source: root,
                reactive: false,
            });
            dateInnerClone.set_position(0, 0);
            dateInnerClone.set_size(1, 1);
            dateInnerLiquidBox.add_child(dateInnerClone);

            dateInnerEffect = new this._vendor.LiquidEffect({
                extensionPath: this._vendor.root,
                settings: this._settings,
                owner: 'vliq-popup-inner-cards',
            });
            dateInnerEffect.setPadding?.(DATE_INNER_PAD);
            dateInnerEffect.setIsDock?.(false);
            dateInnerEffect.setSurfaceLightEnabled?.(true);
            dateInnerEffect.setCornerRadius?.(16);
            dateInnerEffect.setBlurMethod?.(1);
            dateInnerEffect.setMultiRegionMode?.(true);
            dateInnerLiquidBox.add_effect(dateInnerEffect);
        }

        try {
            const paintRoot =
                this._paintRoot ??
                this._resolvePaintRoot();

            if (paintRoot) {
                // Both material layers must remain BELOW the full native popup
                // paint root. QuickSettingsMenu wraps BoxPointer + overlay in
                // an extra actor, unlike Date Menu; anchoring to BoxPointer
                // alone put glass above Quick Settings content.
                Main.layoutManager.uiGroup.insert_child_below(
                    root,
                    paintRoot
                );

                if (dateInnerRoot) {
                    Main.layoutManager.uiGroup.insert_child_above(
                        dateInnerRoot,
                        root
                    );
                    Main.layoutManager.uiGroup.set_child_below_sibling?.(
                        dateInnerRoot,
                        paintRoot
                    );
                }
            } else {
                // Unknown hierarchy: fail safe by keeping material below other
                // UI-group children rather than painting over native content.
                Main.layoutManager.uiGroup.insert_child_at_index?.(
                    root,
                    0
                );
                if (dateInnerRoot) {
                    Main.layoutManager.uiGroup.insert_child_above(
                        dateInnerRoot,
                        root
                    );
                }
            }
        } catch (error) {
            try {
                sceneManager.destroy?.();
            } catch {}
            try {
                dateInnerRoot?.destroy?.();
            } catch {}
            try {
                root.destroy?.();
            } catch {}

            console.error(
                '[VLIQ][PopupGlass] stage material attach failed: ' +
                error
            );
            return false;
        }

        this._box.add_style_class_name?.(GLASS_CLASS);
        this._boxPointer.add_style_class_name?.(SHELL_CLASS);
        this._suppressNativeBoxPointerBorder();
        if (this._isDateMenu)
            this._boxPointer.add_style_class_name?.(DATE_SHELL_CLASS);
        if (this._isQuickSettings) {
            this._boxPointer.add_style_class_name?.(QUICK_SHELL_CLASS);
            this._menu?.actor?.add_style_class_name?.(
                QUICK_ROOT_CLASS
            );
            this._setupQuickThemeSync();
        }

        this._root = root;
        this._liquidBox = liquidBox;
        this._sceneManager = sceneManager;
        this._overviewSceneClone = overviewSceneClone;
        this._overviewSceneSource = overviewSceneSource;
        this._lastOverviewSceneGeometryKey = '';
        this._filterLayer = filterLayer;
        this._effect = effect;
        this._dateInnerRoot = dateInnerRoot;
        this._dateInnerLiquidBox = dateInnerLiquidBox;
        this._dateInnerClone = dateInnerClone;
        this._dateInnerEffect = dateInnerEffect;

        try {
            this._openStateId = this._menu.connect(
                'open-state-changed',
                (_menu, isOpen) => {
                    if (!isOpen) {
                        this._root?.hide?.();
                        this._dateInnerRoot?.hide?.();
                        this._cancelDateTextSample();
                        this._manager?._syncStageLoopState?.();
                        return;
                    }

                    // On every reopen, use the ACTUAL scene currently
                    // behind GNOME's native popup. This also repairs
                    // older cached vendor managers that have rebuilt their
                    // window-clone subtree while the menu was closed.
                    this._syncOverviewWindowCapture();

                    // Reopening a popup must not destroy and recreate the live
                    // capture tree. WindowCloneManager.sync() already heals
                    // added/removed windows. Rebuilding here allocated a new
                    // background + clone tree and could expose an empty capture
                    // for the first rendered frame.
                    this._lastSceneSyncUs = 0;
                    this._lastFullSyncUs = 0;
                    this._fullSyncDirty = true;
                    this._manager?._ensureStageSync?.();

                    const needsCardRescan =
                        this._dateCardActors.length === 0 ||
                        (
                            this._isQuickSettings &&
                            this._quickNeedsRescan
                        );
                    this._scanDateCardActors(
                        needsCardRescan
                    );
                    if (this._isQuickSettings)
                        this._applyQuickThemeForegroundPolarity();

                    if (this._surfaceAdapter?.adaptiveText) {
                        this._scheduleDateTextSample(
                            this._surfaceAdapter.adaptiveSampleDelayMs
                                ?? 220
                        );
                    }
                    this._invalidateGeometry();
                    this._root?.queue_redraw?.();
                    this._dateInnerRoot?.queue_redraw?.();
                }
            );
        } catch {
            this._openStateId = 0;
        }

        effect.setLiveGeometryHook?.(() => {
            // Paint-time path is uniforms only; actor tree writes remain in
            // the stage before-update sync.
            this._syncShaderGeometry();
        });

        // The outer effect's paint hook already calls _sync(true), which
        // updates Date Menu inner regions once per compositor paint. A second
        // live hook on dateInnerEffect duplicated the full region traversal.
        dateInnerEffect?.setLiveGeometryHook?.(null);

        this.updateAppearance(this._manager._appearance);
        this._sync(false);

        console.log(
            '[VLIQ][PopupGlass] attached ' +
            this._manager.describeMenu(this._menu)
        );
        return true;
    }

    _invalidateGeometry() {
        this._fullSyncDirty = true;
        this._lastShaderX = NaN;
        this._lastShaderY = NaN;
        this._lastShaderW = NaN;
        this._lastShaderH = NaN;
        this._lastMonitorX = NaN;
        this._lastMonitorY = NaN;
        this._lastScreenW = 0;
        this._lastScreenH = 0;
    }

    _applyQuickThemeForegroundPolarity() {
        if (
            !this._isQuickSettings ||
            !this._box
        ) {
            return;
        }

        try {
            this._box.ensure_style?.();
            const color =
                this._box.get_theme_node?.()
                    ?.get_foreground_color?.();
            if (!color)
                return;

            const luma = rgbLuminance(
                color.red,
                color.green,
                color.blue
            );

            // Light theme foreground is dark -> use dark text. Dark theme
            // foreground is light -> use light text.
            const useDarkText = luma < 0.5;

            for (const actor of this._dateCardActors) {
                if (actor?.visible && actor?.mapped)
                    this._applyDateCardTextPolarity(
                        actor,
                        useDarkText
                    );
            }
        } catch {
            // Backdrop sampling remains the correction path.
        }
    }

    _setupQuickThemeSync() {
        if (
            !this._isQuickSettings ||
            this._quickThemeChangedId
        ) {
            return;
        }

        try {
            const context =
                St.ThemeContext.get_for_stage(global.stage);
            this._quickThemeContext = context;
            this._quickThemeChangedId =
                context.connect('changed', () => {
                    if (
                        this._destroyed ||
                        !this._menu?.isOpen
                    ) {
                        return;
                    }

                    this._applyQuickThemeForegroundPolarity();
                    this._quickRegionDirty = true;
                    this._fullSyncDirty = true;
                    this._dateInnerRoot?.queue_redraw?.();

                    if (this._surfaceAdapter?.adaptiveText) {
                        this._scheduleDateTextSample(
                            this._surfaceAdapter
                                ?.themeResampleDelayMs
                                ?? 16
                        );
                    }
                });
        } catch {
            this._quickThemeContext = null;
            this._quickThemeChangedId = 0;
        }
    }

    _cleanupQuickThemeSync() {
        if (
            this._quickThemeContext &&
            this._quickThemeChangedId
        ) {
            try {
                this._quickThemeContext.disconnect(
                    this._quickThemeChangedId
                );
            } catch {}
        }

        this._quickThemeContext = null;
        this._quickThemeChangedId = 0;
    }

    _patchQuickOverlayMenuClose(actor) {
        if (
            !this._isQuickSettings ||
            this._surfaceAdapter?.collapseFade !== false
        ) {
            return;
        }

        const classes = actorClasses(actor);
        if (!classes.includes('quick-toggle-menu-container'))
            return;

        const menu = actor?._delegate ?? null;
        if (
            !menu ||
            typeof menu.close !== 'function' ||
            this._quickPatchedMenus.has(menu)
        ) {
            return;
        }

        const originalClose = menu.close;
        this._quickPatchedMenus.set(menu, originalClose);

        menu.close = function (_animate) {
            // PopupAnimation.NONE is numeric 0 in GNOME Shell. Passing 0 to
            // the native implementation removes both opacity fade and the
            // delayed collapse while preserving all close signals/cleanup.
            return originalClose.call(this, 0);
        };
    }

    _restoreQuickOverlayMenuCloses() {
        for (const [menu, originalClose] of this._quickPatchedMenus) {
            try {
                if (menu)
                    menu.close = originalClose;
            } catch {}
        }
        this._quickPatchedMenus.clear();
    }

    _clearQuickSignalEntries() {
        for (const {obj, id} of this._quickSignalEntries) {
            try {
                obj?.disconnect?.(id);
            } catch {}
        }
        this._quickSignalEntries = [];
    }

    _watchQuickActor(actor) {
        if (
            !this._isQuickSettings ||
            !actor
        ) {
            return;
        }

        const markDirty = () => {
            const wasDirty =
                this._quickRegionDirty;

            this._quickRegionDirty = true;
            this._fullSyncDirty = true;

            // A burst of child/style notifications can arrive from one user
            // gesture. One queued redraw is sufficient until the next sync
            // consumes the dirty flag.
            if (!wasDirty)
                this._dateInnerRoot?.queue_redraw?.();
        };

        for (const signal of [
            'style-changed',
            'notify::checked',
            'notify::hover',
            'notify::visible',
            'notify::mapped',
            'notify::allocation',
        ]) {
            try {
                const id = actor.connect(
                    signal,
                    markDirty
                );
                this._quickSignalEntries.push({
                    obj: actor,
                    id,
                });
            } catch {
                // Not every card actor exposes every property notification.
            }
        }
    }

    _rebuildQuickSignalEntries() {
        if (!this._isQuickSettings)
            return;

        this._clearQuickSignalEntries();

        // The region registry already contains the semantic Quick Settings
        // cards we care about. Watching every descendant multiplied signal
        // traffic during hover/animation with no extra visual information.
        for (const actor of this._dateCardActors)
            this._watchQuickActor(actor);
    }

    _scanDateCardActors(force = false) {
        if (
            (!this._isDateMenu && !this._isQuickSettings) ||
            !this._box
        ) {
            return;
        }

        const nowUs = GLib.get_monotonic_time();

        if (
            !force &&
            this._dateCardActors.length > 0 &&
            nowUs - this._lastDateCardScanUs <
                DATE_INNER_SCAN_INTERVAL_US
        ) {
            return;
        }

        this._lastDateCardScanUs = nowUs;
        const found = [];

        const walk = (actor, inSystemItem = false) => {
            if (!actor)
                return;

            if (this._isQuickSettings)
                this._patchQuickOverlayMenuClose(actor);

            let systemItem = inSystemItem;
            if (actor !== this._box) {
                const classes = actorClasses(actor);
                systemItem =
                    systemItem ||
                    classes.includes('quick-settings-system-item');

                const klass = this._isDateMenu
                    ? dateCardClass(actor)
                    : quickCardClass(actor, systemItem);

                if (klass) {
                    if (
                        !this._isQuickSettings ||
                        actor.visible ||
                        actor.mapped
                    ) {
                        found.push({actor, klass});
                    }
                    return;
                }
            }

            for (const child of actor.get_children?.() ?? [])
                walk(child, systemItem);
        };

        walk(this._box);

        // GNOME QuickSettingsMenu renders expanded Wi-Fi/Bluetooth/Power
        // menus in a sibling overlay, not inside menu.box. Scan that overlay
        // as part of the same physical popup so collapsible cards receive the
        // exact same nested glass material.
        if (
            this._isQuickSettings &&
            this._menu?._overlay
        ) {
            walk(this._menu._overlay);
        }

        if (this._isDateMenu) {
            found.sort((a, b) =>
                (DATE_INNER_CARD_PRIORITY.get(a.klass) ?? 99) -
                (DATE_INNER_CARD_PRIORITY.get(b.klass) ?? 99)
            );
        } else {
            const overlay =
                this._menu?._overlay ?? null;

            // The shader can draw at most 16 regions, but adaptive foreground
            // must cover every visible Quick Settings card. Keep the full
            // actor registry and order expanded overlay menus first so Power
            // Mode / Wi-Fi / Bluetooth can never be dropped from the shader
            // region budget by the main grid's many buttons/sliders.
            found.sort((a, b) => {
                const aOverlay =
                    actorIsDescendantOf(a.actor, overlay) ? 0 : 1;
                const bOverlay =
                    actorIsDescendantOf(b.actor, overlay) ? 0 : 1;
                if (aOverlay !== bOverlay)
                    return aOverlay - bOverlay;

                const [ax, ay] =
                    a.actor.get_transformed_position?.() ?? [0, 0];
                const [bx, by] =
                    b.actor.get_transformed_position?.() ?? [0, 0];
                return (ay - by) || (ax - bx);
            });
        }

        // Keep every discovered actor for adaptive text and state tracking.
        // Region limiting happens only at the shader boundary below.
        this._dateCardActors =
            found.map(item => item.actor);

        if (this._isQuickSettings) {
            this._rebuildQuickSignalEntries();
            this._quickNeedsRescan = false;
        }

        const live = new Set(this._dateCardActors);
        for (const actor of this._dateCardResponses.keys()) {
            if (!live.has(actor))
                this._dateCardResponses.delete(actor);
        }

        for (const actor of this._quickSelectedState.keys()) {
            if (live.has(actor))
                continue;

            try {
                actor.remove_style_class_name?.(
                    QUICK_ACTIVE_CLASS
                );
            } catch {}
            this._quickSelectedState.delete(actor);
        }

        for (const actor of this._dateCardTextState.keys()) {
            if (live.has(actor))
                continue;

            try {
                actor.remove_style_class_name?.(
                    DATE_CARD_TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    DATE_CARD_TEXT_DARK_CLASS
                );
                actor.remove_style_class_name?.(
                    QUICK_CARD_TEXT_LIGHT_CLASS
                );
                actor.remove_style_class_name?.(
                    QUICK_CARD_TEXT_DARK_CLASS
                );
            } catch {}
            this._dateCardTextState.delete(actor);
        }

        const radii = this._dateCardActors
            .map(actor => readRadius(actor))
            .filter(radius =>
                Number.isFinite(radius) &&
                radius >= 6 &&
                radius <= 36
            )
            .sort((a, b) => a - b);

        if (radii.length) {
            const middle = Math.floor(radii.length / 2);
            const median =
                radii.length % 2
                    ? radii[middle]
                    : (radii[middle - 1] + radii[middle]) / 2;
            const nextRadius =
                clampNumber(Math.round(median), 10, 28);

            if (nextRadius !== this._dateInnerRadius) {
                this._dateInnerRadius = nextRadius;
                this._dateInnerEffect?.setCornerRadius?.(
                    nextRadius
                );
            }
        }
    }

    _dateCardResponse(actor, klass, quickState = null) {
        if (this._isDateMenu && klass === 'calendar')
            return 0;

        let pressed;
        let selected;
        let engaged;

        if (this._isQuickSettings) {
            const state =
                quickState ?? quickCardState(actor);
            ({pressed, selected, engaged} = state);
        } else {
            pressed = hasPseudo(actor, 'active');
            selected =
                hasPseudo(actor, 'checked') ||
                hasPseudo(actor, 'selected');
            engaged =
                pressed ||
                hasPseudo(actor, 'hover') ||
                hasPseudo(actor, 'focus');
        }

        const role = VLIQ_GLASS_ROLES.innerCard;
        const target = resolveGlassInteractionTarget(
            {
                pressed,
                engaged,
                // Quick Settings active state is foreground-only. Selected
                // must not alter tile body/material at rest.
                selected:
                    this._isQuickSettings
                        ? false
                        : selected,
            },
            role.interaction
        );
        const previous =
            this._dateCardResponses.get(actor) ?? 0.0;
        const next =
            this._isQuickSettings
                ? target
                : stepGlassInteraction(
                    previous,
                    target,
                    role.interaction
                );

        this._dateCardResponses.set(actor, next);
        return next;
    }

    _syncDateInnerRegions(
        monitorX,
        monitorY,
        screenW,
        screenH,
        allowScan = true
    ) {
        if (!this._dateInnerEffect)
            return;

        if (allowScan)
            this._scanDateCardActors(false);

        const appearanceProfile =
            this._surfaceAdapter?.appearanceProfile ??
            (this._isDateMenu ? 'dateMenu' : null);
        const surfaceAppearance =
            appearanceProfile
                ? {
                    ...this._manager._appearance,
                    ...(this._manager._appearance?.[appearanceProfile] ?? {}),
                }
                : this._manager._appearance;
        const tintEnabled =
            (surfaceAppearance?.opacity ?? 0) > 0;

        const regions = [];

        for (const actor of this._dateCardActors) {
            if (
                !actor?.visible ||
                !actor?.mapped ||
                (actor.get_paint_opacity?.() ?? actor.opacity ?? 255) <= 0
            ) {
                continue;
            }

            const rect = this._vendor.getTransformedRect(actor);
            if (!finiteRect(rect))
                continue;

            const [absX, absY, width, height] = rect;
            const klass = this._isDateMenu
                ? dateCardClass(actor)
                : quickCardClass(actor);

            const quickAdapter =
                VLIQ_GLASS_ADAPTERS.quickMenu;
            const state =
                this._isQuickSettings
                    ? quickCardState(actor)
                    : null;
            const quickSelected =
                Boolean(state?.selected);

            if (this._isQuickSettings) {
                const previousSelected =
                    this._quickSelectedState.get(actor);

                if (previousSelected !== quickSelected) {
                    if (quickSelected) {
                        actor.add_style_class_name?.(
                            QUICK_ACTIVE_CLASS
                        );
                    } else {
                        actor.remove_style_class_name?.(
                            QUICK_ACTIVE_CLASS
                        );
                    }
                    this._quickSelectedState.set(
                        actor,
                        quickSelected
                    );
                }
            }

            const baseStrength = tintEnabled
                ? (() => {
                    if (this._isQuickSettings) {
                        return clampNumber(
                            (surfaceAppearance?.opacity ?? 0) *
                                (quickAdapter.nestedTintScale ?? 2.3),
                            0,
                            quickAdapter.nestedTintMax ?? 0.11
                        );
                    }

                    switch (klass) {
                    case 'calendar':
                        return 0.024;
                    case 'message':
                        return 0.036;
                    case 'datemenu-today-button':
                        return 0.052;
                    case 'message-list-clear-button':
                        return 0.058;
                    default:
                        return 0.046;
                    }
                })()
                : 0;

            const response =
                this._dateCardResponse(
                    actor,
                    klass,
                    state
                );

            const strengthCeiling = 0.11;

            const reactiveStrength =
                tintEnabled
                    ? Math.min(
                        strengthCeiling,
                        baseStrength + response * 0.025
                    )
                    : 0;

            const tint =
                this._isQuickSettings
                    ? quickAdapter.neutralTint
                    : [1.0, 1.0, 1.0];

            regions.push({
                x: absX - monitorX - DATE_INNER_PAD,
                y: absY - monitorY - DATE_INNER_PAD,
                w: width + DATE_INNER_PAD * 2,
                h: height + DATE_INNER_PAD * 2,
                tintR: tint[0],
                tintG: tint[1],
                tintB: tint[2],
                baseStrength: reactiveStrength,
                response,
            });
        }

        const shaderRegions =
            regions.slice(0, MAX_INNER_GLASS_REGIONS);

        this._dateInnerRegionCount = shaderRegions.length;

        if (
            this._lastInnerResolutionW !== screenW ||
            this._lastInnerResolutionH !== screenH
        ) {
            this._lastInnerResolutionW = screenW;
            this._lastInnerResolutionH = screenH;
            this._dateInnerEffect.setResolution?.(
                screenW,
                screenH
            );
        }

        let regionsChanged =
            this._lastInnerRegions.length !==
            shaderRegions.length;

        if (!regionsChanged) {
            for (let i = 0; i < shaderRegions.length; i++) {
                const next = shaderRegions[i];
                const prev = this._lastInnerRegions[i];

                if (
                    !prev ||
                    Math.abs(prev.x - next.x) > 0.01 ||
                    Math.abs(prev.y - next.y) > 0.01 ||
                    Math.abs(prev.w - next.w) > 0.01 ||
                    Math.abs(prev.h - next.h) > 0.01 ||
                    Math.abs(prev.tintR - next.tintR) > 0.001 ||
                    Math.abs(prev.tintG - next.tintG) > 0.001 ||
                    Math.abs(prev.tintB - next.tintB) > 0.001 ||
                    Math.abs(
                        prev.baseStrength -
                        next.baseStrength
                    ) > 0.001 ||
                    Math.abs(prev.response - next.response) > 0.001
                ) {
                    regionsChanged = true;
                    break;
                }
            }
        }

        if (regionsChanged) {
            this._dateInnerEffect.setGlassRegions?.(
                shaderRegions
            );
            this._lastInnerRegions =
                shaderRegions.map(region => ({
                    x: region.x,
                    y: region.y,
                    w: region.w,
                    h: region.h,
                    tintR: region.tintR,
                    tintG: region.tintG,
                    tintB: region.tintB,
                    baseStrength: region.baseStrength,
                    response: region.response,
                }));
        }

        if (this._isQuickSettings)
            this._quickRegionDirty = false;
    }

    _syncDateInnerShaderGeometry() {
        if (
            this._isQuickSettings ||
            this._destroyed ||
            !this._dateInnerEffect ||
            !this._dateInnerRoot?.mapped
        ) {
            return;
        }

        const measured = this._measure();
        if (!measured)
            return;

        const monitor = measured.monitor;
        const monitorX = monitor.x ?? 0;
        const monitorY = monitor.y ?? 0;
        const screenW = Math.max(
            1,
            monitor.width ?? global.stage.width
        );
        const screenH = Math.max(
            1,
            monitor.height ?? global.stage.height
        );

        this._syncDateInnerRegions(
            monitorX,
            monitorY,
            screenW,
            screenH,
            false
        );
    }

    _captureDateMenuFrame(rect) {
        if (!rect || rect.length < 4)
            return Promise.resolve(null);

        const [x, y, width, height] = rect;
        const left = Math.max(0, Math.floor(x));
        const top = Math.max(0, Math.floor(y));
        const right = Math.min(
            global.stage.width,
            Math.ceil(x + width)
        );
        const bottom = Math.min(
            global.stage.height,
            Math.ceil(y + height)
        );

        if (right <= left || bottom <= top)
            return Promise.resolve(null);

        if (!this._dateScreenshot)
            this._dateScreenshot = new Shell.Screenshot();

        return new Promise(resolve => {
            let stream = null;

            try {
                stream = Gio.MemoryOutputStream.new_resizable();
                this._dateScreenshot.screenshot_area(
                    left,
                    top,
                    right - left,
                    bottom - top,
                    stream,
                    (object, result) => {
                        try {
                            if (!object)
                                throw new Error('null screenshot object');

                            const [ok] =
                                object.screenshot_area_finish(result);
                            stream.close(null);

                            if (!ok) {
                                resolve(null);
                                return;
                            }

                            const bytes = stream.steal_as_bytes();
                            const pixbuf =
                                GdkPixbuf.Pixbuf.new_from_stream(
                                    Gio.MemoryInputStream.new_from_bytes(
                                        bytes
                                    ),
                                    null
                                );

                            if (!pixbuf) {
                                resolve(null);
                                return;
                            }

                            resolve({
                                x: left,
                                y: top,
                                width: pixbuf.get_width(),
                                height: pixbuf.get_height(),
                                stride: pixbuf.get_rowstride(),
                                channels: pixbuf.get_n_channels(),
                                data: pixbuf.get_pixels(),
                            });
                        } catch {
                            try {
                                stream?.close?.(null);
                            } catch {}
                            resolve(null);
                        }
                    }
                );
            } catch {
                try {
                    stream?.close?.(null);
                } catch {}
                resolve(null);
            }
        });
    }

    _dateCardLuminance(frame, actor) {
        if (!frame || !actor)
            return null;

        const rect = this._vendor.getTransformedRect(actor);
        if (!finiteRect(rect))
            return null;

        let [x, y, width, height] = rect;

        // Sample the optical body, not the antialiased rim. Media cards also
        // get a little more horizontal inset so album art cannot dominate the
        // text polarity decision.
        const klass = dateCardClass(actor);
        const insetX = klass === 'message'
            ? Math.min(18, width * 0.08)
            : Math.min(8, width * 0.04);
        const insetY = Math.min(8, height * 0.08);

        x += insetX;
        y += insetY;
        width -= insetX * 2;
        height -= insetY * 2;

        const left = clampNumber(
            Math.floor(x - frame.x),
            0,
            frame.width - 1
        );
        const top = clampNumber(
            Math.floor(y - frame.y),
            0,
            frame.height - 1
        );
        const right = clampNumber(
            Math.ceil(x + width - frame.x),
            left + 1,
            frame.width
        );
        const bottom = clampNumber(
            Math.ceil(y + height - frame.y),
            top + 1,
            frame.height
        );

        if (right <= left || bottom <= top)
            return null;

        const sampleWidth = right - left;
        const sampleHeight = bottom - top;
        const step = Math.max(
            1,
            Math.floor(
                Math.min(sampleWidth, sampleHeight) /
                DATE_CARD_SAMPLE_GRID
            )
        );

        const values = [];
        const {data, stride, channels} = frame;

        for (let py = top; py < bottom; py += step) {
            const row = py * stride;

            for (let px = left; px < right; px += step) {
                const index = row + px * channels;
                let r = data[index];
                let g = data[index + 1];
                let b = data[index + 2];

                if (channels > 3) {
                    const alpha = data[index + 3];
                    if (alpha < 32)
                        continue;

                    if (alpha < 255) {
                        const inv = 255 / alpha;
                        r = clampNumber(
                            Math.round(r * inv),
                            0,
                            255
                        );
                        g = clampNumber(
                            Math.round(g * inv),
                            0,
                            255
                        );
                        b = clampNumber(
                            Math.round(b * inv),
                            0,
                            255
                        );
                    }
                }

                values.push(rgbLuminance(r, g, b));
            }
        }

        return trimmedMean(values, 0.30);
    }

    _chooseDateCardDarkText(actor, luminance) {
        if (!Number.isFinite(luminance))
            return null;

        const lightContrast = contrastRatio(
            luminance,
            DATE_LIGHT_LUMA
        );
        const darkContrast = contrastRatio(
            luminance,
            DATE_DARK_LUMA
        );

        const previous =
            this._dateCardTextState.get(actor);

        if (previous === undefined)
            return darkContrast > lightContrast;

        const current =
            previous ? darkContrast : lightContrast;
        const alternative =
            previous ? lightContrast : darkContrast;

        // A hard readability failure always wins immediately. Otherwise
        // require a real contrast advantage before changing polarity, which
        // keeps moving wallpaper/video highlights from making text ping-pong.
        if (
            current < DATE_MIN_READABLE_CONTRAST &&
            alternative >= DATE_MIN_READABLE_CONTRAST
        ) {
            return !previous;
        }

        if (
            alternative >
            current * DATE_TEXT_SWITCH_ADVANTAGE
        ) {
            return !previous;
        }

        return previous;
    }

    _applyDateCardTextPolarity(actor, useDarkText) {
        if (!actor || useDarkText === null)
            return;

        const previous =
            this._dateCardTextState.get(actor);
        if (previous === useDarkText)
            return;

        const lightClass =
            this._isQuickSettings
                ? QUICK_CARD_TEXT_LIGHT_CLASS
                : DATE_CARD_TEXT_LIGHT_CLASS;
        const darkClass =
            this._isQuickSettings
                ? QUICK_CARD_TEXT_DARK_CLASS
                : DATE_CARD_TEXT_DARK_CLASS;

        actor.remove_style_class_name?.(lightClass);
        actor.remove_style_class_name?.(darkClass);
        actor.add_style_class_name?.(
            useDarkText ? darkClass : lightClass
        );

        // GNOME 50 renders expanded QuickToggleMenu content inside a
        // quick-toggle-menu-container parent in QuickSettingsMenu._overlay.
        // Mirror the polarity class to that container as well: Yaru/GNOME
        // assigns explicit foreground colors to popup-menu-item descendants,
        // so relying on inheritance from the inner card alone is insufficient.
        if (this._isQuickSettings) {
            const classes = actorClasses(actor);
            if (classes.includes('quick-toggle-menu')) {
                const parent = actor.get_parent?.() ?? null;
                if (
                    parent &&
                    actorClasses(parent).includes(
                        'quick-toggle-menu-container'
                    )
                ) {
                    parent.remove_style_class_name?.(lightClass);
                    parent.remove_style_class_name?.(darkClass);
                    parent.add_style_class_name?.(
                        useDarkText ? darkClass : lightClass
                    );
                }
            }
        }

        this._dateCardTextState.set(
            actor,
            useDarkText
        );

        // Polarity also drives the adaptive material tint on Quick Settings,
        // so repaint only when the decision actually changes.
        if (this._isQuickSettings) {
            this._dateInnerEffect?.queue_repaint?.();
            this._dateInnerRoot?.queue_redraw?.();
        }
    }

    _cancelDateTextSample() {
        this._dateTextGeneration++;

        if (this._dateTextSampleSourceId) {
            try {
                GLib.source_remove(this._dateTextSampleSourceId);
            } catch {}
            this._dateTextSampleSourceId = 0;
        }
    }

    _scheduleDateTextSample(delayMs = 220) {
        if (
            (!this._isDateMenu && !this._isQuickSettings) ||
            !this._box
        ) {
            return;
        }

        this._cancelDateTextSample();
        const generation = this._dateTextGeneration;

        this._dateTextSampleSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            delayMs,
            () => {
                this._dateTextSampleSourceId = 0;
                this._sampleDateTextPolarity(generation);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    async _sampleDateTextPolarity(generation) {
        if (
            this._destroyed ||
            generation !== this._dateTextGeneration ||
            !this._menu?.isOpen
        ) {
            return;
        }

        const measured = this._measure();
        if (!measured)
            return;

        this._scanDateCardActors(false);

        // QuickToggleMenu lives in QuickSettingsMenu._overlay and can extend
        // well outside the main popup allocation (Power Mode, Wi-Fi, Bluetooth
        // etc.). Sampling only measured.rect makes those actors clamp to the
        // bright edge of the main box and can choose black text over a dark
        // glass submenu. Capture one union rect that includes every visible
        // adaptive card; it is still one screenshot/readback for the popup.
        let sampleRect = measured.rect;
        if (this._isQuickSettings) {
            let minX = measured.rect[0];
            let minY = measured.rect[1];
            let maxX = measured.rect[0] + measured.rect[2];
            let maxY = measured.rect[1] + measured.rect[3];

            for (const actor of this._dateCardActors) {
                if (!actor?.visible || !actor?.mapped)
                    continue;

                const rect =
                    this._vendor.getTransformedRect(actor);
                if (!finiteRect(rect))
                    continue;

                minX = Math.min(minX, rect[0]);
                minY = Math.min(minY, rect[1]);
                maxX = Math.max(maxX, rect[0] + rect[2]);
                maxY = Math.max(maxY, rect[1] + rect[3]);
            }

            sampleRect = [
                minX,
                minY,
                maxX - minX,
                maxY - minY,
            ];
        }

        let frame = null;
        try {
            frame = await this._captureDateMenuFrame(
                sampleRect
            );
        } catch {
            frame = null;
        }

        if (
            this._destroyed ||
            generation !== this._dateTextGeneration ||
            !frame
        ) {
            return;
        }

        // One captured popup frame, many card decisions. No per-card
        // screenshot/readback round trip.
        for (const actor of this._dateCardActors) {
            if (
                !actor?.visible ||
                !actor?.mapped
            ) {
                continue;
            }

            const luminance =
                this._dateCardLuminance(frame, actor);
            const dark =
                this._chooseDateCardDarkText(
                    actor,
                    luminance
                );

            this._applyDateCardTextPolarity(
                actor,
                dark
            );
        }

        // Remove the previous menu-wide polarity classes. Kept here as a
        // hot-swap cleanup path so a runtime revision can transition from the
        // old global scheme without requiring a Shell restart.
        this._box?.remove_style_class_name?.(
            DATE_TEXT_LIGHT_CLASS
        );
        this._box?.remove_style_class_name?.(
            DATE_TEXT_DARK_CLASS
        );

        if (
            !this._destroyed &&
            generation === this._dateTextGeneration &&
            this._menu?.isOpen
        ) {
            const resampleMs =
                this._surfaceAdapter?.adaptiveResampleMs
                    ?? 3000;

            if (resampleMs > 0)
                this._scheduleDateTextSample(resampleMs);
        }
    }

    updateAppearance(state) {
        if (!this._effect || !state)
            return;

        this._fullSyncDirty = true;
        this._radius = readRadius(this._box);

        const appearanceProfile =
            this._surfaceAdapter?.appearanceProfile ?? null;
        const scopedAppearance =
            appearanceProfile
                ? state?.[appearanceProfile]
                : (
                    this._isDateMenu
                        ? state.dateMenu
                        : null
                );

        const profile =
            scopedAppearance
                ? {
                    ...state,
                    ...scopedAppearance,
                }
                : state;

        let brightness = null;
        let contrast = null;
        let saturation = null;

        try {
            brightness =
                this._settings.get_double('menu-brightness');
            contrast =
                this._settings.get_double('menu-contrast');
            saturation =
                this._settings.get_double('menu-saturation');
        } catch {
            // Shared role defaults still produce the approved material.
        }

        if (this._isQuickSettings) {
            applyVLIQGlassRole(
                this._effect,
                VLIQ_GLASS_ROLES.quickMenuCard,
                {
                    tintColor: [
                        (profile.r ?? 255) / 255,
                        (profile.g ?? 255) / 255,
                        (profile.b ?? 255) / 255,
                    ],
                    tintStrength:
                        profile.opacity ??
                        VLIQ_GLASS_ROLES.quickMenuCard.tintStrength,
                    // Outer popup tracks the System Blur slider exactly;
                    // nested pods retain the role's slightly clearer scaling.
                    blurRadius: profile.blur ?? 7,
                    cornerRadius: this._radius,
                    brightness,
                    contrast,
                    saturation,
                    multiRegion:
                        this._surfaceAdapter?.multiRegion ?? false,
                }
            );
        } else {
            this._effect.setTintColor?.(
                (profile.r ?? 255) / 255,
                (profile.g ?? 255) / 255,
                (profile.b ?? 255) / 255
            );
            this._effect.setTintStrength?.(profile.opacity ?? 0.02);
            this._effect.setBlurRadius?.(profile.blur ?? 7);
            this._effect.setCornerRadius?.(this._radius);
            this._effect.setBlurMethod?.(1);

            if (brightness !== null)
                this._effect.setBrightness?.(brightness);
            if (contrast !== null)
                this._effect.setContrast?.(contrast);
            if (saturation !== null)
                this._effect.setSaturation?.(saturation);
        }

        if (
            this._dateInnerEffect &&
            (this._isDateMenu || this._isQuickSettings)
        ) {
            applyVLIQGlassRole(
                this._dateInnerEffect,
                VLIQ_GLASS_ROLES.innerCard,
                {
                    tintColor: [
                        (profile.r ?? 255) / 255,
                        (profile.g ?? 255) / 255,
                        (profile.b ?? 255) / 255,
                    ],
                    baseBlur: profile.blur ?? 7,
                    cornerRadius: this._dateInnerRadius,
                    brightness,
                    contrast,
                    saturation,
                }
            );
        }

        const popupChrome =
            this._surfaceAdapter?.popupChrome ?? null;

        if (popupChrome?.shadow === false) {
            // Single-rim popup policy: LiquidEffect owns depth; no second
            // outer drop shadow from the popup material.
            try {
                this._effect._uniforms?.set?.('shadow_radius', 0);
                this._effect._uniforms?.set?.('shadow_intensity', 0);
                this._effect.queue_repaint?.();
            } catch {
                // Renderer internals are optional.
            }
        }

        const filterOpacity = Math.max(
            0,
            Math.min(
                0.20,
                this._surfaceAdapter?.filterOpacityOverride ??
                    profile.filterOpacity ??
                    0.04
            )
        );
        const filterBorder =
            popupChrome?.filterBorder === false
                ? 'border: none;'
                : (
                    'border: 1px solid rgba(255,255,255,' +
                    Math.min(0.12, filterOpacity + 0.025).toFixed(3) +
                    ');'
                );

        this._filterLayer?.set_style?.(
            'background-color: rgba(255,255,255,' +
            filterOpacity.toFixed(3) +
            '); border-radius: ' +
            Math.round(this._radius) +
            'px; ' +
            filterBorder +
            ' box-shadow: none;'
        );

        // Outer + nested Quick Settings now consume the same live
        // brightness/contrast/saturation values resolved above.
        this._root?.queue_redraw?.();
        this._dateInnerRoot?.queue_redraw?.();
    }

    _setSceneWindowCapture(enabled, scene = this._sceneManager) {
        if (!scene)
            return false;

        // Prefer the newer vendor manager, whose sync() also skips work
        // while cloned windows are disabled. The canonical vendor modules
        // are GJS-import cached for the duration of the Shell process;
        // a VLIQ hot-swap may still hold the PREVIOUS class without
        // setWindowCaptureEnabled(), even after replacing vendor files.
        const nativeChanged =
            scene.setWindowCaptureEnabled?.(enabled) === true;
        const windowActors = scene.windowClonesContainer ?? null;
        let changed = nativeChanged;
        if (
            windowActors &&
            windowActors.visible !== Boolean(enabled)
        ) {
            // This fallback is intentional: hiding the parent subscene
            // works in the old vendored class too, even if its per-frame
            // sync re-shows a child clone. Do not hide the wallpaper mirror.
            if (enabled)
                windowActors.show?.();
            else
                windowActors.hide?.();
            changed = true;
        }
        if (changed && !nativeChanged)
            scene.container?.queue_redraw?.();

        return changed;
    }

    _syncOverviewSceneVisibility() {
        const clone = this._overviewSceneClone;
        const overview = this._overviewSceneSource;
        if (!clone || !overview)
            return false;

        // This actual native Overview/App Grid subtree contains the icons,
        // workspace/search views and VLIQ's existing background blur.
        // All popups use it when GNOME paints Overview. Desktop Browser
        // clones are excluded ONLY in that context, not forever as the
        // previous Calendar-only workaround did.
        //
        // GNOME can keep the overviewGroup allocated after leaving it:
        // both native Overview state and group visibility must agree.
        const active = Boolean(
            (Main.overview?.visible ||
                Main.overview?.visibleTarget) &&
            overview.visible &&
            overview.mapped
        );
        if (clone.visible === active)
            return false;

        if (active)
            clone.show?.();
        else
            clone.hide?.();
        return true;
    }

    _syncOverviewSceneGeometry(monitorX, monitorY) {
        const clone = this._overviewSceneClone;
        const source = this._overviewSceneSource;
        if (!clone?.visible || !source)
            return false;

        // Clutter.Clone re-paints its SOURCE in local coordinates. The
        // original Overview group may be offset/scaled during GNOME's
        // slide/zoom transition. Match its actual stage transform, then
        // subtract this popup's monitor origin. Otherwise app icons appear
        // offset or incorrectly scaled inside the glass on multi-monitor
        // setups, even when the clone source itself is correct.
        let bounds = null;
        try {
            bounds = this._vendor.getTransformedRect(source);
        } catch {}
        if (!bounds || !finiteRect(bounds))
            return false;

        const sourceW = Number(source.width) || global.stage.width;
        const sourceH = Number(source.height) || global.stage.height;
        if (
            !Number.isFinite(sourceW) ||
            !Number.isFinite(sourceH) ||
            sourceW <= 1 || sourceH <= 1
        ) {
            return false;
        }
        const scaleX = bounds[2] / sourceW;
        const scaleY = bounds[3] / sourceH;
        const tx = bounds[0] - monitorX;
        const ty = bounds[1] - monitorY;
        if (
            !Number.isFinite(scaleX) ||
            !Number.isFinite(scaleY) ||
            scaleX <= 0 || scaleY <= 0
        ) {
            return false;
        }
        const key = [sourceW, sourceH, tx, ty, scaleX, scaleY]
            .map(n => Math.round(n * 1000) / 1000)
            .join(':');
        if (key === this._lastOverviewSceneGeometryKey)
            return false;
        this._lastOverviewSceneGeometryKey = key;

        this._vendor.setSizeIfChanged(clone, sourceW, sourceH);
        this._vendor.setTranslationIfChanged(clone, tx, ty);
        if (
            Math.abs((clone.scale_x ?? 1) - scaleX) > 0.0001 ||
            Math.abs((clone.scale_y ?? 1) - scaleY) > 0.0001
        ) {
            clone.set_scale?.(scaleX, scaleY);
        }
        // The existing popup-root clip contains the entire source to the
        // necessary Date glass/blur margin. No fullscreen opaque overlay.
        return true;
    }

    _syncOverviewWindowCapture() {
        // Unified backdrop for Date/Calendar, Quick Settings and ALL
        // supported PopupMenus. Capture actual live desktop windows over
        // wallpaper when Overview is not visible. When native Overview is
        // painted, hide those full-size Browser clones and show the real
        // GNOME overviewGroup scene instead.
        //
        // If Overview is active but its group/clone is unavailable, keep
        // desktop windows hidden and show the shared wallpaper safely;
        // never silently substitute a full-size Browser under App Grid.
        const overviewActive = Boolean(
            Main.overview?.visible ||
            Main.overview?.visibleTarget
        );
        const captureWindows = !overviewActive;

        // Always check the actual actor visibility, even if our requested
        // mode is unchanged: old cached vendors may rebuild the clone
        // subtree on an unrelated GNOME layout transition. This is a cheap
        // read/no-op when the source is already correct (no new frame loop).
        // Do BOTH checks independently: short-circuiting would leave
        // the real App Grid scene hidden if a cached vendor just changed its
        // window-capture state in the same compositor frame.
        const windowChanged =
            this._setSceneWindowCapture(captureWindows);
        const overviewChanged =
            this._syncOverviewSceneVisibility();
        this._overviewWindowCaptureEnabled = captureWindows;
        if (!windowChanged && !overviewChanged)
            return false;

        // A prior native scene may still be cached in the glass FBO.
        // Invalidate the single existing scene/composite ONCE when either
        // source changes (Overview → Desktop or Desktop → App Grid). Do not screenshot the Browser,
        // rebuild the scene, add a CSS backdrop, or poll in the background.
        this._lastSceneSyncUs = 0;
        this._lastFullSyncUs = 0;
        this._fullSyncDirty = true;
        this._root?.queue_redraw?.();
        this._effect?.queue_repaint?.();
        this._dateInnerRoot?.queue_redraw?.();
        return true;
    }

    syncFrame() {
        if (this._destroyed)
            return;

        // Check BEFORE the fixed-FPS frame throttle: opening the Calendar
        // on Super/Overview must never show one stale browser-web frame.
        this._syncOverviewWindowCapture();

        const nowUs =
            GLib.get_monotonic_time();
        const configuredSceneFps =
            this._manager._appearance?.sceneFps ??
            24;
        const sceneFpsCap =
            this._surfaceAdapter?.sceneFpsCap ??
            60;
        const fullSyncFps = Math.max(
            15,
            Math.min(
                sceneFpsCap,
                configuredSceneFps
            )
        );
        const intervalUs =
            1000000 / fullSyncFps;

        if (
            this._lastFullSyncUs > 0 &&
            nowUs - this._lastFullSyncUs <
                intervalUs
        ) {
            return;
        }

        const geometryDrift =
            this._lastFullGeometryX !== this._lastShaderX ||
            this._lastFullGeometryY !== this._lastShaderY ||
            this._lastFullGeometryW !== this._lastShaderW ||
            this._lastFullGeometryH !== this._lastShaderH ||
            this._lastFullOpacity !== this._lastPaintOpacity;

        this._lastFullSyncUs = nowUs;

        // Static popup: only refresh the live window/background clones.
        // Paint hooks already keep shader geometry and Date interactions smooth.
        if (
            !this._fullSyncDirty &&
            !geometryDrift &&
            this._sceneCaptureRect
        ) {
            this._sceneManager?.sync?.();
            this._lastSceneSyncUs = nowUs;
            return;
        }

        this._fullSyncDirty = false;
        this._sync(false);
    }

    _measure() {
        const box = this._box;
        const actor = this._boxPointer;
        if (!box || !actor)
            return null;

        const rect = this._vendor.getTransformedRect(box);
        if (!finiteRect(rect))
            return null;

        const opacity =
            actor.get_paint_opacity?.() ??
            actor.opacity ??
            255;

        if (
            !actor.mapped ||
            !actor.visible ||
            opacity <= 0
        ) {
            return null;
        }

        const monitor =
            this._vendor.resolveMonitorGeometry([
                box,
                actor,
                this._menu?.sourceActor,
            ]) ??
            Main.layoutManager.primaryMonitor ??
            {
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
            };

        return {
            rect,
            opacity,
            monitor,
        };
    }

    _sync(shaderOnly) {
        // Actor visibility must be changed only during full layout/stage
        // sync, never from LiquidEffect's paint-time uniforms hook.
        if (!shaderOnly)
            this._syncOverviewWindowCapture();

        const paintRoot =
            this._paintRoot ??
            this._resolvePaintRoot();

        if (!shaderOnly)
            this._suppressNativeBoxPointerBorder();

        if (
            !shaderOnly &&
            paintRoot?.get_parent?.() === Main.layoutManager.uiGroup
        ) {
            try {
                if (this._root?.get_parent?.() === Main.layoutManager.uiGroup) {
                    Main.layoutManager.uiGroup.set_child_below_sibling?.(
                        this._root,
                        paintRoot
                    );
                }
                if (
                    this._dateInnerRoot?.get_parent?.() ===
                    Main.layoutManager.uiGroup
                ) {
                    Main.layoutManager.uiGroup.set_child_above_sibling?.(
                        this._dateInnerRoot,
                        this._root
                    );
                    Main.layoutManager.uiGroup.set_child_below_sibling?.(
                        this._dateInnerRoot,
                        paintRoot
                    );
                }
            } catch {
                // Ordering self-heal is best effort.
            }
        }

        const measured = this._measure();
        if (!measured) {
            if (!shaderOnly && this._root?.visible)
                this._root.hide?.();
            if (!shaderOnly && this._dateInnerRoot?.visible)
                this._dateInnerRoot.hide?.();
            return;
        }

        const {
            rect: [absX, absY, width, height],
            opacity,
            monitor,
        } = measured;

        this._lastPaintOpacity = opacity;

        const monitorX = monitor.x ?? 0;
        const monitorY = monitor.y ?? 0;
        const screenW = Math.max(
            1,
            monitor.width ?? global.stage.width
        );
        const screenH = Math.max(
            1,
            monitor.height ?? global.stage.height
        );

        // Full actor writes happen only in the stage's full-sync path, not
        // inside LiquidEffect's paint-time geometry hook. At 100% or under
        // GNOME's animated overview transforms, preserve stage alignment.
        const overviewGeometryChanged = !shaderOnly &&
            this._syncOverviewSceneGeometry(monitorX, monitorY);

        // Date/Quick Settings need optical headroom for inner card shadows.
        // Generic indicator/context PopupMenu surfaces do not: expanding them
        // created a second-looking outer card around the native menu bounds.
        const edgePad =
            this._surfaceAdapter?.edgePadding ??
            GLASS_EDGE_PAD;
        const glassAbsX = absX - edgePad;
        const glassAbsY = absY - edgePad;
        const glassW = width + edgePad * 2;
        const glassH = height + edgePad * 2;

        const glassX = glassAbsX - monitorX;
        const glassY = glassAbsY - monitorY;

        const geometryChanged =
            this._lastShaderX !== glassX ||
            this._lastShaderY !== glassY ||
            this._lastShaderW !== glassW ||
            this._lastShaderH !== glassH;

        if (geometryChanged) {
            this._lastShaderX = glassX;
            this._lastShaderY = glassY;
            this._lastShaderW = glassW;
            this._lastShaderH = glassH;

            this._effect?.setGlassGeometry?.(
                glassX,
                glassY,
                glassW,
                glassH
            );
        }

        if (
            this._lastEffectResolutionW !== screenW ||
            this._lastEffectResolutionH !== screenH
        ) {
            this._lastEffectResolutionW = screenW;
            this._lastEffectResolutionH = screenH;
            this._effect?.setResolution?.(
                screenW,
                screenH
            );
        }

        if (this._isDateMenu) {
            this._syncDateInnerRegions(
                monitorX,
                monitorY,
                screenW,
                screenH,
                !shaderOnly
            );
        } else if (this._isQuickSettings) {
            const overlayOpen =
                Boolean(this._menu?._activeMenu?.isOpen);
            const overlayChanged =
                overlayOpen !== this._lastQuickOverlayOpen;

            if (overlayChanged) {
                this._lastQuickOverlayOpen = overlayOpen;
                this._quickRegionDirty = true;
                this._quickNeedsRescan = true;
                this._scanDateCardActors(true);

                if (
                    !shaderOnly &&
                    this._surfaceAdapter?.adaptiveText
                ) {
                    this._scheduleDateTextSample(
                        this._surfaceAdapter
                            ?.expandedSampleDelayMs
                            ?? 140
                    );
                }
            }

            // Quick Settings has many more actors than Date Menu. Rebuild its
            // region array only on actual damage/state/geometry changes. The
            // paint hook no longer walks the Quick actor tree every frame.
            if (
                !shaderOnly &&
                (
                    geometryChanged ||
                    overlayChanged ||
                    this._quickRegionDirty ||
                    this._quickNeedsRescan
                )
            ) {
                this._syncDateInnerRegions(
                    monitorX,
                    monitorY,
                    screenW,
                    screenH,
                    this._quickNeedsRescan ||
                        this._dateCardActors.length === 0
                );
            }
        }

        if (shaderOnly)
            return;

        const rootChanged =
            this._lastMonitorX !== monitorX ||
            this._lastMonitorY !== monitorY ||
            this._lastScreenW !== screenW ||
            this._lastScreenH !== screenH;

        if (rootChanged) {
            this._vendor.setPositionIfChanged(
                this._root,
                monitorX,
                monitorY
            );
            this._vendor.setSizeIfChanged(
                this._root,
                screenW,
                screenH
            );
            this._vendor.setPositionIfChanged(
                this._liquidBox,
                0,
                0
            );
            this._vendor.setSizeIfChanged(
                this._liquidBox,
                screenW,
                screenH
            );

            if (this._dateInnerRoot) {
                this._vendor.setPositionIfChanged(
                    this._dateInnerRoot,
                    monitorX,
                    monitorY
                );
                this._vendor.setSizeIfChanged(
                    this._dateInnerRoot,
                    screenW,
                    screenH
                );
                this._vendor.setPositionIfChanged(
                    this._dateInnerLiquidBox,
                    0,
                    0
                );
                this._vendor.setSizeIfChanged(
                    this._dateInnerLiquidBox,
                    screenW,
                    screenH
                );
                this._vendor.setPositionIfChanged(
                    this._dateInnerClone,
                    0,
                    0
                );
                this._vendor.setSizeIfChanged(
                    this._dateInnerClone,
                    screenW,
                    screenH
                );
            }

            this._lastMonitorX = monitorX;
            this._lastMonitorY = monitorY;
            this._lastScreenW = screenW;
            this._lastScreenH = screenH;
        }

        const filterUsesContentBounds =
            this._surfaceAdapter?.filterUsesContentBounds === true;

        const filterX =
            filterUsesContentBounds
                ? absX - monitorX
                : glassX;
        const filterY =
            filterUsesContentBounds
                ? absY - monitorY
                : glassY;
        const filterW =
            filterUsesContentBounds
                ? width
                : glassW;
        const filterH =
            filterUsesContentBounds
                ? height
                : glassH;

        this._vendor.setPositionIfChanged(
            this._filterLayer,
            filterX,
            filterY
        );
        this._vendor.setSizeIfChanged(
            this._filterLayer,
            filterW,
            filterH
        );

        const appearanceProfile =
            this._surfaceAdapter?.appearanceProfile ??
            (this._isDateMenu ? 'dateMenu' : null);

        const surfaceAppearance =
            appearanceProfile
                ? {
                    ...this._manager._appearance,
                    ...(this._manager._appearance?.[appearanceProfile] ?? {}),
                }
                : this._manager._appearance;

        const blur = Math.max(
            0,
            surfaceAppearance?.blur ?? 0
        );
        const margin = Math.max(
            SAMPLE_MARGIN_MIN,
            Math.min(
                SAMPLE_MARGIN_MAX,
                Math.round(blur * 3 + 48)
            )
        );

        this._vendor.setClipIfChanged(
            this._root,
            glassX - margin,
            glassY - margin,
            glassW + margin * 2,
            glassH + margin * 2
        );
        if (this._dateInnerRoot) {
            this._vendor.setClipIfChanged(
                this._dateInnerRoot,
                glassX - margin,
                glassY - margin,
                glassW + margin * 2,
                glassH + margin * 2
            );
        }

        const shadowMaxRadius =
            Math.max(0, margin - 16);
        if (
            this._lastShadowMaxRadius !==
            shadowMaxRadius
        ) {
            this._lastShadowMaxRadius =
                shadowMaxRadius;
            this._effect?.setShadowMaxRadius?.(
                shadowMaxRadius
            );
        }

        const captureRect = [
            glassAbsX - margin,
            glassAbsY - margin,
            glassW + margin * 2,
            glassH + margin * 2,
        ];

        const configuredSceneFps =
            this._manager._appearance?.sceneFps ?? 30;
        const sceneFpsCap =
            this._surfaceAdapter?.sceneFpsCap ?? 60;
        const sceneFps = Math.max(
            15,
            Math.min(
                sceneFpsCap,
                configuredSceneFps
            )
        );
        const nowUs = GLib.get_monotonic_time();
        const intervalUs = 1000000 / sceneFps;
        const sceneDue =
            geometryChanged ||
            rootChanged ||
            overviewGeometryChanged ||
            this._lastSceneSyncUs === 0 ||
            nowUs - this._lastSceneSyncUs >= intervalUs;

        if (sceneDue) {
            this._sceneManager?.setOffset?.(
                -monitorX,
                -monitorY
            );
            this._sceneManager?.setCullRect?.(captureRect);
            this._sceneManager?.applyBgCloneClip?.(captureRect);
            this._sceneManager?.sync?.();
            this._lastSceneSyncUs = nowUs;
        }

        this._sceneCaptureRect = captureRect;
        this._lastFullGeometryX = glassX;
        this._lastFullGeometryY = glassY;
        this._lastFullGeometryW = glassW;
        this._lastFullGeometryH = glassH;
        this._lastFullOpacity = opacity;

        if (this._root.opacity !== opacity)
            this._root.opacity = opacity;

        if (
            this._dateInnerRoot &&
            this._dateInnerRoot.opacity !== opacity
        ) {
            this._dateInnerRoot.opacity = opacity;
        }

        if (!this._root.visible)
            this._root.show?.();

        if (
            this._dateInnerRoot &&
            this._dateInnerRegionCount > 0 &&
            !this._dateInnerRoot.visible
        ) {
            this._dateInnerRoot.show?.();
        }
    }

    _syncShaderGeometry() {
        if (
            this._destroyed ||
            !this._effect ||
            !this._root?.mapped
        ) {
            return;
        }

        this._sync(true);
    }

    detach() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._cancelDateTextSample();
        this._clearQuickSignalEntries();
        this._cleanupQuickThemeSync();
        this._restoreQuickOverlayMenuCloses();

        try {
            this._effect?.setLiveGeometryHook?.(null);
        } catch {}
        try {
            this._dateInnerEffect?.setLiveGeometryHook?.(null);
        } catch {}

        if (this._openStateId && this._menu) {
            try {
                this._menu.disconnect(this._openStateId);
            } catch {}
        }
        this._openStateId = 0;

        try {
            if (
                this._nativeBoxPointerBorder &&
                this._nativeBoxPointerBorderOpacity !== null
            ) {
                this._nativeBoxPointerBorder.opacity =
                    this._nativeBoxPointerBorderOpacity;
                this._nativeBoxPointerBorder.queue_repaint?.();
            }
        } catch {}

        try {
            this._box?.remove_style_class_name?.(GLASS_CLASS);
            this._box?.remove_style_class_name?.(DATE_TEXT_LIGHT_CLASS);
            this._box?.remove_style_class_name?.(DATE_TEXT_DARK_CLASS);

            for (const actor of this._dateCardActors) {
                try {
                    actor.remove_style_class_name?.(
                        DATE_CARD_TEXT_LIGHT_CLASS
                    );
                    actor.remove_style_class_name?.(
                        DATE_CARD_TEXT_DARK_CLASS
                    );
                    actor.remove_style_class_name?.(
                        QUICK_CARD_TEXT_LIGHT_CLASS
                    );
                    actor.remove_style_class_name?.(
                        QUICK_CARD_TEXT_DARK_CLASS
                    );
                    actor.remove_style_class_name?.(
                        QUICK_ACTIVE_CLASS
                    );

                    if (this._isQuickSettings) {
                        const parent =
                            actor.get_parent?.() ?? null;
                        if (
                            parent &&
                            actorClasses(parent).includes(
                                'quick-toggle-menu-container'
                            )
                        ) {
                            parent.remove_style_class_name?.(
                                QUICK_CARD_TEXT_LIGHT_CLASS
                            );
                            parent.remove_style_class_name?.(
                                QUICK_CARD_TEXT_DARK_CLASS
                            );
                        }
                    }
                } catch {}
            }
            this._boxPointer?.remove_style_class_name?.(SHELL_CLASS);
            this._boxPointer?.remove_style_class_name?.(DATE_SHELL_CLASS);
            this._boxPointer?.remove_style_class_name?.(QUICK_SHELL_CLASS);
            this._menu?.actor?.remove_style_class_name?.(
                QUICK_ROOT_CLASS
            );
        } catch {}

        // Destroy the clone layer before its source (root).
        try {
            this._dateInnerRoot?.destroy?.();
        } catch {}

        try {
            this._sceneManager?.destroy?.();
        } catch {}

        try {
            this._root?.destroy?.();
        } catch {}

        this._root = null;
        this._liquidBox = null;
        this._sceneManager = null;
        this._filterLayer = null;
        this._effect = null;
        this._dateInnerRoot = null;
        this._dateInnerLiquidBox = null;
        this._dateInnerClone = null;
        this._dateInnerEffect = null;
        this._dateCardActors = [];
        this._dateCardResponses.clear();
        this._dateCardTextState.clear();
        this._quickSelectedState.clear();
        this._dateInnerRegionCount = 0;
        this._lastInnerRegions = [];
        this._lastEffectResolutionW = 0;
        this._lastEffectResolutionH = 0;
        this._lastInnerResolutionW = 0;
        this._lastInnerResolutionH = 0;
        this._lastFullGeometryX = NaN;
        this._lastFullGeometryY = NaN;
        this._lastFullGeometryW = NaN;
        this._lastFullGeometryH = NaN;
        this._lastShadowMaxRadius = NaN;
        this._sceneCaptureRect = null;
        this._overviewWindowCaptureEnabled = null;
        // _root owns its one optional native Overview clone as a child;
        // deleting the popup root releases it without deleting GNOME's
        // actual overviewGroup actor.
        this._overviewSceneClone = null;
        this._overviewSceneSource = null;
        this._lastOverviewSceneGeometryKey = '';
        this._dateScreenshot = null;
        this._lastQuickOverlayOpen = false;
        this._quickRegionDirty = false;
        this._quickNeedsRescan = false;
        this._menu = null;
        this._box = null;
        this._boxPointer = null;
        this._paintRoot = null;
        this._nativeBoxPointerBorder = null;
        this._nativeBoxPointerBorderOpacity = null;
        this._bin = null;
    }
}

export class PopupGlassManager {
    constructor(params) {
        this._vendor = params.vendor;
        this._settings = params.settings;
        this._vliqSettings =
            params.vliqSettings ?? null;
        this._readAppearance = params.readAppearance;
        this._surfaces = new Map();
        this._enabled = false;
        this._originalOpen = null;
        this._originalDestroy = null;
        this._patchedOpen = null;
        this._patchedDestroy = null;
        this._appearance = null;
        this._stageSyncId = 0;
        this._pendingAttachSources = new Map();
        this._systemPopupPrewarmSourceId = 0;
        this._systemPopupPrewarmQueue = [];

        this._panelMenuManager = null;
        this._originalPanelChangeMenu = null;
        this._patchedPanelChangeMenu = null;
        this._originalPanelAddMenu = null;
        this._patchedPanelAddMenu = null;
        this._originalPanelRemoveMenu = null;
        this._patchedPanelRemoveMenu = null;
        this._panelMenuHoverSignals = new Map();
        this._panelHoverSwitchSourceId = 0;
        this._panelHoverSwitchTarget = null;
        this._panelHoverSettingId = 0;
        this._panelHoverDelaySettingId = 0;
    }

    setup() {
        if (this._enabled)
            return;

        this._enabled = true;
        this._appearance = this._readAppearance();

        const prototype = PopupMenu.PopupMenu.prototype;

        this._originalOpen =
            prototype.open?._vliqOriginalOpen ??
            prototype.open;
        this._originalDestroy =
            prototype.destroy?._vliqOriginalDestroy ??
            prototype.destroy;

        const manager = this;

        this._patchedOpen = function (...args) {
            const animation = args[0];
            const hoverSwitch =
                animation ===
                BoxPointer.PopupAnimation.FADE;
            const confirmedPanelHover =
                this._vliqPanelHoverConfirmed === true;

            if (
                manager._enabled &&
                !manager._surfaces.has(this) &&
                confirmedPanelHover
            ) {
                // The panel-level dwell already confirmed user intent. Open
                // native GNOME UI immediately, return from the input event, and
                // only then build the expensive glass stack on an idle slice.
                const result =
                    manager._originalOpen.apply(
                        this,
                        args
                    );

                if (this.isOpen)
                    manager._scheduleIdleAttach(this);

                return result;
            }

            if (
                manager._enabled &&
                !manager._surfaces.has(this) &&
                hoverSwitch
            ) {
                // Non-panel FADE users keep the material-only debounce.
                const result =
                    manager._originalOpen.apply(
                        this,
                        args
                    );

                if (this.isOpen)
                    manager._scheduleDeferredAttach(this);

                return result;
            }

            manager._cancelDeferredAttach(this);
            manager._cancelPanelHoverSwitch();

            if (manager._enabled)
                manager.attach(this);

            return manager._originalOpen.apply(
                this,
                args
            );
        };

        this._patchedDestroy = function (...args) {
            manager._cancelDeferredAttach(this);
            manager.detach(this);
            return manager._originalDestroy.apply(this, args);
        };

        this._patchedOpen._vliqOriginalOpen =
            this._originalOpen;
        this._patchedDestroy._vliqOriginalDestroy =
            this._originalDestroy;

        prototype.open = this._patchedOpen;
        prototype.destroy = this._patchedDestroy;

        this._installPanelHoverSwitchDebounce();
        this._scheduleSystemPopupPrewarm();

        // Frame work is armed only while at least one managed popup is open.
        // Closed PopupMenu instances can stay alive for the whole Shell
        // session, so an always-on stage callback becomes permanent overhead.
        this._syncStageLoopState();

        console.log(
            '[VLIQ][PopupGlass] global PopupMenu adapter active'
        );
    }

    _panelHoverSwitchEnabled() {
        try {
            return Boolean(
                this._vliqSettings?.get_boolean?.(
                    'panel-menu-hover-switch'
                )
            );
        } catch {
            // Optimization-first default: do not open adjacent panel menus
            // merely because the pointer crosses their icons.
            return false;
        }
    }

    _panelHoverSwitchDelayMs() {
        try {
            const value =
                this._vliqSettings?.get_int?.(
                    'panel-menu-hover-delay-ms'
                );
            if (Number.isFinite(value))
                return Math.max(0, Math.min(1000, value));
        } catch {}

        return DEFAULT_PANEL_MENU_HOVER_DWELL_MS;
    }

    _cancelPanelHoverSwitch() {
        if (this._panelHoverSwitchSourceId) {
            try {
                GLib.source_remove(
                    this._panelHoverSwitchSourceId
                );
            } catch {}
            this._panelHoverSwitchSourceId = 0;
        }
        this._panelHoverSwitchTarget = null;
    }

    _unwatchPanelMenuSource(menu) {
        const watched =
            this._panelMenuHoverSignals.get(menu) ??
            null;
        if (!watched)
            return;

        this._panelMenuHoverSignals.delete(menu);

        try {
            watched.actor?.disconnect?.(
                watched.id
            );
        } catch {}

        if (
            this._panelHoverSwitchTarget === menu
        ) {
            this._cancelPanelHoverSwitch();
        }
    }

    _watchPanelMenuSource(menu) {
        if (
            !menu ||
            this._panelMenuHoverSignals.has(menu)
        ) {
            return;
        }

        const actor =
            menu.sourceActor ?? null;
        if (!actor)
            return;

        try {
            const id = actor.connect(
                'notify::hover',
                () => {
                    if (
                        !this._enabled ||
                        !this._panelMenuManager
                    ) {
                        return;
                    }

                    if (actor.hover !== true) {
                        if (
                            this._panelHoverSwitchTarget ===
                            menu
                        ) {
                            this._cancelPanelHoverSwitch();
                        }
                        return;
                    }

                    const activeMenu =
                        this._panelMenuManager
                            .activeMenu ??
                        null;

                    if (
                        !activeMenu ||
                        activeMenu === menu
                    ) {
                        return;
                    }

                    if (
                        !this._panelHoverSwitchEnabled()
                    ) {
                        this._cancelPanelHoverSwitch();
                        return;
                    }

                    this._schedulePanelHoverSwitch(
                        this._panelMenuManager,
                        menu
                    );
                }
            );

            this._panelMenuHoverSignals.set(
                menu,
                {actor, id}
            );
        } catch {
            // Some non-panel menu sources may not expose hover.
        }
    }

    _schedulePanelHoverSwitch(
        panelManager,
        newMenu
    ) {
        if (
            !this._enabled ||
            !panelManager ||
            !newMenu ||
            newMenu === panelManager.activeMenu
        ) {
            this._cancelPanelHoverSwitch();
            return;
        }

        if (
            this._panelHoverSwitchSourceId &&
            this._panelHoverSwitchTarget === newMenu
        ) {
            return;
        }

        this._cancelPanelHoverSwitch();
        this._panelHoverSwitchTarget = newMenu;

        let sourceId = 0;
        sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            this._panelHoverSwitchDelayMs(),
            () => {
                if (
                    this._panelHoverSwitchSourceId ===
                    sourceId
                ) {
                    this._panelHoverSwitchSourceId = 0;
                }

                const target =
                    this._panelHoverSwitchTarget;
                this._panelHoverSwitchTarget = null;

                if (
                    !this._enabled ||
                    !this._panelHoverSwitchEnabled() ||
                    target !== newMenu ||
                    !panelManager.activeMenu ||
                    newMenu === panelManager.activeMenu
                ) {
                    return GLib.SOURCE_REMOVE;
                }

                // Do not depend on sourceActor.hover here. Under GNOME's
                // modal panel grab it is not reliable for AppIndicator sources.
                // If another panel source was entered meanwhile, its _changeMenu
                // call replaced this target/timer before we get here.
                try {
                    newMenu._vliqPanelHoverConfirmed =
                        true;
                    this._originalPanelChangeMenu?.call(
                        panelManager,
                        newMenu
                    );
                } finally {
                    try {
                        delete newMenu
                            ._vliqPanelHoverConfirmed;
                    } catch {
                        newMenu._vliqPanelHoverConfirmed =
                            false;
                    }
                }

                return GLib.SOURCE_REMOVE;
            }
        );

        this._panelHoverSwitchSourceId =
            sourceId;
    }

    _installPanelHoverSwitchDebounce() {
        const panelManager =
            Main.panel?.menuManager ?? null;

        if (
            !panelManager ||
            this._panelMenuManager
        ) {
            return;
        }

        const currentChangeMenu =
            panelManager._changeMenu;
        const originalChangeMenu =
            currentChangeMenu
                ?._vliqOriginalChangeMenu ??
            currentChangeMenu;
        if (
            typeof originalChangeMenu !==
            'function'
        ) {
            return;
        }

        const currentAddMenu =
            panelManager.addMenu;
        const originalAddMenu =
            currentAddMenu
                ?._vliqOriginalAddMenu ??
            currentAddMenu;

        const currentRemoveMenu =
            panelManager.removeMenu;
        const originalRemoveMenu =
            currentRemoveMenu
                ?._vliqOriginalRemoveMenu ??
            currentRemoveMenu;

        this._panelMenuManager =
            panelManager;
        this._originalPanelChangeMenu =
            originalChangeMenu;
        this._originalPanelAddMenu =
            typeof originalAddMenu === 'function'
                ? originalAddMenu
                : null;
        this._originalPanelRemoveMenu =
            typeof originalRemoveMenu === 'function'
                ? originalRemoveMenu
                : null;

        const owner = this;

        this._patchedPanelChangeMenu =
            function (newMenu) {
                if (!owner._enabled) {
                    return originalChangeMenu.call(
                        this,
                        newMenu
                    );
                }

                const activeMenu =
                    this.activeMenu ?? null;

                if (
                    !activeMenu ||
                    !newMenu ||
                    newMenu === activeMenu
                ) {
                    owner._cancelPanelHoverSwitch();
                    return originalChangeMenu.call(
                        this,
                        newMenu
                    );
                }

                // Keyboard navigation is the only manager-driven transition
                // that bypasses the hover policy.
                let focusedMenu = null;
                try {
                    const keyFocus =
                        global.stage.get_key_focus?.() ??
                        null;
                    focusedMenu =
                        this._findMenuForSource?.(
                            keyFocus
                        ) ?? null;
                } catch {}

                if (focusedMenu === newMenu) {
                    owner._cancelPanelHoverSwitch();
                    return originalChangeMenu.call(
                        this,
                        newMenu
                    );
                }

                // GNOME's remaining menu-to-menu manager transition is the
                // pointer-hover path. The setting owns this branch directly:
                // OFF = hard block; ON = debounce this exact target.
                if (!owner._panelHoverSwitchEnabled()) {
                    owner._cancelPanelHoverSwitch();
                    return;
                }

                owner._schedulePanelHoverSwitch(
                    this,
                    newMenu
                );
                return;
            };

        this._patchedPanelChangeMenu
            ._vliqOriginalChangeMenu =
                originalChangeMenu;

        panelManager._changeMenu =
            this._patchedPanelChangeMenu;

        if (this._originalPanelAddMenu) {
            this._patchedPanelAddMenu =
                function (menu, position) {
                    const result =
                        originalAddMenu.call(
                            this,
                            menu,
                            position
                        );
                    owner._watchPanelMenuSource(
                        menu
                    );
                    return result;
                };

            this._patchedPanelAddMenu
                ._vliqOriginalAddMenu =
                    originalAddMenu;

            panelManager.addMenu =
                this._patchedPanelAddMenu;
        }

        if (this._originalPanelRemoveMenu) {
            this._patchedPanelRemoveMenu =
                function (menu) {
                    owner._unwatchPanelMenuSource(
                        menu
                    );
                    return originalRemoveMenu.call(
                        this,
                        menu
                    );
                };

            this._patchedPanelRemoveMenu
                ._vliqOriginalRemoveMenu =
                    originalRemoveMenu;

            panelManager.removeMenu =
                this._patchedPanelRemoveMenu;
        }

        for (
            const menu of
            panelManager._menus ?? []
        ) {
            this._watchPanelMenuSource(menu);
        }

        if (
            this._vliqSettings &&
            !this._panelHoverSettingId
        ) {
            try {
                this._panelHoverSettingId =
                    this._vliqSettings.connect(
                        'changed::panel-menu-hover-switch',
                        () => {
                            this._cancelPanelHoverSwitch();
                        }
                    );
            } catch {
                this._panelHoverSettingId = 0;
            }
        }

        if (
            this._vliqSettings &&
            !this._panelHoverDelaySettingId
        ) {
            try {
                this._panelHoverDelaySettingId =
                    this._vliqSettings.connect(
                        'changed::panel-menu-hover-delay-ms',
                        () => {
                            this._cancelPanelHoverSwitch();
                        }
                    );
            } catch {
                this._panelHoverDelaySettingId = 0;
            }
        }
    }

    _uninstallPanelHoverSwitchDebounce() {
        this._cancelPanelHoverSwitch();

        if (
            this._vliqSettings &&
            this._panelHoverSettingId
        ) {
            try {
                this._vliqSettings.disconnect(
                    this._panelHoverSettingId
                );
            } catch {}
        }
        this._panelHoverSettingId = 0;

        if (
            this._vliqSettings &&
            this._panelHoverDelaySettingId
        ) {
            try {
                this._vliqSettings.disconnect(
                    this._panelHoverDelaySettingId
                );
            } catch {}
        }
        this._panelHoverDelaySettingId = 0;

        for (
            const menu of
            [...this._panelMenuHoverSignals.keys()]
        ) {
            this._unwatchPanelMenuSource(menu);
        }
        this._panelMenuHoverSignals.clear();

        if (this._panelMenuManager) {
            if (
                this._patchedPanelChangeMenu &&
                this._panelMenuManager._changeMenu ===
                    this._patchedPanelChangeMenu
            ) {
                this._panelMenuManager._changeMenu =
                    this._originalPanelChangeMenu;
            }

            if (
                this._patchedPanelAddMenu &&
                this._panelMenuManager.addMenu ===
                    this._patchedPanelAddMenu
            ) {
                this._panelMenuManager.addMenu =
                    this._originalPanelAddMenu;
            }

            if (
                this._patchedPanelRemoveMenu &&
                this._panelMenuManager.removeMenu ===
                    this._patchedPanelRemoveMenu
            ) {
                this._panelMenuManager.removeMenu =
                    this._originalPanelRemoveMenu;
            }
        }

        this._panelMenuManager = null;
        this._originalPanelChangeMenu = null;
        this._patchedPanelChangeMenu = null;
        this._originalPanelAddMenu = null;
        this._patchedPanelAddMenu = null;
        this._originalPanelRemoveMenu = null;
        this._patchedPanelRemoveMenu = null;
    }

    _cancelSystemPopupPrewarm() {
        if (this._systemPopupPrewarmSourceId) {
            try {
                GLib.source_remove(
                    this._systemPopupPrewarmSourceId
                );
            } catch {}
            this._systemPopupPrewarmSourceId = 0;
        }
        this._systemPopupPrewarmQueue = [];
    }

    _scheduleSystemPopupPrewarm() {
        this._cancelSystemPopupPrewarm();

        const candidates = [
            Main.panel?.statusArea?.dateMenu?.menu ?? null,
            Main.panel?.statusArea?.quickSettings?.menu ?? null,
        ].filter(Boolean);

        this._systemPopupPrewarmQueue =
            candidates.filter(menu =>
                !this._surfaces.has(menu)
            );

        if (!this._systemPopupPrewarmQueue.length)
            return;

        this._systemPopupPrewarmSourceId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT_IDLE,
                350,
                () => {
                    if (!this._enabled) {
                        this._systemPopupPrewarmSourceId = 0;
                        this._systemPopupPrewarmQueue = [];
                        return GLib.SOURCE_REMOVE;
                    }

                    const menu =
                        this._systemPopupPrewarmQueue.shift() ??
                        null;

                    if (
                        menu &&
                        !this._surfaces.has(menu)
                    ) {
                        try {
                            this.attach(menu);
                        } catch (error) {
                            console.error(
                                '[VLIQ][PopupGlass] system popup prewarm failed: ' +
                                error
                            );
                        }
                    }

                    if (!this._systemPopupPrewarmQueue.length) {
                        this._systemPopupPrewarmSourceId = 0;
                        return GLib.SOURCE_REMOVE;
                    }

                    return GLib.SOURCE_CONTINUE;
                }
            );
    }

    _ensureStageSync() {
        if (!this._enabled || this._stageSyncId)
            return;

        this._stageSyncId = global.stage.connect(
            'before-update',
            () => {
                if (!this._enabled)
                    return;

                for (const [menu, surface] of this._surfaces) {
                    if (!menu?.isOpen)
                        continue;

                    try {
                        surface.syncFrame();
                    } catch (error) {
                        console.error(
                            '[VLIQ][PopupGlass] frame sync failed; restoring native popup: ' +
                            error +
                            '\n' +
                            (error?.stack ?? '')
                        );
                        this.detach(menu);
                    }
                }
            }
        );
    }

    _stopStageSync() {
        if (!this._stageSyncId)
            return;

        try {
            global.stage.disconnect(this._stageSyncId);
        } catch {}
        this._stageSyncId = 0;
    }

    _syncStageLoopState() {
        if (!this._enabled) {
            this._stopStageSync();
            return;
        }

        for (const menu of this._surfaces.keys()) {
            if (menu?.isOpen) {
                this._ensureStageSync();
                return;
            }
        }

        this._stopStageSync();
    }

    _cancelDeferredAttach(menu) {
        const sourceId =
            this._pendingAttachSources.get(menu) ??
            0;
        if (!sourceId)
            return;

        try {
            GLib.source_remove(sourceId);
        } catch {}
        this._pendingAttachSources.delete(menu);
    }

    _scheduleIdleAttach(menu) {
        if (
            !this._enabled ||
            !menu ||
            this._surfaces.has(menu)
        ) {
            return;
        }

        this._cancelDeferredAttach(menu);

        let sourceId = 0;
        sourceId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                if (
                    this._pendingAttachSources.get(menu) ===
                    sourceId
                ) {
                    this._pendingAttachSources.delete(menu);
                }

                if (
                    !this._enabled ||
                    !menu?.isOpen ||
                    this._surfaces.has(menu)
                ) {
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    this.attach(menu);
                } catch (error) {
                    console.error(
                        '[VLIQ][PopupGlass] idle panel attach failed: ' +
                        error
                    );
                }

                return GLib.SOURCE_REMOVE;
            }
        );

        this._pendingAttachSources.set(
            menu,
            sourceId
        );
    }

    _scheduleDeferredAttach(menu) {
        if (
            !this._enabled ||
            !menu ||
            this._surfaces.has(menu)
        ) {
            return;
        }

        this._cancelDeferredAttach(menu);

        let sourceId = 0;
        sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            HOVER_SWITCH_GLASS_DWELL_MS,
            () => {
                if (
                    this._pendingAttachSources.get(menu) ===
                    sourceId
                ) {
                    this._pendingAttachSources.delete(menu);
                }

                // The pointer may already have crossed into another panel
                // button. In that case GNOME closed this menu and we allocate
                // absolutely nothing for it.
                if (
                    !this._enabled ||
                    !menu?.isOpen ||
                    this._surfaces.has(menu)
                ) {
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    this.attach(menu);
                } catch (error) {
                    console.error(
                        '[VLIQ][PopupGlass] deferred hover attach failed: ' +
                        error
                    );
                }

                return GLib.SOURCE_REMOVE;
            }
        );

        this._pendingAttachSources.set(
            menu,
            sourceId
        );
    }

    describeMenu(menu) {
        if (!menu)
            return 'unknown-menu';

        const boxClasses =
            menu.box?.get_style_class_name?.() ??
            menu.box?.style_class ??
            '';
        const sourceName =
            menu.sourceActor?.get_name?.() ??
            menu.sourceActor?.constructor?.name ??
            '';

        return (
            (sourceName ? sourceName + ' ' : '') +
            '[' + boxClasses + ']'
        ).trim();
    }

    attach(menu) {
        if (!this._enabled || !menu)
            return null;

        this._cancelDeferredAttach(menu);

        const existing = this._surfaces.get(menu);
        if (existing)
            return existing;

        const surface = new PopupGlassSurface(this, menu);
        if (!surface.attach())
            return null;

        this._surfaces.set(menu, surface);
        this._syncStageLoopState();
        return surface;
    }

    detach(menu) {
        this._cancelDeferredAttach(menu);

        const surface = this._surfaces.get(menu);
        if (!surface)
            return;

        this._surfaces.delete(menu);
        surface.detach();
        this._syncStageLoopState();
    }

    updateAppearance(state = this._readAppearance()) {
        this._appearance = state;
        for (const surface of this._surfaces.values())
            surface.updateAppearance(state);
    }

    cleanup() {
        if (!this._enabled)
            return;

        this._enabled = false;

        this._stopStageSync();
        this._cancelSystemPopupPrewarm();
        this._uninstallPanelHoverSwitchDebounce();

        for (const [menu, sourceId] of this._pendingAttachSources) {
            try {
                GLib.source_remove(sourceId);
            } catch {}
            this._pendingAttachSources.delete(menu);
        }

        const prototype = PopupMenu.PopupMenu.prototype;
        if (prototype.open === this._patchedOpen)
            prototype.open = this._originalOpen;
        if (prototype.destroy === this._patchedDestroy)
            prototype.destroy = this._originalDestroy;

        for (const [menu, surface] of [...this._surfaces]) {
            this._surfaces.delete(menu);
            surface.detach();
        }

        this._originalOpen = null;
        this._originalDestroy = null;
        this._patchedOpen = null;
        this._patchedDestroy = null;
        this._appearance = null;

        console.log(
            '[VLIQ][PopupGlass] global PopupMenu adapter stopped'
        );
    }
}
