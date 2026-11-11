// VLIQ GNOME 50 bottom taskbar. Reuse the native panel's input and menu
// actors; only move its chrome box and add a lightweight app-launcher strip.
// Everything is reversible on layout changes/hot reload. No extra compositor
// effect is created here: TopBarIslands owns the single full-width glass.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MAX_TASKBAR_APPS = 11;
const APP_ICON_SIZE = 24;

function safeDisconnect(object, id) {
    if (!id)
        return;
    try { object?.disconnect?.(id); } catch {}
}

export class BottomTaskbar {
    constructor({panel = Main.panel, layout = Main.layoutManager,
        display = global.display, appSystem = Shell.AppSystem.get_default(),
        shellSettings = null, getDockEntries = null,
        onLauncherClick = null}) {
        this._panel = panel;
        this._layout = layout;
        this._display = display;
        this._appSystem = appSystem;
        this._shellSettings = shellSettings;
        this._ownsShellSettings = !shellSettings;
        this._getDockEntries = getDockEntries;
        this._onLauncherClick = onLauncherClick;
        this._enabled = false;
        this._start = null;
        this._appStrip = null;
        this._centerGroup = null;
        this._activity = null;
        this._date = null;
        this._dateParent = null;
        this._dateIndex = -1;
        this._signals = [];
        this._stageId = 0;
        this._originalPanelPosition = null;
        this._originalCenterTranslation = 0;
        this._placingPanel = false;
        this._dockPaint = new Map();
        this._menuSides = new Map();
        this._appKey = '';
    }

    isActive() {
        if (!this._enabled)
            return false;
        const box = this._layout?.panelBox;
        const monitor = this._layout?.primaryMonitor;
        if (!box || !monitor)
            return false;
        try {
            const [, y] = box.get_position?.() ?? [box.x, box.y];
            const height = box.height > 1
                ? box.height : (this._panel?.height || 36);
            const expectedY = monitor.y + monitor.height - height;
            return Number.isFinite(y) &&
                Math.abs(y - expectedY) < 3;
        } catch {
            return false;
        }
    }

    setLauncherCallback(callback) {
        this._onLauncherClick = typeof callback === 'function'
            ? callback : null;
    }

    setup() {
        if (this._enabled)
            return true;
        const panel = this._panel;
        const box = this._layout?.panelBox;
        if (!box || !panel?._leftBox || !panel?._centerBox ||
            !panel?._rightBox)
            return false;
        try {
            if (!this._shellSettings) {
                try {
                    this._shellSettings = new Gio.Settings({
                        schema_id: 'org.gnome.shell',
                    });
                } catch (error) {
                    // Pinned-app settings are optional. Keep moving the
                    // native panel even on a stripped-down GNOME build.
                    console.warn(
                        '[VLIQ][Taskbar] favorites schema unavailable: ' +
                        error
                    );
                }
            }
            this._originalPanelPosition = box.get_position?.() ?? [
                box.x ?? 0, box.y ?? 0,
            ];
            this._originalCenterTranslation =
                panel._centerBox.translation_x ?? 0;
            this._enabled = true;
            // Native panel movement is the essential feature. Optional
            // launcher/app icon rendering must never abort bottom placement.
            this._placePanel();
            try {
                // One center allocation for Start + apps. GNOME centers
                // panelCenter as a UNIT, unlike a far-left Start icon.
                this._centerGroup = new St.BoxLayout({
                    style_class: 'vliq-taskbar-center-group',
                    vertical: false,
                    reactive: false,
                    x_expand: false,
                    y_expand: false,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                panel._centerBox.insert_child_at_index(
                    this._centerGroup, 0);
            } catch (error) {
                console.warn('[VLIQ][Taskbar] center group fallback: ' +
                    error);
                this._centerGroup = null;
            }
            try {
                const icon = new St.Icon({
                    icon_name: 'start-here-symbolic',
                    icon_size: APP_ICON_SIZE,
                    style_class: 'vliq-taskbar-launcher-icon',
                });
                this._start = new St.Button({
                    style_class: 'vliq-taskbar-launcher',
                    accessible_name: 'VLIQ Applications',
                    reactive: true,
                    can_focus: true,
                    track_hover: true,
                    child: icon,
                });
                this._start.connect('clicked', () => {
                    if (this._onLauncherClick)
                        this._onLauncherClick();
                    else
                        Main.overview?.showApps?.();
                });
                (this._centerGroup ?? panel._centerBox)
                    .insert_child_at_index(this._start, 0);
                // Hide native Activities only after a working replacement
                // Start button has been attached to the real panel.
                this._activity =
                    panel.statusArea?.activities?.container ?? null;
                this._activityWasVisible =
                    this._activity?.visible !== false;
                this._activity?.hide?.();
            } catch (error) {
                console.warn('[VLIQ][Taskbar] launcher unavailable: ' +
                    error);
                try { this._start?.destroy?.(); } catch {}
                this._start = null;
            }

            // Keep original menu actor identity and popup ownership.
            try {
                const date = panel.statusArea?.dateMenu?.container ?? null;
                if (date?.get_parent?.() === panel._centerBox) {
                    this._date = date;
                    this._dateParent = panel._centerBox;
                    this._dateIndex = Math.max(0,
                        panel._centerBox.get_children().indexOf(date));
                    panel._centerBox.remove_child(date);
                    panel._rightBox.add_child(date);
                }
            } catch (error) {
                console.warn('[VLIQ][Taskbar] native Date Menu stays in ' +
                    'center: ' + error);
            }

            try {
                this._appStrip = new St.BoxLayout({
                    style_class: 'vliq-taskbar-apps',
                    reactive: false,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                (this._centerGroup ?? panel._centerBox)
                    .insert_child_at_index(
                        this._appStrip, this._start ? 1 : 0);
                this._refreshApps();
            } catch (error) {
                console.warn('[VLIQ][Taskbar] app strip unavailable: ' +
                    error);
                try { this._appStrip?.destroy?.(); } catch {}
                this._appStrip = null;
            }

            for (const [actor, signal, callback] of [
                [this._layout, 'monitors-changed', () => {
                    this._placePanel();
                    this._syncCenterAlignment();
                    this._refreshApps();
                }],
                // LayoutManager._updateBoxes() can return panelBox to its
                // built-in top position during monitor/session relayout.
                // Correct after native allocation (not just every 24fps)
                // and avoid one-frame flashing at the top edge.
                [box, 'notify::allocation', () => this._placePanel()],
                [this._display, 'workareas-changed',
                    () => this._syncCenterAlignment()],
                [this._appSystem, 'installed-changed', () => this._refreshApps()],
                [this._appSystem, 'app-state-changed', () => this._refreshApps()],
                [this._shellSettings, 'changed::favorite-apps',
                    () => this._refreshApps()],
            ]) {
                try {
                    if (actor?.connect) {
                        const id = actor.connect(signal, callback);
                        if (id)
                            this._signals.push({actor, id});
                    }
                } catch {}
            }

            // The stage callback is cheap: no GObject writes if native
            // monitor/panel/Dock geometry and opacity have not changed.
            try {
                this._stageId = global.stage.connect('before-update', () => {
                    this._placePanel();
                    this._hideOriginalDock();
                    this._syncMenuArrows();
                });
            } catch (error) {
                console.warn('[VLIQ][Taskbar] stage follow unavailable: ' +
                    error);
            }
            this._placePanel();
            this._syncCenterAlignment();
            this._syncMenuArrows();
            this._hideOriginalDock();
            console.log('[VLIQ][Taskbar] BOTTOM_ACTIVE at ' +
                (this._layout.primaryMonitor?.height ?? '?') + 'px monitor');
            return true;
        } catch (error) {
            console.warn('[VLIQ][Taskbar] native setup failed: ' + error);
            this.cleanup();
            return false;
        }
    }

    _placePanel() {
        if (!this._enabled || this._placingPanel)
            return;
        this._placingPanel = true;
        try {
            this._placePanelNow();
        } finally {
            this._placingPanel = false;
        }
    }

    _placePanelNow() {
        const box = this._layout?.panelBox;
        const monitor = this._layout?.primaryMonitor;
        if (!box || !monitor)
            return;
        // GNOME may rebuild the center box after a session-mode change.
        // Restore only the original Date Menu container if it moved back.
        if (this._date?.get_parent?.() === this._dateParent) {
            this._dateParent.remove_child(this._date);
            this._panel._rightBox.add_child(this._date);
        }
        const h = Number(box.height) > 1 ? box.height :
            (Number(this._panel?.height) > 1 ? this._panel.height : 36);
        const x = monitor.x;
        const y = monitor.y + monitor.height - h;
        if (![x, y, h].every(Number.isFinite))
            return;
        const [currentX, currentY] = box.get_position?.() ?? [box.x, box.y];
        if (Math.abs(currentX - x) > 0.1 ||
            Math.abs(currentY - y) > 0.1) {
            try {
                box.set_position(x, y);
            } catch (error) {
                // A compositor migration may temporarily forbid GObject
                // geometry writes; log once and retry at the next frame.
                if (!this._panelMoveWarning) {
                    this._panelMoveWarning = true;
                    console.warn('[VLIQ][Taskbar] panel position update: ' +
                        error);
                }
            }
        }
    }

    _syncCenterAlignment() {
        if (!this._enabled)
            return;
        const box = this._panel?._centerBox;
        const monitor = this._layout?.primaryMonitor;
        if (!box || !monitor)
            return;
        let correction = 0;
        try {
            // GNOME Shell 50 panel.vfunc_allocate centers using
            // sideWidth=(panelWidth-centerWidth+centerOffset)/2 where
            // centerOffset=2*(workarea.x-monitor.x)+workarea.width-
            // monitor.width. When Ubuntu Dock reserves left-hand work
            // area, that moves Start/apps away from the actual monitor
            // midpoint. Cancel only THAT known native offset.
            const area = this._layout?.getWorkAreaForMonitor?.(
                monitor.index);
            if (area && Number.isFinite(area.x) &&
                Number.isFinite(area.width) &&
                area.width > 0) {
                const centerOffset =
                    2 * (area.x - monitor.x) +
                    area.width - monitor.width;
                correction = -centerOffset / 2;
            }
        } catch {}
        if (!Number.isFinite(correction))
            return;
        const x = this._originalCenterTranslation + correction;
        if (Math.abs((box.translation_x ?? 0) - x) > 0.1)
            box.translation_x = x;
    }

    _syncMenuArrows() {
        if (!this._enabled)
            return;
        // GNOME BoxPointer flips automatically when a menu has no space
        // below; explicitly request BOTTOM to avoid one wrong-direction
        // frame and restore each original side when returning to the top.
        for (const indicator of Object.values(
            this._panel?.statusArea ?? {})) {
            const pointer = indicator?.menu?._boxPointer;
            if (!pointer?.updateArrowSide)
                continue;
            if (!this._menuSides.has(pointer))
                this._menuSides.set(pointer,
                    pointer._userArrowSide ?? St.Side.TOP);
            if (pointer._userArrowSide !== St.Side.BOTTOM) {
                try { pointer.updateArrowSide(St.Side.BOTTOM); }
                catch (error) {
                    if (!this._arrowWarning) {
                        this._arrowWarning = true;
                        console.warn('[VLIQ][Taskbar] popup arrow update: ' +
                            error);
                    }
                }
            }
        }
    }

    _refreshApps() {
        if (!this._enabled || !this._appStrip)
            return;
        let favoriteIds = [];
        try {
            favoriteIds = this._shellSettings?.get_strv('favorite-apps') ?? [];
        } catch {}
        let running = [];
        try { running = this._appSystem?.get_running?.() ?? []; } catch {}
        // GNOME centers panelCenter using its NATURAL width. Measure the
        // real right side including the relocated Date/Quick Settings, not
        // a guessed 320px budget which caused icon/tray overlap.
        const monitorWidth = this._layout?.primaryMonitor?.width ?? 1280;
        const naturalWidth = actor => {
            try {
                const [, natural] = actor?.get_preferred_width?.(-1) ?? [];
                if (Number.isFinite(natural) && natural >= 0)
                    return natural;
            } catch {}
            return Math.max(0, actor?.width ?? 0);
        };
        const sideWidth = Math.max(
            naturalWidth(this._panel?._leftBox),
            naturalWidth(this._panel?._rightBox)
        );
        const centerBudget = Math.max(0,
            monitorWidth - sideWidth * 2 - 36);
        const startWidth = this._start ? 46 : 0;
        const maxApps = Math.max(0, Math.min(MAX_TASKBAR_APPS,
            Math.floor((centerBudget - startWidth) / 44)));
        const ordered = [];
        const seen = new Set();
        const add = app => {
            if (!app || ordered.length >= maxApps)
                return;
            const id = app.get_id?.();
            if (!id || seen.has(id))
                return;
            seen.add(id);
            ordered.push(app);
        };
        // Reserve room for currently running (not pinned) apps even when
        // the user has more favorites than the available icon slots.
        const favoriteSet = new Set(favoriteIds);
        const unpinnedRunning = running.filter(app =>
            app?.get_id?.() && !favoriteSet.has(app.get_id()));
        const reserved = Math.min(3, unpinnedRunning.length,
            Math.max(0, maxApps - 2));
        const favoriteBudget = maxApps - reserved;
        for (const id of favoriteIds) {
            if (ordered.length >= favoriteBudget)
                break;
            try { add(this._appSystem?.lookup_app?.(id)); } catch {}
        }
        for (const app of running)
            add(app);

        const key = ordered.map(app => {
            let active = false;
            try { active = (app.get_windows?.()?.length ?? 0) > 0; } catch {}
            return app.get_id() + ':' + (active ? '1' : '0');
        }).join('|');
        if (key === this._appKey)
            return;
        this._appKey = key;
        for (const child of this._appStrip.get_children?.() ?? [])
            child.destroy?.();

        for (const app of ordered) {
            let runningApp = false;
            try { runningApp = (app.get_windows?.()?.length ?? 0) > 0; } catch {}
            const content = new St.BoxLayout({
                style_class: 'vliq-taskbar-app-content',
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            const icon = app.create_icon_texture?.(APP_ICON_SIZE) ??
                new St.Icon({icon_name: 'application-x-executable-symbolic',
                    icon_size: APP_ICON_SIZE});
            content.add_child(icon);
            const dot = new St.Widget({
                style_class: 'vliq-taskbar-running-dot',
                reactive: false,
                height: 2,
            });
            if (!runningApp)
                dot.opacity = 0;
            content.add_child(dot);
            const button = new St.Button({
                style_class: 'vliq-taskbar-app-button',
                accessible_name: app.get_name?.() ?? app.get_id(),
                child: content,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            // Focus/restore the actual Meta.Window for running apps; launch
            // a pinned app when it has no window.
            button.connect('clicked', () => this._activateApp(app));
            this._appStrip.add_child(button);
        }
    }

    _activateApp(app) {
        if (!app)
            return;
        try {
            const windows = (app.get_windows?.() ?? []).filter(window =>
                window && typeof window === 'object' &&
                (typeof window.activate === 'function' ||
                 typeof Main.activateWindow === 'function')
            );
            if (windows.length) {
                const focused = windows.find(window =>
                    window.has_focus?.() === true);
                const latest = windows.slice().sort((a, b) =>
                    (b.get_user_time?.() ?? 0) -
                    (a.get_user_time?.() ?? 0)
                )[0];
                const window = focused ?? latest;
                // Windows 11 behavior: second click minimizes a focused
                // app; first click restores/raises it on its workspace.
                if (focused && typeof window.minimize === 'function') {
                    window.minimize();
                    return;
                }
                if (window.minimized)
                    window.unminimize?.();
                if (typeof Main.activateWindow === 'function') {
                    Main.activateWindow(window);
                    return;
                }
                if (typeof app.activate_window === 'function') {
                    app.activate_window(window,
                        global.get_current_time?.() ?? 0);
                    return;
                }
                if (typeof window.activate === 'function') {
                    window.activate(global.get_current_time?.() ?? 0);
                    return;
                }
            }
            if (typeof app.activate === 'function') {
                app.activate();
                return;
            }
            console.warn('[VLIQ][Taskbar] no launch method for ' +
                (app.get_id?.() ?? 'unknown app'));
        } catch (error) {
            console.warn('[VLIQ][Taskbar] application click: ' + error);
            try { app.activate?.(); } catch (fallbackError) {
                console.warn('[VLIQ][Taskbar] launch fallback: ' +
                    fallbackError);
            }
        }
    }

    _hideOriginalDock() {
        if (!this._enabled)
            return;
        let entries = [];
        try { entries = this._getDockEntries?.() ?? []; } catch {}
        for (const entry of entries) {
            const actor = entry?.container;
            if (!actor)
                continue;
            if (!this._dockPaint.has(actor)) {
                this._dockPaint.set(actor, {
                    opacity: actor.opacity,
                    reactive: actor.reactive,
                    visible: actor.visible,
                    glass: entry?.manager?.bgActor ?? null,
                    glassOpacity: entry?.manager?.bgActor?.opacity,
                });
            }
            // A transparent native Dock can still contain reactive child
            // icons. Unmap the legacy Dock while the taskbar owns app input.
            // The exact actor visibility is restored on layout exit.
            try {
                if (actor.visible !== false)
                    actor.hide?.();
                if (actor.opacity !== 0)
                    actor.opacity = 0;
                if (actor.reactive !== false)
                    actor.reactive = false;
                const glass = entry?.manager?.bgActor;
                if (glass && glass.opacity !== 0)
                    glass.opacity = 0;
                // Ubuntu Dock Panel Mode uses a separate stage-level
                // PanelGlassSurface, NOT the manager bgActor. Hide it
                // before first taskbar paint. The integration's own stage
                // guard prevents that glass from reappearing next frame.
                entry?.panelLiquidSurface?.hide?.();
            } catch (error) {
                if (!this._dockWarning) {
                    this._dockWarning = true;
                    console.warn('[VLIQ][Taskbar] Dock concealment: ' +
                        error);
                }
            }
        }
    }

    cleanup() {
        if (this._stageId) {
            try { global.stage.disconnect(this._stageId); } catch {}
            this._stageId = 0;
        }
        for (const {actor, id} of this._signals)
            safeDisconnect(actor, id);
        this._signals = [];
        for (const [pointer, side] of this._menuSides) {
            try { pointer.updateArrowSide?.(side); } catch {}
        }
        this._menuSides.clear();

        try { this._start?.destroy?.(); } catch {}
        try { this._appStrip?.destroy?.(); } catch {}
        try { this._centerGroup?.destroy?.(); } catch {}
        this._start = null;
        this._appStrip = null;
        this._centerGroup = null;
        if (this._date?.get_parent?.() === this._panel?._rightBox) {
            try {
                this._panel._rightBox.remove_child(this._date);
                this._dateParent?.insert_child_at_index?.(
                    this._date, Math.max(0, this._dateIndex));
            } catch {}
        }
        this._date = null;
        this._dateParent = null;
        if (this._activity && this._activityWasVisible)
            this._activity.show?.();
        this._activity = null;

        for (const [actor, old] of this._dockPaint) {
            try {
                if (actor.opacity === 0)
                    actor.opacity = old.opacity;
                if (actor.reactive === false)
                    actor.reactive = old.reactive;
                if (old.visible !== false && actor.visible === false)
                    actor.show?.();
                if (old.glass && old.glass.opacity === 0 &&
                    old.glassOpacity !== undefined)
                    old.glass.opacity = old.glassOpacity;
            } catch {}
        }
        this._dockPaint.clear();
        this._enabled = false;
        const box = this._layout?.panelBox;
        const monitor = this._layout?.primaryMonitor;
        if (box && monitor) {
            // Match native GNOME LayoutManager._updateBoxes, including a
            // monitor replacement while bottom taskbar mode was active.
            try { box.set_position(monitor.x, monitor.y); } catch {}
        } else if (box && this._originalPanelPosition) {
            try { box.set_position(...this._originalPanelPosition); } catch {}
        }
        // Undo the native panel's temporary Windows 11 centering
        // correction, including custom offsets owned by other extensions.
        if (this._panel?._centerBox)
            this._panel._centerBox.translation_x =
                this._originalCenterTranslation;
        this._originalCenterTranslation = 0;
        this._appKey = '';
        this._originalPanelPosition = null;
        if (this._ownsShellSettings)
            this._shellSettings = null;
    }
}
