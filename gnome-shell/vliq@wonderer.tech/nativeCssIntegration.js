// VLIQ's shader-independent backend for software-rendered/low-end GNOME.
// This module deliberately imports NO vendored LiquidEffect or GPU capture
// manager. Native Shell actors own their contents, animation and input.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {
    milkyPaintTokens, buildMilkyAppearanceCss,
    MilkyActorPainter, milkyCardActors,
} from './milkyPaint.js';
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
        this._milkySettingsSignal = 0;
        this._milkyStyleFile = null;
        this._milkyCssSignature = '';
        this._milkyFileSequence = 0;
        this._isMilky = false;
        this._milkyActorPainter = new MilkyActorPainter();
        this._milkyPaintStatus = '';
        this._host = null;
        this._enabled = false;
        this._launcher = null;
        this._launcherHover = null;
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

    _readMilkyAppearance() {
        let milky = false;
        try {
            milky = this._settings?.get_string?.('glass-style') === 'milky';
        } catch {}
        return {
            milky,
            systemDarkTaskbar:
                this._interfaceSettings?.get_string?.('color-scheme') ===
                'prefer-dark',
        };
    }

    _theme() {
        return St.ThemeContext.get_for_stage(global.stage).get_theme();
    }

    _cleanupMilkyStylesheet() {
        if (this._milkyStyleFile) {
            try { this._theme().unload_stylesheet(this._milkyStyleFile); }
            catch {}
            try { this._milkyStyleFile.delete(null); } catch {}
        }
        this._milkyStyleFile = null;
        this._milkyCssSignature = '';
    }

    _milkyCss(state) {
        // All Liquid-backed GNOME surfaces receive fixed Milky White, except
        // for the native GNOME header/taskbar's fixed black 60% material.
        const shared = buildMilkyAppearanceCss(state)
            .replaceAll('.vliq-global-milky ',
                '.vliq-native-css.vliq-global-milky ');
        const white = milkyPaintTokens('popup');
        const darkPopup =
            '.vliq-native-css.vliq-global-milky.vliq-native-css-dark ' +
            '.popup-menu-content.quick-settings,\n' +
            '.vliq-native-css.vliq-global-milky.vliq-native-css-dark ' +
            '.popup-menu-content.datemenu-popover {\n' +
            '  background-color: ' + white.fill + ' !important;\n' +
            '  background-image: none !important;\n' +
            '  border: 0 !important;\n' +
            '  box-shadow: ' + white.rim + ' !important;\n' +
            '}\n';
        // This backend deliberately does not instantiate the GPU managers
        // that normally tag Liquid targets. Reuse GNOME's native paint
        // classes for the same menu/banner/dialog/OSD/preview surfaces.
        // Header selectors stay separate and continue to win as black 60%.
        const nativeLiquidTargets = [
            '.vliq-native-css.vliq-global-milky .popup-menu-content',
            '.vliq-native-css.vliq-global-milky .notification-banner',
            '.vliq-native-css.vliq-global-milky .message.notification-banner',
            '.vliq-native-css.vliq-global-milky .switcher-list',
            '.vliq-native-css.vliq-global-milky .modal-dialog',
            '.vliq-native-css.vliq-global-milky .workspace-switcher',
            '.vliq-native-css.vliq-global-milky .resize-popup',
            '.vliq-native-css.vliq-global-milky .osd-window',
            '.vliq-native-css.vliq-global-milky .vliq-app-preview-card',
            '.vliq-native-css.vliq-global-milky .vliq-spotlight-card',
            '.vliq-native-css.vliq-global-milky .vliq-orb-face-v2',
            '.vliq-native-css.vliq-global-milky .dash-background',
        ];
        const nativeWhite = nativeLiquidTargets.join(',\n') +
            ' {\n' +
            '  background-color: ' + white.fill + ' !important;\n' +
            '  background-image: none !important;\n' +
            '  border: 0 !important;\n' +
            '  box-shadow: ' + white.rim + ' !important;\n' +
            '}\n';
        return shared + nativeWhite + darkPopup;
    }

    _syncMilkyNativeActors(state) {
        const actors = state?.milky
            ? milkyCardActors(Main.panel, this._topPanelIslands, state)
            : [];
        this._milkyActorPainter.sync(actors, state);
        const marker = state?.milky ? 'header=black/60 popup=white/92' : 'off';
        if (marker !== this._milkyPaintStatus) {
            this._milkyPaintStatus = marker;
            console.log('[VLIQ][Milky] Native CSS direct actors=' +
                actors.length + ' values=' + marker);
        }
    }

    _refreshMilkyAppearance() {
        if (!this._enabled)
            return;
        const state = this._readMilkyAppearance();
        this._isMilky = state.milky;
        if (state.milky)
            this._host?.add_style_class_name?.('vliq-global-milky');
        else
            this._host?.remove_style_class_name?.('vliq-global-milky');
        // No per-Milky theme/texture switch remains in the preferences.
        // Direct St.Widget styling remains functional even if an optional
        // theme stylesheet or grain image fails to load.
        this._syncMilkyNativeActors(state);
        this._topPanelIslands?.updateAppearance?.();

        if (!state.milky) {
            this._cleanupMilkyStylesheet();
            return;
        }
        // Fixed CSS is generated only on material or native Dark Style
        // changes. There is no SVG grain tile, frame loop or slider watcher.
        const css = this._milkyCss(state);
        if (this._milkyStyleFile && css === this._milkyCssSignature)
            return;
        const dir = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'vliq@wonderer.tech',
            'native-card-appearance',
        ]);
        let file = null;
        try {
            GLib.mkdir_with_parents(dir, 0o755);
            const path = GLib.build_filenamev([
                dir, 'milky-' + this._milkyFileSequence++ + '.css',
            ]);
            GLib.file_set_contents(path, css);
            file = Gio.File.new_for_path(path);
            this._theme().load_stylesheet(file);
        } catch (error) {
            try { file?.delete?.(null); } catch {}
            console.warn('[VLIQ][NativeCSS] fixed Milky CSS unavailable: ' +
                error);
            return;
        }
        this._cleanupMilkyStylesheet();
        this._milkyStyleFile = file;
        this._milkyCssSignature = css;
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
        this._refreshMilkyAppearance();
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

            this._milkySettingsSignal = this._settings?.connect?.(
                'changed', (_settings, key) => {
                    if (key === 'glass-style')
                        this._refreshMilkyAppearance();
                }
            ) ?? 0;
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
                onLauncherHover: this._launcherHover,
                readAppearance: () => this._readMilkyAppearance(),
                onLayoutChanged: () => this._syncMilkyNativeActors(
                    this._readMilkyAppearance()),
            });
            if (!panel.setup()) {
                panel.cleanup();
                return;
            }
            this._topPanelIslands = panel;
            this._syncMilkyNativeActors(this._readMilkyAppearance());
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

    setBottomTaskbarLauncher(callback, hoverCallback = null) {
        this._launcher = typeof callback === 'function' ? callback : null;
        this._launcherHover = typeof hoverCallback === 'function'
            ? hoverCallback : null;
        this._topPanelIslands?.setLauncherCallback?.(this._launcher);
        this._topPanelIslands?.setLauncherHoverCallback?.(
            this._launcherHover);
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
        if (this._milkySettingsSignal) {
            try { this._settings?.disconnect?.(this._milkySettingsSignal); }
            catch {}
        }
        this._milkySettingsSignal = 0;
        this._milkyActorPainter.clear();
        this._cleanupMilkyStylesheet();
        this._host?.remove_style_class_name?.('vliq-global-milky');
        this._host?.remove_style_class_name?.('vliq-milky-black');
        this._host?.remove_style_class_name?.('vliq-native-css-dark');
        this._host?.remove_style_class_name?.('vliq-native-css');
        this._host = null;
    }
}
