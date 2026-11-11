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
        onLauncherClick = null, panel = Main.panel,
        layout = Main.layoutManager, display = global.display}) {
        this._vendor = vendor;
        this._settings = settings;
        // VLIQ's canonical schema controls the layout. The renderer's
        // separate settings still control LiquidEffect optics.
        this._layoutSettings = layoutSettings;
        this._layoutMode = 'split';
        this._bottomTaskbarFactory = bottomTaskbarFactory ??
            (options => new BottomTaskbar(options));
        this._getDockEntries = getDockEntries;
        this._onLauncherClick = onLauncherClick;
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
    }

    setLauncherCallback(callback) {
        this._onLauncherClick = typeof callback === 'function'
            ? callback : null;
        this._bottomTaskbar?.setLauncherCallback?.(callback);
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
        if (!panel || !host || !nativePanelBox)
            return false;

        // Use GNOME's OWN left/center/right allocations. Any applets,
        // indicators and menus stay in their original shell containers.
        const actors = REGIONS.map(([role, key]) => ({
            role, actor: panel[key],
        }));
        if (actors.some(({actor}) => !actor))
            return false;

        let root = nativePanelBox;
        while (root && root.get_parent?.() !== host)
            root = root.get_parent?.() ?? null;
        if (!root)
            return false;

        this._host = host;
        this._panelRoot = root;
        try {
            // Setup follows the user's saved layout before the first
            // compositor frame, avoiding an initial three-pill flash.
            this._buildLayout(this._preferredLayout());

            this._enabled = true;
            // The native panel moves during Overview/fullscreen and can
            // receive late system indicators. Derive glass rectangles from
            // transformed native allocations, not saved/stale coordinates.
            this._stageSignal = global.stage.connect(
                'before-update', () => this._syncStageFrame()
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
                        if (signal === 'changed::top-header-layout')
                            this._switchLayout();
                        else
                            this.sync();
                    });
                    if (id)
                        this._signals.push({actor, id});
                } catch {
                    // Optional GNOME signals vary slightly across releases.
                }
            }
            this.sync();
            console.log(
                '[VLIQ][TopBar] ' + this._layoutMode +
                ' native optical header attached'
            );
            return true;
        } catch (error) {
            console.warn('[VLIQ][TopBar] header fallback: ' + error);
            this.cleanup();
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
        this._panel?.remove_style_class_name?.('vliq-three-islands');
        this._panel?.remove_style_class_name?.('vliq-full-header');
        this._panel?.remove_style_class_name?.('vliq-top-header-ready');
        this._hasReportedReady = false;
        this._lastStageSyncUs = 0;
    }

    _buildLayout(mode) {
        this._layoutMode = mode;
        const panel = this._panel;
        panel.add_style_class_name('vliq-liquid-top-panel');
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
                {cornerRadius: 0}
            );
            if (!surface.attach(this._host, this._panelRoot)) {
                surface.destroy();
                throw new Error('full-header glass attach failed');
            }
            panel.add_style_class_name('vliq-full-header');
            this._regions.push({
                role: 'full', actor: panel, surface, ready: false,
                inactive: false, lastBounds: null,
            });
        } else {
            panel.add_style_class_name('vliq-three-islands');
            for (const [role, key] of REGIONS) {
                const actor = panel[key];
                const surface = new PanelGlassSurface(
                    this._vendor, this._settings, this._readAppearance,
                    {cornerRadius: RADIUS}
                );
                if (!surface.attach(this._host, this._panelRoot)) {
                    surface.destroy();
                    throw new Error('island glass attach failed: ' + role);
                }
                actor.add_style_class_name('vliq-panel-island');
                actor.add_style_class_name('vliq-panel-island-' + role);
                this._regions.push({
                    role, actor, surface, ready: false,
                    inactive: false, lastBounds: null,
                });
            }
        }
    }

    _switchLayout() {
        if (!this._enabled)
            return;
        const next = this._preferredLayout();
        if (next === this._layoutMode)
            return;
        // Dispose the old bounded material before creating the replacement;
        // never keep a hidden full-width shader beneath the three islands.
        this._disposeLayout();
        try {
            this._buildLayout(next);
        } catch (error) {
            console.warn(
                '[VLIQ][TopBar] ' + next + ' mode unavailable: ' + error
            );
            this._disposeLayout();
            // The accepted three-island layout is the safe rendering fallback.
            try { this._buildLayout('split'); } catch (fallbackError) {
                console.warn(
                    '[VLIQ][TopBar] split fallback failed: ' + fallbackError
                );
                this._disposeLayout();
            }
        }
        this.sync();
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
            const ready = region.surface.ready;
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
        const ready = Boolean(glass.ready);
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
        for (const {surface} of this._regions)
            surface.updateAppearance();
        this.sync();
    }

    cleanup() {
        this._enabled = false;
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
    }
}
