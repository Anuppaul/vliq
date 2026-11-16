// VLIQ's shader-independent backend for software-rendered/low-end GNOME.
// This module deliberately imports NO vendored LiquidEffect or GPU capture
// manager. Native Shell actors own their contents, animation and input.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {
    milkyPaintTokens, buildMilkyAppearanceCss, buildMilkyGrainSvg,
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
        this._milkyGrainFile = null;
        this._milkyGrainStrength = -1;
        this._milkyFileSequence = 0;
        this._isMilky = false;
        this._milkyActorPainter = new MilkyActorPainter();
        this._milkyPaintStatus = '';
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

    _readMilkyAppearance() {
        const getInt = (key, fallback) => {
            try {
                const value = this._settings?.get_int?.(key);
                return Number.isFinite(value) ? value : fallback;
            } catch {
                return fallback;
            }
        };
        let milky = false;
        try {
            milky = this._settings?.get_string?.('glass-style') === 'milky';
        } catch {}
        const clamp = (value, low, high) =>
            Math.max(low, Math.min(high, value));
        return {
            milky,
            milkyOpacity: clamp(getInt('milky-opacity', 24), 0, 100) / 100,
            milkyBlack: this._settings?.get_boolean?.('milky-black') === true,
            milkyBorder: clamp(getInt('milky-border', 20), 0, 100) / 100,
            milkyGrain: clamp(getInt('milky-grain', 28), 0, 100) / 100,
            systemDarkTaskbar:
                this._interfaceSettings?.get_string?.('color-scheme') ===
                'prefer-dark',
        };
    }

    _theme() {
        return St.ThemeContext.get_for_stage(global.stage).get_theme();
    }

    _cleanupMilkyStylesheet(keepGrain = false) {
        if (this._milkyStyleFile) {
            try { this._theme().unload_stylesheet(this._milkyStyleFile); }
            catch {}
            try { this._milkyStyleFile.delete(null); } catch {}
        }
        this._milkyStyleFile = null;
        this._milkyCssSignature = '';
        if (!keepGrain) {
            try { this._milkyGrainFile?.delete?.(null); } catch {}
            this._milkyGrainFile = null;
            this._milkyGrainStrength = -1;
        }
    }

    _milkyCss(state, grainUri = '') {
        const tokens = milkyPaintTokens(state);
        const image = grainUri
            ? 'background-image: url("' + grainUri +
                '") !important; background-repeat: repeat !important;'
            : 'background-image: none !important;';
        // This scope is intentionally stronger than the static, always-on
        // native CSS fallback. Theme reload order must not decide whether
        // the user's opacity/white/edge values are actually visible.
        const shared = buildMilkyAppearanceCss(state, grainUri)
            .replaceAll('.vliq-global-milky ',
                '.vliq-native-css.vliq-global-milky ');
        return shared +
            '.vliq-native-css.vliq-global-milky .popup-menu-content {' +
            'background-color: ' + tokens.fill + ' !important;' +
            image + 'border: 0 !important;' +
            'box-shadow: ' + tokens.rim + ' !important;}\n' +
            // Keep GNOME's Bottom-only Dark Style independent of the
            // user's Milky White / Black color toggle.
            '.vliq-native-css.vliq-global-milky.vliq-native-css-dark ' +
            '.popup-menu-content {' +
            'background-color: rgba(29,31,35,0.97) !important;' +
            'background-image: none !important;}\n' +
            '.vliq-native-css.vliq-global-milky ' +
            '#panel.vliq-liquid-top-panel.vliq-bottom-taskbar.' +
            'vliq-system-dark-taskbar {' +
            'background-color: rgba(29,31,35,0.98) !important;' +
            'background-image: none !important;}\n';
    }

    _syncMilkyNativeActors(state) {
        const actors = state?.milky
            ? milkyCardActors(Main.panel, this._topPanelIslands, state)
            : [];
        this._milkyActorPainter.sync(actors, state);
        const marker = state?.milky
            ? [state.milkyOpacity, state.milkyBlack ? 'black' : 'white',
                state.milkyBorder, state.milkyGrain].join('/')
            : 'off';
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
        this._host?.remove_style_class_name?.('vliq-milky-black');
        if (state.milky && state.milkyBlack)
            this._host?.add_style_class_name?.('vliq-milky-black');
        else
            this._host?.remove_style_class_name?.('vliq-milky-black');
        // Direct St.Widget styling remains functional even if an optional
        // theme stylesheet or grain image fails to load.
        this._syncMilkyNativeActors(state);
        this._topPanelIslands?.updateAppearance?.();

        if (!state.milky) {
            this._cleanupMilkyStylesheet();
            return;
        }
        const grainStrength = Math.round(state.milkyGrain * 100);
        const dir = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'vliq@wonderer.tech',
            'native-card-appearance',
        ]);
        let grain = grainStrength > 0 &&
            grainStrength === this._milkyGrainStrength
            ? this._milkyGrainFile : null;
        let newGrain = false;
        let createdGrainFile = null;
        if (grainStrength > 0 && !grain) {
            try {
                GLib.mkdir_with_parents(dir, 0o755);
                const path = GLib.build_filenamev([
                    dir, 'grain-' + this._milkyFileSequence++ + '.svg',
                ]);
                GLib.file_set_contents(path,
                    buildMilkyGrainSvg(grainStrength / 100));
                grain = Gio.File.new_for_path(path);
                newGrain = true;
                createdGrainFile = grain;
            } catch (error) {
                console.warn('[VLIQ][NativeCSS] grain disabled: ' + error);
                grain = null;
            }
        }
        const grainUri = grain?.get_uri?.() ?? '';
        let css = this._milkyCss(state, grainUri);
        if (this._milkyStyleFile &&
            css === this._milkyCssSignature) {
            if (newGrain)
                try { grain?.delete?.(null); } catch {}
            return;
        }
        let file = null;
        try {
            GLib.mkdir_with_parents(dir, 0o755);
            const path = GLib.build_filenamev([
                dir, 'milky-' + this._milkyFileSequence++ + '.css',
            ]);
            GLib.file_set_contents(path, css);
            file = Gio.File.new_for_path(path);
            try {
                this._theme().load_stylesheet(file);
            } catch (error) {
                // St may reject an SVG CSS image on some distributions.
                // NEVER let optional grain disable every Milky slider.
                if (!grainUri)
                    throw error;
                css = this._milkyCss(state);
                GLib.file_set_contents(path, css);
                this._theme().load_stylesheet(file);
                console.warn('[VLIQ][NativeCSS] grain image unsupported; ' +
                    'using plain Milky CSS');
                try { createdGrainFile?.delete?.(null); } catch {}
                createdGrainFile = null;
                grain = null;
            }
        } catch (error) {
            try { file?.delete?.(null); } catch {}
            if (newGrain)
                try { createdGrainFile?.delete?.(null); } catch {}
            console.warn('[VLIQ][NativeCSS] material update failed: ' +
                error);
            return;
        }
        const keepGrain = grain &&
            grain === this._milkyGrainFile;
        this._cleanupMilkyStylesheet(keepGrain);
        this._milkyStyleFile = file;
        this._milkyCssSignature = css;
        this._milkyGrainFile = grain;
        this._milkyGrainStrength = grain ? grainStrength : 0;
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
                    if ([
                        'glass-style', 'milky-opacity', 'milky-black',
                        'milky-border', 'milky-grain',
                    ].includes(key))
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
        if (this._milkySettingsSignal) {
            try { this._settings?.disconnect?.(this._milkySettingsSignal); }
            catch {}
        }
        this._milkySettingsSignal = 0;
        this._milkyActorPainter.clear();
        this._cleanupMilkyStylesheet();
        this._host?.remove_style_class_name?.('vliq-global-milky');
        this._host?.remove_style_class_name?.('vliq-native-css-dark');
        this._host?.remove_style_class_name?.('vliq-native-css');
        this._host = null;
    }
}
