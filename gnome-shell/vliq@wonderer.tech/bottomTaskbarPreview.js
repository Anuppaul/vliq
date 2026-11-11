// Native GNOME Shell 50 Bottom Taskbar window previews.
// Live Meta.WindowActor thumbnails, NOT screenshots or a second Dock.
// Only builds actors after a sustained hover; no permanent frame callback.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOVER_DELAY_MS = 260;
const LEAVE_GRACE_MS = 260;
const TILE_WIDTH = 216;
const THUMB_WIDTH = 192;
const THUMB_HEIGHT = 112;
const MAX_WINDOWS = 4;
const GAP = 8;

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

export class BottomTaskbarPreview {
    constructor({layout = Main.layoutManager,
        stage = global.stage, activateWindow = null} = {}) {
        this._layout = layout;
        this._stage = stage;
        this._activateWindow = activateWindow ?? (window => {
            if (window.minimized)
                window.unminimize?.();
            if (typeof Main.activateWindow === 'function')
                Main.activateWindow(window);
            else
                window.activate?.(global.get_current_time?.() ?? 0);
        });
        this._enabled = true;
        this._showTimer = 0;
        this._hideTimer = 0;
        this._popup = null;
        this._popupAddedAsChrome = false;
        this._previewItem = null;
        this._hoverItem = null;
    }

    _clearTimer(name) {
        const id = this[name];
        if (id) {
            try { GLib.source_remove(id); } catch {}
            this[name] = 0;
        }
    }

    _schedule(callback, delayMs, name) {
        this._clearTimer(name);
        this[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this[name] = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    onButtonHover(item, hovering) {
        if (!this._enabled || !item)
            return;
        if (!hovering) {
            if (this._hoverItem === item)
                this._hoverItem = null;
            this._clearTimer('_showTimer');
            this._scheduleHide();
            return;
        }

        this._hoverItem = item;
        this._clearTimer('_hideTimer');
        this._clearTimer('_showTimer');
        if (this._popup && this._previewItem === item)
            return;
        this._schedule(() => {
            if (this._enabled && this._hoverItem === item &&
                item.button?.get_parent?.() && item.button?.visible !== false)
                this._open(item);
        }, HOVER_DELAY_MS, '_showTimer');
    }

    _scheduleHide() {
        if (!this._popup)
            return;
        this._schedule(() => {
            if (!this._hoverItem && !this._popup?.hover)
                this.close();
        }, LEAVE_GRACE_MS, '_hideTimer');
    }

    _getWindows(item) {
        let windows = [];
        try { windows = item.app?.get_windows?.() ?? []; } catch {}
        return windows.filter(window => {
            try {
                return window &&
                    typeof window.get_compositor_private === 'function' &&
                    window.get_compositor_private() !== null;
            } catch {
                // Window may close while GNOME is emitting hover; skip the
                // stale Meta.Window rather than aborting every preview.
                return false;
            }
        });
    }

    _thumbnail(window) {
        const source = window.get_compositor_private();
        const rect = window.get_frame_rect?.() ?? null;
        const sourceWidth = Math.max(1,
            rect?.width ?? source.width ?? THUMB_WIDTH);
        const sourceHeight = Math.max(1,
            rect?.height ?? source.height ?? THUMB_HEIGHT);
        const scale = Math.min(1,
            THUMB_WIDTH / sourceWidth, THUMB_HEIGHT / sourceHeight);

        const clone = new Clutter.Clone({
            source,
            width: Math.max(1, Math.round(sourceWidth * scale)),
            height: Math.max(1, Math.round(sourceHeight * scale)),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const frame = new St.Widget({
            style_class: 'vliq-taskbar-preview-thumbnail',
            layout_manager: new Clutter.BinLayout(),
            width: THUMB_WIDTH,
            height: THUMB_HEIGHT,
        });
        frame.add_child(clone);
        return frame;
    }

    _tile(window, item) {
        const content = new St.BoxLayout({
            vertical: true,
            style_class: 'vliq-taskbar-preview-content',
        });
        content.add_child(this._thumbnail(window));

        const footer = new St.BoxLayout({
            style_class: 'vliq-taskbar-preview-footer',
        });
        const title = new St.Label({
            text: window.get_title?.() || item.app?.get_name?.() || 'Window',
            style_class: 'vliq-taskbar-preview-title',
            x_expand: true,
            width: TILE_WIDTH - 54,
        });
        if (title.clutter_text)
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        footer.add_child(title);

        if (typeof window.delete === 'function') {
            const close = new St.Button({
                style_class: 'vliq-taskbar-preview-close',
                child: new St.Icon({
                    icon_name: 'window-close-symbolic', icon_size: 14,
                }),
                reactive: true, can_focus: true, track_hover: true,
                accessible_name: 'Close window',
            });
            close.connect('clicked', () => {
                this.close();
                window.delete(global.get_current_time?.() ?? 0);
            });
            footer.add_child(close);
        }
        content.add_child(footer);

        const button = new St.Button({
            style_class: 'vliq-taskbar-preview-tile',
            child: content,
            width: TILE_WIDTH,
            reactive: true, can_focus: true, track_hover: true,
            accessible_name: window.get_title?.() || 'Activate window',
        });
        button.connect('clicked', () => {
            this.close();
            this._activateWindow(window);
        });
        return button;
    }

    _open(item) {
        if (!this._enabled || !item?.button)
            return;
        const windows = this._getWindows(item);
        // A non-running pinned app receives a lightweight name tooltip;
        // actual running windows get live native compositor thumbnails.
        const monitor = this._layout?.primaryMonitor;
        if (!monitor)
            return;
        const fit = Math.max(1, Math.floor(
            (monitor.width - GAP * 3) / (TILE_WIDTH + GAP)));
        const shown = windows.slice(0, Math.min(MAX_WINDOWS, fit));

        this._hidePopup();
        const popup = new St.BoxLayout({
            style_class: 'vliq-taskbar-window-previews',
            reactive: true,
            track_hover: true,
            x_expand: false,
        });

        if (shown.length) {
            for (const window of shown)
                popup.add_child(this._tile(window, item));
        } else {
            popup.add_child(new St.Label({
                style_class: 'vliq-taskbar-preview-empty',
                text: item.app?.get_name?.() ?? 'Application',
            }));
        }

        if (windows.length > shown.length) {
            popup.add_child(new St.Label({
                text: '+' + (windows.length - shown.length),
                style_class: 'vliq-taskbar-preview-extra',
            }));
        }

        try {
            if (typeof this._layout?.addTopChrome === 'function') {
                this._layout.addTopChrome(popup, {
                    affectsStruts: false, trackFullscreen: false,
                });
                this._popupAddedAsChrome = true;
            } else {
                this._layout?.uiGroup?.add_child?.(popup);
                this._popupAddedAsChrome = false;
            }
        } catch (error) {
            popup.destroy();
            console.warn('[VLIQ][TaskbarPreview] attach failed: ' + error);
            return;
        }
        this._popup = popup;
        this._previewItem = item;
        popup.connect('notify::hover', () => {
            if (popup.hover) {
                this._clearTimer('_hideTimer');
            } else if (!this._hoverItem) {
                this._scheduleHide();
            }
        });
        popup.connect('notify::allocation', () => {
            if (this._popup === popup)
                this._placePopup(popup, item);
        });
        this._placePopup(popup, item);
    }

    _placePopup(popup, item) {
        const monitor = this._layout?.primaryMonitor;
        const panelBox = this._layout?.panelBox;
        const host = this._layout?.uiGroup;
        if (!monitor || !panelBox || !host)
            return;

        const [buttonX] = item.button.get_transformed_position?.() ??
            [monitor.x, 0];
        const [, panelY] = panelBox.get_transformed_position?.() ??
            [monitor.x, monitor.y + monitor.height - 44];
        const [hostX, hostY] = host.get_transformed_position?.() ?? [0, 0];

        const [, naturalWidth] = popup.get_preferred_width?.(-1) ?? [];
        const [, naturalHeight] = popup.get_preferred_height?.(-1) ?? [];
        const width = Number.isFinite(naturalWidth) && naturalWidth > 0
            ? naturalWidth : Math.max(TILE_WIDTH,
                popup.get_children?.().length * (TILE_WIDTH + GAP));
        const height = Number.isFinite(naturalHeight) && naturalHeight > 0
            ? naturalHeight : 174;
        const center = buttonX + (item.button.width ?? 36) / 2;
        const x = clamp(Math.round(center - width / 2),
            monitor.x + GAP,
            Math.max(monitor.x + GAP,
                monitor.x + monitor.width - width - GAP));
        const y = Math.max(monitor.y + GAP, panelY - height - GAP);
        const localX = x - hostX, localY = y - hostY;
        if (Math.abs((popup.x ?? 0) - localX) > 0.5 ||
            Math.abs((popup.y ?? 0) - localY) > 0.5)
            popup.set_position(localX, localY);
    }

    // Close the preview on native app click, mode exit or app removal.
    close() {
        this._clearTimer('_showTimer');
        this._clearTimer('_hideTimer');
        this._hoverItem = null;
        this._hidePopup();
    }

    closeForItem(item) {
        if (this._previewItem === item || this._hoverItem === item)
            this.close();
    }

    _hidePopup() {
        const popup = this._popup;
        if (!popup)
            return;
        this._popup = null;
        this._previewItem = null;
        try {
            if (this._popupAddedAsChrome)
                this._layout?.removeChrome?.(popup);
            popup.destroy();
        } catch {}
        this._popupAddedAsChrome = false;
    }

    destroy() {
        this._enabled = false;
        this.close();
    }
}
