import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {collectOrbApps} from './apps.js';
import {BottomTaskbarPreview} from './bottomTaskbarPreview.js';
import {LiquidGlassIntegration} from './liquidGlassDock.js';
import {SearchSurfaceManager} from './searchSurface.js';
import {SpotlightSearchController} from './spotlightSearch.js';
import {TerminalBackdropBlurManager} from './terminalBackdropBlur.js';
import {QuickBrightnessManager} from './quickBrightness.js';
import {
    allocateAcrossRings,
    arcForPosition,
    clamp,
    effectiveRingGap,
    ICON_HOVER_SCALE,
    selectGeometrySlots,
    slotsForGeometry,
    totalCapacity,
} from './geometry.js';

const DEFAULT_ORB_ICON = 'start-here-symbolic';
const FALLBACK_ORB_ICON = 'view-app-grid-symbolic';
const ORB_AUTO_HIDE_REVEAL_PX = 7;
const SCREEN_MARGIN = 8;
const AUTO_LAYOUT_MAX_DEPTH = 8;
// OrbGlassManager pre-warms four shader batches. One region belongs to the
// Orb face itself, leaving 63 real-glass app regions per visible page.
const MAX_VISIBLE_ORB_APPS = 63;
// Retain at most two detached pages while Orb is open.
const MAX_CACHED_INACTIVE_ORB_PAGES = 2;
const APP_PREVIEW_MAX_WINDOWS = 4;
// Larger edge-to-edge native window previews for Orb and Ubuntu Dock.
// Keep just a narrow hit-target-safe gap around the live thumbnail, not a
// second decorative side frame. The monitor-fit guard below prevents overflow
// even at the user's full 50–180% Preview Size preference.
// Mini preview baseline: 480×270 at 100% in the existing user control.
// Preserve exact 16:9 layout, native thumbnail scaling and monitor fitting.
const APP_PREVIEW_SIZE_BOOST = 1.0;
const APP_PREVIEW_GAP = 8;
// Native 16:9 thumbnail cards keep one clearly visible refractive perimeter.
// This is inner breathing room, not a second opaque side layer.
const APP_PREVIEW_PADDING = 16;
const APP_PREVIEW_OFFSET = 14;
const APP_PREVIEW_HIDE_DELAY = 220;
const DOCK_PREVIEW_RESCAN_MS = 1400;
const RUNTIME_SINGLETON_KEY = '__vliqDesktopActiveRuntime';
const VLIQ_SCHEMA_ID = 'org.gnome.shell.extensions.vliq';

// WindowPreviewLayout sizes the native clone from the Meta.Window *frame*,
// but its compositor texture may include a wider/taller buffer (CSD shadow).
// Fit the glass card to the visible union, not a hardcoded landscape ratio.
// The GJS getters return stage coordinates; the returned sizes are logical px.
function previewWindowBounds(window) {
    const rawFrame = window.get_frame_rect();
    const frame = {
        x: Number.isFinite(rawFrame?.x) ? rawFrame.x : 0,
        y: Number.isFinite(rawFrame?.y) ? rawFrame.y : 0,
        width: Math.max(1, rawFrame?.width || 1),
        height: Math.max(1, rawFrame?.height || 1),
    };

    let buffer = null;
    try {
        buffer = window.get_buffer_rect?.() ?? null;
    } catch {
        // A destroyed or not-yet-composited actor can lack buffer geometry.
    }

    if (!buffer ||
        ![buffer.x, buffer.y, buffer.width, buffer.height]
            .every(Number.isFinite) ||
        buffer.width <= 0 || buffer.height <= 0) {
        return {
            frame,
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
        };
    }

    const x = Math.min(frame.x, buffer.x);
    const y = Math.min(frame.y, buffer.y);
    return {
        frame,
        x,
        y,
        width: Math.max(
            1,
            Math.max(frame.x + frame.width, buffer.x + buffer.width) - x
        ),
        height: Math.max(
            1,
            Math.max(frame.y + frame.height, buffer.y + buffer.height) - y
        ),
    };
}

// Build each thumbnail from its own aspect ratio. GNOME's native
// Shell.WindowPreviewLayout performs the actual live texture allocation;
// this only plans the outer clickable tiles and refractive card geometry.
// One consistent 16:9 glass frame for every running-window preview, regardless
// of the app's original aspect ratio or window count. GNOME renders each live
// Shell.WindowPreviewLayout thumbnail *inside* its own 16:9 tile using contain,
// so a portrait Terminal is not distorted or cropped.
//
// Use a width divisible by 16 so the glass card's 16:9 ratio is *exact* in
// integer logical pixels, even on HiDPI or narrow multi-monitor layouts.
function planWindowPreview(windows, preferredScale, monitor) {
    const count = windows.length;
    if (!count)
        return null;

    const columns = count === 1 ? 1 : 2;
    const rows = Math.ceil(count / columns);
    const maxWidth = Math.max(16, Math.min(
        480 * preferredScale,
        monitor.width - SCREEN_MARGIN * 2,
        (monitor.height - SCREEN_MARGIN * 2) * 16 / 9
    ));

    const cardWidth = Math.max(16, Math.floor(maxWidth / 16) * 16);
    const cardHeight = cardWidth * 9 / 16;

    // A 16:9 tile for every app, packed and centered within the one 16:9
    // glass card. Two apps sit side by side; four form a 2x2 native grid.
    const freeWidth = Math.max(
        16,
        cardWidth - APP_PREVIEW_PADDING * 2 -
            (columns - 1) * APP_PREVIEW_GAP
    );
    const freeHeight = Math.max(
        9,
        cardHeight - APP_PREVIEW_PADDING * 2 -
            (rows - 1) * APP_PREVIEW_GAP
    );
    const tileMaxWidth = Math.min(
        freeWidth / columns,
        freeHeight / rows * 16 / 9
    );
    const tileWidth = Math.max(16, Math.floor(tileMaxWidth / 16) * 16);
    const tileHeight = tileWidth * 9 / 16;

    const groupWidth = columns * tileWidth +
        (columns - 1) * APP_PREVIEW_GAP;
    const groupHeight = rows * tileHeight +
        (rows - 1) * APP_PREVIEW_GAP;
    const startY = Math.floor((cardHeight - groupHeight) / 2);
    const tiles = windows.map((window, index) => {
        const row = Math.floor(index / columns);
        const col = index % columns;
        const rowCount = Math.min(columns, count - row * columns);
        const rowWidth = rowCount * tileWidth +
            (rowCount - 1) * APP_PREVIEW_GAP;
        const rowX = Math.floor((cardWidth - rowWidth) / 2);

        return {
            bounds: previewWindowBounds(window),
            width: tileWidth,
            height: tileHeight,
            x: rowX + col * (tileWidth + APP_PREVIEW_GAP),
            y: startY + row * (tileHeight + APP_PREVIEW_GAP),
        };
    });

    return {cardWidth, cardHeight, tiles};
}

function createCanonicalVLIQSettings(uuid) {
    const schemaDir = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'gnome-shell',
        'extensions',
        uuid,
        'schemas',
    ]);

    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir,
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const schema = source.lookup(VLIQ_SCHEMA_ID, true);

    if (!schema) {
        throw new Error(
            'VLIQ canonical GSettings schema was not found: ' +
            schemaDir
        );
    }

    return new Gio.Settings({settings_schema: schema});
}

export default class VLIQRuntime extends Extension {
    async enable() {
        const previousRuntime = globalThis[RUNTIME_SINGLETON_KEY];
        if (previousRuntime && previousRuntime !== this) {
            try {
                previousRuntime.disable();
            } catch (error) {
                logError(
                    error,
                    'VLIQ: failed to retire duplicate runtime'
                );
            }
        }

        this._disabled = false;

        // Runtime revisions are hot-swapped without reloading the stable
        // bootstrap extension. Extension.getSettings() can therefore retain
        // the schema snapshot that existed when the bootstrap was loaded.
        // Always load the canonical compiled schema afresh so newly added
        // runtime/prefs keys bind immediately in the current Shell session.
        try {
            this._settings =
                createCanonicalVLIQSettings(this.uuid);
        } catch (error) {
            logError(
                error,
                'VLIQ: canonical settings load failed; using bootstrap schema'
            );
            this._settings = this.getSettings();
        }

        this._shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        this._appSystem = Shell.AppSystem.get_default();
        this._radialActors = [];
        this._closingActors = new Set();
        this._tooltip = null;
        this._appPreview = null;
        this._appPreviewApp = null;
        this._appPreviewAnchor = null;
        this._appPreviewPreferredSide = null;
        this._appPreviewHideTimeoutId = 0;
        this._globalWindowPreview = new BottomTaskbarPreview({
            layout: Main.layoutManager,
        });
        this._globalPreviewItems = new WeakMap();
        this._globalPreviewAnchor = null;
        this._dockPreviewHooks = new Map();
        this._dockPreviewRescanId = 0;
        this._menuOpen = false;
        this._dragging = false;
        this._openTimeoutId = 0;
        this._closeTimeoutId = 0;
        this._orbAutoHideTimeoutId = 0;
        this._orbAutoFadeTimeoutId = 0;
        this._orbHidden = false;
        this._orbFaded = false;
        this._suppressClickUntil = 0;
        this._writingOrbPosition = false;
        this._dragCurrentX = 0;
        this._dragCurrentY = 0;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragPointerOrigin = null;
        this._dragGrab = null;
        this._liquidGlassIntegration = null;
        this._searchSurfaceManager = null;
        this._spotlightSearch = null;
        this._terminalBackdropBlurManager = null;
        this._quickBrightnessManager = null;
        this._orbPageIndex = 0;
        this._orbPageCount = 1;
        this._orbPageIndicator = null;
        this._orbLastPageScrollUs = 0;
        // Reuse app selection and fitted geometry only within one open menu.
        this._orbPageSession = null;
        this._activeOrbPageIndex = null;
        this._geometryActors = [];

        this._removeStaleLayers();
        this._createLayer();

        this._searchSurfaceManager =
            new SearchSurfaceManager();
        this._searchSurfaceManager.setup();

        this._liquidGlassIntegration = new LiquidGlassIntegration({
            vliqSettings: this._settings,
        });

        try {
            await this._liquidGlassIntegration.enable();
        } catch (error) {
            logError(
                error,
                'VLIQ: Liquid Glass startup failed; keeping full Orb active'
            );
            try {
                this._liquidGlassIntegration.disable();
            } catch {
                // Best-effort rollback of a partial material startup.
            }
            this._liquidGlassIntegration = null;
        }

        this._spotlightSearch =
            new SpotlightSearchController({
                settings: this._settings,
                appSystem: this._appSystem,
                attachSpotlightGlass:
                    (
                        target,
                        resultsTarget,
                        hostLayer
                    ) =>
                        this._liquidGlassIntegration
                            ?.attachSpotlightGlass?.(
                                target,
                                resultsTarget,
                                hostLayer
                            ) ??
                        false,
                refreshAdaptiveText: () =>
                    this._liquidGlassIntegration
                        ?.refreshAdaptiveText?.(),
                beforeOpen: () => {
                    this._cancelOpenTimer();
                    this._cancelCloseTimer();
                    this._hideAppPreview(true);
                    this._closeMenu(true);
                },
            });
        this._spotlightSearch.setup();

        // GNOME 50 Quick Settings brightness directly beneath Sound.
        // Reuse hardware backlight when available; provide native-looking
        // software dimming on desktops where GNOME hides brightness.
        try {
            this._quickBrightnessManager =
                new QuickBrightnessManager(this._settings);
            this._quickBrightnessManager.setup();
        } catch (error) {
            try { this._quickBrightnessManager?.cleanup(); } catch {}
            this._quickBrightnessManager = null;
            console.warn('[VLIQ][Brightness] setup skipped: ' + error);
        }

        // Independent, opt-in compositor-native Ptyxis window blur. Does
        // not depend on Liquid Glass startup and does not modify text alpha.
        try {
            this._terminalBackdropBlurManager =
                new TerminalBackdropBlurManager(this._settings);
            this._terminalBackdropBlurManager.setup();
        } catch (error) {
            try { this._terminalBackdropBlurManager?.cleanup(); } catch {}
            this._terminalBackdropBlurManager = null;
            console.warn('[VLIQ][TerminalBlur] unavailable: ' + error);
        }

        this._setOrbEnabled(
            this._settings.get_boolean('orb-enabled')
        );
        // The bottom taskbar's VLIQ Start control opens the exact same
        // native GNOME Apps view as the standalone Orb.
        this._liquidGlassIntegration?.setBottomTaskbarLauncher?.(
            () => this._showAllApps()
        );
        this._syncOrbTaskbarMode();
        this._connectSignals();
        this._setupDockHoverPreviews();

        globalThis[RUNTIME_SINGLETON_KEY] = this;
        console.log(
            '[VLIQ] Full Orb + system Liquid Glass runtime active'
        );
    }

    disable() {
        if (this._disabled)
            return;

        this._disabled = true;

        if (globalThis[RUNTIME_SINGLETON_KEY] === this)
            delete globalThis[RUNTIME_SINGLETON_KEY];

        this._cancelOpenTimer();
        this._cancelCloseTimer();
        this._cancelOrbAutoHideTimer();
        this._cancelOrbAutoFadeTimer();
        this._cancelAppPreviewHide();
        this._hideAppPreview(true);
        this._globalWindowPreview?.destroy?.();
        this._globalWindowPreview = null;
        this._globalPreviewAnchor = null;
        this._quickBrightnessManager?.cleanup();
        this._quickBrightnessManager = null;
        this._terminalBackdropBlurManager?.cleanup();
        this._terminalBackdropBlurManager = null;
        this._spotlightSearch?.destroy?.();
        this._spotlightSearch = null;
        this._searchSurfaceManager?.cleanup?.();
        this._searchSurfaceManager = null;
        this._cleanupDockHoverPreviews();
        this._closeMenu(true);
        this._destroyClosingActors();
        this._liquidGlassIntegration?.disable();

        if (this._settings && this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        if (this._shellSettings && this._favoritesChangedId)
            this._shellSettings.disconnect(this._favoritesChangedId);
        if (this._appSystem && this._installedChangedId)
            this._appSystem.disconnect(this._installedChangedId);
        if (this._appSystem && this._appStateChangedId)
            this._appSystem.disconnect(this._appStateChangedId);
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);

        if (this._dragGrab) {
            const dragGrab = this._dragGrab;
            this._dragGrab = null;
            this._dragging = false;
            this._dragPointerOrigin = null;
            this._liquidGlassIntegration?.setOrbDragging?.(false);
            dragGrab.dismiss();
        }

        this._hideOrbPageIndicator(true);
        this._destroyGeometryActors();
        this._orbLastPageScrollUs = 0;
        this._layer?.destroy();
        this._layer = null;
        this._orb = null;
        this._orbContent = null;
        this._orbFace = null;
        this._orbMark = null;
        this._panGesture = null;
        this._tooltip = null;
        this._appPreview = null;
        this._appPreviewApp = null;
        this._appPreviewAnchor = null;
        this._appPreviewPreferredSide = null;
        this._appPreviewHideTimeoutId = 0;
        this._dockPreviewHooks = new Map();
        this._dockPreviewRescanId = 0;
        this._radialActors = [];
        this._closingActors.clear();
        this._closingActors = null;
        this._liquidGlassIntegration = null;
        this._searchSurfaceManager = null;
        this._spotlightSearch = null;
        this._orbPageIndicator = null;
        this._orbPageIndex = 0;
        this._orbPageCount = 1;
        this._orbLastPageScrollUs = 0;
        this._orbPageSession = null;
        this._activeOrbPageIndex = null;
        this._geometryActors = [];
        this._appSystem = null;
        this._shellSettings = null;
        this._settings = null;
    }

    _removeStaleLayers() {
        for (const actor of Main.uiGroup.get_children()) {
            if (actor.get_name?.() === 'vliq-layer') {
                try {
                    actor.destroy();
                } catch (error) {
                    logError(
                        error,
                        'VLIQ: stale layer cleanup failed'
                    );
                }
            }
        }
    }

    _createLayer() {
        this._layer = new St.Widget({
            name: 'vliq-layer',
            reactive: false,
            x: 0,
            y: 0,
            layout_manager: new Clutter.FixedLayout(),
        });
        Main.uiGroup.add_child(this._layer);
        this._syncLayerSize();
    }

    _syncOrbTaskbarMode() {
        if (!this._orb)
            return;
        const bottom = this._settings?.get_string?.(
            'top-header-layout') === 'bottom' &&
            this._liquidGlassIntegration?.isBottomTaskbarActive?.() === true;
        if (bottom) {
            this._cancelOpenTimer();
            this._cancelCloseTimer();
            this._cancelOrbAutoHideTimer();
            this._cancelOrbAutoFadeTimer();
            this._closeMenu(true);
            this._hideAppPreview?.(true);
            this._orb.remove_all_transitions?.();
            this._orb.hide?.();
        } else {
            this._orb.show?.();
            if (this._orbHidden)
                this._revealOrb();
            this._scheduleOrbAutoHide();
            this._scheduleOrbAutoFade();
        }
    }

    _setOrbEnabled(enabled) {
        if (enabled) {
            if (this._orb)
                return;

            this._createOrb();
            this._syncOrbFromSettings();
            this._scheduleOrbAutoHide();
            this._scheduleOrbAutoFade();
            this._syncOrbTaskbarMode();
            return;
        }

        if (!this._orb)
            return;

        this._cancelOpenTimer();
        this._cancelCloseTimer();
        this._cancelOrbAutoHideTimer();
        this._cancelOrbAutoFadeTimer();
        this._closeMenu(true);
        this._hideOrbPageIndicator(true);
        this._destroyGeometryActors();
        this._orbPageIndex = 0;
        this._orbPageCount = 1;
        this._orbLastPageScrollUs = 0;

        if (this._dragGrab) {
            this._dragGrab.dismiss();
            this._dragGrab = null;
        }

        this._dragging = false;
        this._dragPointerOrigin = null;
        this._liquidGlassIntegration?.setOrbDragging?.(false);
        this._orb.destroy();
        this._orb = null;
        this._orbContent = null;
        this._orbFace = null;
        this._orbMark = null;
        this._panGesture = null;
        this._orbHidden = false;
        this._orbFaded = false;
    }

    _createOrb() {
        this._orbContent = new St.Widget({
            style_class: 'vliq-orb-content-v2',
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            layout_manager: new Clutter.FixedLayout(),
        });

        this._orbFace = new St.Widget({
            style_class: 'vliq-orb-face-v2',
            reactive: false,
        });

        this._orbMark = new St.Icon({
            icon_name: DEFAULT_ORB_ICON,
            fallback_icon_name: FALLBACK_ORB_ICON,
            icon_size: 24,
            style_class: 'vliq-orb-glyph-v2',
            reactive: false,
        });

        this._orbContent.add_child(this._orbFace);
        this._orbContent.add_child(this._orbMark);

        this._orb = new St.Button({
            style_class: 'vliq-orb-hitbox-v2',
            accessible_name: 'VLIQ',
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: this._orbContent,
        });

        this._layer.add_child(this._orb);
        this._applyOrbAppearance();

        this._orb.connect('notify::hover', () => {
            if (this._dragging)
                return;

            const hovering = this._orb.get_hover();
            this._setOrbVisualPseudoClass('hover', hovering);

            if (hovering) {
                this._cancelOrbAutoFadeTimer();
                this._restoreOrbOpacity(true);
                this._revealOrb();
                this._cancelOrbAutoHideTimer();
                this._scheduleOpen();
            } else {
                this._scheduleClose();
                this._scheduleOrbAutoHide();
                this._scheduleOrbAutoFade();
            }
        });

        this._orb.connect('clicked', () => {
            if (GLib.get_monotonic_time() < this._suppressClickUntil)
                return;

            this._cancelOrbAutoFadeTimer();
            this._restoreOrbOpacity(true);
            this._revealOrb();
            this._showAllApps();
        });

        this._orb.connect('scroll-event', (_actor, event) => {
            if (!this._menuOpen || this._orbPageCount <= 1)
                return Clutter.EVENT_PROPAGATE;

            let direction = null;
            try {
                direction = event.get_scroll_direction?.();
            } catch {}

            let delta = 0;
            if (
                direction === Clutter.ScrollDirection.DOWN ||
                direction === Clutter.ScrollDirection.RIGHT
            ) {
                delta = 1;
            } else if (
                direction === Clutter.ScrollDirection.UP ||
                direction === Clutter.ScrollDirection.LEFT
            ) {
                delta = -1;
            } else if (
                direction === Clutter.ScrollDirection.SMOOTH
            ) {
                try {
                    const [, dy] =
                        event.get_scroll_delta?.() ?? [0, 0];
                    if (Math.abs(dy) > 0.01)
                        delta = dy > 0 ? 1 : -1;
                } catch {}
            }

            if (!delta)
                return Clutter.EVENT_PROPAGATE;

            this._changeOrbPage(delta);
            return Clutter.EVENT_STOP;
        });

        this._panGesture = new Clutter.PanGesture();
        this._panGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        this._panGesture.set_begin_threshold(2);
        this._orb.add_action(this._panGesture);

        this._panGesture.connect('recognize', gesture => {
            this._dragging = true;
            this._cancelOpenTimer();
            this._cancelCloseTimer();
            this._cancelOrbAutoHideTimer();
            this._cancelOrbAutoFadeTimer();
            // A pending auto-hide ease(x/y) competes with every pointer move
            // and makes the face and separate glass region visibly oscillate.
            this._orb.remove_all_transitions?.();
            this._restoreOrbOpacity(false);

            if (this._orbHidden) {
                // Revealing from saved GSettings teleports the grabbed actor
                // while the gesture is already active. Instead expand the
                // currently grabbed edge tab in place, then start dragging.
                this._orbHidden = false;
                this._clampOrbToStage();
            }

            this._closeMenu(true);
            const [x, y] = this._orb.get_position();
            this._dragStartX = this._dragCurrentX = x;
            this._dragStartY = this._dragCurrentY = y;
            // Stage-space pointer anchor is independent of the moving actor,
            // unlike a local-coordinate delta coupled to its allocation.
            const centroid = gesture.get_centroid_abs?.();
            this._dragPointerOrigin =
                centroid &&
                Number.isFinite(centroid.get_x?.()) &&
                Number.isFinite(centroid.get_y?.())
                    ? [centroid.get_x(), centroid.get_y()]
                    : null;

            this._liquidGlassIntegration?.setOrbDragging?.(true);
            this._orb.fake_release();
            this._dragGrab = global.stage.grab(this._orb);
            this._setOrbVisualPseudoClass('dragging', true);
            return Clutter.EVENT_STOP;
        });

        this._panGesture.connect('pan-update', gesture => {
            if (!this._dragging)
                return;

            let x;
            let y;
            const centroid = gesture.get_centroid_abs?.();
            if (
                this._dragPointerOrigin &&
                centroid &&
                Number.isFinite(centroid.get_x?.()) &&
                Number.isFinite(centroid.get_y?.())
            ) {
                // Compute from ONE fixed stage-space origin, not from the
                // previous clamped position. Crossing an edge then reversing
                // must not accumulate a displaced or oscillating offset.
                x = this._dragStartX +
                    centroid.get_x() - this._dragPointerOrigin[0];
                y = this._dragStartY +
                    centroid.get_y() - this._dragPointerOrigin[1];
            } else {
                // GNOME-compatible fallback for builds without the centroid
                // accessor: get_delta_abs is incremental per pan update.
                const delta = gesture.get_delta_abs();
                x = this._dragCurrentX + delta.get_x();
                y = this._dragCurrentY + delta.get_y();
            }
            if (!Number.isFinite(x) || !Number.isFinite(y))
                return;
            const size = this._settings.get_int('orb-size');
            const [nextX, nextY] = this._clampPositionToVisibleMonitor(
                x, y, size
            );

            this._dragCurrentX = Math.round(nextX);
            this._dragCurrentY = Math.round(nextY);
            this._orb.set_position(
                this._dragCurrentX, this._dragCurrentY
            );
        });

        const finishDrag = () => {
            if (!this._dragging)
                return;

            this._dragging = false;
            this._dragPointerOrigin = null;

            if (this._dragGrab) {
                this._dragGrab.dismiss();
                this._dragGrab = null;
            }

            this._setOrbVisualPseudoClass('dragging', false);
            this._clampOrbToStage();
            this._liquidGlassIntegration?.setOrbDragging?.(false);
            this._storeOrbPosition();
            this._suppressClickUntil = GLib.get_monotonic_time() + 250000;
            this._scheduleOrbAutoHide();
            this._scheduleOrbAutoFade();
        };

        this._panGesture.connect('end', finishDrag);
        this._panGesture.connect('cancel', finishDrag);
    }

    _setOrbVisualPseudoClass(name, enabled) {
        if (!this._orbFace)
            return;

        if (enabled)
            this._orbFace.add_style_pseudo_class(name);
        else
            this._orbFace.remove_style_pseudo_class(name);
    }

    _connectSignals() {
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'top-header-layout' ||
                key === 'top-header-runtime-status') {
                // The active native layout may change one second after a
                // saved preference (when Shell recovers a missed signal).
                // Reconcile the standalone Orb as soon as the compositor
                // publishes what actually became active.
                this._syncOrbTaskbarMode();
                return;
            }
            if (key === 'orb-x' || key === 'orb-y') {
                if (!this._writingOrbPosition) {
                    this._syncOrbFromSettings();
                    this._refreshOpenMenu();
                }
                return;
            }

            if (key === 'orb-enabled') {
                this._setOrbEnabled(
                    this._settings.get_boolean('orb-enabled')
                );
                return;
            }

            if (['orb-size', 'orb-opacity', 'orb-icon'].includes(key)) {
                this._applyOrbAppearance();
                this._syncOrbFromSettings();
            }

            if (key === 'auto-hide-orb') {
                if (this._settings.get_boolean('auto-hide-orb')) {
                    this._cancelOrbAutoFadeTimer();
                    this._restoreOrbOpacity(false);
                    this._scheduleOrbAutoHide();
                } else {
                    this._cancelOrbAutoHideTimer();
                    this._revealOrb();
                    this._scheduleOrbAutoFade();
                }
            }

            if (key === 'auto-hide-delay' && this._settings.get_boolean('auto-hide-orb')) {
                this._cancelOrbAutoHideTimer();
                this._scheduleOrbAutoHide();
            }

            if (key === 'auto-fade-orb') {
                if (this._settings.get_boolean('auto-fade-orb'))
                    this._scheduleOrbAutoFade();
                else {
                    this._cancelOrbAutoFadeTimer();
                    this._restoreOrbOpacity(true);
                }
            }

            if (key === 'auto-fade-delay' && this._settings.get_boolean('auto-fade-orb')) {
                this._cancelOrbAutoFadeTimer();
                this._scheduleOrbAutoFade();
            }

            if (
                key === 'app-preview-size' &&
                this._appPreviewApp &&
                this._appPreviewAnchor
            ) {
                const app = this._appPreviewApp;
                const anchor = this._appPreviewAnchor;
                const side = this._appPreviewPreferredSide;
                this._hideAppPreview(true);

                if (anchor.get_parent())
                    this._showAppPreview(app, anchor, side);
            }

            if (
                key === 'orb-app-source' ||
                key === 'orb-custom-apps' ||
                key === 'orb-geometry'
            ) {
                this._orbPageIndex = 0;
                this._orbLastPageScrollUs = 0;
                this._refreshOpenMenu();
                return;
            }

            if ([
                'ring-mode',
                'orb-size',
                'icon-size',
                'icon-gap',
                'ring-gap',
                'show-tooltips',
                'show-running-indicator',
                'animation-ms',
            ].includes(key) && this._menuOpen) {
                this._orbPageIndex = 0;
                this._orbLastPageScrollUs = 0;
                this._reopenMenu();
            }
        });

        const refreshLaunchers = () => {
            this._orbPageIndex = 0;
            this._orbLastPageScrollUs = 0;
            this._refreshOpenMenu();
            this._scanDockHoverPreviews();
        };

        this._favoritesChangedId = this._shellSettings.connect(
            'changed::favorite-apps',
            refreshLaunchers
        );
        this._installedChangedId = this._appSystem.connect(
            'installed-changed',
            refreshLaunchers
        );
        this._appStateChangedId = this._appSystem.connect(
            'app-state-changed',
            refreshLaunchers
        );
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => {
                this._syncLayerSize();
                this._syncOrbFromSettings();
                this._refreshOpenMenu();
                this._scanDockHoverPreviews();
            }
        );

    }

    _syncLayerSize() {
        if (this._layer)
            this._layer.set_size(global.stage.width, global.stage.height);
    }

    _applyOrbAppearance() {
        if (
            !this._orb ||
            !this._orbContent ||
            !this._orbFace ||
            !this._orbMark
        ) {
            return;
        }

        const size = this._settings.get_int('orb-size');
        const opacity = this._settings.get_int('orb-opacity');

        this._orb.set_size(size, size);
        this._orbContent.set_size(size, size);
        this._orbFace.set_position(0, 0);
        this._orbFace.set_size(size, size);

        this._orb.opacity = this._orbFaded
            ? 0
            : Math.round(opacity * 2.55);

        const markSize = Math.max(
            8,
            Math.min(size - 6, Math.round(size * 0.44))
        );
        const markOffset = Math.round((size - markSize) / 2);

        this._orbMark.set_icon_size(markSize);
        this._orbMark.set_size(markSize, markSize);
        this._orbMark.set_position(markOffset, markOffset);

        this._applyOrbIcon();
    }

    _applyOrbIcon() {
        if (!this._orbMark)
            return;

        const configured =
            this._settings.get_string('orb-icon').trim() || DEFAULT_ORB_ICON;

        this._orbMark.fallback_icon_name = FALLBACK_ORB_ICON;

        if (configured.startsWith('/')) {
            const file = Gio.File.new_for_path(configured);
            if (file.query_exists(null)) {
                this._orbMark.icon_name = null;
                this._orbMark.gicon = new Gio.FileIcon({file});
                return;
            }

            this._orbMark.gicon = null;
            this._orbMark.icon_name = DEFAULT_ORB_ICON;
            return;
        }

        if (configured.startsWith('file://')) {
            const file = Gio.File.new_for_uri(configured);
            if (file.query_exists(null)) {
                this._orbMark.icon_name = null;
                this._orbMark.gicon = new Gio.FileIcon({file});
                return;
            }

            this._orbMark.gicon = null;
            this._orbMark.icon_name = DEFAULT_ORB_ICON;
            return;
        }

        this._orbMark.gicon = null;
        this._orbMark.icon_name = configured;
    }

    _syncOrbFromSettings() {
        if (!this._orb)
            return;

        const size = this._settings.get_int('orb-size');
        const maxX = Math.max(0, global.stage.width - size);
        const maxY = Math.max(0, global.stage.height - size);

        const desiredX =
            clamp(this._settings.get_double('orb-x'), 0, 1) * maxX;
        const desiredY =
            clamp(this._settings.get_double('orb-y'), 0, 1) * maxY;
        const [x, y] = this._clampPositionToVisibleMonitor(
            desiredX,
            desiredY,
            size
        );

        this._orb.set_position(x, y);

        if (this._orbHidden)
            this._applyOrbHiddenPosition(x, y, size, false);
    }

    _scheduleOrbAutoHide() {
        this._cancelOrbAutoHideTimer();

        if (
            !this._orb ||
            !this._settings.get_boolean('auto-hide-orb') ||
            this._dragging ||
            this._menuOpen ||
            this._orb.get_hover()
        ) {
            return;
        }

        const delay = this._settings.get_int('auto-hide-delay');
        this._orbAutoHideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._orbAutoHideTimeoutId = 0;

                if (
                    !this._orb ||
                    !this._settings.get_boolean('auto-hide-orb') ||
                    this._dragging ||
                    this._menuOpen ||
                    this._orb.get_hover()
                ) {
                    return GLib.SOURCE_REMOVE;
                }

                this._hideOrbToEdge();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelOrbAutoHideTimer() {
        if (this._orbAutoHideTimeoutId) {
            GLib.source_remove(this._orbAutoHideTimeoutId);
            this._orbAutoHideTimeoutId = 0;
        }
    }

    _scheduleOrbAutoFade() {
        this._cancelOrbAutoFadeTimer();

        if (
            !this._orb ||
            !this._settings.get_boolean('auto-fade-orb') ||
            this._settings.get_boolean('auto-hide-orb') ||
            this._dragging ||
            this._menuOpen ||
            this._orbHidden ||
            this._orb.get_hover()
        ) {
            return;
        }

        const delay = this._settings.get_int('auto-fade-delay');
        if (delay <= 0) {
            this._fadeOrbOut();
            return;
        }

        this._orbAutoFadeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._orbAutoFadeTimeoutId = 0;

                if (
                    !this._orb ||
                    !this._settings.get_boolean('auto-fade-orb') ||
                    this._settings.get_boolean('auto-hide-orb') ||
                    this._dragging ||
                    this._menuOpen ||
                    this._orbHidden ||
                    this._orb.get_hover()
                ) {
                    return GLib.SOURCE_REMOVE;
                }

                this._fadeOrbOut();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelOrbAutoFadeTimer() {
        if (this._orbAutoFadeTimeoutId) {
            GLib.source_remove(this._orbAutoFadeTimeoutId);
            this._orbAutoFadeTimeoutId = 0;
        }
    }

    _fadeOrbOut() {
        if (!this._orb || this._orbFaded)
            return;

        this._orbFaded = true;
        this._orb.remove_transition('opacity');
        this._orb.ease({
            opacity: 0,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _restoreOrbOpacity(animate = false) {
        if (!this._orb)
            return;

        const target = Math.round(
            this._settings.get_int('orb-opacity') * 2.55
        );

        this._orbFaded = false;
        this._orb.remove_transition('opacity');

        if (animate) {
            this._orb.ease({
                opacity: target,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._orb.opacity = target;
        }
    }

    _hideOrbToEdge() {
        if (!this._orb || this._orbHidden)
            return;

        this._cancelOrbAutoFadeTimer();
        this._restoreOrbOpacity(false);

        const size = this._settings.get_int('orb-size');
        const [x, y] = this._orb.get_position();

        this._orb.remove_all_transitions();
        this._orbHidden = true;
        this._applyOrbHiddenPosition(x, y, size, true);
    }

    _applyOrbHiddenPosition(x, y, size, animate = false) {
        const centerX = x + size / 2;
        const centerY = y + size / 2;
        const monitor = this._nearestMonitor(centerX, centerY);

        const candidates = [
            {
                edge: 'left',
                x: monitor.x - size + ORB_AUTO_HIDE_REVEAL_PX,
                y,
                distance: Math.abs(centerX - monitor.x),
            },
            {
                edge: 'right',
                x: monitor.x + monitor.width - ORB_AUTO_HIDE_REVEAL_PX,
                y,
                distance: Math.abs(monitor.x + monitor.width - centerX),
            },
            {
                edge: 'bottom',
                x,
                y: monitor.y + monitor.height - ORB_AUTO_HIDE_REVEAL_PX,
                distance: Math.abs(monitor.y + monitor.height - centerY),
            },
        ];

        for (const candidate of candidates) {
            candidate.visibleArea = this._visibleAreaAcrossMonitors(
                candidate.x,
                candidate.y,
                size
            );
        }

        candidates.sort((a, b) =>
            a.visibleArea - b.visibleArea ||
            a.distance - b.distance
        );

        const target = candidates[0];

        this._orb.remove_all_transitions();

        if (animate) {
            this._orb.ease({
                x: target.x,
                y: target.y,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._orb.set_position(target.x, target.y);
        }
    }

    _visibleAreaAcrossMonitors(x, y, size) {
        let visibleArea = 0;

        for (const monitor of Main.layoutManager.monitors) {
            const left = Math.max(x, monitor.x);
            const top = Math.max(y, monitor.y);
            const right = Math.min(x + size, monitor.x + monitor.width);
            const bottom = Math.min(y + size, monitor.y + monitor.height);

            if (right > left && bottom > top)
                visibleArea += (right - left) * (bottom - top);
        }

        return visibleArea;
    }

    _revealOrb() {
        if (!this._orb || !this._orbHidden)
            return;

        this._orb.remove_all_transitions();
        this._orbHidden = false;
        this._syncOrbFromSettings();
    }

    _clampOrbToStage() {
        const [x, y] = this._orb.get_position();
        const size = this._settings.get_int('orb-size');
        const [safeX, safeY] = this._clampPositionToVisibleMonitor(
            x,
            y,
            size
        );

        this._orb.set_position(safeX, safeY);
    }

    _clampPositionToVisibleMonitor(x, y, size) {
        const centerX = x + size / 2;
        const centerY = y + size / 2;
        const monitor = this._nearestMonitor(centerX, centerY);

        const minX = monitor.x;
        const minY = monitor.y;
        const maxX = Math.max(minX, monitor.x + monitor.width - size);
        const maxY = Math.max(minY, monitor.y + monitor.height - size);

        return [
            clamp(x, minX, maxX),
            clamp(y, minY, maxY),
        ];
    }

    _nearestMonitor(x, y) {
        const monitors = Main.layoutManager.monitors;
        if (!monitors || monitors.length === 0) {
            return {
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
            };
        }

        let nearest = monitors[0];
        let nearestDistance = Number.POSITIVE_INFINITY;

        for (const monitor of monitors) {
            if (
                x >= monitor.x &&
                x < monitor.x + monitor.width &&
                y >= monitor.y &&
                y < monitor.y + monitor.height
            ) {
                return monitor;
            }

            const dx =
                x < monitor.x
                    ? monitor.x - x
                    : x >= monitor.x + monitor.width
                        ? x - (monitor.x + monitor.width)
                        : 0;
            const dy =
                y < monitor.y
                    ? monitor.y - y
                    : y >= monitor.y + monitor.height
                        ? y - (monitor.y + monitor.height)
                        : 0;
            const distance = dx * dx + dy * dy;

            if (distance < nearestDistance) {
                nearest = monitor;
                nearestDistance = distance;
            }
        }

        return nearest;
    }

    _storeOrbPosition() {
        const [x, y] = this._orb.get_position();
        const size = this._settings.get_int('orb-size');
        const maxX = Math.max(1, global.stage.width - size);
        const maxY = Math.max(1, global.stage.height - size);

        this._writingOrbPosition = true;
        try {
            this._settings.set_double('orb-x', clamp(x / maxX, 0, 1));
            this._settings.set_double('orb-y', clamp(y / maxY, 0, 1));
        } finally {
            this._writingOrbPosition = false;
        }
    }

    _showAllApps() {
        this._cancelOpenTimer();
        this._cancelCloseTimer();
        this._closeMenu(true);

        const showAppsButton = Main.overview?.dash?.showAppsButton;
        if (!showAppsButton) {
            logError(
                new Error('GNOME Applications button is unavailable'),
                'VLIQ: failed to open Applications view'
            );
            return;
        }

        if (Main.overview.visible && showAppsButton.checked) {
            showAppsButton.checked = false;
            Main.overview.hide();
            return;
        }

        Main.overview.show(ControlsState.APP_GRID);
    }

    _scheduleOpen() {
        this._cancelCloseTimer();
        if (this._menuOpen || this._openTimeoutId)
            return;

        const delay = this._settings.get_int('hover-delay');
        if (delay <= 0) {
            this._openMenu();
            return;
        }

        this._openTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._openTimeoutId = 0;
                if (!this._dragging && this._orb?.get_hover())
                    this._openMenu();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _scheduleClose() {
        this._cancelOpenTimer();
        if (!this._menuOpen || this._closeTimeoutId)
            return;

        this._closeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._settings.get_int('close-delay'),
            () => {
                this._closeTimeoutId = 0;
                this._closeMenu();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelOpenTimer() {
        if (this._openTimeoutId) {
            GLib.source_remove(this._openTimeoutId);
            this._openTimeoutId = 0;
        }
    }

    _cancelCloseTimer() {
        if (this._closeTimeoutId) {
            GLib.source_remove(this._closeTimeoutId);
            this._closeTimeoutId = 0;
        }
    }

    _openMenu(reusePageSession = false, recycledButtons = null) {
        this._cancelOpenTimer();
        this._cancelCloseTimer();
        this._cancelOrbAutoHideTimer();
        this._cancelOrbAutoFadeTimer();
        this._restoreOrbOpacity(true);
        this._revealOrb();

        if (this._menuOpen || this._dragging)
            return;

        this._destroyClosingActors();
        this._cancelAppPreviewHide();
        this._hideAppPreview(true);

        const pageSession = reusePageSession
            ? this._orbPageSession
            : null;
        if (!pageSession)
            this._orbPageSession = null;

        const configuredSource =
            this._settings.get_string(
                'orb-app-source'
            );
        const appSource =
            ['dock', 'custom', 'all'].includes(
                configuredSource
            )
                ? configuredSource
                : 'dock';
        // Paging should not enumerate the full installed-app list again.
        // Explicit refresh, settings changes and fresh opens recalculate it.
        const requestedApps = pageSession?.apps ??
            collectOrbApps(
                this._appSystem,
                this._shellSettings,
                appSource,
                this._settings.get_strv(
                    'orb-custom-apps'
                )
            );
        if (requestedApps.length === 0) {
            this._orbPageIndex = 0;
            this._orbPageCount = 1;
            this._hideOrbPageIndicator(true);
            return;
        }

        this._menuOpen = true;
        this._setOrbVisualPseudoClass('open', true);

        const orbSize = this._settings.get_int('orb-size');
        const iconSize = this._settings.get_int('icon-size');
        const iconGap = this._settings.get_int('icon-gap');
        const ringGap = effectiveRingGap(
            iconSize,
            this._settings.get_int('ring-gap')
        );
        const animationMs = this._settings.get_int('animation-ms');
        const [orbX, orbY] = this._orb.get_position();
        const centerX = orbX + orbSize / 2;
        const centerY = orbY + orbSize / 2;
        const monitor = this._monitorAt(centerX, centerY);
        const configuredRingMode =
            this._settings.get_string(
                'ring-mode'
            );
        const ringMode =
            ['auto', '2', '3', '4'].includes(
                configuredRingMode
            )
                ? configuredRingMode
                : 'auto';
        const configuredGeometry =
            this._settings.get_string(
                'orb-geometry'
            );
        const geometry =
            [
                'orbit',
                'star',
                'molecule',
                'spiral',
                'petal',
            ].includes(configuredGeometry)
                ? configuredGeometry
                : 'orbit';

        let rings =
            ringMode === 'auto'
                ? 1
                : Number(ringMode);
        let slotRings = null;
        let capacities = null;
        let layoutArc = null;

        const maxDepth =
            ringMode === 'auto'
                ? AUTO_LAYOUT_MAX_DEPTH
                : rings;
        let previousCapacity = -1;
        let stagnantDepths = 0;

        if (pageSession) {
            rings = pageSession.rings;
            slotRings = pageSession.slotRings;
            capacities = pageSession.capacities;
            layoutArc = pageSession.layoutArc;
        } else {
            for (
                let candidate = rings;
                candidate <= maxDepth;
                candidate++
            ) {
                const outerRadius =
                    orbSize / 2 +
                    candidate * ringGap;
                const candidateArc =
                    arcForPosition(
                        centerX,
                        centerY,
                        outerRadius,
                        iconSize,
                        monitor
                    );
                const candidateSlotRings =
                    slotsForGeometry(
                        geometry,
                        centerX,
                        centerY,
                        orbSize,
                        ringGap,
                        candidate,
                        candidateArc,
                        iconSize,
                        iconGap,
                        monitor,
                        SCREEN_MARGIN
                    );
                const candidateCapacities =
                    candidateSlotRings.map(
                        slots => slots.length
                    );
                const candidateCapacity =
                    totalCapacity(
                        candidateCapacities
                    );

                rings = candidate;
                slotRings =
                    candidateSlotRings;
                capacities =
                    candidateCapacities;
                layoutArc =
                    candidateArc;

                if (ringMode !== 'auto')
                    break;

                if (
                    // 63 apps maximum per visible shader page. Avoid
                    // chasing thousands of installed apps on one page,
                    // which can compress geometry needlessly.
                    candidateCapacity >=
                    Math.min(requestedApps.length, MAX_VISIBLE_ORB_APPS)
                ) {
                    break;
                }

                // Near an edge/corner, Orbit can safely grow deeper into the
                // monitor even though its angular arc is narrower. Alternative
                // geometries may hit a physical fit limit earlier; stop after two
                // consecutive depths add no usable slots instead of doing useless
                // work up to the hard safety cap.
                if (
                    candidateCapacity <=
                    previousCapacity
                ) {
                    stagnantDepths++;
                } else {
                    stagnantDepths = 0;
                }

                previousCapacity =
                    candidateCapacity;

                if (stagnantDepths >= 2)
                    break;
            }
            // On small monitors/at corners, fitGeometryGroups can drop
            // complete outer levels. Use the actual fitted slot depth.
            rings = slotRings.length;
            this._orbPageSession = {
                apps: requestedApps,
                rings,
                slotRings,
                capacities,
                layoutArc,
                placementsByLength: new Map(),
                // Detached inactive pages are excluded from OrbGlass scans.
                inactiveButtons: new Map(),
            };
        }

        const visibleCapacity = Math.min(
            totalCapacity(capacities),
            MAX_VISIBLE_ORB_APPS
        );
        if (visibleCapacity === 0) {
            this._menuOpen = false;
            this._orbPageSession = null;
            this._setOrbVisualPseudoClass('open', false);
            return;
        }

        this._orbPageCount = Math.max(
            1,
            Math.ceil(
                requestedApps.length /
                visibleCapacity
            )
        );
        this._orbPageIndex = clamp(
            this._orbPageIndex,
            0,
            this._orbPageCount - 1
        );

        const pageStart =
            this._orbPageIndex *
            visibleCapacity;
        const apps = requestedApps.slice(
            pageStart,
            pageStart + visibleCapacity
        );
        const counts = allocateAcrossRings(
            apps.length,
            capacities
        );

        this._syncOrbPageIndicator();

        // Page 1 and 2 commonly have the same app count; reuse their
        // exact slot selection. A shorter final page has a separate plan.
        let placements = this._orbPageSession
            ?.placementsByLength.get(apps.length);
        if (!placements) {
            placements = [];
            for (
                let ring = 0;
                ring < slotRings.length;
                ring++
            ) {
                const slots = slotRings[ring] ?? [];
                const count = counts[ring] ?? 0;
                if (!slots.length || count <= 0)
                    continue;
                const selectedSlots =
                    selectGeometrySlots(
                        slots,
                        count,
                        geometry,
                        layoutArc
                    );
                placements.push(
                    ...selectedSlots
                );
            }
            this._orbPageSession
                ?.placementsByLength.set(apps.length, placements);
        }

        // Page switches are native, in-place swaps, not a second radial
        // entrance from the Orb. Replaying the entrance on every page briefly
        // leaves the scene with zero-opacity icons and looks like a blink.
        const entranceMs = reusePageSession ? 0 : animationMs;
        this._createGeometryLinks(
            geometry,
            placements,
            centerX,
            centerY,
            iconSize,
            entranceMs
        );

        for (
            let appIndex = 0;
            appIndex < apps.length &&
            appIndex < placements.length;
            appIndex++
        ) {
            const slot =
                placements[appIndex];
            const actor =
                recycledButtons?.[appIndex] ??
                this._createAppButton(
                    apps[appIndex],
                    iconSize
                );
            if (recycledButtons) {
                actor.remove_all_transitions?.();
                actor.show?.();
            }
            // Fix the layout once at the final native slot. Animate the
            // paint-time transform rather than x/y: Clutter's FixedLayout
            // reallocation used to lag the glass scene and produce a jump on
            // the first visible frames of large radial pages.
            actor.set_position(slot.x, slot.y);
            actor.translation_x = entranceMs > 0
                ? centerX - iconSize / 2 - slot.x
                : 0;
            actor.translation_y = entranceMs > 0
                ? centerY - iconSize / 2 - slot.y
                : 0;
            actor.opacity = entranceMs > 0 ? 0 : 255;
            actor.scale_x = entranceMs > 0 ? 0.35 : 1;
            actor.scale_y = entranceMs > 0 ? 0.35 : 1;
            this._layer.add_child(actor);
            this._radialActors.push(actor);

            if (entranceMs > 0) {
                actor.ease({
                    translation_x: 0,
                    translation_y: 0,
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    duration: entranceMs,
                    mode:
                        Clutter.AnimationMode
                            .EASE_OUT_QUAD,
                });
            }
        }
        this._activeOrbPageIndex = this._orbPageIndex;
    }

    _createGeometryLinks(
        geometry,
        slots,
        centerX,
        centerY,
        iconSize,
        animationMs
    ) {
        this._destroyGeometryActors();

        if (
            geometry === 'orbit' ||
            !slots.length ||
            !this._layer
        ) {
            return;
        }

        const centers = slots.map(slot => ({
            x: slot.x + iconSize / 2,
            y: slot.y + iconSize / 2,
        }));
        const links = [];

        if (
            geometry === 'molecule' ||
            geometry === 'spiral'
        ) {
            let previous = {
                x: centerX,
                y: centerY,
            };
            for (const point of centers) {
                links.push([
                    previous,
                    point,
                ]);
                previous = point;
            }
        } else {
            for (const point of centers) {
                links.push([
                    {
                        x: centerX,
                        y: centerY,
                    },
                    point,
                ]);
            }
        }

        for (const [from, to] of links) {
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length =
                Math.hypot(dx, dy);
            if (length <= 2)
                continue;

            const line = new St.Widget({
                style_class:
                    'vliq-orb-geometry-link',
                reactive: false,
            });
            line.set_size(
                Math.max(
                    1,
                    Math.round(length)
                ),
                2
            );
            line.set_position(
                Math.round(from.x),
                Math.round(from.y - 1)
            );
            line.set_pivot_point(
                0,
                0.5
            );
            line.set_rotation_angle?.(
                Clutter.RotateAxis.Z_AXIS,
                Math.atan2(
                    dy,
                    dx
                ) *
                180 /
                Math.PI
            );
            line.opacity = 0;

            try {
                if (
                    typeof this._layer
                        .insert_child_below ===
                    'function'
                ) {
                    this._layer.insert_child_below(
                        line,
                        this._orb
                    );
                } else {
                    this._layer.add_child(line);
                    this._layer
                        .set_child_below_sibling?.(
                            line,
                            this._orb
                        );
                }
            } catch {
                if (!line.get_parent?.())
                    this._layer.add_child(line);
            }

            this._geometryActors.push(
                line
            );

            if (animationMs <= 0) {
                line.opacity = 92;
            } else {
                line.ease({
                    opacity: 92,
                    duration:
                        Math.min(
                            animationMs,
                            180
                        ),
                    mode:
                        Clutter.AnimationMode
                            .EASE_OUT_QUAD,
                });
            }
        }
    }

    _destroyGeometryActors(
        immediate = true
    ) {
        const actors =
            this._geometryActors ?? [];
        this._geometryActors = [];

        for (const actor of actors) {
            actor.remove_all_transitions?.();

            if (immediate) {
                actor.destroy?.();
                continue;
            }

            actor.ease?.({
                opacity: 0,
                duration: 80,
                mode:
                    Clutter.AnimationMode
                        .EASE_OUT_QUAD,
                onComplete: () =>
                    actor.destroy?.(),
            });
        }
    }

    _createAppButton(app, iconSize) {
        const running = app.get_state() !== Shell.AppState.STOPPED;
        const textureSize = Math.max(
            12,
            Math.round(iconSize * 0.72)
        );
        const content = new St.Widget({
            style_class: 'vliq-app-content',
            layout_manager: new Clutter.FixedLayout(),
        });
        content.set_size(iconSize, iconSize);

        const icon = app.create_icon_texture(textureSize);
        icon.set_position(
            (iconSize - textureSize) / 2,
            (iconSize - textureSize) / 2 - 1
        );
        content.add_child(icon);

        if (
            running &&
            this._settings.get_boolean('show-running-indicator')
        ) {
            const dotSize = Math.max(3, Math.round(iconSize * 0.09));
            const dot = new St.Widget({
                style_class: 'vliq-running-dot',
                reactive: false,
            });
            dot.set_size(dotSize, dotSize);
            dot.set_position(
                (iconSize - dotSize) / 2,
                iconSize - dotSize - 2
            );
            content.add_child(dot);
        }

        const button = new St.Button({
            style_class: 'vliq-app-button',
            accessible_name: app.get_name(),
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: content,
        });
        button.set_size(iconSize, iconSize);
        button.set_pivot_point(0.5, 0.5);

        button.connect('notify::hover', () => {
            if (button.get_hover()) {
                this._cancelCloseTimer();
                this._cancelAppPreviewHide();

                button.ease({
                    scale_x: ICON_HOVER_SCALE,
                    scale_y: ICON_HOVER_SCALE,
                    duration: 110,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });

                const previewShown = this._showAppPreview(app, button);
                if (previewShown) {
                    this._hideTooltip();
                } else if (this._settings.get_boolean('show-tooltips')) {
                    this._showTooltip(app.get_name(), button);
                }
            } else {
                this._hideTooltip();
                this._scheduleAppPreviewHide(button);

                button.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: 110,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                this._scheduleClose();
            }
        });

        button.connect('clicked', () => {
            this._hideTooltip();
            this._cancelAppPreviewHide();
            this._hideAppPreview(true);
            this._closeMenu();
            Main.overview.hide();
            app.activate();
        });

        return button;
    }

    _closeMenu(immediate = false, preservePageButtons = false) {
        this._cancelOpenTimer();
        this._cancelCloseTimer();
        this._cancelAppPreviewHide();
        this._hideAppPreview(immediate);
        this._hideTooltip();
        this._hideOrbPageIndicator(immediate);
        this._destroyGeometryActors(immediate);
        if (!preservePageButtons) {
            // Native close/disable/refresh releases every detached actor.
            for (const buttons of
                this._orbPageSession?.inactiveButtons?.values() ?? []) {
                for (const actor of buttons)
                    actor.destroy?.();
            }
            this._orbPageSession?.inactiveButtons?.clear();
            this._orbPageSession = null;
        }
        this._activeOrbPageIndex = null;

        if (!this._menuOpen && this._radialActors.length === 0) {
            this._scheduleOrbAutoHide();
            this._scheduleOrbAutoFade();
            return;
        }

        this._menuOpen = false;
        this._setOrbVisualPseudoClass('open', false);
        const actors = this._radialActors;
        this._radialActors = [];

        if (!this._orb || immediate) {
            const detached = [];
            for (const actor of actors) {
                if (preservePageButtons &&
                    actor.get_parent?.() === this._layer) {
                    try {
                        actor.remove_all_transitions?.();
                        actor.hide?.();
                        this._layer.remove_child(actor);
                        detached.push(actor);
                        continue;
                    } catch {
                        // Fall back to destruction if detachment fails.
                    }
                }
                actor.destroy();
            }
            this._scheduleOrbAutoHide();
            this._scheduleOrbAutoFade();
            return detached;
        }

        const duration = Math.min(
            150,
            this._settings.get_int('animation-ms')
        );
        const orbSize = this._settings.get_int('orb-size');
        const iconSize = this._settings.get_int('icon-size');
        const [orbX, orbY] = this._orb.get_position();
        const targetX = orbX + orbSize / 2 - iconSize / 2;
        const targetY = orbY + orbSize / 2 - iconSize / 2;

        for (const actor of actors) {
            if (duration <= 0) {
                actor.destroy();
                continue;
            }

            this._closingActors.add(actor);
            actor.ease({
                // Translation avoids a second round of layout invalidations
                // when a live radial page collapses back to its Orb.
                translation_x: targetX - actor.x,
                translation_y: targetY - actor.y,
                opacity: 0,
                scale_x: 0.35,
                scale_y: 0.35,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._closingActors?.delete(actor);
                    actor.destroy();
                },
            });
        }

        this._scheduleOrbAutoHide();
        this._scheduleOrbAutoFade();
    }

    _changeOrbPage(delta) {
        if (
            !this._menuOpen ||
            this._orbPageCount <= 1
        ) {
            return;
        }

        const nowUs = GLib.get_monotonic_time();
        if (
            this._orbLastPageScrollUs &&
            nowUs - this._orbLastPageScrollUs <
                140000
        ) {
            return;
        }
        this._orbLastPageScrollUs = nowUs;

        const count = this._orbPageCount;
        this._orbPageIndex =
            (
                this._orbPageIndex +
                delta +
                count
            ) % count;
        this._reopenMenu(true);
    }

    _syncOrbPageIndicator() {
        if (
            !this._menuOpen ||
            this._orbPageCount <= 1 ||
            !this._orb ||
            !this._layer
        ) {
            this._hideOrbPageIndicator(true);
            return;
        }

        if (!this._orbPageIndicator) {
            this._orbPageIndicator = new St.Label({
                style_class:
                    'vliq-orb-page-indicator',
                reactive: false,
            });
            this._layer.add_child(
                this._orbPageIndicator
            );
        }

        this._orbPageIndicator.text =
            `${this._orbPageIndex + 1} / ${this._orbPageCount} · scroll`;

        const [orbX, orbY] =
            this._orb.get_position();
        const orbSize =
            this._settings.get_int('orb-size');
        const monitor = this._monitorAt(
            orbX + orbSize / 2,
            orbY + orbSize / 2
        );
        const [, naturalWidth] =
            this._orbPageIndicator
                .get_preferred_width?.(-1) ??
            [0, 72];
        const [, naturalHeight] =
            this._orbPageIndicator
                .get_preferred_height?.(-1) ??
            [0, 24];

        const onLeftHalf =
            orbX + orbSize / 2 <
            monitor.x + monitor.width / 2;
        const desiredX = onLeftHalf
            ? orbX + orbSize + 10
            : orbX - naturalWidth - 10;
        const desiredY =
            orbY +
            orbSize / 2 -
            naturalHeight / 2;

        this._orbPageIndicator.set_position(
            Math.round(
                clamp(
                    desiredX,
                    monitor.x + SCREEN_MARGIN,
                    monitor.x +
                        monitor.width -
                        naturalWidth -
                        SCREEN_MARGIN
                )
            ),
            Math.round(
                clamp(
                    desiredY,
                    monitor.y + SCREEN_MARGIN,
                    monitor.y +
                        monitor.height -
                        naturalHeight -
                        SCREEN_MARGIN
                )
            )
        );
        this._orbPageIndicator.show?.();
    }

    _hideOrbPageIndicator(immediate = false) {
        const indicator =
            this._orbPageIndicator;
        this._orbPageIndicator = null;

        if (!indicator)
            return;

        indicator.remove_all_transitions?.();

        if (immediate) {
            indicator.destroy?.();
            return;
        }

        indicator.ease?.({
            opacity: 0,
            duration: 80,
            mode:
                Clutter.AnimationMode
                    .EASE_OUT_QUAD,
            onComplete: () =>
                indicator.destroy?.(),
        });
    }

    _destroyClosingActors() {
        if (!this._closingActors || this._closingActors.size === 0)
            return;

        for (const actor of this._closingActors) {
            actor.remove_all_transitions();
            actor.destroy();
        }

        this._closingActors.clear();
    }

    _reopenMenu(reusePageSession = false) {
        const session = reusePageSession && this._menuOpen
            ? this._orbPageSession
            : null;
        const outgoingPage = this._activeOrbPageIndex;
        const outgoingCount = this._radialActors.length;
        const incomingPage = this._orbPageIndex;
        // Take the incoming page out of the LRU before evicting any entries.
        const cachedNext =
            session?.inactiveButtons?.get(incomingPage) ?? null;
        session?.inactiveButtons?.delete(incomingPage);

        const detached = this._closeMenu(true, Boolean(session));
        if (session) {
            if (detached?.length === outgoingCount &&
                detached.length && outgoingPage !== null) {
                session.inactiveButtons.set(outgoingPage, detached);
            } else {
                for (const actor of detached ?? [])
                    actor.destroy?.();
            }
            while (
                session.inactiveButtons.size >
                MAX_CACHED_INACTIVE_ORB_PAGES
            ) {
                const oldest = session.inactiveButtons.keys()
                    .next().value;
                const evicted = session.inactiveButtons.get(oldest);
                session.inactiveButtons.delete(oldest);
                for (const actor of evicted ?? [])
                    actor.destroy?.();
            }
            this._orbPageSession = session;
        }
        this._openMenu(Boolean(session), cachedNext);
    }

    _refreshOpenMenu() {
        if (this._menuOpen)
            this._reopenMenu();
    }

    _collectDockPreviewContainers() {
        const found = [];

        const walk = actor => {
            if (!actor || actor === global.window_group)
                return;

            if (
                actor.get_name?.() ===
                'dashtodockDashContainer'
            ) {
                found.push(actor);
                return;
            }

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };

        walk(Main.layoutManager.uiGroup);
        return found;
    }

    _dockPreviewSide(anchorActor) {
        if (!anchorActor)
            return null;

        let x = 0;
        let y = 0;
        let width = 0;
        let height = 0;

        try {
            [x, y] =
                anchorActor.get_transformed_position();
            [width, height] =
                anchorActor.get_transformed_size();
        } catch {
            return null;
        }

        const centerX = x + width / 2;
        const centerY = y + height / 2;
        const monitor = this._monitorAt(
            centerX,
            centerY
        );

        const distances = [
            {
                edge: 'left',
                value: Math.abs(x - monitor.x),
            },
            {
                edge: 'right',
                value: Math.abs(
                    monitor.x +
                    monitor.width -
                    (x + width)
                ),
            },
            {
                edge: 'top',
                value: Math.abs(y - monitor.y),
            },
            {
                edge: 'bottom',
                value: Math.abs(
                    monitor.y +
                    monitor.height -
                    (y + height)
                ),
            },
        ].sort((a, b) => a.value - b.value);

        switch (distances[0]?.edge) {
        case 'left':
            return 'right';
        case 'right':
            return 'left';
        case 'top':
            return 'bottom';
        case 'bottom':
            return 'top';
        default:
            return null;
        }
    }

    _findDockAppActors(container) {
        const found = [];

        const walk = actor => {
            if (!actor)
                return;

            const app = actor.app ?? null;
            if (
                app &&
                typeof app.get_windows === 'function' &&
                actor.icon &&
                typeof actor.connect === 'function'
            ) {
                found.push({actor, app});
                return;
            }

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };

        walk(container);
        return found;
    }

    _hookDockPreviewActor(actor, app) {
        if (
            !actor ||
            !app ||
            this._dockPreviewHooks.has(actor)
        ) {
            return;
        }

        const item =
            actor.get_parent?.() ?? null;
        const label =
            item?.label ?? null;

        const entry = {
            hoverId: 0,
            destroyId: 0,
            label,
            labelVisibleId: 0,
        };

        if (label) {
            try {
                entry.labelVisibleId = label.connect(
                    'notify::visible',
                    () => {
                        if (
                            this._appPreviewAnchor !== actor ||
                            !label.visible
                        ) {
                            return;
                        }

                        try {
                            label.remove_all_transitions?.();
                            label.opacity = 0;
                            label.hide();
                        } catch {}
                    }
                );
            } catch {}
        }

        try {
            entry.hoverId = actor.connect(
                'notify::hover',
                () => {
                    if (
                        this._disabled ||
                        !actor.get_parent?.()
                    ) {
                        return;
                    }

                    if (actor.get_hover?.()) {
                        this._cancelAppPreviewHide();
                        this._hideTooltip();

                        const shown =
                            this._showAppPreview(
                                app,
                                actor,
                                this._dockPreviewSide(actor)
                            );

                        if (shown) {
                            // Dash-to-Dock owns its hover label on the parent
                            // DashItemContainer. It has showLabel(), but no
                            // hideLabel() helper, so suppress the real label
                            // actor directly after cancelling its fade-in.
                            try {
                                label?.remove_all_transitions?.();
                                if (label)
                                    label.opacity = 0;
                                label?.hide?.();
                            } catch {}

                            GLib.idle_add(
                                GLib.PRIORITY_DEFAULT_IDLE,
                                () => {
                                    if (
                                        this._appPreviewAnchor === actor &&
                                        actor.get_hover?.()
                                    ) {
                                        try {
                                            label?.remove_all_transitions?.();
                                            if (label)
                                                label.opacity = 0;
                                            label?.hide?.();
                                        } catch {}
                                    }
                                    return GLib.SOURCE_REMOVE;
                                }
                            );
                        }
                    } else {
                        this._scheduleAppPreviewHide(actor);
                    }
                }
            );
        } catch {}

        try {
            entry.destroyId = actor.connect(
                'destroy',
                () => {
                    this._dockPreviewHooks.delete(actor);

                    if (
                        this._appPreviewAnchor === actor
                    ) {
                        this._hideAppPreview(true);
                    }
                }
            );
        } catch {}

        this._dockPreviewHooks.set(actor, entry);
    }

    _scanDockHoverPreviews() {
        if (this._disabled)
            return;

        const live = new Set();

        for (
            const container of
            this._collectDockPreviewContainers()
        ) {
            for (
                const {actor, app} of
                this._findDockAppActors(container)
            ) {
                live.add(actor);
                this._hookDockPreviewActor(actor, app);
            }
        }

        for (
            const [actor, entry] of
            [...this._dockPreviewHooks]
        ) {
            if (live.has(actor))
                continue;

            try {
                if (entry.hoverId)
                    actor.disconnect(entry.hoverId);
            } catch {}

            try {
                if (entry.destroyId)
                    actor.disconnect(entry.destroyId);
            } catch {}

            try {
                if (
                    entry.label &&
                    entry.labelVisibleId
                ) {
                    entry.label.disconnect(
                        entry.labelVisibleId
                    );
                }
            } catch {}

            this._dockPreviewHooks.delete(actor);
        }
    }

    _setupDockHoverPreviews() {
        this._cleanupDockHoverPreviews();
        this._scanDockHoverPreviews();

        this._dockPreviewRescanId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                DOCK_PREVIEW_RESCAN_MS,
                () => {
                    if (this._disabled) {
                        this._dockPreviewRescanId = 0;
                        return GLib.SOURCE_REMOVE;
                    }

                    this._scanDockHoverPreviews();
                    return GLib.SOURCE_CONTINUE;
                }
            );
    }

    _cleanupDockHoverPreviews() {
        if (this._dockPreviewRescanId) {
            try {
                GLib.source_remove(
                    this._dockPreviewRescanId
                );
            } catch {}
            this._dockPreviewRescanId = 0;
        }

        for (
            const [actor, entry] of
            this._dockPreviewHooks ?? []
        ) {
            try {
                if (entry.hoverId)
                    actor.disconnect(entry.hoverId);
            } catch {}

            try {
                if (entry.destroyId)
                    actor.disconnect(entry.destroyId);
            } catch {}

            try {
                if (
                    entry.label &&
                    entry.labelVisibleId
                ) {
                    entry.label.disconnect(
                        entry.labelVisibleId
                    );
                }
            } catch {}
        }

        this._dockPreviewHooks?.clear?.();
    }

    _monitorAt(x, y) {
        for (const monitor of Main.layoutManager.monitors) {
            if (
                x >= monitor.x &&
                x < monitor.x + monitor.width &&
                y >= monitor.y &&
                y < monitor.y + monitor.height
            ) {
                return monitor;
            }
        }

        return Main.layoutManager.primaryMonitor ?? {
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        };
    }

    _globalPreviewItem(app, anchorActor, preferredSide) {
        if (!anchorActor || !app)
            return null;
        let item = this._globalPreviewItems?.get(anchorActor) ?? null;
        if (!item) {
            item = {app, button: anchorActor, side: preferredSide};
            this._globalPreviewItems?.set(anchorActor, item);
        } else {
            item.app = app;
            item.side = preferredSide;
        }
        return item;
    }

    _showAppPreview(app, anchorActor, preferredSide = null) {
        if (this._globalWindowPreview) {
            const item = this._globalPreviewItem(
                app, anchorActor, preferredSide);
            if (!item)
                return false;
            const running = (app.get_windows?.() ?? []).some(w =>
                !w.skip_taskbar && Boolean(w.get_compositor_private?.()));
            if (!running) {
                this._globalWindowPreview.close();
                this._globalPreviewAnchor = null;
                return false;
            }
            this._globalPreviewAnchor = anchorActor;
            this._globalWindowPreview.onButtonHover(item, true);
            return true;
        }
        const windows = app.get_windows()
            .filter(window =>
                !window.skip_taskbar &&
                Boolean(window.get_compositor_private?.())
            )
            .slice(0, APP_PREVIEW_MAX_WINDOWS);

        if (windows.length === 0) {
            this._hideAppPreview(true);
            return false;
        }

        if (
            this._appPreview &&
            this._appPreviewApp === app &&
            this._appPreviewAnchor === anchorActor &&
            this._appPreviewPreferredSide === preferredSide
        ) {
            this._positionAppPreview(
                this._appPreview,
                anchorActor,
                preferredSide
            );
            return true;
        }

        this._hideAppPreview(true);

        const [anchorX, anchorY] =
            anchorActor.get_transformed_position();
        const [anchorWidth, anchorHeight] =
            anchorActor.get_transformed_size();
        const monitor = this._monitorAt(
            anchorX + anchorWidth / 2,
            anchorY + anchorHeight / 2
        );
        const layout = planWindowPreview(
            windows,
            this._settings.get_int('app-preview-size') / 100 *
                APP_PREVIEW_SIZE_BOOST,
            monitor
        );
        const {cardWidth, cardHeight} = layout;

        const card = new St.Widget({
            style_class: 'vliq-app-preview-card',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        card.set_size(cardWidth, cardHeight);
        card.set_pivot_point(0.5, 0.5);

        windows.forEach((window, index) => {
            const item = layout.tiles[index];
            const tile = this._createWindowPreviewTile(
                window,
                item.width,
                item.height,
                item.bounds
            );
            tile.set_position(item.x, item.y);
            card.add_child(tile);
        });

        card.connect('notify::hover', () => {
            if (card.get_hover()) {
                this._cancelCloseTimer();
                this._cancelAppPreviewHide();
            } else {
                this._scheduleAppPreviewHide();
                this._scheduleClose();
            }
        });

        app.connectObject('windows-changed', () => {
            if (
                this._appPreviewApp !== app ||
                !this._appPreviewAnchor
            ) {
                return;
            }

            const anchor = this._appPreviewAnchor;
            const side = this._appPreviewPreferredSide;
            this._hideAppPreview(true);

            if (anchor.get_parent())
                this._showAppPreview(app, anchor, side);
        }, card);

        this._layer.add_child(card);
        this._appPreview = card;
        this._appPreviewApp = app;
        this._appPreviewAnchor = anchorActor;
        this._appPreviewPreferredSide = preferredSide;

        this._positionAppPreview(
            card,
            anchorActor,
            preferredSide
        );

        // Render the native WindowPreviewLayout clones in fixed 16:9 slots.
        // The glass renderer inserts its refractive material underneath those
        // tiles, as the preview card's first child. Parent opacity/scale and
        // teardown then stay aligned with GNOME's compositor automatically.
        this._liquidGlassIntegration
            ?.attachPreviewGlass?.(card);

        card.opacity = 0;
        card.scale_x = 0.96;
        card.scale_y = 0.96;
        card.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        return true;
    }

    _createWindowPreviewTile(
        window, tileWidth, tileHeight, bounds = previewWindowBounds(window)
    ) {
        const content = new St.Widget({
            style_class: 'vliq-window-preview-content',
            reactive: false,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        content.set_size(tileWidth, tileHeight);

        const previewLayout = new Shell.WindowPreviewLayout();
        const preview = new Clutter.Actor({
            reactive: false,
            // The source window buffer can extend beyond its frame (shadows).
            // Let the native clone paint that extent; the *tile* clips it.
            clip_to_allocation: false,
        });
        // Shell.WindowPreviewLayout tracks its container. GNOME Shell itself
        // assigns it after actor construction to avoid GJS container setup
        // issues during initialization.
        preview.layout_manager = previewLayout;

        // Fit the *painted* union of frame+buffer into the native tile.
        // WindowPreviewLayout positions its Clutter.Clone from frame origin,
        // and therefore raw frame-only sizing can let CSD/shadow pixels
        // overflow the card or produce asymmetrical empty side areas.
        const maxWidth = Math.max(1, tileWidth - 4);
        const maxHeight = Math.max(1, tileHeight - 4);
        // GNOME's native preview is a compositor texture: it can be
        // scaled just like Overview thumbnails. A forced 1:1 cap made small
        // windows tiny inside a large glass frame even after sizing fixes.
        const scale = Math.min(
            maxWidth / bounds.width,
            maxHeight / bounds.height
        );
        const previewWidth = Math.max(
            1, Math.floor(bounds.frame.width * scale)
        );
        const previewHeight = Math.max(
            1, Math.floor(bounds.frame.height * scale)
        );

        preview.set_size(previewWidth, previewHeight);
        preview.set_position(
            Math.round(
                (tileWidth - bounds.width * scale) / 2 +
                (bounds.frame.x - bounds.x) * scale
            ),
            Math.round(
                (tileHeight - bounds.height * scale) / 2 +
                (bounds.frame.y - bounds.y) * scale
            )
        );
        previewLayout.add_window(window);
        content.add_child(preview);

        const tile = new St.Button({
            style_class: 'vliq-window-preview-tile',
            accessible_name: window.title || 'Window preview',
            can_focus: true,
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            child: content,
        });
        tile.set_size(tileWidth, tileHeight);

        tile.connect('notify::hover', () => {
            if (tile.get_hover()) {
                this._cancelCloseTimer();
                this._cancelAppPreviewHide();
            } else {
                this._scheduleAppPreviewHide();
                this._scheduleClose();
            }
        });

        tile.connect('clicked', () => {
            this._cancelAppPreviewHide();
            this._hideAppPreview(true);
            this._closeMenu(true);
            Main.activateWindow(window);
        });

        return tile;
    }

    _positionAppPreview(
        card,
        anchorActor,
        preferredSide = null
    ) {
        if (!card || !anchorActor)
            return;

        const [anchorX, anchorY] =
            anchorActor.get_transformed_position();
        const [anchorWidth, anchorHeight] =
            anchorActor.get_transformed_size();
        const anchorCenterX = anchorX + anchorWidth / 2;
        const anchorCenterY = anchorY + anchorHeight / 2;

        const monitor = this._monitorAt(
            anchorCenterX,
            anchorCenterY
        );
        const cardWidth = card.width;
        const cardHeight = card.height;

        const candidates = {
            right: {
                x: anchorX + anchorWidth + APP_PREVIEW_OFFSET,
                y: anchorCenterY - cardHeight / 2,
            },
            left: {
                x: anchorX - cardWidth - APP_PREVIEW_OFFSET,
                y: anchorCenterY - cardHeight / 2,
            },
            bottom: {
                x: anchorCenterX - cardWidth / 2,
                y: anchorY + anchorHeight + APP_PREVIEW_OFFSET,
            },
            top: {
                x: anchorCenterX - cardWidth / 2,
                y: anchorY - cardHeight - APP_PREVIEW_OFFSET,
            },
        };

        const sideOrders = {
            top: ['top', 'right', 'left', 'bottom'],
            bottom: ['bottom', 'right', 'left', 'top'],
            left: ['left', 'bottom', 'top', 'right'],
            right: ['right', 'bottom', 'top', 'left'],
        };

        let order = sideOrders[preferredSide] ?? null;

        if (!order) {
            let referenceX =
                monitor.x + monitor.width / 2;
            let referenceY =
                monitor.y + monitor.height / 2;

            if (this._orb) {
                const [orbX, orbY] =
                    this._orb.get_position();
                const orbSize =
                    this._settings.get_int('orb-size');
                referenceX = orbX + orbSize / 2;
                referenceY = orbY + orbSize / 2;
            }

            const dx = anchorCenterX - referenceX;
            const dy = anchorCenterY - referenceY;

            if (Math.abs(dx) >= Math.abs(dy)) {
                order = dx >= 0
                    ? ['right', 'bottom', 'top', 'left']
                    : ['left', 'bottom', 'top', 'right'];
            } else {
                order = dy >= 0
                    ? ['bottom', 'right', 'left', 'top']
                    : ['top', 'right', 'left', 'bottom'];
            }
        }

        const minX = monitor.x + SCREEN_MARGIN;
        const maxX =
            monitor.x +
            monitor.width -
            cardWidth -
            SCREEN_MARGIN;
        const minY = monitor.y + SCREEN_MARGIN;
        const maxY =
            monitor.y +
            monitor.height -
            cardHeight -
            SCREEN_MARGIN;

        const fits = candidate =>
            candidate.x >= minX &&
            candidate.x <= maxX &&
            candidate.y >= minY &&
            candidate.y <= maxY;

        let target = null;
        for (const side of order) {
            if (fits(candidates[side])) {
                target = candidates[side];
                break;
            }
        }

        target ??= candidates[order[0]];

        card.set_position(
            Math.round(
                clamp(
                    target.x,
                    minX,
                    Math.max(minX, maxX)
                )
            ),
            Math.round(
                clamp(
                    target.y,
                    minY,
                    Math.max(minY, maxY)
                )
            )
        );
    }

    _scheduleAppPreviewHide(anchorActor = null) {
        if (this._globalWindowPreview) {
            // Late LEAVE from another icon must never dismiss the newly
            // hovered icon's pending live preview.
            const anchor = this._globalPreviewAnchor;
            if (anchorActor && anchorActor !== anchor)
                return;
            const item = anchor
                ? this._globalPreviewItems?.get(anchor) : null;
            if (item)
                this._globalWindowPreview.onButtonHover(item, false);
            return;
        }
        this._cancelAppPreviewHide();

        if (!this._appPreview)
            return;

        this._appPreviewHideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            APP_PREVIEW_HIDE_DELAY,
            () => {
                this._appPreviewHideTimeoutId = 0;

                if (this._appPreview?.get_hover())
                    return GLib.SOURCE_REMOVE;

                this._hideAppPreview();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelAppPreviewHide() {
        if (this._globalWindowPreview)
            return; // Native preview manages its own leave grace.
        if (!this._appPreviewHideTimeoutId)
            return;

        GLib.source_remove(this._appPreviewHideTimeoutId);
        this._appPreviewHideTimeoutId = 0;
    }

    _hideAppPreview(immediate = false) {
        if (this._globalWindowPreview) {
            this._globalWindowPreview.close();
            this._globalPreviewAnchor = null;
        }
        const card = this._appPreview;

        this._appPreview = null;
        this._appPreviewApp = null;
        this._appPreviewAnchor = null;
        this._appPreviewPreferredSide = null;

        if (!card)
            return;

        card.remove_all_transitions();

        if (immediate) {
            card.destroy();
            return;
        }

        card.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => card.destroy(),
        });
    }

    _showTooltip(text, actor) {
        this._hideTooltip();

        this._tooltip = new St.Label({
            text,
            style_class: 'vliq-tooltip',
            reactive: false,
        });
        this._layer.add_child(this._tooltip);

        const [x, y] = actor.get_transformed_position();
        const [, width] = this._tooltip.get_preferred_width(-1);

        this._tooltip.set_position(
            clamp(
                x + actor.width / 2 - width / 2,
                SCREEN_MARGIN,
                global.stage.width - width - SCREEN_MARGIN
            ),
            clamp(
                y + actor.height + 8,
                SCREEN_MARGIN,
                global.stage.height - 38
            )
        );
    }

    _hideTooltip() {
        this._tooltip?.destroy();
        this._tooltip = null;
    }
}
