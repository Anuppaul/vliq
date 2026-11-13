// VLIQ GNOME 50 top bar: configurable full-width or three-part glass.
// No GNOME panel actor is reparented and native controls keep their input.
// Never reparent GNOME's panel buttons or modify their input handling.
// Reuse one bounded PanelGlassSurface per visible region, not DashManager's
// old full-monitor FBO; no extra shader, input surface or render timer.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {frameDue} from './frameBudget.js';
import {PanelGlassSurface} from './panelGlass.js';
import {BottomTaskbar} from './bottomTaskbar.js';
import {primaryPanelIsFullscreen} from './fullscreenPanelGuard.js';

const STAGE_SYNC_FPS = 24;
// GSettings changes normally arrive as signals. A low-cost reconciliation
// also repairs missed signals and runtime hot-reload ordering on idle desktops.
const LAYOUT_RECONCILE_SECONDS = 1;
const MAX_LAYOUT_RETRIES = 3;
const LAYOUT_RETRY_COOLDOWN_US = 4_000_000;
const RADIUS = 16;
const INSET_Y = 2;
const SIDE_MARGIN = 6;
const ISLAND_PAD_X = 9;
const ISLAND_GAP = 8;
const MIN_WIDTH = 22;
const MIN_HEIGHT = 14;
const REGIONS = Object.freeze([
    ['left', '_leftBox'],
    ['center', '_centerBox'],
    ['right', '_rightBox'],
]);

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

export class TopBarIslands {
    constructor({vendor, settings, readAppearance, layoutSettings = null,
        bottomTaskbarFactory = null, getDockEntries = null,
        forceCssOnly = false,
        onLauncherClick = null, onLayoutChanged = null,
        panel = Main.panel,
        layout = Main.layoutManager, display = global.display}) {
        this._vendor = vendor;
        this._settings = settings;
        this._forceCssOnly = forceCssOnly === true;
        // VLIQ's canonical schema controls the layout. The renderer's
        // separate settings still control LiquidEffect optics.
        this._layoutSettings = layoutSettings;
        this._layoutMode = 'split';
        this._bottomTaskbarFactory = bottomTaskbarFactory ??
            (options => new BottomTaskbar(options));
        this._getDockEntries = getDockEntries;
        this._onLauncherClick = onLauncherClick;
        this._onLayoutChanged = onLayoutChanged;
        this._bottomTaskbar = null;
        this._readAppearance = readAppearance;
        this._panel = panel;
        this._layout = layout;
        this._display = display;
        this._regions = [];
        this._signals = [];
        this._stageSignal = 0;
        this._enabled = false;
        this._visibilityGate = null;
        this._host = null;
        this._panelRoot = null;
        this._hasReportedReady = false;
        this._lastStageSyncUs = 0;
        this._syncing = false;
        this._switchingLayout = false;
        this._layoutWatchId = 0;
        this._failedDesired = null;
        this._failedAttempts = 0;
        this._retryNotBeforeUs = 0;
    }

    isBottomTaskbarActive() {
        return this._layoutMode === 'bottom' &&
            Boolean(this._bottomTaskbar?.isActive?.() ??
                this._bottomTaskbar?.active);
    }

    // Separate paint ownership from instantaneous transformed coordinates.
    // During app activation GNOME can temporarily relocate/reallocate the
    // native panel; the Bottom session still owns the ONLY Dock backplate.
    ownsBottomTaskbarChrome() {
        return this._layoutMode === 'bottom' &&
            Boolean(this._bottomTaskbar?.ownsChrome?.() ??
                this._bottomTaskbar?.active);
    }

    setLauncherCallback(callback) {
        this._onLauncherClick = typeof callback === 'function'
            ? callback : null;
        this._bottomTaskbar?.setLauncherCallback?.(callback);
    }

    _publishLayoutStatus(message) {
        if (!this._layoutSettings?.set_string)
            return;
        try {
            const previous = this._layoutSettings.get_string(
                'top-header-runtime-status'
            );
            if (previous !== message)
                this._layoutSettings.set_string(
                    'top-header-runtime-status', message
                );
        } catch (error) {
            console.warn('[VLIQ][TopBar] status unavailable: ' + error);
        }
    }

    _activeStatus() {
        if (this._layoutMode === 'bottom')
            return this.isBottomTaskbarActive()
                ? (!this._forceCssOnly && this._regions.length
                    ? 'Bottom Taskbar active (Liquid Glass)'
                    : 'Bottom Taskbar active (CSS fallback)')
                : 'Bottom Taskbar unavailable';
        if (this._layoutMode === 'full')
            return 'Full Header active';
        return '3-Part Header active';
    }

    setVisibilityGate(callback) {
        this._visibilityGate = typeof callback === 'function'
            ? callback : null;
        this.sync();
    }

    setup() {
        if (this._enabled)
            return true;

        const panel = this._panel;
        const layout = this._layout;
        const host = layout?.uiGroup;
        const nativePanelBox = layout?.panelBox;
        if (!panel || !host || !nativePanelBox) {
            this._publishLayoutStatus(
                'Error: native GNOME panel/host unavailable'
            );
            return false;
        }

        // Use GNOME's OWN left/center/right allocations. Any applets,
        // indicators and menus stay in their original shell containers.
        const actors = REGIONS.map(([role, key]) => ({
            role, actor: panel[key],
        }));
        if (actors.some(({actor}) => !actor)) {
            this._publishLayoutStatus(
                'Error: native panel indicator boxes unavailable'
            );
            return false;
        }

        let root = nativePanelBox;
        while (root && root.get_parent?.() !== host)
            root = root.get_parent?.() ?? null;
        if (!root) {
            this._publishLayoutStatus(
                'Error: native panel is outside GNOME uiGroup'
            );
            return false;
        }

        this._host = host;
        this._panelRoot = root;
        let initialFailure = null;
        try {
            // Prefer the saved layout on the very first compositor frame.
            // If GNOME has not finished creating optional native controls,
            // keep the manager/listeners alive in a safe split fallback.
            // Otherwise the requested Bottom mode becomes permanently
            // unreachable until VLIQ is reinstalled.
            const requested = this._preferredLayout();
            try {
                this._buildLayout(requested);
            } catch (error) {
                console.warn('[VLIQ][TopBar] startup ' +
                    requested + ' failed: ' + error);
                this._disposeLayout();
                if (requested === 'split')
                    throw error;
                initialFailure = 'Error activating ' + requested +
                    ' at startup: ' + String(error);
                this._failedDesired = requested;
                this._failedAttempts = 1;
                this._retryNotBeforeUs =
                    GLib.get_monotonic_time() + LAYOUT_RETRY_COOLDOWN_US;
                this._buildLayout('split');
            }

            this._enabled = true;
            // The native panel moves during Overview/fullscreen and can
            // receive late system indicators. Derive glass rectangles from
            // transformed native allocations, not saved/stale coordinates.
            if (!this._forceCssOnly) {
                this._stageSignal = global.stage.connect(
                    'before-update', () => this._syncStageFrame()
                );
            }
            // A selected layout can be committed by a separate
            // Preferences process even while Shell is idle and does not
            // paint a frame. Reconcile once/second to recover missed
            // GSettings notifications without polling on every frame.
            this._layoutWatchId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                LAYOUT_RECONCILE_SECONDS,
                () => {
                    if (!this._enabled)
                        return GLib.SOURCE_REMOVE;
                    this._reconcileLayout();
                    return GLib.SOURCE_CONTINUE;
                }
            );
            for (const [actor, signal] of [
                [layout, 'monitors-changed'],
                [layout.panelBox, 'notify::visible'],
                [panel, 'notify::mapped'],
                [this._display, 'in-fullscreen-changed'],
                ...actors.flatMap(({actor}) => [
                    [actor, 'child-added'],
                    [actor, 'child-removed'],
                ]),
                [this._layoutSettings, 'changed::top-header-layout'],
            ]) {
                try {
                    if (!actor?.connect)
                        continue;
                    const id = actor.connect(signal, () => {
                        if (signal === 'changed::top-header-layout') {
                            // Explicit user selection overrides any
                            // cooldown from a previous failed attempt.
                            this._failedDesired = null;
                            this._failedAttempts = 0;
                            this._retryNotBeforeUs = 0;
                            this._reconcileLayout();
                        } else {
                            this.sync();
                        }
                    });
                    if (id)
                        this._signals.push({actor, id});
                } catch {
                    // Optional GNOME signals vary slightly across releases.
                }
            }
            this.sync();
            this._publishLayoutStatus(
                initialFailure ?? this._activeStatus()
            );
            console.log(
                '[VLIQ][TopBar] ' + this._layoutMode +
                ' native optical header attached'
            );
            return true;
        } catch (error) {
            console.warn('[VLIQ][TopBar] header fallback: ' + error +
                '\\n' + (error?.stack ?? ''));
            this.cleanup();
            // Never rewrite the selected layout on GNOME initialization
            // failure. The user must be able to inspect and retry it.
            this._publishLayoutStatus(
                'Error: desktop layout initialization failed: ' +
                String(error)
            );
            return false;
        }
    }

    _preferredLayout() {
        try {
            const selected = this._layoutSettings?.get_string?.(
                'top-header-layout'
            );
            return selected === 'full' || selected === 'bottom'
                ? selected : 'split';
        } catch {
            return 'split';
        }
    }

    _disposeLayout() {
        for (const region of this._regions) {
            try { region.surface.destroy(); } catch {}
            if (region.role === 'full')
                continue;
            for (const name of [
                'vliq-panel-island-ready',
                'vliq-panel-island-css-fallback',
                'vliq-panel-island-inactive',
                'vliq-panel-island-' + region.role,
                'vliq-panel-island',
            ]) {
                try { region.actor.remove_style_class_name(name); } catch {}
            }
        }
        this._regions = [];
        // Restore native GNOME chrome before creating the next header.
        this._bottomTaskbar?.cleanup?.();
        this._bottomTaskbar = null;
        this._panel?.remove_style_class_name?.('vliq-bottom-taskbar');
        this._panel?.remove_style_class_name?.('vliq-system-dark-taskbar');
        this._panel?.remove_style_class_name?.('vliq-bottom-taskbar-glass-attached');
        this._panel?.remove_style_class_name?.('vliq-bottom-taskbar-css-fallback');
        this._panel?.remove_style_class_name?.('vliq-three-islands');
        this._panel?.remove_style_class_name?.('vliq-full-header');
        this._panel?.remove_style_class_name?.('vliq-top-header-ready');
        this._hasReportedReady = false;
        this._lastStageSyncUs = 0;
    }

    _syncSystemDarkTaskbarStyle() {
        const active = this._layoutMode === 'bottom' &&
            this._readAppearance?.()?.systemDarkTaskbar === true;
        if (active)
            this._panel?.add_style_class_name?.('vliq-system-dark-taskbar');
        else
            this._panel?.remove_style_class_name?.('vliq-system-dark-taskbar');
    }

    _buildLayout(mode) {
        this._layoutMode = mode;
        const panel = this._panel;
        panel.add_style_class_name('vliq-liquid-top-panel');
        this._syncSystemDarkTaskbarStyle();
        if (mode === 'full' || mode === 'bottom') {
            if (mode === 'bottom') {
                this._bottomTaskbar = this._bottomTaskbarFactory({
                    panel: this._panel, layout: this._layout,
                    display: this._display,
                    getDockEntries: this._getDockEntries,
                    onLauncherClick: this._onLauncherClick,
                });
                if (!this._bottomTaskbar?.setup?.())
                    throw new Error('native bottom taskbar unavailable');
                panel.add_style_class_name('vliq-bottom-taskbar');
            }
            // One edge-to-edge bounded panel. It is placed under the native
            // panelBox and spans only its allocated 36-ish-pixel height.
            const surface = new PanelGlassSurface(
                this._vendor, this._settings, this._readAppearance,
                {cornerRadius: 0, borderless: mode === 'bottom',
                    systemDarkTaskbar: mode === 'bottom',
                    cssOnly: this._forceCssOnly}
            );
            if (!surface.attach(this._host, this._panelRoot)) {
                surface.destroy();
                if (mode !== 'bottom')
                    throw new Error('full-header glass attach failed');

                // The bottom taskbar's native GNOME controls are usable
                // without a functioning offscreen glass FBO. Keep the mode
                // and CSS fallback rather than silently returning to split
                // after a shader/GPU initialization failure.
                console.warn(
                    '[VLIQ][Taskbar] panel material unavailable; ' +
                    'keeping functional native bottom taskbar with CSS fallback'
                );
                panel.add_style_class_name('vliq-full-header');
                return;
            }
            panel.add_style_class_name('vliq-full-header');
            if (mode === 'bottom' && !this._forceCssOnly) {
                // One paint owner from the moment the GPU material is
                // attached. Native CSS must not draw a second 13% veil
                // underneath the same liquid shader during first paint.
                panel.add_style_class_name(
                    'vliq-bottom-taskbar-glass-attached');
            }
            if (mode === 'bottom' && this._forceCssOnly)
                panel.add_style_class_name('vliq-bottom-taskbar-css-fallback');
            this._regions.push({
                role: 'full', actor: panel, surface, cssOnly: this._forceCssOnly,
                ready: false,
                inactive: false, lastBounds: null, notReadyFrames: 0,
            });
        } else {
            panel.add_style_class_name('vliq-three-islands');
            for (const [role, key] of REGIONS) {
                const actor = panel[key];
                // Three bounded island materials follow the selected global
                // Appearance mode. Liquid and Frosted use the same shader;
                // Milky hides the GPU material and paints the native card.
                // A shader failure must never break GNOME's panel controls.
                let surface = new PanelGlassSurface(
                    this._vendor, this._settings, this._readAppearance,
                    {cornerRadius: RADIUS, cssOnly: this._forceCssOnly}
                );
                let cssFallback = this._forceCssOnly;
                if (!surface.attach(this._host, this._panelRoot)) {
                    surface.destroy();
                    console.warn('[VLIQ][TopBar] ' + role +
                        ' glass unavailable; retaining native card fallback');
                    surface = new PanelGlassSurface(
                        this._vendor, this._settings, this._readAppearance,
                        {cornerRadius: RADIUS, cssOnly: true}
                    );
                    if (!surface.attach(this._host, this._panelRoot))
                        throw new Error('island fallback failed: ' + role);
                    cssFallback = true;
                }
                if (cssFallback)
                    actor.add_style_class_name('vliq-panel-island-css-fallback');
                actor.add_style_class_name('vliq-panel-island');
                actor.add_style_class_name('vliq-panel-island-' + role);
                this._regions.push({
                    role, actor, surface, cssOnly: cssFallback,
                    ready: false, inactive: false, lastBounds: null,
                });
            }
        }
    }

    _reconcileLayout() {
        if (!this._enabled || this._switchingLayout)
            return;
        const wanted = this._preferredLayout();
        if (wanted !== this._layoutMode) {
            // A failed renderer must NOT rewrite the user's choice to
            // "split". Keep the selected mode and expose the failure.
            if (this._failedDesired !== wanted) {
                this._failedDesired = null;
                this._failedAttempts = 0;
                this._retryNotBeforeUs = 0;
            }
            const now = GLib.get_monotonic_time();
            if (this._failedAttempts >= MAX_LAYOUT_RETRIES ||
                now < this._retryNotBeforeUs)
                return;
            this._switchLayout();
            return;
        }
        // GNOME can move the panel back to its native top position
        // during monitor/work-area relayout. Repair a stale placement, but
        // ALWAYS reconcile the published status: an early "unavailable"
        // must clear after the first successful native allocation.
        if (wanted === 'bottom') {
            if (!this.isBottomTaskbarActive()) {
                try { this._bottomTaskbar?._placePanel?.(); } catch {}
            }
            const message = this.isBottomTaskbarActive()
                ? this._activeStatus()
                : 'Bottom Taskbar selected; native panel not at bottom';
            this._publishLayoutStatus(message);
        }
    }

    _switchLayout() {
        if (!this._enabled || this._switchingLayout)
            return;
        const next = this._preferredLayout();
        if (next === this._layoutMode)
            return;
        this._switchingLayout = true;
        let failureMessage = null;
        try {
            // The previous material and its GNOME actor adaptations must
            // be cleaned up before building another rendering mode.
            this._disposeLayout();
            try {
                this._buildLayout(next);
                this._failedDesired = null;
                this._failedAttempts = 0;
                this._retryNotBeforeUs = 0;
            } catch (error) {
                failureMessage = 'Error activating ' + next +
                    ': ' + String(error);
                console.warn(
                    '[VLIQ][TopBar] ' + next + ' mode unavailable: ' +
                    error + '\\n' + (error?.stack ?? '')
                );
                this._disposeLayout();
                try {
                    this._buildLayout('split');
                } catch (fallbackError) {
                    failureMessage += '; split fallback failed: ' +
                        String(fallbackError);
                    console.warn(
                        '[VLIQ][TopBar] split fallback failed: ' +
                        fallbackError
                    );
                    this._disposeLayout();
                }
                this._failedDesired = next;
                this._failedAttempts++;
                this._retryNotBeforeUs =
                    GLib.get_monotonic_time() + LAYOUT_RETRY_COOLDOWN_US;
                // Do not set_string('top-header-layout','split') here.
                // That used to discard a user-selected Bottom Taskbar
                // and re-enter the GSettings callback recursively.
            }
            this.sync();
            this._publishLayoutStatus(
                failureMessage ?? this._activeStatus()
            );
            try { this._onLayoutChanged?.(this._layoutMode); }
            catch (error) {
                console.warn(
                    '[VLIQ][TopBar] Dock mode sync failed: ' + error
                );
            }
        } finally {
            this._switchingLayout = false;
        }
    }

    // All three native boxes share ONE compositor frame callback. Stable
    // panels need geometry sampling only at the same 24 FPS budget already
    // used by PanelGlassSurface's window-clone capture. GNOME signals and
    // fullscreen transitions still use sync() immediately, bypassing this
    // budget. No GLib timer, extra stage actor, or idle repaint loop.
    _syncStageFrame() {
        if (!this._enabled)
            return;
        const nowUs = GLib.get_monotonic_time();
        if (!frameDue(nowUs, this._lastStageSyncUs, STAGE_SYNC_FPS))
            return;
        this.sync();
    }

    _canShow() {
        if (!this._enabled)
            return false;
        if (this._visibilityGate && !this._visibilityGate())
            return false;
        if (primaryPanelIsFullscreen(this._layout, this._display))
            return false;
        if (this._layout?.panelBox?.visible === false ||
            this._panel?.visible === false ||
            this._panel?.mapped === false)
            return false;
        return true;
    }

    _hideRegion(region) {
        region.surface.hide();
        // A hidden actor must force the material opacity back on even if
        // its old rectangle has not changed. Otherwise de-duplication
        // could leave a newly visible island permanently transparent.
        region.lastBounds = null;
        // Material opacity alone is insufficient: the native box still
        // paints its 13% CSS fallback even if every indicator is hidden.
        // Mark the box inactive until it has valid visible content again.
        if (!region.inactive) {
            region.actor.add_style_class_name('vliq-panel-island-inactive');
            region.inactive = true;
        }
        if (region.ready) {
            region.actor.remove_style_class_name('vliq-panel-island-ready');
            region.ready = false;
        }
    }

    sync() {
        if (!this._enabled || this._syncing)
            return;
        this._syncing = true;
        try {
            this._lastStageSyncUs = GLib.get_monotonic_time();
            this._syncNow();
        } finally {
            this._syncing = false;
        }
    }

    _syncNow() {
        if (this._layoutMode === 'full' ||
            this._layoutMode === 'bottom') {
            this._syncFullHeader();
            return;
        }
        if (!this._canShow()) {
            for (const region of this._regions)
                this._hideRegion(region);
            return;
        }

        const monitor = this._layout?.primaryMonitor;
        const host = this._host;
        if (!monitor || !host)
            return;

        const [hostX, hostY] =
            host.get_transformed_position?.() ?? [0, 0];
        const leftLimit = monitor.x + SIDE_MARGIN;
        const rightLimit = monitor.x + monitor.width - SIDE_MARGIN;
        // Stay inside the native panel's real allocation. A large or
        // late-loading indicator may report bounds extending into desktop;
        // its glass must NEVER become a tall semi-fullscreen overlay.
        const [, panelY] = this._layout?.panelBox
            ?.get_transformed_position?.() ?? [NaN, NaN];
        const [, panelHeight] = this._layout?.panelBox
            ?.get_transformed_size?.() ?? [0, 0];
        const nativePanelY = Number.isFinite(panelY)
            ? panelY : monitor.y;
        const topLimit = Math.max(monitor.y, nativePanelY);
        const bottomLimit = Math.min(
            monitor.y + monitor.height,
            nativePanelY + (
                Number.isFinite(panelHeight) && panelHeight > 1
                    ? panelHeight : (this._panel.height ?? 36)
            )
        );

        const proposals = [];
        for (const region of this._regions) {
            const actor = region.actor;
            const children = actor?.get_children?.() ?? [];
            // GNOME sometimes keeps an empty/hidden system-indicator group
            // mapped at the previous allocation. It must not retain an
            // orphaned glass island.
            const visibleChildren = children.filter(child =>
                child && child.visible !== false && child.mapped !== false
            );
            if (!actor || actor.visible === false || actor.mapped === false ||
                visibleChildren.length === 0) {
                this._hideRegion(region);
                continue;
            }

            // Use the native group's vertical allocation so all three
            // islands remain the same consistent panel height. Only tighten
            // the HORIZONTAL bounds to visible children when GNOME allocates
            // an oversized group. Avoid per-frame temporary rect/map arrays.
            const [groupX, groupY] =
                actor.get_transformed_position?.() ?? [NaN, NaN];
            const [groupW, groupH] =
                actor.get_transformed_size?.() ?? [NaN, NaN];
            let childLeft = Infinity;
            let childRight = -Infinity;
            for (const child of visibleChildren) {
                const [cx] =
                    child.get_transformed_position?.() ?? [NaN, NaN];
                const [cw] =
                    child.get_transformed_size?.() ?? [NaN, NaN];
                if (Number.isFinite(cx) && Number.isFinite(cw) && cw > 0) {
                    childLeft = Math.min(childLeft, cx);
                    childRight = Math.max(childRight, cx + cw);
                }
            }
            // Bounds are always clipped to the actual GNOME group so a
            // rogue offscreen indicator cannot expand glass into desktop.
            let x = groupX;
            let y = groupY;
            let width = groupW;
            let height = groupH;
            if (Number.isFinite(childLeft) && Number.isFinite(childRight) &&
                Number.isFinite(groupX) && Number.isFinite(groupW) &&
                groupW > 0) {
                const left = clamp(childLeft, groupX, groupX + groupW);
                const right = clamp(childRight, left, groupX + groupW);
                if (right - left >= MIN_WIDTH) {
                    x = left;
                    width = right - left;
                }
            }
            if (![x, y, width, height].every(Number.isFinite) ||
                width < MIN_WIDTH || height < MIN_HEIGHT ||
                x >= rightLimit || x + width <= leftLimit) {
                this._hideRegion(region);
                continue;
            }

            const left = clamp(x - ISLAND_PAD_X, leftLimit, rightLimit);
            const right = clamp(x + width + ISLAND_PAD_X, left, rightLimit);
            const top = clamp(y + INSET_Y, topLimit, bottomLimit);
            const bottom = clamp(y + height - INSET_Y, top, bottomLimit);
            if (right - left < MIN_WIDTH || bottom - top < MIN_HEIGHT) {
                this._hideRegion(region);
                continue;
            }
            proposals.push({
                region, left, right, top, bottom,
                opacity: actor.get_paint_opacity?.() ?? actor.opacity ?? 255,
            });
        }

        // On narrow monitors or with extra indicator extensions, GNOME's
        // left/center/right allocations can come close enough that 9px glass
        // padding makes surfaces visually merge. Leave an 8px true wallpaper
        // gap WITHOUT reparenting, clipping or moving native input actors.
        proposals.sort((a, b) => a.left - b.left);
        for (let i = 1; i < proposals.length; i++) {
            const previous = proposals[i - 1];
            const current = proposals[i];
            if (previous.right + ISLAND_GAP <= current.left)
                continue;
            const boundary = (previous.right + current.left) / 2;
            previous.right = Math.min(previous.right,
                boundary - ISLAND_GAP / 2);
            current.left = Math.max(current.left,
                boundary + ISLAND_GAP / 2);
        }
        for (const proposal of proposals) {
            const {region, left, right, top, bottom, opacity} = proposal;
            const width = right - left;
            const height = bottom - top;
            if (width < MIN_WIDTH || height < MIN_HEIGHT) {
                this._hideRegion(region);
                continue;
            }
            if (region.inactive) {
                region.actor.remove_style_class_name(
                    'vliq-panel-island-inactive'
                );
                region.inactive = false;
            }
            const bx = left - hostX;
            const by = top - hostY;
            const prior = region.lastBounds;
            if (!prior ||
                prior[0] !== bx || prior[1] !== by ||
                prior[2] !== width || prior[3] !== height ||
                prior[4] !== opacity) {
                // Only real geometry/opacity changes can write GObject
                // position, size or opacity. Stable regions still update
                // live wallpaper/window clones at PanelGlassSurface's
                // own bounded scene FPS via syncFrame().
                region.surface.setBounds(bx, by, width, height, opacity);
                region.lastBounds = [bx, by, width, height, opacity];
            } else {
                region.surface.syncFrame?.();
            }
            const ready = region.cssOnly ? false : region.surface.ready;
            if (ready !== region.ready) {
                region.ready = ready;
                if (ready)
                    region.actor.add_style_class_name('vliq-panel-island-ready');
                else
                    region.actor.remove_style_class_name('vliq-panel-island-ready');
            }
        }

        if (!this._hasReportedReady &&
            this._regions.length === 3 &&
            this._regions.every(({ready}) => ready)) {
            this._hasReportedReady = true;
            console.log('[VLIQ][TopBar] left/center/right optical glass READY');
        }
    }

    _syncFullHeader() {
        const region = this._regions[0];
        if (!region || region.role !== 'full')
            return;
        const panel = this._panel;
        const glass = region.surface;
        const show = this._canShow();
        const box = this._layout?.panelBox;
        const monitor = this._layout?.primaryMonitor;
        const hide = () => {
            glass.hide();
            region.lastBounds = null;
            if (region.ready) {
                panel.remove_style_class_name('vliq-top-header-ready');
                region.ready = false;
            }
        };
        if (!show || !box || !monitor) {
            hide();
            return;
        }
        // Clip to the native panel allocation and primary monitor, never
        // cover the desktop. The full strip has square corners and follows
        // the original panel's paint opacity.
        const [x, y] = box.get_transformed_position?.() ?? [NaN, NaN];
        const [width, height] = box.get_transformed_size?.() ?? [NaN, NaN];
        const [hostX, hostY] =
            this._host.get_transformed_position?.() ?? [0, 0];
        if (![x, y, width, height, hostX, hostY].every(Number.isFinite)) {
            hide();
            return;
        }
        const left = Math.max(x, monitor.x);
        const top = Math.max(y, monitor.y);
        const right = Math.min(x + width, monitor.x + monitor.width);
        const bottom = Math.min(y + height, monitor.y + monitor.height);
        const w = right - left;
        const h = bottom - top;
        if (w <= 1 || h < MIN_HEIGHT || h > 240) {
            hide();
            return;
        }
        const opacity = panel.get_paint_opacity?.() ?? panel.opacity ?? 255;
        const bounds = [left - hostX, top - hostY, w, h, opacity];
        const previous = region.lastBounds;
        if (!previous || bounds.some((v, i) => v !== previous[i])) {
            glass.setBounds(...bounds);
            region.lastBounds = bounds;
        } else {
            glass.syncFrame?.();
        }
        const materialReady = Boolean(glass.ready);
        let ready = materialReady;
        if (this._layoutMode === 'bottom') {
            // GNOME may transiently unmap/reallocate the panel during a
            // window activation. Do not flash the native CSS backdrop or
            // reshow Ubuntu Dock after a one-frame false readiness sample.
            region.notReadyFrames = materialReady ? 0 :
                (region.notReadyFrames ?? 0) + 1;
            const failureStable = region.notReadyFrames >= 12;
            ready = materialReady || (region.ready && !failureStable);
            // Never turn CSS fallback back on while an attached GPU actor
            // can still contain a cached frame. `ready=false` alone does
            // not guarantee that the old Cogl texture stopped painting.
            // CSS fallback is used ONLY when material.attach() failed and
            // there is no concurrent GPU material at all.
            // Paint ownership remains attached until _disposeLayout().
        }
        // A CSS-only header is itself the visible material. Marking it
        // shader-ready would suppress its fallback background entirely.
        if (region.cssOnly)
            ready = false;
        if (ready !== region.ready) {
            region.ready = ready;
            if (ready)
                panel.add_style_class_name('vliq-top-header-ready');
            else
                panel.remove_style_class_name('vliq-top-header-ready');
        }
    }

    updateAppearance() {
        if (!this._enabled)
            return;
        this._syncSystemDarkTaskbarStyle();
        for (const {surface} of this._regions)
            surface.updateAppearance();
        this.sync();
    }

    cleanup() {
        this._enabled = false;
        if (this._layoutWatchId) {
            try { GLib.source_remove(this._layoutWatchId); } catch {}
            this._layoutWatchId = 0;
        }
        if (this._stageSignal) {
            try { global.stage.disconnect(this._stageSignal); } catch {}
            this._stageSignal = 0;
        }
        for (const {actor, id} of this._signals) {
            try { actor.disconnect(id); } catch {}
        }
        this._signals = [];
        this._disposeLayout();
        this._panel?.remove_style_class_name?.('vliq-liquid-top-panel');
        this._visibilityGate = null;
        this._host = null;
        this._panelRoot = null;
        this._hasReportedReady = false;
        this._lastStageSyncUs = 0;
        this._syncing = false;
        this._switchingLayout = false;
        this._failedDesired = null;
        this._failedAttempts = 0;
        this._retryNotBeforeUs = 0;
        this._publishLayoutStatus('Inactive — GNOME Shell runtime stopped');
    }
}
