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
        this._activity = null;
        this._date = null;
        this._dateParent = null;
        this._dateIndex = -1;
        this._signals = [];
        this._stageId = 0;
        this._originalPanelPosition = null;
        this._dockPaint = new Map();
        this._menuSides = new Map();
        this._appKey = '';
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
            if (!this._shellSettings)
                this._shellSettings = new Gio.Settings({
                    schema_id: 'org.gnome.shell',
                });
            this._originalPanelPosition = box.get_position?.() ?? [
                box.x ?? 0, box.y ?? 0,
            ];
            this._enabled = true;

            // Native Activities remains in its original left box, but is
            // temporarily hidden: the VLIQ launcher replaces it visually.
            this._activity = panel.statusArea?.activities?.container ?? null;
            this._activityWasVisible = this._activity?.visible !== false;
            this._activity?.hide?.();

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
            panel._leftBox.insert_child_at_index(this._start, 0);

            // Preserve the original menu actor and its identity; only shift
            // its container to the right, before native Quick Settings.
            const date = panel.statusArea?.dateMenu?.container ?? null;
            if (date?.get_parent?.() === panel._centerBox) {
                this._date = date;
                this._dateParent = panel._centerBox;
                this._dateIndex = Math.max(0,
                    panel._centerBox.get_children().indexOf(date));
                panel._centerBox.remove_child(date);
                panel._rightBox.insert_child_at_index(date, 0);
            }

            this._appStrip = new St.BoxLayout({
                style_class: 'vliq-taskbar-apps',
                reactive: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            panel._centerBox.insert_child_at_index(this._appStrip, 0);
            this._refreshApps();

            for (const [actor, signal, callback] of [
                [this._layout, 'monitors-changed', () => {
                    this._placePanel();
                    this._refreshApps();
                }],
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
            this._stageId = global.stage.connect('before-update', () => {
                this._placePanel();
                this._hideOriginalDock();
                this._syncMenuArrows();
            });
            this._placePanel();
            this._syncMenuArrows();
            this._hideOriginalDock();
            return true;
        } catch (error) {
            console.warn('[VLIQ][Taskbar] native setup failed: ' + error);
            this.cleanup();
            return false;
        }
    }

    _placePanel() {
        if (!this._enabled)
            return;
        const box = this._layout?.panelBox;
        const monitor = this._layout?.primaryMonitor;
        if (!box || !monitor)
            return;
        // GNOME may rebuild the center box after a session-mode change.
        // Restore only the original Date Menu container if it moved back.
        if (this._date?.get_parent?.() === this._dateParent) {
            this._dateParent.remove_child(this._date);
            this._panel._rightBox.insert_child_at_index(this._date, 0);
        }
        const h = Number(box.height) > 1 ? box.height :
            (Number(this._panel?.height) > 1 ? this._panel.height : 36);
        const x = monitor.x;
        const y = monitor.y + monitor.height - h;
        if (!Number.isFinite(y))
            return;
        const [currentX, currentY] = box.get_position?.() ?? [box.x, box.y];
        if (Math.abs(currentX - x) > 0.1 ||
            Math.abs(currentY - y) > 0.1)
            box.set_position(x, y);
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
            if (pointer._userArrowSide !== St.Side.BOTTOM)
                pointer.updateArrowSide(St.Side.BOTTOM);
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
        // GNOME's center allocation is independent from the left/right
        // groups. Limit the icon strip on smaller displays so Quick Settings
        // and its native Date Menu never overlap app launchers.
        const monitorWidth = this._layout?.primaryMonitor?.width ?? 1280;
        const available = Math.max(0, monitorWidth - 320);
        const maxApps = Math.max(2,
            Math.min(MAX_TASKBAR_APPS, Math.floor(available / 43)));
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
            button.connect('clicked', () => {
                try { app.activate?.(); } catch (error) {
                    console.warn('[VLIQ][Taskbar] activate failed: ' + error);
                }
            });
            this._appStrip.add_child(button);
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
            if (actor.visible !== false)
                actor.hide?.();
            if (actor.opacity !== 0)
                actor.opacity = 0;
            if (actor.reactive !== false)
                actor.reactive = false;
            const glass = entry?.manager?.bgActor;
            if (glass && glass.opacity !== 0)
                glass.opacity = 0;
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
        this._start = null;
        this._appStrip = null;
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
        this._appKey = '';
        this._originalPanelPosition = null;
        if (this._ownsShellSettings)
            this._shellSettings = null;
    }
}
