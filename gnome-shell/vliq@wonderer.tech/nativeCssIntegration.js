// VLIQ's shader-independent backend for software-rendered/low-end GNOME.
// This module deliberately imports NO vendored LiquidEffect or GPU capture
// manager. Native Shell actors own their contents, animation and input.
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TopBarIslands} from './topBarIslands.js';
import {FullscreenPanelChromeGuard} from './fullscreenPanelGuard.js';

const DOCK_UUIDS = [
    'ubuntu-dock@ubuntu.com',
    'dash-to-dock@micxgx.gmail.com',
];

export class NativeCssIntegration {
    constructor({vliqSettings}) {
        this._settings = vliqSettings;
        this._topPanelIslands = null;
        this._fullscreenGuard = null;
        this._interfaceSettings = null;
        this._interfaceSignal = 0;
        this._host = null;
        this._enabled = false;
        this._launcher = null;
    }

    _dockEntries() {
        // Read the existing dock manager, NEVER instantiate another Dock.
        // Resolve on demand because Ubuntu Dock can rebuild on hotplug.
        const entries = [];
        const seen = new Set();
        for (const uuid of DOCK_UUIDS) {
            try {
                const state = Main.extensionManager?.lookup?.(uuid)?.stateObj;
                const manager = state?.dockManager ?? state?._dockManager;
                const docks = manager?._allDocks ?? manager?.allDocks ?? [];
                for (const dock of docks) {
                    const container =
                        dock?.dash?._dashContainer ??
                        dock?.dash?._container ?? null;
                    if (!container || seen.has(container))
                        continue;
                    seen.add(container);
                    entries.push({
                        container,
                        panelBackgroundActor:
                            dock?.dash?._background ?? null,
                    });
                }
            } catch {
                // An unavailable Dock must not block native GNOME layouts.
            }
        }
        return entries;
    }

    _syncSystemTheme() {
        if (!this._host)
            return;
        let dark = false;
        try {
            dark = this._interfaceSettings?.get_string('color-scheme') ===
                'prefer-dark';
        } catch {}
        if (dark)
            this._host.add_style_class_name('vliq-native-css-dark');
        else
            this._host.remove_style_class_name('vliq-native-css-dark');
        this._topPanelIslands?.updateAppearance?.();
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._host = Main.layoutManager?.uiGroup ?? Main.uiGroup ?? null;
        try {
            this._host?.add_style_class_name?.('vliq-native-css');
            try {
                this._interfaceSettings =
                    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
                this._interfaceSignal = this._interfaceSettings.connect(
                    'changed::color-scheme',
                    () => this._syncSystemTheme()
                );
            } catch {
                this._interfaceSettings = null;
                this._interfaceSignal = 0;
            }

            this._syncSystemTheme();
            if (!Main.panel)
                return;
            const panel = new TopBarIslands({
                vendor: null,
                settings: null,
                layoutSettings: this._settings,
                forceCssOnly: true,
                getDockEntries: () => this._dockEntries(),
                onLauncherClick: this._launcher,
                readAppearance: () => ({
                    milky: false,
                    systemDarkTaskbar:
                        this._interfaceSettings?.get_string?.('color-scheme') ===
                        'prefer-dark',
                }),
            });
            if (!panel.setup()) {
                panel.cleanup();
                return;
            }
            this._topPanelIslands = panel;
            this._fullscreenGuard = new FullscreenPanelChromeGuard({
                layout: Main.layoutManager,
                display: global.display,
                panel: Main.panel,
                panelManager: panel,
            });
            this._fullscreenGuard.setup();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    setBottomTaskbarLauncher(callback) {
        this._launcher = typeof callback === 'function' ? callback : null;
        this._topPanelIslands?.setLauncherCallback?.(this._launcher);
    }

    isBottomTaskbarActive() {
        return this._topPanelIslands?.isBottomTaskbarActive?.() === true;
    }

    ownsBottomTaskbarChrome() {
        return this._topPanelIslands?.ownsBottomTaskbarChrome?.() === true;
    }

    attachSpotlightGlass() {
        // Spotlight retains its lightweight native CSS search UI.
        return false;
    }

    attachPreviewGlass() {
        // Preview cards already have a native CSS fallback in runtime.css.
        return false;
    }

    refreshAdaptiveText() {}

    setOrbDragging() {}

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;
        try { this._fullscreenGuard?.cleanup(); } catch {}
        this._fullscreenGuard = null;
        try { this._topPanelIslands?.cleanup(); } catch {}
        this._topPanelIslands = null;
        if (this._interfaceSignal) {
            try {
                this._interfaceSettings?.disconnect(this._interfaceSignal);
            } catch {}
        }
        this._interfaceSignal = 0;
        this._interfaceSettings = null;
        this._host?.remove_style_class_name?.('vliq-native-css-dark');
        this._host?.remove_style_class_name?.('vliq-native-css');
        this._host = null;
    }
}
