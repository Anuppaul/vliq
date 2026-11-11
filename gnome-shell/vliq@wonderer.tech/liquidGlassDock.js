import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    ExtensionState,
} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {
    NotificationGlassManager,
} from './notificationGlass.js';
import {
    PopupGlassManager,
} from './popupGlass.js';
import {
    ShellCardGlassManager,
} from './shellCards.js';
import {
    AppGridBackdropManager,
} from './appGridBackdrop.js';
import {
    WallpaperAtmosphereManager,
} from './wallpaperAtmosphere.js';
import {
    OverviewCloseGlassManager,
} from './overviewCloseGlass.js';
import {
    SharedAdaptiveTextManager,
} from './sharedAdaptiveText.js';
import {
    OrbGlassManager,
} from './orbGlass.js';
import {
    SpotlightGlassManager,
} from './spotlightGlass.js';
import {
    VLIQ_GLASS_ADAPTERS,
    VLIQ_GLASS_ROLES,
    applyVLIQGlassRole,
} from './glassMaterialSystem.js';
import {PanelGlassSurface} from './panelGlass.js';
import {TopBarIslands} from './topBarIslands.js';
import {FullscreenPanelChromeGuard} from './fullscreenPanelGuard.js';

const UPSTREAM_EXTENSION_UUID =
    'liquid-glass@thinkingcoding1231.gmail.com';

const GLASS_SCHEMA =
    'org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com';

const VENDOR_CACHE_KEY = '__vliqLiquidGlassVendorModulesV3';
const VENDOR_ROOT_KEY = '__vliqLiquidGlassVendorRootV3';
const VENDOR_PROMISE_KEY = '__vliqLiquidGlassVendorPromiseV3';
const LEGACY_VENDOR_CACHE_KEY = '__vliqLiquidGlassVendorModulesV2';
const LEGACY_VENDOR_ROOT_KEY = '__vliqLiquidGlassVendorRootV1';
const DEBUG_STATE_KEY = '__vliqLiquidGlassDebugV2';
const DASH_RESCAN_IDLE_TICKS = 2;
const DASH_RESCAN_INTERVAL_MS = 2000;
const DASH_TO_DOCK_SCHEMA =
    'org.gnome.shell.extensions.dash-to-dock';
const UBUNTU_DOCK_UUID =
    'ubuntu-dock@ubuntu.com';
const DOCK_PANEL_MODE_CLASS =
    'vliq-dock-panel-mode';
const DOCK_PANEL_BACKGROUND_CLASS =
    'vliq-ubuntu-dock-panel-background';
const DOCK_GLASS_BACKGROUND_CLASS =
    'vliq-ubuntu-dock-glass-background';
const DOCK_PANEL_BLUR_EFFECT =
    'vliq-ubuntu-dock-panel-blur';
const DOCK_PANEL_BLUR_RADIUS = 18;
const DOCK_PANEL_READY_CLASS = 'vliq-native-panel-liquid-ready';
const DOCK_PANEL_GLASS_STYLE =
    'background-color: transparent; ' +
    'background-image: none; ' +
    'border-color: transparent; ' +
    'border-radius: 0px; ' +
    'box-shadow: none;';
// An explicit inline native Dock fallback is needed even when the GNOME
// theme has a higher-priority rule for the sibling .dash-background.
const DOCK_PANEL_MILKY_STYLE =
    'background-color: rgba(245,249,255,0.24); ' +
    'background-image: none; ' +
    'border-color: transparent; ' +
    'border-radius: 0px; ' +
    'box-shadow: inset 0 0 0 1px rgba(255,255,255,0.20);';
const DOCK_PANEL_BACKDROP_NAME = 'vliq-dock-panel-local-backdrop';
// Panel-local frosted glass: the blur effect is applied to Ubuntu Dock's
// native .dash-background only, never to the whole monitor. A thin highlight
// and the accepted milky tint add depth without another capture pass.
const DOCK_PANEL_PREMIUM_STYLE =
    'background-color: rgba(245,248,255,0.15); ' +
    'background-image: none; ' +
    'background-gradient-direction: vertical; ' +
    'background-gradient-start: rgba(255,255,255,0.15); ' +
    'background-gradient-end: rgba(255,255,255,0.015); ' +
    'border-color: rgba(255,255,255,0.21); ' +
    'border-radius: 0px; ' +
    'box-shadow: inset 0 1px rgba(255,255,255,0.20);';
const DOCK_MODE_SETTLE_FRAMES = 2;
const DOCK_HANDOFF_POLL_MS = 24;
const DOCK_HANDOFF_MAX_MS = 5000;

const NATIVE_DOCK_STATE = Object.freeze({
    HIDDEN: 0,
    SHOWING: 1,
    SHOWN: 2,
    HIDING: 3,
});
const NATIVE_DOCK_SLIDE_EPSILON = 0.002;

const DESKTOP_INTERFACE_SCHEMA =
    'org.gnome.desktop.interface';

const SYSTEM_ACCENT_COLORS = Object.freeze({
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
});

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function parseHexRgb(value) {
    const text = String(value ?? '').trim();

    if (/^#[0-9a-fA-F]{3}$/.test(text)) {
        return [
            Number.parseInt(text[1] + text[1], 16),
            Number.parseInt(text[2] + text[2], 16),
            Number.parseInt(text[3] + text[3], 16),
        ];
    }

    if (/^#[0-9a-fA-F]{6}$/.test(text)) {
        return [
            Number.parseInt(text.slice(1, 3), 16),
            Number.parseInt(text.slice(3, 5), 16),
            Number.parseInt(text.slice(5, 7), 16),
        ];
    }

    return [255, 255, 255];
}

// Single source for Milky colors across every VLIQ-owned native Shell card.
// Keep Liquid/Frosted selectors completely untouched by these optional rules.
function milkyPaintTokens(state = {}) {
    const opacity = clampNumber(state.milkyOpacity ?? 0.24, 0, 1);
    const border = clampNumber(state.milkyBorder ?? 0.20, 0, 1);
    const white = clampNumber(state.milkyWhiteness ?? 0, 0, 1);
    const rgb = [245, 249, 255].map(channel =>
        Math.round(channel + (255 - channel) * white));
    return {
        fill: 'rgba(' + rgb.join(',') + ',' + opacity.toFixed(3) + ')',
        rim: border <= 0 ? 'none' :
            'inset 0 0 0 1px rgba(255,255,255,' +
                border.toFixed(3) + ')',
    };
}

function buildMilkyAppearanceCss(state = {}) {
    if (!state.milky)
        return '';
    const {fill, rim} = milkyPaintTokens(state);
    const roots = [
        // St.Theme is NOT a browser CSS engine: do not use :not().
        // Explicitly clear inactive islands after the main Milky paint.
        ...['panelLeft', 'panelCenter', 'panelRight'].map(id =>
            '.vliq-global-milky #panel.vliq-three-islands #' + id +
            '.vliq-panel-island'),
        '#panel.vliq-liquid-top-panel.vliq-full-header',
        '#panel.vliq-liquid-top-panel.vliq-bottom-taskbar',
        '.vliq-global-milky .vliq-liquid-popup-content',
        '.vliq-global-milky .vliq-liquid-popup-content.popup-menu-content',
        '.vliq-global-milky .popup-menu-content.datemenu-popover',
        '.vliq-global-milky .popup-menu-content.quick-settings',
        '.vliq-global-milky .vliq-liquid-shell-card',
        '.vliq-global-milky .vliq-app-preview-card.vliq-liquid-shell-card',
        '.vliq-global-milky .vliq-native-notification-glass',
        '.vliq-global-milky .vliq-milky-osd',
        '.vliq-global-milky .vliq-orb-face-v2',
        '.vliq-global-milky .vliq-spotlight-glass-entry',
        '.vliq-global-milky .vliq-spotlight-glass-results',
        '.vliq-global-milky .dash-background.vliq-ubuntu-dock-glass-background',
        '.vliq-global-milky .dash-background.vliq-ubuntu-dock-panel-background',
        '.vliq-global-milky #overviewGroup .window-close.vliq-window-close-shared-glass',
        '.vliq-global-milky #overviewGroup .window-icon.vliq-window-icon-shared-glass',
    ];
    const interactionRoots = [
        '.vliq-global-milky .vliq-app-button',
    ];
    const all = [...roots, ...interactionRoots].flatMap(selector =>
        [selector, selector + ':hover', selector + ':focus',
            selector + ':active', selector + ':checked']);
    // The inactive override follows the fill, with strictly higher
    // specificity. It must win even for an island that has shader-ready
    // and inactive classes simultaneously during GNOME relayout.
    const inactive = ['panelLeft', 'panelCenter', 'panelRight'].map(id =>
        '.vliq-global-milky #panel.vliq-three-islands #' + id +
        '.vliq-panel-island.vliq-panel-island-inactive');
    return all.join(',\n') + ' {\n' +
        '  background-color: ' + fill + ' !important;\n' +
        '  background-image: none !important;\n' +
        '  border: 0 !important;\n' +
        '  box-shadow: ' + rim + ' !important;\n' +
        '}\n' + inactive.join(',\n') + ' {\n' +
        '  background-color: transparent !important;\n' +
        '  background-image: none !important;\n' +
        '  border: 0 !important;\n' +
        '  box-shadow: none !important;\n' +
        '}\n';
}

function canonicalExtensionRoot() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'gnome-shell',
        'extensions',
        'vliq@wonderer.tech',
    ]);
}

export function canonicalVendorRoot() {
    return GLib.build_filenamev([
        canonicalExtensionRoot(),
        'vendor',
        'liquid-glass',
    ]);
}

function activeUpstreamExtensionRoot() {
    try {
        const extension = Main.extensionManager.lookup(
            UPSTREAM_EXTENSION_UUID
        );
        if (
            extension &&
            extension.state === ExtensionState.ACTIVE &&
            extension.path
        ) {
            return extension.path;
        }
    } catch {
        // Upstream extension is not active/available.
    }

    return null;
}

function previousRevisionVendorRoot(settings) {
    const revision =
        settings?.get_string?.('runtime-loaded-revision')?.trim?.() ?? '';
    if (!revision || revision === 'base')
        return null;

    const root = GLib.build_filenamev([
        canonicalExtensionRoot(),
        'runtime-revisions',
        revision,
        'vendor',
        'liquid-glass',
    ]);
    const entry = Gio.File.new_for_path(
        GLib.build_filenamev([
            root,
            'dist',
            'liquidEffect.js',
        ])
    );
    return entry.query_exists(null) ? root : null;
}

function moduleUri(root, relativePath) {
    return Gio.File.new_for_path(
        GLib.build_filenamev([
            root,
            ...relativePath.split('/'),
        ])
    ).get_uri();
}

export function createLiquidGlassSettings() {
    // EGO compiles top-level schemas/ during store installation; our
    // development installer also compiles the nested upstream vendor schema.
    // Both may exist. Use whichever compiled source exposes the expected
    // schema ID, without requiring an external install.sh after Store install.
    // Do not create/write schema directories from the GNOME Shell process.
    const candidates = [
        GLib.build_filenamev([
            canonicalExtensionRoot(),
            'schemas',
        ]),
        GLib.build_filenamev([
            canonicalVendorRoot(),
            'schemas',
        ]),
    ];

    for (const schemaDir of candidates) {
        try {
            const compiled = Gio.File.new_for_path(
                GLib.build_filenamev([
                    schemaDir,
                    'gschemas.compiled',
                ])
            );
            if (!compiled.query_exists(null))
                continue;

            const source = Gio.SettingsSchemaSource.new_from_directory(
                schemaDir,
                Gio.SettingsSchemaSource.get_default(),
                false
            );
            const schema = source.lookup(GLASS_SCHEMA, true);
            if (schema)
                return new Gio.Settings({settings_schema: schema});
        } catch (error) {
            console.warn(
                '[VLIQ][Store] could not load compiled GSettings from ' +
                schemaDir + ': ' + error
            );
        }
    }

    // A distro may install the schema globally instead of alongside the
    // extension; do not fail before looking for that supported fallback.
    const fallback =
        Gio.SettingsSchemaSource.get_default()?.lookup?.(
            GLASS_SCHEMA,
            true
        ) ?? null;
    if (fallback)
        return new Gio.Settings({settings_schema: fallback});

    throw new Error(
        'Liquid Glass GSettings schema unavailable. ' +
        'Install VLIQ with both schema XML files under schemas/.'
    );
}

async function importVendorModules(root) {
    const [
        liquidEffect,
        unpickable,
        dockManager,
        osdManager,
        quickSettingsManager,
        logger,
        utils,
        background,
        windowClones,
        actorGeometry,
        actorWrites,
    ] = await Promise.all([
        import(moduleUri(root, 'dist/liquidEffect.js')),
        import(moduleUri(root, 'dist/actors/unpickable.js')),
        import(moduleUri(root, 'dist/dockManager.js')),
        import(moduleUri(root, 'dist/osdManager.js')),
        import(moduleUri(root, 'dist/quickSettingsManager.js')),
        import(moduleUri(root, 'dist/logger.js')),
        import(moduleUri(root, 'dist/utils.js')),
        import(moduleUri(root, 'dist/capture/background.js')),
        import(moduleUri(root, 'dist/capture/windowClones.js')),
        import(moduleUri(root, 'dist/actors/geometry.js')),
        import(moduleUri(root, 'dist/actors/writes.js')),
    ]);

    return {
        root,
        LiquidEffect: liquidEffect.LiquidEffect,
        startGlassRingSampler: liquidEffect.startGlassRingSampler,
        stopGlassRingSampler: liquidEffect.stopGlassRingSampler,
        flushGlassRing: liquidEffect.flushGlassRing,
        UnpickableActor: unpickable.UnpickableActor,
        DashManager: dockManager.DashManager,
        OsdManager: osdManager.OsdManager,
        QuickSettingsManager:
            quickSettingsManager.QuickSettingsManager,
        Logger: logger.Logger,
        setUtilsLogger: utils.setUtilsLogger,
        adaptiveColorTweener: utils.adaptiveColorTweener,
        createBackgroundMirror:
            background.createBackgroundMirror,
        WindowCloneManager:
            windowClones.WindowCloneManager,
        getTransformedRect:
            actorGeometry.getTransformedRect,
        resolveMonitorGeometry:
            actorGeometry.resolveMonitorGeometry,
        setClipIfChanged:
            actorWrites.setClipIfChanged,
        setPositionIfChanged:
            actorWrites.setPositionIfChanged,
        setSizeIfChanged:
            actorWrites.setSizeIfChanged,
        setTranslationIfChanged:
            actorWrites.setTranslationIfChanged,
        destroySharedBackgroundSource:
            utils.destroySharedBackgroundSource,
        releaseAllClonedWindowActors:
            utils.releaseAllClonedWindowActors,
    };
}
function validateVendorApi(vendor) {
    const required = [
        'LiquidEffect',
        'UnpickableActor',
        'WindowCloneManager',
        'DashManager',
        'OsdManager',
        'QuickSettingsManager',
        'Logger',
        'setUtilsLogger',
        'createBackgroundMirror',
        'getTransformedRect',
        'resolveMonitorGeometry',
        'setClipIfChanged',
        'setPositionIfChanged',
        'setSizeIfChanged',
        'setTranslationIfChanged',
        'destroySharedBackgroundSource',
        'releaseAllClonedWindowActors',
    ];

    const missing = required.filter(
        key => !vendor?.[key]
    );

    if (missing.length) {
        throw new Error(
            'Vendored Liquid Glass API is incomplete: ' +
            missing.join(', ')
        );
    }
}


export async function loadLiquidGlassVendorModules(vliqSettings) {
    const ensureQuickSettingsManager = async vendor => {
        if (vendor?.root && !vendor.QuickSettingsManager) {
            const quickSettingsManager = await import(
                moduleUri(
                    vendor.root,
                    'dist/quickSettingsManager.js'
                )
            );
            vendor.QuickSettingsManager =
                quickSettingsManager.QuickSettingsManager;
        }
        return vendor;
    };

    if (globalThis[VENDOR_CACHE_KEY]) {
        return ensureQuickSettingsManager(
            globalThis[VENDOR_CACHE_KEY]
        );
    }

    if (globalThis[VENDOR_PROMISE_KEY]) {
        return ensureQuickSettingsManager(
            await globalThis[VENDOR_PROMISE_KEY]
        );
    }

    // Hot-swap compatibility: reuse the exact vendor module graph already
    // loaded by the previous V2 runtime. Re-importing the whole vendor tree
    // from a new URI can collide with process-global GObject registrations.
    const legacyCache = globalThis[LEGACY_VENDOR_CACHE_KEY] ?? null;
    if (legacyCache?.root) {
        if (!legacyCache.WindowCloneManager) {
            const windowClones = await import(
                moduleUri(
                    legacyCache.root,
                    'dist/capture/windowClones.js'
                )
            );
            legacyCache.WindowCloneManager =
                windowClones.WindowCloneManager;
        }
        await ensureQuickSettingsManager(legacyCache);
        globalThis[VENDOR_CACHE_KEY] = legacyCache;
        globalThis[VENDOR_ROOT_KEY] = legacyCache.root;
        return legacyCache;
    }

    let root =
        globalThis[VENDOR_ROOT_KEY] ??
        globalThis[LEGACY_VENDOR_ROOT_KEY] ??
        activeUpstreamExtensionRoot() ??
        null;

    if (root)
        globalThis[VENDOR_ROOT_KEY] = root;

    if (!root) {
        const liquidType = GObject.type_from_name('LiquidGlassEffect');
        const cloneType = GObject.type_from_name(
            'Gjs_actors_unpickable_UnpickableClone'
        );
        const alreadyRegistered = Boolean(liquidType || cloneType);

        if (alreadyRegistered) {
            root = previousRevisionVendorRoot(vliqSettings);
            if (!root) {
                throw new Error(
                    'Liquid Glass GObject types are already registered, ' +
                    'but the previously loaded VLIQ vendor revision is unavailable'
                );
            }
        } else {
            root = canonicalVendorRoot();
        }

        globalThis[VENDOR_ROOT_KEY] = root;
    }

    const promise = importVendorModules(root)
        .then(modules => ensureQuickSettingsManager(modules))
        .then(modules => {
            globalThis[VENDOR_CACHE_KEY] = modules;
            return modules;
        })
        .catch(error => {
            delete globalThis[VENDOR_PROMISE_KEY];
            if (!globalThis[VENDOR_CACHE_KEY])
                delete globalThis[VENDOR_ROOT_KEY];
            throw error;
        });

    globalThis[VENDOR_PROMISE_KEY] = promise;
    return promise;
}

export class LiquidGlassIntegration {
    constructor(params) {
        this._vliqSettings = params.vliqSettings;
        this._vendor = null;
        this._settings = null;
        this._logger = null;
        this._stylesheet = null;

        this._popupGlassManager = null;
        this._shellCardGlassManager = null;
        this._previewGlassManager = null;
        this._appGridBackdropManager = null;
        this._wallpaperAtmosphereManager = null;
        this._overviewCloseGlassManager = null;
        this._sharedAdaptiveTextManager = null;
        this._orbGlassManager = null;
        this._spotlightGlassManager = null;
        this._cardAppearanceSettingId = 0;
        this._cardAppearanceApplyId = 0;
        this._desktopInterfaceSettings = null;
        this._desktopAccentChangedId = 0;
        this._cardCssFile = null;
        this._cardCssSignature = '';
        this._cardCssCounter = 0;
        this._notificationGlassManager = null;
        this._osdManager = null;
        this._nativeDashEntries = [];
        this._topPanelIslands = null;
        this._bottomLauncherCallback = null;
        this._fullscreenPanelChromeGuard = null;
        this._dashToDockSettings = null;
        this._dashToDockPanelModeId = 0;
        this._dashToDockFixedModeId = 0;
        this._dashToDockVisibilityId = 0;
        this._dockAutoHideRefreshId = 0;
        this._dockVerticalOffsetSettingId = 0;
        this._dockFixedSettleStageId = 0;
        this._dockFixedSettleGeneration = 0;
        this._dockGlassBeforePanelMode = null;
        this._ubuntuDockModule = null;
        this._ubuntuDockManager = null;
        this._dockModeGeneration = 0;
        this._dockModeTransitionStageId = 0;
        this._dockModeHandoffId = 0;
        this._dockModeTransitionTarget = null;
        this._dockHandoffActive = false;

        this._dashTimeoutId = 0;
        this._dashReconnectTimeoutId = 0;
        this._monitorsChangedId = 0;
        this._dumpLoopId = 0;
        this._dumpSettingsId = 0;
        this._dumpKeybindingInstalled = false;
        this._glassRingSamplerActive = false;
        this._enabled = false;
        this._externalGlobalStack = false;
        this._managerHealth = {};
    }

    refreshAdaptiveText() {
        this._sharedAdaptiveTextManager
            ?.refresh?.();
    }

    attachSpotlightGlass(
        target,
        resultsTarget,
        hostLayer
    ) {
        const attached =
            this._spotlightGlassManager
                ?.attach?.(
                    target,
                    resultsTarget,
                    hostLayer
                ) ?? false;

        if (attached)
            this._sharedAdaptiveTextManager
                ?.refresh?.();

        return attached;
    }

    attachPreviewGlass(target) {
        // Manual-only reuse of ShellCardSurface: same refractive shader,
        // stage-local 104px optical headroom and window-clone ROI clipping.
        // Preview content/activation remains owned by the original St.Widget.
        try {
            return this._previewGlassManager
                ?.attachPreview?.(target) ?? false;
        } catch (error) {
            console.warn(
                '[VLIQ][PreviewGlass] using translucent fallback: ' +
                error
            );
            return false;
        }
    }

    _applyFrostedCrystalSettings() {
        // The canonical VLIQ schema is the ONLY source of user intent.
        // Map style controls into the existing material's uniforms; never
        // replace or persist over the original v10 refraction, tint, blur or
        // custom advanced renderer values. New and existing LiquidEffects
        // receive live changes via their vendored MaterialSettings bindings.
        if (!this._settings || !this._vliqSettings)
            return;

        try {
            const mode = this._vliqSettings.get_string('glass-style');
            const enabled = mode === 'frosted';
            const fraction = key =>
                clampNumber(this._vliqSettings.get_int(key), 0, 100) / 100;
            const grain = fraction('frost-grain');
            const edge = fraction('frost-edge-glow');
            const density = enabled ? fraction('frost-density') : 0;

            // Update grain/edge first, the mode-active blend last: no
            // transient half-configured material during a live toggle.
            for (const [key, value] of [
                ['vliq-frost-grain', grain],
                ['vliq-frost-edge-glow', edge],
                ['vliq-frost-amount', density],
                ['vliq-milky-mode', ['milky', 'charcoal'].includes(mode) ? 1.0 : 0.0],
                ['vliq-milky-opacity', fraction('milky-opacity')],
                ['vliq-milky-border', fraction('milky-border')],
                ['vliq-milky-whiteness', fraction('milky-whiteness')],
            ]) {
                // Old cached schemas lack this optional key. Keep the native
                // Milky renderer functional and retain all Liquid settings.
                if (this._settings.settings_schema?.has_key?.(key) === false)
                    continue;
                try {
                    if (Math.abs(this._settings.get_double(key) - value) > 0.0001)
                        this._settings.set_double(key, value);
                } catch (error) {
                    if (key !== 'vliq-milky-mode')
                        throw error;
                }
            }
        } catch (error) {
            // Incompatible external/upstream vendor versions may not have
            // the new keys; never break the user's running GNOME session.
            console.warn(
                '[VLIQ][FrostedCrystal] mode application skipped: ' + error
            );
        }
    }

    async enable() {
        if (this._enabled)
            return;

        this._vendor = await loadLiquidGlassVendorModules(
            this._vliqSettings
        );
        validateVendorApi(this._vendor);
        this._settings = createLiquidGlassSettings();
        this._ensureFullGlassOpticsProfile();
        // Seed the user-selected mode BEFORE creating any glass effects so
        // login never flashes Liquid material before Frosted is ready.
        this._applyFrostedCrystalSettings();

        const externalRoot = activeUpstreamExtensionRoot();
        this._externalGlobalStack = Boolean(
            externalRoot &&
            externalRoot === this._vendor.root
        );

        this._logger = new this._vendor.Logger(this._settings);
        if (!this._externalGlobalStack)
            this._vendor.setUtilsLogger(this._logger);

        if (!this._externalGlobalStack)
            this._loadStylesheet();

        this._enabled = true;
        // Paint Milky natively from the FIRST frame, before popup/dock
        // managers start attaching; prevent a one-frame Liquid flash.
        const initialMaterial = this._vliqSettings?.get_string?.('glass-style');
        this._syncMilkyAppearanceClass(
            ['milky', 'charcoal'].includes(initialMaterial),
            initialMaterial === 'charcoal'
        );

        // Hook GNOME's existing wallpaper actors before creating Orb/Popup
        // glass and the shared BackgroundMirror. Original (default) does
        // not instantiate a ShaderEffect or change the user's wallpaper.
        try {
            this._wallpaperAtmosphereManager =
                new WallpaperAtmosphereManager(this._vliqSettings);
            this._wallpaperAtmosphereManager.setup();
            this._managerHealth.wallpaperAtmosphereManager = true;
        } catch (error) {
            try {
                this._wallpaperAtmosphereManager?.cleanup?.();
            } catch {}
            this._wallpaperAtmosphereManager = null;
            this._managerHealth.wallpaperAtmosphereManager = false;
            console.warn(
                '[VLIQ][Atmosphere] native wallpaper effects unavailable: ' +
                error
            );
        }

        console.log(
            '[VLIQ][LiquidGlass] full upstream integration root: ' +
            this._vendor.root
        );

        // The upstream extension styles panel dropdowns, not the actual
        // GNOME top bar. Attach the same upstream DashManager rendering
        // pipeline to Main.panel so the top panel itself receives glass.
        this._setupTopPanelGlass();

        // Orb is a VLIQ-owned surface. The upstream Liquid Glass extension
        // never knows about vliq-layer, so it must be attached even
        // when we reuse an already-active upstream renderer stack.
        try {
            this._orbGlassManager =
                new OrbGlassManager({
                    vendor: this._vendor,
                    settings: this._settings,
                    readAppearance: () =>
                        this._readSharedCardAppearance(),
                });
            this._orbGlassManager.setup();
            this._managerHealth.orbGlassManager = true;
            console.log(
                '[VLIQ][LiquidGlass] orbGlassManager active'
            );
        } catch (error) {
            this._orbGlassManager = null;
            this._managerHealth.orbGlassManager = false;
            console.error(
                '[VLIQ][LiquidGlass] orbGlassManager setup failed: ' +
                error +
                '\n' +
                (error?.stack ?? '')
            );
        }

        try {
            this._spotlightGlassManager =
                new SpotlightGlassManager({
                    vendor: this._vendor,
                    settings: this._settings,
                    readAppearance: () =>
                        this._readSharedCardAppearance(),
                });
            this._spotlightGlassManager.setup();
            this._managerHealth.spotlightGlassManager = true;
            console.log(
                '[VLIQ][LiquidGlass] spotlightGlassManager active'
            );
        } catch (error) {
            this._spotlightGlassManager = null;
            this._managerHealth.spotlightGlassManager = false;
            console.error(
                '[VLIQ][LiquidGlass] spotlightGlassManager setup failed: ' +
                error
            );
        }

        // App/window previews live outside GNOME's native popup registry.
        // Reuse the tested ShellCardSurface pipeline on demand, even when an
        // independently active upstream glass stack owns normal shell cards.
        // No preview is allocated until there is a real running window.
        try {
            this._previewGlassManager =
                new ShellCardGlassManager({
                    vendor: this._vendor,
                    settings: this._settings,
                    readAppearance: () =>
                        this._readSharedCardAppearance(),
                    manualOnly: true,
                });
            this._previewGlassManager.setup();
            this._managerHealth.previewGlassManager = true;
        } catch (error) {
            try { this._previewGlassManager?.cleanup?.(); } catch {}
            this._previewGlassManager = null;
            this._managerHealth.previewGlassManager = false;
            console.warn('[VLIQ][PreviewGlass] setup failed: ' + error);
        }

        // Keep VLIQ-owned materials live-bound to the same shared appearance
        // controls in both standalone and upstream-stack modes.
        this._setupSharedCardAppearanceSync();

        // Dash-to-Dock's extend-height setting is its panel-mode source of
        // truth. Track it independently from the glass renderer so panel mode
        // can intentionally use a premium non-glass surface.
        await this._setupUbuntuDockBridge();
        this._setupDashToDockModeWatch();
        this._setupDockVerticalOffsetWatch();

        if (this._dockIsPanelMode())
            this._syncDockGlassPreferenceForPanelMode(true);

        this._findNativeDashToDock();

        if (this._externalGlobalStack) {
            console.warn(
                '[VLIQ][LiquidGlass] original Liquid Glass extension is ' +
                'already active; reusing its global manager stack and ' +
                'attaching only VLIQ-specific dock surfaces.'
            );
            this._installDebugState();
            return;
        }

        this._setupDiagnostics();

        const start = (name, fn) => {
            try {
                fn();
                this._managerHealth[name] = true;
                console.log(
                    '[VLIQ][LiquidGlass] ' +
                    name +
                    ' active'
                );
                return true;
            } catch (error) {
                this._managerHealth[name] = false;
                console.error(
                    '[VLIQ][LiquidGlass] ' +
                    name +
                    ' setup failed: ' +
                    error +
                    '\n' +
                    (error?.stack ?? '')
                );
                return false;
            }
        };

        start('popupGlassManager', () => {
            this._popupGlassManager =
                new PopupGlassManager({
                    vendor: this._vendor,
                    settings: this._settings,
                    vliqSettings:
                        this._vliqSettings,
                    readAppearance: () =>
                        this._readSharedCardAppearance(),
                });
            this._popupGlassManager.setup();
        });

        start('shellCardGlassManager', () => {
            this._shellCardGlassManager =
                new ShellCardGlassManager({
                    vendor: this._vendor,
                    settings: this._settings,
                    readAppearance: () =>
                        this._readSharedCardAppearance(),
                });
            this._shellCardGlassManager.setup();
        });

        start('appGridBackdropManager', () => {
            this._appGridBackdropManager =
                new AppGridBackdropManager({
                    atmosphereManager: this._wallpaperAtmosphereManager,
                });
            this._appGridBackdropManager.setup();
        });

        start('overviewCloseGlassManager', () => {
            this._overviewCloseGlassManager =
                new OverviewCloseGlassManager({
                    vendor: this._vendor,
                    settings: this._settings,
                    readAppearance: () =>
                        this._readSharedCardAppearance(),
                });
            this._overviewCloseGlassManager.setup();
        });

        start('sharedAdaptiveTextManager', () => {
            this._sharedAdaptiveTextManager =
                new SharedAdaptiveTextManager({
                    vendor: this._vendor,
                });
            this._sharedAdaptiveTextManager.setup();
        });

        start('nativeNotificationStyler', () => {
            this._setupNativeNotificationStyler();
        });

        start('osdManager', () => {
            this._osdManager = new this._vendor.OsdManager(
                this._vendor.root,
                this._settings,
                this._logger,
                VLIQ_GLASS_ROLES.osdCard
            );
            this._installMilkyOsdAdapter();
            this._osdManager.setup();
            this._syncMilkyOsdMaterial();
        });

        // PopupMenu.prototype is the single outer-card path for Date Menu,
        // Quick Settings, panel menus and context/app menus. Date + Quick
        // nested cards also share PopupGlass' one clone-of-parent pipeline;
        // do not stack the legacy QuickSettingsManager renderer on top.

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => {
                this._scheduleNativeDashRescan();
                for (const entry of this._nativeDashEntries) {
                    this._syncNativeIntellihideTarget(
                        entry,
                        true
                    );
                }
                this._notificationGlassManager?.updateAppearance();
                this._popupGlassManager?.updateAppearance();
                this._shellCardGlassManager?.updateAppearance();
                this._overviewCloseGlassManager?.updateAppearance();
                this._orbGlassManager?.updateAppearance();
                this._spotlightGlassManager?.refresh();
                this._sharedAdaptiveTextManager?.refresh();
            }
        );

        if (this._nativeDashEntries.length === 0) {
            this._dashTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                2000,
                () => {
                    try {
                        if (!this._findNativeDashToDock())
                            this._scheduleNativeDashRescan();
                    } finally {
                        this._dashTimeoutId = 0;
                    }
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        console.log(
            '[VLIQ][LiquidGlass] immediate manager health: ' +
            JSON.stringify(this._managerHealth)
        );

        this._installDebugState();
    }

    _ensureFullGlassOpticsProfile() {
        if (!this._settings || !this._vliqSettings)
            return;

        let version = 0;
        try {
            version = this._vliqSettings.get_int(
                'glass-optics-profile-version'
            );
        } catch {
            return;
        }

        if (version < 1) {
            // The vendored renderer already implements the full optical model.
            // Its conservative defaults intentionally ship chroma/specular/sheen
            // at zero, which reads as ordinary frosted blur. Seed a one-time
            // VLIQ profile that makes the lens unmistakable while keeping the
            // shader GPU-native and avoiding CPU framebuffer readback.
            const doubles = {
                'glass-max-z': 82.0,
                'glass-displacement-scale': 24.0,
                'glass-edge-smoothing': 0.85,
                'glass-profile-shape-n': 3.8,
                'glass-ior': 1.72,
                'glass-chroma-strength': 2.2,
                'glass-specular-intensity': 0.48,
                'glass-shininess': 56.0,
                'glass-rim-width': 3.4,
                'glass-rim-intensity': 0.78,
                'glass-rim-directional-power': 1.7,
                'glass-rim-power': 2.5,
                'glass-rim-light-color-intensity': 1.15,
                'glass-sheen-intensity': 0.14,
                'glass-light-angle-deg': 105.0,
                'shadow-radius': 30.0,
                'shadow-intensity': 0.16,
                'glass-ao-intensity': 0.42,
                'glass-ao-radius': 2.2,
                'menu-brightness': 1.03,
                'menu-contrast': 1.05,
                'menu-saturation': 1.18,
                'notification-brightness': 1.03,
                'notification-contrast': 1.05,
                'notification-saturation': 1.18,
                'osd-brightness': 1.03,
                'osd-contrast': 1.05,
                'osd-saturation': 1.18,
                'dock-brightness': 1.02,
                'dock-contrast': 1.04,
                'dock-saturation': 1.15,
            };

            for (const [key, value] of Object.entries(doubles)) {
                try {
                    this._settings.set_double(key, value);
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] optics key skipped ' +
                        key + ': ' + error
                    );
                }
            }

            try {
                this._settings.set_int('blur-method', 1);
                this._settings.set_int('glass-blur-downscale', 2);

                // Refraction should dominate the look; blur and tint support it
                // instead of turning the surface into an opaque frosted card.
                this._vliqSettings.set_int('glass-blur', 12);
                this._vliqSettings.set_int('glass-opacity', 8);
                this._vliqSettings.set_string(
                    'glass-tint-color',
                    '#ffffff'
                );
                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    1
                );
                version = 1;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] optics profile migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] full refractive optics profile seeded'
            );
        }

        if (version < 2) {
            // Surface profile v2: align Top Panel and Ubuntu Dock with the
            // refractive system material without changing margin, placement,
            // glass expansion, icon geometry or dock behavior.
            //
            // Respect explicit user overrides: only seed keys that have never
            // been written in this settings namespace.
            const setDoubleIfUnset = (key, value) => {
                try {
                    if (this._settings.get_user_value(key) === null)
                        this._settings.set_double(key, value);
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] dock profile key skipped ' +
                        key + ': ' + error
                    );
                }
            };

            const setIntIfUnset = (key, value) => {
                try {
                    if (this._settings.get_user_value(key) === null)
                        this._settings.set_int(key, value);
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] dock profile key skipped ' +
                        key + ': ' + error
                    );
                }
            };

            const setStringIfUnset = (key, value) => {
                try {
                    if (this._settings.get_user_value(key) === null)
                        this._settings.set_string(key, value);
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] dock profile key skipped ' +
                        key + ': ' + error
                    );
                }
            };

            setStringIfUnset('dock-tint-color', '#ffffff');
            setDoubleIfUnset('dock-tint-strength', 0.06);
            setIntIfUnset('dock-blur-radius', 8);
            setDoubleIfUnset('dock-corner-radius', 28.0);

            try {
                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    2
                );
                version = 2;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] dock optics profile migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] panel/dock optical profile v2 seeded'
            );
        }

        if (version < 3) {
            // Material profile v3: reduce bulk tint/blur so refraction remains
            // readable, then add a separate low-opacity neutral white veil.
            // The veil is painted by each surface above LiquidEffect and below
            // native content; it should read as glass body, not colored fog.
            try {
                this._vliqSettings.set_int('glass-opacity', 3);
                this._vliqSettings.set_int('glass-blur', 9);
                this._vliqSettings.set_int('glass-filter-opacity', 5);
                this._vliqSettings.set_string(
                    'glass-tint-color',
                    '#ffffff'
                );

                // Top panel / Ubuntu Dock share DockManager material settings.
                // Keep them even clearer than cards so icons stay crisp.
                this._settings.set_double('dock-tint-strength', 0.03);
                this._settings.set_int('dock-blur-radius', 6);

                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    3
                );
                version = 3;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] clear-glass profile migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] clear-glass material profile v3 seeded'
            );
        }

        if (version < 4) {
            // v4 micro-tune: less bulk blur/tint globally, with Date Menu
            // calibrated independently. Preserve manual edits made after v3 by
            // only replacing values that still equal our previous seed.
            try {
                if (this._vliqSettings.get_int('glass-opacity') === 3)
                    this._vliqSettings.set_int('glass-opacity', 2);
                if (this._vliqSettings.get_int('glass-blur') === 9)
                    this._vliqSettings.set_int('glass-blur', 7);
                if (this._vliqSettings.get_int('glass-filter-opacity') === 5)
                    this._vliqSettings.set_int('glass-filter-opacity', 4);

                if (this._settings.get_double('dock-tint-strength') === 0.03)
                    this._settings.set_double('dock-tint-strength', 0.02);
                if (this._settings.get_int('dock-blur-radius') === 6)
                    this._settings.set_int('dock-blur-radius', 4);

                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    4
                );
                version = 4;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] micro-tune profile migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] Date Menu micro-tune/performance profile v4 seeded'
            );
        }

        if (version < 5) {
            // v5 moves optical uniforms to renderer GSettings. Migrate only
            // untouched legacy seed values; manual preference edits survive.
            // Replacement values exactly match the premium role that used to
            // be written directly into each effect, so the accepted baseline
            // stays visually unchanged.
            const migrateDoubleIfSeeded = (
                key,
                previousValue,
                premiumValue
            ) => {
                try {
                    const current = this._settings.get_double(key);
                    if (Math.abs(current - previousValue) < 0.0001)
                        this._settings.set_double(key, premiumValue);
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] optics v5 key skipped ' +
                        key + ': ' + error
                    );
                }
            };

            migrateDoubleIfSeeded('glass-max-z', 82.0, 90.0);
            migrateDoubleIfSeeded('glass-displacement-scale', 24.0, 31.0);
            migrateDoubleIfSeeded('glass-edge-smoothing', 0.85, 0.82);
            migrateDoubleIfSeeded('glass-profile-shape-n', 3.8, 3.9);
            migrateDoubleIfSeeded('glass-ior', 1.72, 1.68);
            migrateDoubleIfSeeded('glass-chroma-strength', 2.2, 1.4);
            migrateDoubleIfSeeded('glass-specular-intensity', 0.48, 0.55);
            migrateDoubleIfSeeded('glass-shininess', 56.0, 62.0);
            migrateDoubleIfSeeded('glass-rim-width', 3.4, 2.8);
            migrateDoubleIfSeeded('glass-rim-intensity', 0.78, 0.90);
            migrateDoubleIfSeeded('glass-rim-directional-power', 1.7, 1.55);
            migrateDoubleIfSeeded('glass-rim-power', 2.5, 2.3);
            migrateDoubleIfSeeded('glass-rim-light-color-intensity', 1.15, 1.18);
            migrateDoubleIfSeeded('glass-sheen-intensity', 0.14, 0.10);
            migrateDoubleIfSeeded('glass-light-angle-deg', 105.0, 108.0);
            migrateDoubleIfSeeded('shadow-radius', 30.0, 0.0);
            migrateDoubleIfSeeded('shadow-intensity', 0.16, 0.0);
            migrateDoubleIfSeeded('glass-ao-intensity', 0.42, 0.34);
            migrateDoubleIfSeeded('glass-ao-radius', 2.2, 1.3);

            try {
                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    5
                );
                version = 5;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] optics v5 migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] live optics controls profile v5 seeded'
            );
        }

        if (version < 6) {
            // v6 increases perceived glass thickness without increasing blur,
            // tint, IOR or renderer count. glass-max-z controls physical dome
            // depth; glass-displacement-scale controls optical thickness /
            // refraction magnitude. Only exact v5 seed values are migrated so
            // manual advanced optics edits survive.
            const migrateThicknessIfSeeded = (
                key,
                previousValue,
                thickerValue
            ) => {
                try {
                    const current =
                        this._settings.get_double(key);
                    if (
                        Math.abs(
                            current - previousValue
                        ) < 0.0001
                    ) {
                        this._settings.set_double(
                            key,
                            thickerValue
                        );
                    }
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] thickness v6 key skipped ' +
                        key + ': ' + error
                    );
                }
            };

            migrateThicknessIfSeeded(
                'glass-max-z',
                90.0,
                104.0
            );
            migrateThicknessIfSeeded(
                'glass-displacement-scale',
                31.0,
                36.0
            );

            try {
                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    6
                );
                version = 6;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] thickness v6 migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] thicker shared glass profile v6 seeded'
            );
        }

        if (version < 7) {
            // v7 pushes the accepted thicker profile one step further while
            // leaving blur, tint, IOR, rim and shader topology unchanged.
            // Only exact v6 seed values migrate; manual optics overrides stay.
            const migrateThicknessV7IfSeeded = (
                key,
                previousValue,
                thickerValue
            ) => {
                try {
                    const current =
                        this._settings.get_double(key);
                    if (
                        Math.abs(
                            current - previousValue
                        ) < 0.0001
                    ) {
                        this._settings.set_double(
                            key,
                            thickerValue
                        );
                    }
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] thickness v7 key skipped ' +
                        key + ': ' + error
                    );
                }
            };

            migrateThicknessV7IfSeeded(
                'glass-max-z',
                104.0,
                118.0
            );
            migrateThicknessV7IfSeeded(
                'glass-displacement-scale',
                36.0,
                42.0
            );

            try {
                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    7
                );
                version = 7;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] thickness v7 migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] extra-thick shared glass profile v7 seeded'
            );
        }

        if (version < 8) {
            // v8 performance profile: geometry/input remain on the native
            // compositor frame clock, while expensive cloned-scene refreshes
            // default to 24 FPS. Respect an explicit user FPS override.
            try {
                if (
                    this._vliqSettings.get_user_value(
                        'glass-live-scene-fps'
                    ) === null
                ) {
                    this._vliqSettings.set_int(
                        'glass-live-scene-fps',
                        24
                    );
                }

                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    8
                );
                version = 8;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] performance v8 migration incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] performance profile v8 seeded'
            );
        }

        if (version < 9) {
            // v9: richer liquid optics without a stronger fog/blur layer.
            // Only change values that match the shipped v7/v5 profile;
            // advanced preferences the user customized remain untouched.
            // MaterialSettings owns these uniforms and its live GSettings
            // bindings propagate the migrated values to all glass surfaces.
            // Historical targets must not move as the current role evolves.
            const seededOptics = [
                ['glass-max-z', 118.0, 132.0],
                ['glass-displacement-scale', 42.0, 50.0],
                ['glass-chroma-strength', 1.4, 1.6],
                ['glass-specular-intensity', 0.55, 0.69],
                ['glass-shininess', 62.0, 70.0],
                ['glass-rim-width', 2.8, 3.3],
                ['glass-rim-intensity', 0.90, 1.07],
                ['glass-rim-power', 2.3, 2.15],
                [
                    'glass-rim-light-color-intensity',
                    1.18,
                    1.24,
                ],
                ['glass-sheen-intensity', 0.10, 0.15],
            ];

            for (const [key, previous, target] of seededOptics) {
                try {
                    const current = this._settings.get_double(key);
                    if (Number.isFinite(target) &&
                        Math.abs(current - previous) < 0.0001) {
                        this._settings.set_double(key, target);
                    }
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] liquid optics v9 skipped ' +
                        key + ': ' + error
                    );
                }
            }

            // Do not touch native geometry, shaders, blur radius, downscale,
            // neutral milky tint/grain, contrast or any saved custom setting.
            try {
                this._vliqSettings.set_int(
                    'glass-optics-profile-version',
                    9
                );
                version = 9;
            } catch (error) {
                console.warn(
                    '[VLIQ][LiquidGlass] liquid optics v9 incomplete: ' +
                    error
                );
            }

            console.log(
                '[VLIQ][LiquidGlass] richer liquid optics v9 seeded'
            );
        }

        if (version < 10) {
            // v10 liquid-lens tuning: existing material uniforms only.
            // Respect custom renderer controls, including explicitly disabled
            // chromatic aberration and manual IOR/refraction values.
            const optics = VLIQ_GLASS_ROLES.innerCard.optics;
            const seeds = [
                ['glass-max-z', 132.0, 'max_z'],
                ['glass-displacement-scale', 50.0, 'displacement_scale'],
                ['glass-ior', 1.68, 'ior'],
                ['glass-chroma-strength', 1.6, 'chroma_strength'],
                ['glass-specular-intensity', 0.69, 'specular_intensity'],
                ['glass-shininess', 70.0, 'shininess'],
                ['glass-rim-width', 3.3, 'rim_width'],
                ['glass-rim-intensity', 1.07, 'rim_intensity'],
                ['glass-rim-power', 2.15, 'rim_power'],
                ['glass-rim-light-color-intensity', 1.24, 'rim_light_color_intensity'],
                ['glass-sheen-intensity', 0.15, 'sheen_intensity'],
            ];
            let complete = true;
            for (const [key, previous, name] of seeds) {
                try {
                    const current = this._settings.get_double(key);
                    const target = optics[name];
                    if (Number.isFinite(target) &&
                        Math.abs(current - previous) < 0.0001)
                        this._settings.set_double(key, target);
                } catch (error) {
                    complete = false;
                    console.warn(
                        '[VLIQ][LiquidGlass] v10 key skipped ' +
                        key + ': ' + error
                    );
                }
            }

            // A schema/load error cannot silently mark a partial upgrade
            // successful. Never touch blur, tint, glass actors or geometry.
            if (complete) {
                try {
                    this._vliqSettings.set_int(
                        'glass-optics-profile-version', 10
                    );
                    version = 10;
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] v10 migration incomplete: ' +
                        error
                    );
                }
            }
            if (version === 10)
                console.log(
                    '[VLIQ][LiquidGlass] richer liquid optics v10 seeded'
                );
        }

        if (version < 11) {
            // Thinner physical light band for the shared Liquid Glass rim.
            // Migrate only the exact v10 stock value. Respect user-chosen
            // Rim Width, including 0 (disabled), even across hot reloads.
            let complete = true;
            try {
                const current = this._settings.get_double('glass-rim-width');
                if (Math.abs(current - 3.7) < 0.0001)
                    this._settings.set_double(
                        'glass-rim-width',
                        VLIQ_GLASS_ROLES.innerCard.optics.rim_width
                    );
            } catch (error) {
                complete = false;
                console.warn(
                    '[VLIQ][LiquidGlass] thin rim v11 incomplete: ' + error
                );
            }
            if (complete) {
                try {
                    this._vliqSettings.set_int(
                        'glass-optics-profile-version', 11
                    );
                    version = 11;
                } catch (error) {
                    console.warn(
                        '[VLIQ][LiquidGlass] thin rim v11 incomplete: ' + error
                    );
                }
            }
            if (version === 11)
                console.log(
                    '[VLIQ][LiquidGlass] thin shared optical rim v11 seeded'
                );
        }
    }

    _readSharedCardAppearance() {
        if (!this._vliqSettings) {
            return {
                milky: false,
                charcoal: false,
                milkyOpacity: 0.24,
                milkyBorder: 0.20,
                milkyWhiteness: 0,
                opacity: 0,
                tint: '#ffffff',
                r: 255,
                g: 255,
                b: 255,
                blur: 0,
                filterOpacity: 0.05,
                fill: 'rgba(255,255,255,0)',
            };
        }

        const opacity = clampNumber(
            this._vliqSettings.get_int(
                'glass-opacity'
            ),
            0,
            100
        ) / 100;

        const tint =
            this._vliqSettings.get_string(
                'glass-tint-color'
            );
        const [r, g, b] = parseHexRgb(tint);

        const blur = clampNumber(
            this._vliqSettings.get_int(
                'glass-blur'
            ),
            0,
            80
        );

        const filterOpacity = clampNumber(
            this._vliqSettings.get_int(
                'glass-filter-opacity'
            ),
            0,
            20
        ) / 100;

        const sceneFps = clampNumber(
            this._vliqSettings.get_int(
                'glass-live-scene-fps'
            ),
            15,
            60
        );

        const dateMenu = {
            opacity: clampNumber(
                this._vliqSettings.get_int(
                    'date-menu-glass-opacity'
                ),
                0,
                20
            ) / 100,
            blur: clampNumber(
                this._vliqSettings.get_int(
                    'date-menu-glass-blur'
                ),
                0,
                20
            ),
            filterOpacity: clampNumber(
                this._vliqSettings.get_int(
                    'date-menu-glass-filter-opacity'
                ),
                0,
                20
            ) / 100,
        };

        return {
            // Legacy Milky flag means flat-material rendering (GPU off).
            milky: ['milky', 'charcoal'].includes(
                this._vliqSettings.get_string('glass-style')),
            charcoal: this._vliqSettings.get_string('glass-style') === 'charcoal',
            milkyOpacity: clampNumber(this._vliqSettings.get_int('milky-opacity'), 0, 100) / 100,
            milkyBorder: clampNumber(this._vliqSettings.get_int('milky-border'), 0, 100) / 100,
            milkyWhiteness: clampNumber(this._vliqSettings.get_int('milky-whiteness'), 0, 100) / 100,
            opacity,
            tint,
            r,
            g,
            b,
            blur,
            filterOpacity,
            sceneFps,
            dateMenu,
            fill:
                `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`,
        };
    }

    _applySharedDashMaterial(manager, surface = 'dock') {
        const effect = manager?.effect;
        if (!effect)
            return;

        const isTopPanel = surface === 'topPanel';
        const role = isTopPanel
            ? VLIQ_GLASS_ROLES.topPanel
            : VLIQ_GLASS_ROLES.dock;
        const adapter = isTopPanel
            ? VLIQ_GLASS_ADAPTERS.topPanel
            : VLIQ_GLASS_ADAPTERS.dock;
        const state = this._readSharedCardAppearance();

        let brightness = null;
        let contrast = null;
        let saturation = null;
        let cornerRadius = isTopPanel
            ? (adapter.cornerRadius ?? 0)
            : null;

        try {
            brightness =
                this._settings.get_double('dock-brightness');
            contrast =
                this._settings.get_double('dock-contrast');
            saturation =
                this._settings.get_double('dock-saturation');

            if (!isTopPanel) {
                cornerRadius =
                    this._settings.get_double(
                        'dock-corner-radius'
                    );
            }
        } catch {
            // Keep renderer defaults if an optional dock key is unavailable.
        }

        applyVLIQGlassRole(
            effect,
            role,
            {
                tintColor: [
                    (state.r ?? 255) / 255,
                    (state.g ?? 255) / 255,
                    (state.b ?? 255) / 255,
                ],
                tintStrength:
                    adapter.inheritGlobalTint
                        ? (state.opacity ?? role.tintStrength)
                        : role.tintStrength,
                baseBlur:
                    adapter.inheritGlobalBlur
                        ? (state.blur ?? 7)
                        : 7,
                cornerRadius,
                brightness,
                contrast,
                saturation,
                multiRegion: adapter.multiRegion,
            }
        );

        // DashManager owns geometry/capture semantics for both surfaces.
        // Shared material application must never change that contract.
        effect.setIsDock?.(true);
    }

    // Drag lifecycle bridge: keep the Orb foreground actor and the separate
    // stage-level refractive material in the same compositor update cadence.
    // Other system glass surfaces are deliberately unaffected.
    setOrbDragging(active) {
        this._orbGlassManager?.setDragActive?.(active);
    }

    _syncMilkyOsdMaterial(enabled = this._milkyModeActive) {
        for (const state of this._osdManager?._osdStates ?? []) {
            try {
                if (enabled) {
                    state.bgActor?.hide?.();
                    if (state.bgActor)
                        state.bgActor.opacity = 0;
                    state.targetBox?.add_style_class_name?.('vliq-milky-osd');
                } else {
                    state.targetBox?.remove_style_class_name?.('vliq-milky-osd');
                }
            } catch {}
        }
    }

    _installMilkyOsdAdapter() {
        const osd = this._osdManager;
        if (!osd || osd._vliqMilkySyncWrapped ||
            typeof osd._syncGeometry !== 'function')
            return;
        // Wrap the *instance* so this works with a hot-cached vendor module.
        // Never re-register an existing GObject or mutate the vendor source.
        const original = osd._syncGeometry.bind(osd);
        osd._syncGeometry = state => {
            if (this._milkyModeActive) {
                state?.bgActor?.hide?.();
                state?.targetBox?.add_style_class_name?.('vliq-milky-osd');
                return; // Native OSD keeps its input/volume progress UI.
            }
            state?.targetBox?.remove_style_class_name?.('vliq-milky-osd');
            return original(state);
        };
        osd._vliqMilkySyncWrapped = true;
    }

    _syncMilkyAppearanceClass(enabled, charcoal = false) {
        // Flat mode retains legacy shader-suppression semantics while
        // applying exactly one native appearance class at a time.
        this._milkyModeActive = enabled;
        const uiGroup = Main.layoutManager?.uiGroup ?? Main.uiGroup;
        if (uiGroup) {
            if (enabled && !charcoal)
                uiGroup.add_style_class_name?.('vliq-global-milky');
            else
                uiGroup.remove_style_class_name?.('vliq-global-milky');
            if (enabled && charcoal)
                uiGroup.add_style_class_name?.('vliq-global-charcoal');
            else
                uiGroup.remove_style_class_name?.('vliq-global-charcoal');
        }
        this._syncMilkyOsdMaterial(enabled);
    }

    _applySharedCardAppearance() {
        const state = this._readSharedCardAppearance();

        // CSS-only Milky must work even with a cached legacy vendor module.
        this._syncMilkyAppearanceClass(
            state.milky === true, state.charcoal === true);
        this._popupGlassManager?.updateAppearance(state);
        this._shellCardGlassManager?.updateAppearance(state);
        this._previewGlassManager?.updateAppearance(state);
        this._appGridBackdropManager?.updateAppearance(state);
        this._overviewCloseGlassManager?.updateAppearance(state);
        this._orbGlassManager?.updateAppearance(state);
        this._spotlightGlassManager?.updateAppearance(state);
        this._sharedAdaptiveTextManager?.refresh();
        this._applyCardAppearanceStylesheet(state);
        this._applyAllNativeNotificationAppearances(state);
        this._osdManager?.updateMaterialAppearance?.(state);
        this._topPanelIslands?.updateAppearance();
        for (const entry of this._nativeDashEntries) {
            if (entry.manager) {
                this._applySharedDashMaterial(entry.manager, 'dock');
                this._syncNativeDockVisualState(entry, true);
            }
            entry.panelLiquidSurface?.updateAppearance?.();
            if (entry.panelPaintActive && entry.panelBackgroundActor)
                this._setDockPanelPremiumStyle(
                    entry, entry.panelBackgroundActor);
        }

        console.log(
            '[VLIQ][CardAppearance] applied ' +
            'opacity=' +
            Math.round(state.opacity * 100) +
            ' tint=' +
            state.tint +
            ' blur=' +
            state.blur +
            ' filter=' +
            Math.round((state.filterOpacity ?? 0) * 100) +
            ' sceneFps=' +
            (state.sceneFps ?? 30) +
            ' systemAccent=' +
            this._readSystemAccentColor().name + '/' +
            this._readSystemAccentColor().color +
            ' dateMenu=' +
            Math.round((state.dateMenu?.opacity ?? 0) * 100) + '/' +
            (state.dateMenu?.blur ?? 0) + '/' +
            Math.round((state.dateMenu?.filterOpacity ?? 0) * 100)
        );
    }

    _readSystemAccentColor() {
        let name = 'blue';

        try {
            name =
                this._desktopInterfaceSettings
                    ?.get_string?.('accent-color') ??
                name;
        } catch {
            // GNOME default blue is the safe fallback.
        }

        return {
            name,
            color:
                SYSTEM_ACCENT_COLORS[name] ??
                SYSTEM_ACCENT_COLORS.blue,
        };
    }

    _queueSharedCardAppearanceApply() {
        if (this._cardAppearanceApplyId)
            return;

        this._cardAppearanceApplyId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                80,
                () => {
                    this._cardAppearanceApplyId = 0;
                    if (this._enabled)
                        this._applySharedCardAppearance();
                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _setupSharedCardAppearanceSync() {
        if (!this._desktopInterfaceSettings) {
            try {
                this._desktopInterfaceSettings =
                    new Gio.Settings({
                        schema_id:
                            DESKTOP_INTERFACE_SCHEMA,
                    });

                this._desktopAccentChangedId =
                    this._desktopInterfaceSettings.connect(
                        'changed::accent-color',
                        () => {
                            this._queueSharedCardAppearanceApply();
                        }
                    );
            } catch (error) {
                this._desktopInterfaceSettings = null;
                this._desktopAccentChangedId = 0;
                console.warn(
                    '[VLIQ][Appearance] desktop accent sync unavailable: ' +
                    error
                );
            }
        }

        if (!this._vliqSettings) {
            this._applySharedCardAppearance();
            return;
        }

        if (!this._cardAppearanceSettingId) {
            this._cardAppearanceSettingId =
                this._vliqSettings.connect(
                    'changed',
                    (_settings, key) => {
                        if ([
                            'glass-opacity',
                            'glass-tint-color',
                            'glass-blur',
                            'glass-filter-opacity',
                            'date-menu-glass-opacity',
                            'date-menu-glass-blur',
                            'date-menu-glass-filter-opacity',
                            'glass-live-scene-fps',
                            'glass-style',
                            'milky-opacity',
                            'milky-border',
                            'milky-whiteness',
                            'frost-density',
                            'frost-grain',
                            'frost-edge-glow',
                        ].includes(key)) {
                            if ([
                                'glass-style',
                                'milky-opacity',
                                'milky-border',
                                'milky-whiteness',
                                'frost-density',
                                'frost-grain',
                                'frost-edge-glow',
                            ].includes(key))
                                this._applyFrostedCrystalSettings();
                            this._queueSharedCardAppearanceApply();
                        }
                    }
                );
        }

        this._applySharedCardAppearance();
    }

    _cleanupSharedCardAppearanceSync() {
        this._syncMilkyAppearanceClass(false);
        if (
            this._cardAppearanceSettingId &&
            this._vliqSettings
        ) {
            try {
                this._vliqSettings.disconnect(
                    this._cardAppearanceSettingId
                );
            } catch {
                // Settings may already be tearing down.
            }
        }
        this._cardAppearanceSettingId = 0;

        if (
            this._desktopInterfaceSettings &&
            this._desktopAccentChangedId
        ) {
            try {
                this._desktopInterfaceSettings.disconnect(
                    this._desktopAccentChangedId
                );
            } catch {}
        }
        this._desktopAccentChangedId = 0;
        this._desktopInterfaceSettings = null;

        if (this._cardAppearanceApplyId) {
            try {
                GLib.source_remove(
                    this._cardAppearanceApplyId
                );
            } catch {
                // Debounce source may already be gone.
            }
        }
        this._cardAppearanceApplyId = 0;

        this._unloadCardAppearanceStylesheet();
    }

    _getShellTheme() {
        return St.ThemeContext
            .get_for_stage(global.stage)
            .get_theme();
    }

    _unloadCardAppearanceStylesheet() {
        if (!this._cardCssFile)
            return;

        try {
            this._getShellTheme().unload_stylesheet(
                this._cardCssFile
            );
        } catch (error) {
            console.warn(
                '[VLIQ][CardAppearance] stylesheet unload failed: ' +
                error
            );
        }

        try {
            this._cardCssFile.delete(null);
        } catch {
            // Cached CSS file may already be gone.
        }

        this._cardCssFile = null;
        this._cardCssSignature = '';
    }

    _applyCardAppearanceStylesheet(
        state = this._readSharedCardAppearance()
    ) {
        // Notifications and popup menus have dedicated filter actors. Generic
        // Shell cards use their native card actor itself as the neutral white
        // veil, which is paint-only and therefore does not add another blur
        // pass or disturb layout.
        const filterOpacity = Math.max(
            0,
            Math.min(0.20, state.filterOpacity ?? 0.05)
        );
        const barFilterOpacity = Math.min(
            0.08,
            filterOpacity * 0.6
        );

        const systemAccent =
            this._readSystemAccentColor();
        const accentColor = systemAccent.color;
        const css =
            '/* VLIQ semantic accent: use the actual desktop Appearance setting, not a stale Shell/Yaru token. */\n' +
            '.vliq-liquid-popup-content.datemenu-popover .calendar-day.calendar-today,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .vliq-date-card-text-light .calendar-day.calendar-today,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .vliq-date-card-text-dark .calendar-day.calendar-today {\n' +
            '  color: ' + accentColor + ' !important;\n' +
            '}\n' +
            '.vliq-liquid-popup-content.quick-settings .vliq-quick-active StLabel,\n' +
            '.vliq-liquid-popup-content.quick-settings .vliq-quick-active .quick-toggle-title,\n' +
            '.vliq-liquid-popup-content.quick-settings .vliq-quick-active .quick-toggle-subtitle,\n' +
            '.vliq-liquid-quick-menu-root .vliq-quick-active StLabel,\n' +
            '.vliq-liquid-quick-menu-root .vliq-quick-active .quick-toggle-title,\n' +
            '.vliq-liquid-quick-menu-root .vliq-quick-active .quick-toggle-subtitle {\n' +
            '  color: ' + accentColor + ' !important;\n' +
            '}\n' +
            '#overviewGroup .workspace-thumbnail-indicator {\n' +
            '  border-color: ' + accentColor + ' !important;\n' +
            '}\n' +
            '.vliq-liquid-popup-content.datemenu-popover .datemenu-today-button:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .calendar:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .events-button:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .world-clocks-button:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .weather-button:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .message:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .message-list-clear-button:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .calendar-month-label:focus,\n' +
            '.vliq-liquid-popup-content.datemenu-popover .calendar-month-header .pager-button:focus {\n' +
            '  border-color: ' + accentColor + ' !important;\n' +
            '}\n' +
            '.vliq-liquid-popup-content.quick-settings .quick-slider .slider {\n' +
            '  -barlevel-active-background-color: ' + accentColor + ';\n' +
            '}\n' +
            '.modal-dialog.vliq-liquid-shell-card .modal-dialog-button:default {\n' +
            '  background-color: ' + accentColor + ' !important;\n' +
            '  color: #ffffff !important;\n' +
            '}\n' +            // Running indicators are always the accepted Bottom Taskbar
            // cool-white, never the desktop's changing accent color.
            '.vliq-running-dot {\n' +
            '  background-color: rgba(235, 244, 255, 0.94) !important;\n' +
            '}\n' +
            '.vliq-native-notification-glass,\n' +
            '.vliq-native-notification-glass:hover,\n' +
            '.vliq-native-notification-glass:focus {\n' +
            '  background-color: transparent !important;\n' +
            '  background-image: none !important;\n' +
            '  border-color: transparent !important;\n' +
            '  box-shadow: none !important;\n' +
            '}\n' +
            '.vliq-liquid-shell-card {\n' +
            '  background-color: rgba(255,255,255,' +
            filterOpacity.toFixed(3) +
            ') !important;\n' +
            '  background-image: none !important;\n' +
            '  box-shadow: none !important;\n' +
            '}\n' +
            // The global white filter must not stack over the genuine
            // refractive preview card. Keep global shell-card filtering for
            // every other surface and override this preview only.
            '.vliq-app-preview-card.vliq-liquid-shell-card {\n' +
            '  background-color: transparent !important;\n' +
            '  background-image: none !important;\n' +
            '  border-color: transparent !important;\n' +
            '  box-shadow: none !important;\n' +
            '}\n' +
            // Never repaint a white sheet behind the three detached
            // optical islands when global Appearance filter changes.
            '#panel.vliq-liquid-top-panel {\n' +
            '  background-color: transparent !important;\n' +
            '  background-image: none !important;\n' +
            '  border-radius: 0px !important;\n' +
            '  box-shadow: none !important;\n' +
            '}\n' +
            '#dashtodockDashContainer.liquid-glass-transparent,\n' +
            '.liquid-glass-transparent #dashtodockContainer,\n' +
            '.liquid-glass-transparent .dashtodock-box,\n' +
            '.liquid-glass-transparent .dash-background {\n' +
            '  background-color: rgba(255,255,255,' +
            barFilterOpacity.toFixed(3) +
            ') !important;\n' +
            '  background-image: none !important;\n' +
            '  box-shadow: none !important;\n' +
            '}\n' +
            buildMilkyAppearanceCss(state);

        if (
            this._cardCssFile &&
            this._cardCssSignature === css
        ) {
            return;
        }

        const dir = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'vliq@wonderer.tech',
            'card-appearance',
        ]);
        GLib.mkdir_with_parents(dir, 0o755);

        const path = GLib.build_filenamev([
            dir,
            'cards-' +
            Date.now() +
            '-' +
            this._cardCssCounter++ +
            '.css',
        ]);

        GLib.file_set_contents(path, css);

        // Load FIRST. An invalid/missing St CSS selector must never destroy
        // the last successfully loaded Appearance stylesheet. A theme
        // swap occurs within one Shell event turn, so no extra paint frame.
        const file = Gio.File.new_for_path(path);
        try {
            this._getShellTheme().load_stylesheet(file);
        } catch (error) {
            try { file.delete(null); } catch {}
            console.warn(
                '[VLIQ][Milky] Appearance stylesheet rejected: ' + error
            );
            return;
        }
        this._unloadCardAppearanceStylesheet();
        this._cardCssFile = file;
        this._cardCssSignature = css;

        Main.messageTray?._banner?.queue_redraw?.();
    }

    isBottomTaskbarActive() {
        return this._topPanelIslands?.isBottomTaskbarActive?.() === true;
    }

    ownsBottomTaskbarChrome() {
        // Geometry can temporarily read "not at bottom" during a GNOME
        // 50 relayout. Paint ownership cannot: a live Bottom Taskbar must
        // suppress the old Dock shader and .dash-background throughout.
        return this._topPanelIslands?.ownsBottomTaskbarChrome?.() === true;
    }

    setBottomTaskbarLauncher(callback) {
        this._bottomLauncherCallback =
            typeof callback === 'function' ? callback : null;
        this._topPanelIslands?.setLauncherCallback?.(
            this._bottomLauncherCallback
        );
    }

    _setupTopPanelGlass() {
        if (this._topPanelIslands || !Main.panel)
            return;

        // One configurable native top bar: three independent islands or one
        // full-width, square glass strip. Both use bounded PanelGlassSurface
        // captures and leave GNOME controls and menus in place.
        let manager = null;
        try {
            manager = new TopBarIslands({
                vendor: this._vendor,
                settings: this._settings,
                layoutSettings: this._vliqSettings,
                getDockEntries: () => this._nativeDashEntries,
                onLauncherClick: this._bottomLauncherCallback,
                onLayoutChanged: () => {
                    // Bottom mode must retire native Ubuntu Dock's own
                    // Panel Mode CSS + LiquidEffect; returning to a top
                    // header must restore whichever Dock mode was native.
                    for (const entry of [...this._nativeDashEntries])
                        this._syncNativeDashEntryMode(entry);
                },
                readAppearance: () => this._readSharedCardAppearance(),
            });
            if (!manager.setup()) {
                manager.cleanup();
                console.warn(
                    '[VLIQ][TopBar] native panel boxes unavailable; ' +
                    'leaving GNOME controls functional without glass'
                );
                return;
            }

            this._topPanelIslands = manager;

            // Retain GNOME 50 fullscreen guard in both layouts:
            // native panelBox and bounded glass hide together.
            this._fullscreenPanelChromeGuard =
                new FullscreenPanelChromeGuard({
                    layout: Main.layoutManager,
                    display: global.display,
                    panel: Main.panel,
                    panelManager: manager,
                });
            this._fullscreenPanelChromeGuard.setup();

            console.log(
                '[VLIQ][LiquidGlass] configurable top-header glass active'
            );
        } catch (error) {
            try { this._fullscreenPanelChromeGuard?.cleanup(); } catch {}
            this._fullscreenPanelChromeGuard = null;
            try { manager?.cleanup(); } catch {}
            this._topPanelIslands = null;
            console.error(
                '[VLIQ][LiquidGlass] top bar islands setup failed: ' +
                error + '\n' + (error?.stack ?? '')
            );
        }
    }

    _cleanupTopPanelGlass() {
        try { this._fullscreenPanelChromeGuard?.cleanup(); } catch {}
        this._fullscreenPanelChromeGuard = null;
        try { this._topPanelIslands?.cleanup(); } catch (error) {
            console.warn(
                '[VLIQ][TopBar] cleanup warning: ' + error
            );
        }
        this._topPanelIslands = null;
    }

    _setupNativeNotificationStyler() {
        if (this._notificationGlassManager)
            return;

        this._notificationGlassManager =
            new NotificationGlassManager({
                vendor: this._vendor,
                settings: this._settings,
                readAppearance: () =>
                    this._readSharedCardAppearance(),
            });

        this._notificationGlassManager.setup();

    }

    _applyAllNativeNotificationAppearances(
        state = this._readSharedCardAppearance()
    ) {
        this._notificationGlassManager?.updateAppearance(state);
    }

    _cleanupNativeNotificationStyler() {
        try {
            this._notificationGlassManager?.cleanup();
        } catch (error) {
            console.error(
                '[VLIQ][LiquidGlass] notification material cleanup failed: ' +
                error
            );
        }

        this._notificationGlassManager = null;
    }

    _readDockVerticalOffset() {
        try {
            return clampNumber(
                this._vliqSettings.get_int(
                    'dock-vertical-offset'
                ),
                -64,
                64
            );
        } catch {
            return 0;
        }
    }

    _applyDockVerticalOffset(
        entry,
        slideOverride = null
    ) {
        const dock = entry?.nativeDock;
        const dash = dock?.dash ?? null;
        const visualRoot =
            entry?.nativeBox ??
            dock?._box ??
            null;
        if (!dock || !dash || !visualRoot)
            return;

        // Clean up transforms owned by the two earlier offset experiments so a
        // hot-swap immediately returns to one single translation owner.
        for (const actor of [
            dash,
            dash._background ?? null,
            dash._dashContainer ?? null,
        ]) {
            if (
                actor &&
                Math.abs(
                    actor.translation_y ?? 0
                ) > 0.01
            ) {
                actor.translation_y = 0;
            }
        }

        // Panel mode stays completely native.
        if (this._dockIsPanelMode()) {
            if (
                Math.abs(
                    visualRoot.translation_y ?? 0
                ) > 0.01
            ) {
                visualRoot.translation_y = 0;
            }
            this._syncPanelBackdropGeometry(entry);
            return;
        }

        const offset =
            this._readDockVerticalOffset();

        // Number(null) is 0 in JS, not NaN. Most call sites pass the
        // optional override as null, so the old code ALWAYS treated the
        // otherwise-visible native dock as hidden and reset its offset on
        // every rescan/hover/appearance sync. That desynchronised the native
        // hover rectangle, intellihide and slide animation.
        let slide =
            slideOverride === null ||
            slideOverride === undefined
                ? NaN
                : Number(slideOverride);
        if (!Number.isFinite(slide))
            slide =
                this._readNativeDockSlide(
                    entry
                );
        if (!Number.isFinite(slide))
            slide = 1;

        slide = clampNumber(slide, 0, 1);

        // DashSlideContainer owns native autohide allocation. _box is its one
        // visual child and contains the complete DockDash, so translating _box
        // moves background, icons, labels and hit targets as a single unit
        // without moving children outside DockDash's offscreen texture.
        //
        // Interpolate to zero while hidden so pressure-barrier/autohide behavior
        // remains exactly native at the monitor edge.
        const translationY =
            slide <= NATIVE_DOCK_SLIDE_EPSILON ||
            offset === 0
                ? 0
                : -offset * slide;

        if (
            Math.abs(
                (visualRoot.translation_y ?? 0) -
                translationY
            ) > 0.01
        ) {
            visualRoot.translation_y =
                translationY;
        }
    }

    _applyAllDockVerticalOffsets() {
        for (const entry of this._nativeDashEntries) {
            this._applyDockVerticalOffset(
                entry
            );
            this._syncNativeIntellihideTarget(
                entry,
                true
            );
        }
    }

    _setupDockVerticalOffsetWatch() {
        if (this._dockVerticalOffsetSettingId)
            return;

        try {
            this._dockVerticalOffsetSettingId =
                this._vliqSettings.connect(
                    'changed::dock-vertical-offset',
                    () => {
                        if (!this._enabled)
                            return;

                        this._applyAllDockVerticalOffsets();
                    }
                );
        } catch {
            this._dockVerticalOffsetSettingId = 0;
        }
    }

    _cleanupDockVerticalOffsetWatch() {
        if (
            this._dockVerticalOffsetSettingId &&
            this._vliqSettings
        ) {
            try {
                this._vliqSettings.disconnect(
                    this._dockVerticalOffsetSettingId
                );
            } catch {}
        }

        this._dockVerticalOffsetSettingId = 0;

        // Restore every paint transform owned by this setting on teardown.
        for (const entry of this._nativeDashEntries) {
            try {
                const dash =
                    entry.nativeDock?.dash ??
                    null;
                const actors = [
                    entry.nativeBox ??
                        entry.nativeDock?._box ??
                        null,
                    dash,
                    dash?._background ?? null,
                    dash?._dashContainer ?? null,
                ];

                for (const actor of actors) {
                    if (
                        actor &&
                        Math.abs(
                            actor.translation_y ?? 0
                        ) > 0.01
                    ) {
                        actor.translation_y = 0;
                    }
                }
            } catch {}
        }
    }

    _setupDashToDockModeWatch() {
        if (this._dashToDockSettings)
            return;

        try {
            const source =
                Gio.SettingsSchemaSource.get_default();
            const schema =
                source?.lookup?.(
                    DASH_TO_DOCK_SCHEMA,
                    true
                ) ?? null;

            if (!schema)
                return;

            this._dashToDockSettings =
                new Gio.Settings({
                    settings_schema: schema,
                });

            this._dashToDockPanelModeId =
                this._dashToDockSettings.connect(
                    'changed::extend-height',
                    () => {
                        if (!this._enabled)
                            return;

                        this._beginDockModeTransition(
                            this._dockIsPanelMode()
                        );
                    }
                );

            this._dashToDockFixedModeId =
                this._dashToDockSettings.connect(
                    'changed::dock-fixed',
                    () => {
                        if (!this._enabled)
                            return;

                        this._handleDockFixedModeChanged();
                        this._queueNativeDockAutoHideRefresh();
                    }
                );

            // Ubuntu Dock owns the actual hide/show state machine. When the
            // *native* settings change from VLIQ Prefs (or Ubuntu Settings),
            // repair hover, visibility and stable intellihide target exactly
            // once on the next idle turn AFTER native handlers run. Never
            // compete with Dash-to-Dock by calling _animateIn/_animateOut.
            this._dashToDockVisibilityId =
                this._dashToDockSettings.connect(
                    'changed',
                    (_nativeSettings, key) => {
                        if (
                            !this._enabled ||
                            ![
                                'autohide',
                                'intellihide',
                                'intellihide-mode',
                                'manualhide',
                                'require-pressure-to-show',
                                'pressure-threshold',
                                'show-delay',
                                'hide-delay',
                                'animation-time',
                                'autohide-in-fullscreen',
                                'dock-position',
                                'multi-monitor',
                            ].includes(key)
                        ) {
                            return;
                        }
                        this._queueNativeDockAutoHideRefresh();
                    }
                );
        } catch (error) {
            this._dashToDockSettings = null;
            this._dashToDockPanelModeId = 0;
            this._dashToDockFixedModeId = 0;
            this._dashToDockVisibilityId = 0;
            console.warn(
                '[VLIQ][Dock] Dash-to-Dock panel-mode watch unavailable: ' +
                error
            );
        }
    }

    _queueNativeDockAutoHideRefresh() {
        if (!this._enabled || this._dockAutoHideRefreshId)
            return;

        this._dockAutoHideRefreshId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._dockAutoHideRefreshId = 0;
                if (!this._enabled)
                    return GLib.SOURCE_REMOVE;

                // Native mode/monitor changes can replace the DockDash actor.
                // Rebind first; then repair only the already-present native
                // hover/overlap state, without a second hide/show animation.
                this._findNativeDashToDock();
                for (const entry of this._nativeDashEntries) {
                    this._applyDockVerticalOffset(entry);
                    this._syncNativeIntellihideTarget(entry, true);
                    try {
                        entry.nativeBox?.sync_hover?.();
                    } catch {}
                    try {
                        entry.nativeIntellihide?.forceUpdate?.();
                    } catch {}
                    this._syncNativeDockVisualState(entry, true);
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cleanupDashToDockModeWatch() {
        if (this._dockAutoHideRefreshId) {
            try {
                GLib.source_remove(this._dockAutoHideRefreshId);
            } catch {}
            this._dockAutoHideRefreshId = 0;
        }

        // Restore the exact dock-glass preference that existed before panel
        // mode temporarily suppressed the renderer.
        this._syncDockGlassPreferenceForPanelMode(false);

        if (
            this._dashToDockSettings &&
            this._dashToDockPanelModeId
        ) {
            try {
                this._dashToDockSettings.disconnect(
                    this._dashToDockPanelModeId
                );
            } catch {}
        }

        if (
            this._dashToDockSettings &&
            this._dashToDockFixedModeId
        ) {
            try {
                this._dashToDockSettings.disconnect(
                    this._dashToDockFixedModeId
                );
            } catch {}
        }

        if (
            this._dashToDockSettings &&
            this._dashToDockVisibilityId
        ) {
            try {
                this._dashToDockSettings.disconnect(
                    this._dashToDockVisibilityId
                );
            } catch {}
        }

        this._dashToDockPanelModeId = 0;
        this._dashToDockFixedModeId = 0;
        this._dashToDockVisibilityId = 0;
        this._cancelDockFixedSettle();
        this._dashToDockSettings = null;
    }

    _dockIsFixedMode() {
        try {
            return Boolean(
                this._dashToDockSettings?.get_boolean?.(
                    'dock-fixed'
                )
            );
        } catch {
            return false;
        }
    }

    _cancelDockFixedSettle() {
        this._dockFixedSettleGeneration++;

        if (this._dockFixedSettleStageId) {
            try {
                global.stage.disconnect(
                    this._dockFixedSettleStageId
                );
            } catch {}
            this._dockFixedSettleStageId = 0;
        }

        for (const entry of this._nativeDashEntries) {
            entry.nativeFixedModeSettling = false;
            entry.nativeFixedSettleKey = '';
            entry.nativeFixedSettleFrames = 0;
        }
    }

    _handleDockFixedModeChanged() {
        this._cancelDockFixedSettle();

        // Intelligent Autohide ON (dock-fixed=false): native lifecycle owns
        // reveal/hide immediately; no special handoff is needed.
        if (
            !this._dockIsFixedMode() ||
            this._dockIsPanelMode()
        ) {
            for (const entry of this._nativeDashEntries) {
                this._syncNativeDockBinding(entry);
                this._syncNativeDockVisualState(
                    entry,
                    true
                );
            }
            return;
        }

        // Intelligent Autohide OFF (dock-fixed=true): Ubuntu Dock animates
        // from its current hidden/partial allocation to the permanent shown
        // allocation. Keep glass completely invisible until that native
        // geometry has reached slide=1 and stayed identical for two painted
        // frames. This prevents the short 3–4-icon-wide glass flash.
        for (const entry of this._nativeDashEntries) {
            entry.nativeFixedModeSettling = true;
            entry.nativeFixedSettleKey = '';
            entry.nativeFixedSettleFrames = 0;
            entry.nativeDockStableW = NaN;
            entry.nativeDockStableH = NaN;

            if (
                entry.manager?.bgActor &&
                entry.manager.bgActor.opacity !== 0
            ) {
                entry.manager.bgActor.opacity = 0;
            }
        }

        const generation =
            this._dockFixedSettleGeneration;
        let settleTicks = 0;

        this._dockFixedSettleStageId =
            global.stage.connect(
                'after-paint',
                () => {
                    if (
                        !this._enabled ||
                        generation !==
                            this._dockFixedSettleGeneration
                    ) {
                        return;
                    }

                    if (
                        !this._dockIsFixedMode() ||
                        this._dockIsPanelMode()
                    ) {
                        this._cancelDockFixedSettle();
                        return;
                    }

                    settleTicks++;

                    let allSettled = true;
                    let hasManagedDock = false;

                    for (const entry of this._nativeDashEntries) {
                        const manager = entry.manager;
                        if (
                            !manager ||
                            !this._nativeDashIsReady(
                                entry.container
                            )
                        ) {
                            continue;
                        }

                        hasManagedDock = true;

                        const slide =
                            this._readNativeDockSlide(
                                entry
                            );
                        const state =
                            this._readNativeDockState(
                                entry
                            );
                        const fullyShown =
                            (
                                Number.isFinite(slide) &&
                                slide >=
                                    1 -
                                    NATIVE_DOCK_SLIDE_EPSILON
                            ) ||
                            state ===
                                NATIVE_DOCK_STATE.SHOWN;

                        if (!fullyShown) {
                            entry.nativeFixedSettleKey = '';
                            entry.nativeFixedSettleFrames = 0;
                            allSettled = false;
                            continue;
                        }

                        let bounds = null;
                        try {
                            bounds =
                                manager._readDockBounds?.() ??
                                null;
                        } catch {}

                        const valid =
                            bounds &&
                            Number.isFinite(bounds.baseW) &&
                            Number.isFinite(bounds.baseH) &&
                            bounds.baseW > 9 &&
                            bounds.baseH > 9;

                        if (!valid) {
                            entry.nativeFixedSettleKey = '';
                            entry.nativeFixedSettleFrames = 0;
                            allSettled = false;
                            continue;
                        }

                        const key = [
                            Math.round(bounds.absX * 10) / 10,
                            Math.round(bounds.absY * 10) / 10,
                            Math.round(bounds.baseW * 10) / 10,
                            Math.round(bounds.baseH * 10) / 10,
                        ].join(':');

                        if (
                            key ===
                            entry.nativeFixedSettleKey
                        ) {
                            entry.nativeFixedSettleFrames++;
                        } else {
                            entry.nativeFixedSettleKey = key;
                            entry.nativeFixedSettleFrames = 1;
                        }

                        if (
                            entry.nativeFixedSettleFrames <
                            2
                        ) {
                            allSettled = false;
                        }
                    }

                    if (!hasManagedDock || !allSettled) {
                        // Safety valve only. Normal handoff completes within a
                        // few frames after slide-x reaches 1. Do not retain an
                        // after-paint callback forever if Ubuntu Dock is being
                        // rebuilt or unavailable during the setting change.
                        if (settleTicks < 180)
                            return;
                    }

                    try {
                        global.stage.disconnect(
                            this._dockFixedSettleStageId
                        );
                    } catch {}
                    this._dockFixedSettleStageId = 0;

                    for (const entry of this._nativeDashEntries) {
                        if (!entry.nativeFixedModeSettling)
                            continue;

                        entry.nativeFixedModeSettling = false;
                        entry.nativeFixedSettleKey = '';
                        entry.nativeFixedSettleFrames = 0;

                        // Push the now-final native geometry into the shader
                        // while the glass is still at opacity 0, then reveal.
                        try {
                            entry.manager?._syncGeometry?.();
                        } catch {}

                        this._ensureNativeDockPaintState(
                            entry
                        );
                        this._syncNativeDockVisualState(
                            entry,
                            true
                        );
                    }
                }
            );
    }

    _dockIsPanelMode() {
        try {
            return Boolean(
                this._dashToDockSettings?.get_boolean?.(
                    'extend-height'
                )
            );
        } catch {
            return false;
        }
    }

    _syncDockGlassPreferenceForPanelMode(panelMode) {
        // Our vendored DockManager is detached directly, so changing the
        // global Liquid Glass preference would only create an unnecessary
        // remove/recreate cycle. This preference bridge is needed solely when
        // an already-active upstream Liquid Glass stack owns the dock.
        if (!this._settings || !this._externalGlobalStack)
            return;

        if (panelMode) {
            if (this._dockGlassBeforePanelMode === null) {
                try {
                    this._dockGlassBeforePanelMode =
                        this._settings.get_boolean(
                            'enable-dock-glass'
                        );
                } catch {
                    this._dockGlassBeforePanelMode = false;
                }
            }

            try {
                if (
                    this._settings.get_boolean(
                        'enable-dock-glass'
                    )
                ) {
                    this._settings.set_boolean(
                        'enable-dock-glass',
                        false
                    );
                }
            } catch {}

            return;
        }

        if (this._dockGlassBeforePanelMode === null)
            return;

        const restore =
            this._dockGlassBeforePanelMode;
        this._dockGlassBeforePanelMode = null;

        try {
            if (
                this._settings.get_boolean(
                    'enable-dock-glass'
                ) !== restore
            ) {
                this._settings.set_boolean(
                    'enable-dock-glass',
                    restore
                );
            }
        } catch {}
    }

    async _setupUbuntuDockBridge() {
        this._ubuntuDockModule = null;
        this._ubuntuDockManager = null;

        try {
            const extension =
                Main.extensionManager.lookup(
                    UBUNTU_DOCK_UUID
                );

            if (
                !extension ||
                extension.state !== ExtensionState.ACTIVE
            ) {
                return;
            }

            const stateManager =
                extension.stateObj?.dockManager ?? null;
            if (stateManager) {
                this._ubuntuDockManager = stateManager;
                return;
            }

            const root =
                extension.path ??
                extension.dir?.get_path?.() ??
                null;
            if (!root)
                return;

            const moduleFile =
                Gio.File.new_for_path(
                    GLib.build_filenamev([
                        root,
                        'extension.js',
                    ])
                );

            if (!moduleFile.query_exists(null))
                return;

            const module =
                await import(moduleFile.get_uri());

            this._ubuntuDockModule = module;
            this._ubuntuDockManager =
                module?.dockManager ?? null;
        } catch (error) {
            this._ubuntuDockModule = null;
            this._ubuntuDockManager = null;
            console.warn(
                '[VLIQ][Dock] Ubuntu Dock bridge unavailable: ' +
                error
            );
        }
    }

    _refreshUbuntuDockManager() {
        try {
            const extension =
                Main.extensionManager.lookup(
                    UBUNTU_DOCK_UUID
                );

            this._ubuntuDockManager =
                this._ubuntuDockModule?.dockManager ??
                extension?.stateObj?.dockManager ??
                this._ubuntuDockManager ??
                null;
        } catch {}
    }

    _nativeDockForContainer(container) {
        if (!container)
            return null;

        this._refreshUbuntuDockManager();

        const docks =
            this._ubuntuDockManager?._allDocks ??
            this._ubuntuDockManager?.allDocks ??
            [];

        for (const dock of docks) {
            if (
                dock?.dash?._dashContainer ===
                    container ||
                dock?.dash?._container ===
                    container
            ) {
                return dock;
            }
        }

        return null;
    }

    _disconnectNativeDockSignals(entry) {
        if (!entry)
            return;

        const disconnect = (object, id) => {
            if (!object || !id)
                return;
            try {
                object.disconnect(id);
            } catch {}
        };

        disconnect(
            entry.nativeDock,
            entry.nativeDockStateId
        );
        disconnect(
            entry.nativeDock,
            entry.nativeDockShowingId
        );
        disconnect(
            entry.nativeDock,
            entry.nativeDockHidingId
        );
        disconnect(
            entry.nativeSlider,
            entry.nativeSliderId
        );
        disconnect(
            entry.nativeSlider,
            entry.nativeSliderAllocationId
        );
        disconnect(
            entry.nativeBox,
            entry.nativeBoxAllocationId
        );
        disconnect(
            Main.overview,
            entry.nativeOverviewHiddenId
        );

        // If VLIQ supplied its own normalized overlap target, hand ownership
        // back to Ubuntu Dock before dropping the binding.
        if (
            entry.nativeIntellihide &&
            entry.nativeDock
        ) {
            const nativeBox =
                entry.nativeDock._staticBox ??
                entry.nativeDock.staticBox ??
                null;
            if (nativeBox) {
                try {
                    entry.nativeIntellihide
                        .updateTargetBox?.(
                            nativeBox
                        );
                } catch {}
            }
        }

        entry.nativeDockStateId = 0;
        entry.nativeDockShowingId = 0;
        entry.nativeDockHidingId = 0;
        entry.nativeIntellihideId = 0;
        entry.nativeSliderId = 0;
        entry.nativeSliderAllocationId = 0;
        entry.nativeBoxAllocationId = 0;
        entry.nativeOverviewHiddenId = 0;
        entry.nativeIntellihide = null;
        entry.nativeSlider = null;
        entry.nativeBox = null;
        entry.nativeIntellihideTargetBox = null;
        entry.nativeIntellihideRectKey = '';
        entry.nativeLastSlideEndpoint = null;
        entry.nativeDockTransition = null;
        entry.nativeVisibilityGate = null;
        entry.nativeVisibilityGateInstalled = false;
        entry.nativeGlassVisible = null;
    }

    _readNativeDockSlide(entry) {
        const slider =
            entry?.nativeSlider ??
            entry?.nativeDock?._slider ??
            null;
        if (!slider)
            return NaN;

        for (const value of [
            slider.slide_x,
            slider.slideX,
        ]) {
            // An absent property on a GNOME/Ubuntu Dock variant is not a
            // hidden slide. Number(null) incorrectly returns 0, hiding
            // the glass and preventing the second property from being read.
            if (value === null || value === undefined)
                continue;
            const n = Number(value);
            if (Number.isFinite(n))
                return Math.max(
                    0,
                    Math.min(1, n)
                );
        }

        try {
            const property =
                slider.get_property?.('slide-x');
            const n = property === null ||
                property === undefined
                    ? NaN
                    : Number(property);
            if (Number.isFinite(n)) {
                return Math.max(
                    0,
                    Math.min(1, n)
                );
            }
        } catch {}

        return NaN;
    }

    _readNativeDockState(entry) {
        const dock = entry?.nativeDock;
        if (!dock)
            return null;

        const candidates = [];

        try {
            candidates.push(dock.dockState);
        } catch {}

        try {
            candidates.push(
                dock.getDockState?.()
            );
        } catch {}

        try {
            candidates.push(
                dock._dockState
            );
        } catch {}

        for (const value of candidates) {
            if (value === null || value === undefined)
                continue;
            const state = Number(value);
            if (
                Number.isFinite(state) &&
                state >= NATIVE_DOCK_STATE.HIDDEN &&
                state <= NATIVE_DOCK_STATE.HIDING
            ) {
                return state;
            }
        }

        // Last-resort visual state for forks that do not expose dock state.
        const slide =
            this._readNativeDockSlide(entry);
        if (Number.isFinite(slide)) {
            if (
                slide <=
                NATIVE_DOCK_SLIDE_EPSILON
            ) {
                return NATIVE_DOCK_STATE.HIDDEN;
            }

            if (
                slide >=
                1 - NATIVE_DOCK_SLIDE_EPSILON
            ) {
                return NATIVE_DOCK_STATE.SHOWN;
            }
        }

        return null;
    }

    _normalizeLegacyNativeDockState(entry) {
        const dock = entry?.nativeDock;
        if (!dock)
            return;

        // Dash-to-Dock v104 / Ubuntu Dock lineage initializes _dockState to
        // HIDDEN even when a non-startup slider begins fully visible. Upstream
        // PR #2511 corrects exactly this mismatch. Only repair the legacy
        // private-state API; modern GObject dockState builds own their state.
        let publicState = NaN;
        try {
            const value = dock.dockState;
            if (value !== null && value !== undefined)
                publicState = Number(value);
        } catch {}

        if (Number.isFinite(publicState))
            return;

        const slide =
            this._readNativeDockSlide(entry);

        if (
            Number.isFinite(slide) &&
            slide >=
                1 - NATIVE_DOCK_SLIDE_EPSILON &&
            Number(dock._dockState) ===
                NATIVE_DOCK_STATE.HIDDEN
        ) {
            try {
                dock._dockState =
                    NATIVE_DOCK_STATE.SHOWN;
            } catch {}
        }
    }

    _syncNativeIntellihideTarget(
        entry,
        force = false
    ) {
        const dock = entry?.nativeDock;
        const intellihide =
            entry?.nativeIntellihide;
        const box =
            entry?.nativeBox ??
            dock?._box ??
            null;

        if (
            !dock ||
            !intellihide ||
            !box
        ) {
            return false;
        }

        // Native Dash-to-Dock *already* computes a stable fully-visible
        // _staticBox in its own _updateStaticBox() while autohide animates.
        // The previous VLIQ override reconstructed the target from the
        // moving _box, allowing per-frame allocation/hover races to push
        // intellihide's overlap rectangle away from the visible dock.
        // Trust the native target at offset=0. If the user deliberately
        // offsets VLIQ's dock, clone the stable native geometry and apply
        // precisely that vertical offset, independently of slide progress.
        const nativeBox =
            dock._staticBox ??
            dock.staticBox ??
            null;
        const nativeX = Number(nativeBox?.x1);
        const nativeY = Number(nativeBox?.y1);
        const nativeW = Number(nativeBox?.x2) - nativeX;
        const nativeH = Number(nativeBox?.y2) - nativeY;
        const nativeValid =
            nativeBox &&
            Number.isFinite(nativeX) &&
            Number.isFinite(nativeY) &&
            Number.isFinite(nativeW) &&
            Number.isFinite(nativeH) &&
            nativeW > 1 && nativeH > 1;
        const panelMode = this._dockIsPanelMode();
        const verticalOffset = panelMode
            ? 0
            : this._readDockVerticalOffset();

        if (nativeValid && (panelMode || verticalOffset === 0)) {
            // Clear our temporary target on returning from an offset/panel
            // transition; otherwise the native actor box owns all subsequent
            // monitor/layout/hide updates. No duplicate forceUpdate loop.
            if (
                force ||
                entry.nativeIntellihideRectKey !== 'native'
            ) {
                try {
                    intellihide.updateTargetBox?.(nativeBox);
                } catch {
                    return false;
                }
            }
            entry.nativeIntellihideRectKey = 'native';
            return true;
        }

        if (panelMode) {
            // Older dock variants may not expose an allocated static box yet.
            // Do not inject floating-dock geometry into panel mode.
            entry.nativeIntellihideRectKey = '';
            return false;
        }

        if (nativeValid) {
            const x = nativeX;
            const y = nativeY - verticalOffset;
            const key = [
                Math.round(x * 100) / 100,
                Math.round(y * 100) / 100,
                Math.round(nativeW * 100) / 100,
                Math.round(nativeH * 100) / 100,
            ].join(':');
            if (!force && entry.nativeIntellihideRectKey === key)
                return true;

            entry.nativeIntellihideTargetBox ??= new Clutter.ActorBox();
            entry.nativeIntellihideTargetBox.init_rect(
                x, y, nativeW, nativeH
            );
            try {
                intellihide.updateTargetBox?.(
                    entry.nativeIntellihideTargetBox
                );
                entry.nativeIntellihideRectKey = key;
                return true;
            } catch {
                entry.nativeIntellihideRectKey = '';
                return false;
            }
        }

        // Legacy fallback ONLY when the upstream version has not provided
        // _staticBox yet. Do not use moving allocation when native geometry
        // is valid; this path will self-correct on the next allocation event.
        const monitor =
            dock._monitor ??
            Main.layoutManager.monitors?.[
                dock.monitorIndex
            ] ??
            null;
        if (!monitor)
            return false;

        const width = Number(box.width);
        const height = Number(box.height);
        if (
            !Number.isFinite(width) ||
            !Number.isFinite(height) ||
            width <= 1 ||
            height <= 1
        ) {
            return false;
        }

        let absX = NaN;
        let absY = NaN;
        try {
            [absX, absY] =
                box.get_transformed_position();
        } catch {}

        if (
            !Number.isFinite(absX) ||
            !Number.isFinite(absY)
        ) {
            return false;
        }

        // Intellihide must test the rectangle where the dock WOULD BE fully
        // visible, not its current autohide-translated allocation.
        // The stable native target branch above already applied this offset.
        // Only old GNOME forks without _staticBox use the fallback below.
        let x = absX;
        // _box transformed coordinates already include the configured offset.
        // Only monitor-edge reconstruction below needs to apply it explicitly.
        let y = absY;
        const position =
            dock._position ??
            dock.position ??
            null;

        const slide =
            this._readNativeDockSlide(entry);
        const visibleSlide =
            Number.isFinite(slide)
                ? clampNumber(slide, 0, 1)
                : (
                    this._readNativeDockState(entry) ===
                        NATIVE_DOCK_STATE.SHOWN
                        ? 1
                        : 0
                );

        // _applyDockVerticalOffset() intentionally interpolates the visual
        // translation to zero while the dock hides. Intellihide, however,
        // must always test the rectangle where the dock WOULD BE fully shown.
        // For side docks, compensate for the portion of the configured offset
        // that is currently interpolated out.
        const hiddenOffsetCorrection =
            verticalOffset * (1 - visibleSlide);

        switch (position) {
        case St.Side.LEFT:
            x = monitor.x;
            y = absY - hiddenOffsetCorrection;
            break;
        case St.Side.RIGHT:
            x =
                monitor.x +
                monitor.width -
                width;
            y = absY - hiddenOffsetCorrection;
            break;
        case St.Side.TOP:
            y =
                monitor.y -
                verticalOffset;
            break;
        case St.Side.BOTTOM:
            y =
                monitor.y +
                monitor.height -
                height -
                verticalOffset;
            break;
        default:
            return false;
        }

        const key = [
            Math.round(x * 100) / 100,
            Math.round(y * 100) / 100,
            Math.round(width * 100) / 100,
            Math.round(height * 100) / 100,
        ].join(':');

        if (
            !force &&
            entry.nativeIntellihideRectKey ===
                key
        ) {
            return true;
        }

        if (!entry.nativeIntellihideTargetBox) {
            entry.nativeIntellihideTargetBox =
                new Clutter.ActorBox();
        }

        entry.nativeIntellihideTargetBox
            .init_rect(
                x,
                y,
                width,
                height
            );
        try {
            intellihide.updateTargetBox?.(
                entry.nativeIntellihideTargetBox
            );
            entry.nativeIntellihideRectKey = key;
            return true;
        } catch {
            entry.nativeIntellihideRectKey = '';
            return false;
        }
    }

    _findNativeDockRoot(entry) {
        let actor =
            entry?.container ?? null;

        while (
            actor &&
            actor.get_parent?.() &&
            actor.get_parent() !==
                Main.layoutManager.uiGroup
        ) {
            actor =
                actor.get_parent();
        }

        return (
            actor?.get_parent?.() ===
                Main.layoutManager.uiGroup
        )
            ? actor
            : null;
    }

    _ensureNativeDockPaintState(entry) {
        const dock = entry?.nativeDock;
        const manager = entry?.manager;
        if (!dock || !manager)
            return;

        // The glass is an independent, full-monitor unpickable actor. It must
        // remain BELOW Ubuntu Dock's native root. If another Shell/theme pass
        // restacks the dock, leaving glass above it makes the app targets still
        // hoverable while their icons are visually covered by the glass.
        const dockRoot =
            this._findNativeDockRoot(entry);
        const bgActor =
            manager.bgActor ?? null;
        const uiGroup =
            Main.layoutManager.uiGroup;

        if (
            dockRoot &&
            bgActor &&
            dockRoot.get_parent?.() === uiGroup &&
            bgActor.get_parent?.() === uiGroup
        ) {
            try {
                const children =
                    uiGroup.get_children?.() ?? [];
                const bgIndex =
                    children.indexOf(bgActor);
                const dockIndex =
                    children.indexOf(dockRoot);

                if (
                    bgIndex >= 0 &&
                    dockIndex >= 0 &&
                    bgIndex > dockIndex
                ) {
                    uiGroup.set_child_below_sibling?.(
                        bgActor,
                        dockRoot
                    );
                }
            } catch {}
        }

        // Never force native app-icon opacity from zero to 255. GNOME 50
        // legitimately uses zero opacity during app activation, hover,
        // relayout and Overview transitions. A VLIQ write here can race
        // Mutter's animation on the next frame, producing a repeated icon
        // flash while its separate Liquid Glass card remains visible.
        //
        // Our ownership ends at keeping bgActor BELOW Ubuntu Dock. Native
        // Dash-to-Dock alone owns icon visibility and opacity.
    }

    _nativeDockGlassVisible(entry) {
        if (!entry?.container)
            return false;
        // Milky paints the native .dash-background, never this GPU actor.
        // Older test fixtures or previous revisions may not expose this key.
        try {
            if (['milky', 'charcoal'].includes(
                this._vliqSettings?.get_string?.('glass-style')))
                return false;
        } catch {}

        // The single bottom taskbar replaces Ubuntu Dock's visual strip.
        // Retain its native state, but never paint a second overlapping
        // Liquid Glass backplate until the user returns to header mode.
        if (this._vliqSettings?.get_string?.(
            'top-header-layout') === 'bottom')
            return false;

        if (this._dockIsPanelMode())
            return false;

        if (
            entry.nativeFixedModeSettling ||
            this._dockFixedSettleStageId
        ) {
            return false;
        }

        if (
            this._dockModeTransitionTarget === false
        ) {
            return false;
        }

        const dock = entry.nativeDock;
        if (!dock)
            return this._nativeDashIsReady(
                entry.container
            );

        // A transition-start signal is the authoritative indication that the
        // glass must remain visible even if the legacy _dockState or slider
        // endpoint has not advanced yet.
        const slide =
            this._readNativeDockSlide(entry);

        if (
            entry.nativeDockTransition ===
                'hiding' &&
            Number.isFinite(slide) &&
            slide <=
                NATIVE_DOCK_SLIDE_EPSILON
        ) {
            entry.nativeDockTransition = null;
            return false;
        }

        if (
            entry.nativeDockTransition ===
                'showing' ||
            entry.nativeDockTransition ===
                'hiding'
        ) {
            return true;
        }

        // Slider endpoints are the authoritative visual truth. On v104 the
        // final notify::slide-x may fire before the animation onComplete writes
        // _dockState, so consulting state first would leave glass visible after
        // the dock has already reached its hidden endpoint.
        if (Number.isFinite(slide)) {
            if (
                slide <=
                NATIVE_DOCK_SLIDE_EPSILON
            ) {
                return false;
            }
            if (
                slide >=
                1 - NATIVE_DOCK_SLIDE_EPSILON
            ) {
                return true;
            }
        }

        // Mid-animation fallback for forks where the slider property is not
        // readable from GJS.
        const state =
            this._readNativeDockState(entry);
        return state === null ||
            state !== NATIVE_DOCK_STATE.HIDDEN;
    }

    _syncNativeDockVisualState(
        entry,
        requestFrame = false
    ) {
        const manager = entry?.manager;
        if (!manager)
            return;

        const visible =
            this._nativeDockGlassVisible(
                entry
            );

        // The visibility callback is stable for the lifetime of this manager.
        // Reinstalling it on every slide-x notify allocated a new closure and
        // called show()/hide() on every native autohide animation frame.
        if (!entry.nativeVisibilityGateInstalled) {
            entry.nativeVisibilityGate =
                () =>
                    this._nativeDockGlassVisible(
                        entry
                    );
            manager.setVisibilityGate?.(
                entry.nativeVisibilityGate
            );
            entry.nativeVisibilityGateInstalled = true;
        }

        if (!manager.bgActor)
            return;

        if (!visible) {
            if (manager.bgActor.opacity !== 0)
                manager.bgActor.opacity = 0;
            // Keep the independent glass actor mapped while Ubuntu Dock is
            // hidden. Unmapping/remapping the full-monitor offscreen effect
            // creates an empty first frame on reveal and can expose transient
            // allocations as a one-frame size flash.
            entry.nativeGlassVisible = false;
            return;
        }

        if (!manager.bgActor.visible)
            manager.bgActor.show?.();

        const opacity =
            entry.container
                ?.get_paint_opacity?.() ??
            entry.container?.opacity ??
            255;
        if (manager.bgActor.opacity !== opacity)
            manager.bgActor.opacity = opacity;

        const becameVisible =
            entry.nativeGlassVisible !== true;
        entry.nativeGlassVisible = true;

        // Native Dash-to-Dock already damages the stage while slide-x animates.
        // Do not stack bgActor + shader + full-stage redraw requests on every
        // slider frame. A single redraw is enough when semantic visibility
        // changes; paint-time geometry follows the native animation thereafter.
        if (requestFrame || becameVisible)
            manager.bgActor.queue_redraw?.();
    }

    _syncNativeDockBinding(entry) {
        if (!entry?.container)
            return null;

        const dock =
            this._nativeDockForContainer(
                entry.container
            );

        if (dock === entry.nativeDock) {
            this._applyDockVerticalOffset(
                entry
            );
            this._syncNativeIntellihideTarget(
                entry
            );
            this._syncNativeDockVisualState(
                entry
            );
            return dock;
        }

        this._disconnectNativeDockSignals(
            entry
        );

        entry.nativeDock = dock;

        if (dock) {
            const intellihide =
                dock._intellihide ?? null;
            const slider =
                dock._slider ?? null;
            const box =
                dock._box ?? null;

            entry.nativeIntellihide =
                intellihide;
            entry.nativeSlider = slider;
            entry.nativeBox = box;

            this._normalizeLegacyNativeDockState(
                entry
            );
            this._applyDockVerticalOffset(
                entry
            );

            // Newer Dash-to-Dock exposes dockState as a GObject property.
            // Older Ubuntu Dock/v104 builds do not, so this is optional.
            try {
                entry.nativeDockStateId =
                    dock.connect(
                        'notify::dock-state',
                        () => {
                            const state =
                                this._readNativeDockState(
                                    entry
                                );

                            // Modern builds expose dockState directly. Treat
                            // its terminal states as an endpoint fallback in
                            // case notify::slide-x is coalesced or unavailable.
                            if (
                                (
                                    state ===
                                        NATIVE_DOCK_STATE.HIDDEN &&
                                    entry.nativeDockTransition ===
                                        'hiding'
                                ) ||
                                (
                                    state ===
                                        NATIVE_DOCK_STATE.SHOWN &&
                                    entry.nativeDockTransition ===
                                        'showing'
                                )
                            ) {
                                entry.nativeDockTransition =
                                    null;
                            }

                            this._ensureNativeDockPaintState(
                                entry
                            );
                            this._syncNativeDockVisualState(
                                entry,
                                true
                            );
                        }
                    );
            } catch {
                entry.nativeDockStateId = 0;
            }

            // These signals exist across the older and newer state-machine
            // implementations and fire exactly once per transition.
            try {
                entry.nativeDockShowingId =
                    dock.connect(
                        'showing',
                        () => {
                            entry.nativeDockTransition =
                                'showing';
                            this._ensureNativeDockPaintState(
                                entry
                            );
                            this._syncNativeIntellihideTarget(
                                entry,
                                true
                            );
                            this._syncNativeDockVisualState(
                                entry,
                                true
                            );
                        }
                    );
            } catch {
                entry.nativeDockShowingId = 0;
            }

            try {
                entry.nativeDockHidingId =
                    dock.connect(
                        'hiding',
                        () => {
                            entry.nativeDockTransition =
                                'hiding';
                            this._syncNativeIntellihideTarget(
                                entry,
                                true
                            );
                            // Keep glass visible for the entire native hide
                            // animation; slider endpoint callback hides it.
                            this._syncNativeDockVisualState(
                                entry,
                                true
                            );
                        }
                    );
            } catch {
                entry.nativeDockHidingId = 0;
            }

            // Do NOT mirror intellihide status-changed into VLIQ repaint.
            // Ubuntu Dock consumes that signal first and decides the actual
            // transition. Reading its state in the same signal turn can observe
            // the previous state and produces duplicate show/hide churn.
            entry.nativeIntellihideId = 0;

            if (slider) {
                try {
                    entry.nativeSliderId =
                        slider.connect(
                            'notify::slide-x',
                            () => {
                                const slide =
                                    this._readNativeDockSlide(
                                        entry
                                    );
                                if (!Number.isFinite(slide))
                                    return;

                                // This is intentionally the only per-frame
                                // VLIQ work on slide-x: one conditional
                                // paint-transform write. Heavy glass/state work
                                // below still runs at endpoints only.
                                this._applyDockVerticalOffset(
                                    entry,
                                    slide
                                );

                                let endpoint = null;
                                if (
                                    slide <=
                                    NATIVE_DOCK_SLIDE_EPSILON
                                ) {
                                    endpoint = 0;
                                } else if (
                                    slide >=
                                    1 -
                                    NATIVE_DOCK_SLIDE_EPSILON
                                ) {
                                    endpoint = 1;
                                }

                                // The signal still fires while animating, but
                                // VLIQ performs no actor/shader work until an
                                // endpoint actually changes.
                                if (
                                    endpoint === null ||
                                    endpoint ===
                                        entry.nativeLastSlideEndpoint
                                ) {
                                    return;
                                }

                                entry.nativeLastSlideEndpoint =
                                    endpoint;

                                if (
                                    (
                                        endpoint === 0 &&
                                        entry.nativeDockTransition ===
                                            'hiding'
                                    ) ||
                                    (
                                        endpoint === 1 &&
                                        entry.nativeDockTransition ===
                                            'showing'
                                    )
                                ) {
                                    entry.nativeDockTransition =
                                        null;
                                }

                                if (endpoint === 1) {
                                    this._ensureNativeDockPaintState(
                                        entry
                                    );
                                }

                                this._syncNativeDockVisualState(
                                    entry,
                                    endpoint === 1
                                );
                            }
                        );
                } catch {
                    entry.nativeSliderId = 0;
                }

                try {
                    entry.nativeSliderAllocationId =
                        slider.connect(
                            'notify::allocation',
                            () =>
                                this._syncNativeIntellihideTarget(
                                    entry
                                )
                        );
                } catch {
                    entry.nativeSliderAllocationId = 0;
                }
            }

            if (box) {
                try {
                    entry.nativeBoxAllocationId =
                        box.connect(
                            'notify::allocation',
                            () =>
                                this._syncNativeIntellihideTarget(
                                    entry
                                )
                        );
                } catch {
                    entry.nativeBoxAllocationId = 0;
                }
            }

            // GNOME 50 can leave overlap/hover state stale across Overview.
            // Re-anchor the target, sync hover, then force one native overlap
            // evaluation when returning to the desktop.
            try {
                entry.nativeOverviewHiddenId =
                    Main.overview.connect(
                        'hidden',
                        () => {
                            try {
                                box?.sync_hover?.();
                            } catch {}

                            this._syncNativeIntellihideTarget(
                                entry,
                                true
                            );

                            try {
                                intellihide
                                    ?.forceUpdate?.();
                            } catch {}
                        }
                    );
            } catch {
                entry.nativeOverviewHiddenId = 0;
            }

            const initialSlide =
                this._readNativeDockSlide(entry);
            if (Number.isFinite(initialSlide)) {
                if (
                    initialSlide <=
                    NATIVE_DOCK_SLIDE_EPSILON
                ) {
                    entry.nativeLastSlideEndpoint = 0;
                } else if (
                    initialSlide >=
                    1 - NATIVE_DOCK_SLIDE_EPSILON
                ) {
                    entry.nativeLastSlideEndpoint = 1;
                }
            }

            this._syncNativeIntellihideTarget(
                entry,
                true
            );
            this._ensureNativeDockPaintState(
                entry
            );
        }

        this._syncNativeDockVisualState(
            entry
        );

        return dock;
    }

    _cancelDockModeTransition() {
        this._dockModeGeneration++;

        if (this._dockModeTransitionStageId) {
            try {
                global.stage.disconnect(
                    this._dockModeTransitionStageId
                );
            } catch {}
            this._dockModeTransitionStageId = 0;
        }

        if (this._dockModeHandoffId) {
            try {
                GLib.source_remove(
                    this._dockModeHandoffId
                );
            } catch {}
            this._dockModeHandoffId = 0;
        }

        this._dockModeTransitionTarget = null;
        this._dockHandoffActive = false;
    }

    _beginDockModeTransition(panelMode) {
        if (!this._enabled)
            return;

        this._cancelDockModeTransition();
        const generation =
            this._dockModeGeneration;
        this._dockModeTransitionTarget =
            panelMode;

        if (panelMode) {
            this._syncDockGlassPreferenceForPanelMode(
                true
            );

            this._findNativeDashToDock();
            this._dockModeTransitionTarget = null;
            this._scheduleNativeDashRescan();
            return;
        }

        // Panel -> floating dock: keep the existing translucent panel paint
        // as a visual handoff while Ubuntu Dock applies _resetPosition().
        // Glass stays detached during these settle frames, so it can never
        // capture the old full-panel allocation.
        this._findNativeDashToDock();

        let settledFrames = 0;
        this._dockModeTransitionStageId =
            global.stage.connect(
                'after-paint',
                () => {
                    if (
                        !this._enabled ||
                        generation !==
                            this._dockModeGeneration
                    ) {
                        return;
                    }

                    if (this._dockIsPanelMode()) {
                        this._beginDockModeTransition(
                            true
                        );
                        return;
                    }

                    settledFrames++;
                    if (
                        settledFrames <
                        DOCK_MODE_SETTLE_FRAMES
                    ) {
                        return;
                    }

                    if (
                        this._dockModeTransitionStageId
                    ) {
                        try {
                            global.stage.disconnect(
                                this._dockModeTransitionStageId
                            );
                        } catch {}
                        this._dockModeTransitionStageId = 0;
                    }

                    this._startDockModeHandoff(
                        generation
                    );
                }
            );
    }

    _startDockModeHandoff(generation) {
        if (
            !this._enabled ||
            generation !== this._dockModeGeneration
        ) {
            return;
        }

        this._dockModeTransitionTarget = null;
        this._dockHandoffActive = true;

        // External Liquid Glass, if present, is restored only AFTER Ubuntu
        // Dock has left extended geometry. This removes the old full-width
        // black frame during panel -> dock transitions.
        this._syncDockGlassPreferenceForPanelMode(
            false
        );

        this._findNativeDashToDock();

        const startedUs =
            GLib.get_monotonic_time();

        this._dockModeHandoffId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                DOCK_HANDOFF_POLL_MS,
                () => {
                    if (
                        !this._enabled ||
                        generation !==
                            this._dockModeGeneration
                    ) {
                        this._dockModeHandoffId = 0;
                        return GLib.SOURCE_REMOVE;
                    }

                    if (this._dockIsPanelMode()) {
                        this._dockModeHandoffId = 0;
                        this._beginDockModeTransition(
                            true
                        );
                        return GLib.SOURCE_REMOVE;
                    }

                    this._findNativeDashToDock();

                    let ready =
                        this._nativeDashEntries.length > 0;

                    for (
                        const entry of
                        this._nativeDashEntries
                    ) {
                        if (
                            !this._nativeDashIsReady(
                                entry.container
                            )
                        ) {
                            continue;
                        }

                        this._syncNativeDockBinding(
                            entry
                        );

                        if (this._externalGlobalStack)
                            continue;

                        if (!entry.manager) {
                            ready = false;
                            continue;
                        }

                        const effect =
                            entry.manager.effect;

                        if (!effect?._shadersLoaded) {
                            ready = false;
                            continue;
                        }

                        const slide =
                            this._readNativeDockSlide(
                                entry
                            );
                        const state =
                            this._readNativeDockState(
                                entry
                            );
                        const hidden =
                            (
                                Number.isFinite(slide) &&
                                slide <=
                                    NATIVE_DOCK_SLIDE_EPSILON
                            ) ||
                            state ===
                                NATIVE_DOCK_STATE.HIDDEN;

                        // A hidden autohide dock cannot produce a composited
                        // glass paint yet. Hidden is therefore a valid warm
                        // handoff state; the first native 'showing' signal will
                        // reveal the already-initialized glass actor.
                        if (
                            !hidden &&
                            !(
                                (
                                    effect
                                        ?._diagCompositedPaintCount ??
                                    0
                                ) > 0
                            )
                        ) {
                            ready = false;
                        }
                    }

                    const elapsedMs =
                        (
                            GLib.get_monotonic_time() -
                            startedUs
                        ) / 1000;

                    if (
                        this._externalGlobalStack &&
                        elapsedMs < 320
                    ) {
                        ready = false;
                    }

                    if (ready) {
                        this._dockModeHandoffId = 0;
                        this._completeDockModeHandoff();
                        return GLib.SOURCE_REMOVE;
                    }

                    if (
                        elapsedMs >=
                        DOCK_HANDOFF_MAX_MS
                    ) {
                        // Safety-first fallback: keep the translucent native
                        // background instead of exposing a black/uninitialized
                        // shader frame. A later rescan can still finish the
                        // handoff once glass becomes healthy.
                        this._dockModeHandoffId = 0;
                        console.warn(
                            '[VLIQ][Dock] glass handoff timed out; keeping native fallback'
                        );
                        this._scheduleNativeDashRescan();
                        return GLib.SOURCE_REMOVE;
                    }

                    return GLib.SOURCE_CONTINUE;
                }
            );
    }

    _completeDockModeHandoff() {
        this._dockHandoffActive = false;
        this._dockModeTransitionTarget = null;

        for (const entry of this._nativeDashEntries) {
            this._applyDockPanelPaint(
                entry,
                false
            );
            this._setDockPanelModeClass(
                entry.container,
                false
            );
            this._syncDockGlassBackgroundClass(
                entry,
                true
            );

            if (entry.manager) {
                this._syncNativeDockBinding(entry);
                this._syncNativeDockVisualState(
                    entry,
                    true
                );
            }
        }

        this._scheduleNativeDashRescan();
    }

    _setDockPanelModeClass(container, enabled) {
        if (!container)
            return;

        try {
            const active =
                Boolean(
                    container.has_style_class_name?.(
                        DOCK_PANEL_MODE_CLASS
                    )
                );

            if (enabled && !active) {
                container.add_style_class_name?.(
                    DOCK_PANEL_MODE_CLASS
                );
            } else if (!enabled && active) {
                container.remove_style_class_name?.(
                    DOCK_PANEL_MODE_CLASS
                );
            }
        } catch {}
    }

    _findDockPanelBackground(container) {
        let found = null;

        const walk = actor => {
            if (!actor || found)
                return;

            const classes = String(
                actor.get_style_class_name?.() ??
                actor.style_class ??
                ''
            ).split(/\s+/);

            if (classes.includes('dash-background')) {
                found = actor;
                return;
            }

            for (const child of actor.get_children?.() ?? [])
                walk(child);
        };

        // Ubuntu Dock inherits Dash-to-Dock's actor structure: the real
        // .dash-background is a sibling of #dashtodockDashContainer, not a
        // child of it. Walk upward through the local dock subtree and search
        // each common ancestor, rather than scanning the whole Shell.
        let cursor = container;
        let depth = 0;

        while (cursor && depth++ < 6 && !found) {
            walk(cursor);

            const name = cursor.get_name?.() ?? '';
            if (
                found ||
                name === 'dash' ||
                name === 'dashtodockContainer'
            ) {
                break;
            }

            cursor = cursor.get_parent?.() ?? null;
        }

        return found;
    }

    _removeDockPanelBlur(actor) {
        if (!actor)
            return;

        try {
            actor.remove_effect_by_name?.(
                DOCK_PANEL_BLUR_EFFECT
            );
        } catch {}
    }

    _ensureDockPanelBlur(actor) {
        if (!actor)
            return;

        try {
            if (
                actor.get_effect?.(
                    DOCK_PANEL_BLUR_EFFECT
                )
            ) {
                return;
            }
        } catch {}

        let effect = null;

        try {
            effect = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius: DOCK_PANEL_BLUR_RADIUS,
                brightness: 1.0,
            });
        } catch {
            try {
                effect = new Shell.BlurEffect({
                    mode: Shell.BlurMode.BACKGROUND,
                    brightness: 1.0,
                });

                if (effect.set_radius) {
                    effect.set_radius(
                        DOCK_PANEL_BLUR_RADIUS
                    );
                } else if ('radius' in effect) {
                    effect.radius =
                        DOCK_PANEL_BLUR_RADIUS;
                } else if ('sigma' in effect) {
                    effect.sigma =
                        DOCK_PANEL_BLUR_RADIUS / 2;
                }
            } catch {
                effect = null;
            }
        }

        if (!effect)
            return;

        try {
            actor.add_effect_with_name?.(
                DOCK_PANEL_BLUR_EFFECT,
                effect
            );
        } catch {}
    }

    // The native panel owns a bounded stage-level LiquidEffect material.
    // Do not use DashManager's full-monitor capture (PR #35 regression).
    _ensurePanelBackdrop(entry, source) {
        const uiGroup = Main.layoutManager.uiGroup;
        if (!entry || !source || !uiGroup || !this._vendor)
            return false;

        let root = entry.container;
        while (root && root.get_parent?.() !== uiGroup)
            root = root.get_parent?.() ?? null;
        if (!root)
            return false;

        if (
            entry.panelBackdropActor &&
            entry.panelBackdropSource === source &&
            entry.panelBackdropRoot === root
        ) {
            this._syncPanelBackdropGeometry(entry);
            return true;
        }
        this._removePanelBackdrop(entry);

        try {
            const surface = new PanelGlassSurface(
                this._vendor,
                this._settings,
                () => this._readSharedCardAppearance()
            );
            if (!surface.attach(uiGroup, root)) {
                surface.destroy();
                return false;
            }
            entry.panelLiquidSurface = surface;
            entry.panelBackdropActor = surface._material;
            entry.panelBackdropSource = source;
            entry.panelBackdropRoot = root;

            // Scoped only to this one native Panel Mode surface. Scene sync
            // stops completely when its manager is destroyed or disabled.
            entry.panelGlassFrameSignal = global.stage.connect(
                'before-update',
                () => {
                    try {
                        this._syncPanelBackdropGeometry(entry);
                    } catch {
                        // Preserve native background fallback on actor teardown.
                        entry.panelLiquidSurface?.hide();
                    }
                }
            );
            this._syncPanelBackdropGeometry(entry);
            return true;
        } catch (error) {
            this._removePanelBackdrop(entry);
            console.warn('[VLIQ][Dock] panel material fallback: ' + error);
            return false;
        }
    }

    _syncPanelBackdropGeometry(entry) {
        const surface = entry?.panelLiquidSurface;
        const source = entry?.panelBackdropSource;
        if (!surface || !source || !this._dockIsPanelMode())
            return;

        // Bottom Taskbar owns the one bounded glass strip. Ubuntu Dock
        // Panel Mode's independent uiGroup sibling can stay painted after
        // its container/icons are hidden, making a second stripe or gap.
        // Suppress the producer each frame; otherwise its own compositor
        // callback would re-show the old glass immediately.
        if (this.ownsBottomTaskbarChrome()) {
            surface.hide();
            this._setPanelLiquidReady(entry, false);
            return;
        }

        try {
            const [x, y] = source.get_transformed_position();
            const [w, h] = source.get_transformed_size();
            const index = Main.layoutManager.findIndexForActor(source);
            const monitor = Main.layoutManager.monitors[
                index >= 0 ? index : Main.layoutManager.primaryIndex
            ] ?? Main.layoutManager.primaryMonitor;
            const valid = source.get_stage?.() === global.stage &&
                source.mapped !== false &&
                source.visible !== false &&
                // The native Ubuntu Dock controls real hide/reveal. Its
                // independent glass backdrop must NEVER remain painted
                // on top of a fullscreen application while the native
                // dock's own fullscreen state is settling.
                monitor?.inFullscreen !== true &&
                monitor &&
                [x, y, w, h].every(Number.isFinite) &&
                w > 1 && h > 1 &&
                // Guard all four edges and constrain *thickness*. Never
                // allow a malformed fullscreen-sized blur/material actor.
                Math.min(w, h) <= Math.min(
                    180,
                    (w >= h ? monitor.height : monitor.width) * 0.25
                );
            if (!valid) {
                surface.hide();
                this._setPanelLiquidReady(entry, false);
                return;
            }

            const left = Math.max(x, monitor.x);
            const top = Math.max(y, monitor.y);
            const right = Math.min(x + w, monitor.x + monitor.width);
            const bottom = Math.min(y + h, monitor.y + monitor.height);
            const width = right - left, height = bottom - top;
            if (width <= 1 || height <= 1) {
                surface.hide();
                this._setPanelLiquidReady(entry, false);
                return;
            }

            const [uiX, uiY] =
                Main.layoutManager.uiGroup.get_transformed_position?.() ??
                [0, 0];
            const opacity = source.get_paint_opacity?.() ??
                source.opacity ?? 255;
            surface.setBounds(
                left - uiX, top - uiY, width, height, opacity
            );
            this._setPanelLiquidReady(entry, surface.ready);
        } catch {
            surface.hide();
            this._setPanelLiquidReady(entry, false);
        }
    }

    _setPanelLiquidReady(entry, ready) {
        if (!entry || entry.panelLiquidReady === ready)
            return;
        entry.panelLiquidReady = ready;
        const background = entry.panelBackgroundActor;
        if (!background)
            return;
        try {
            if (ready)
                background.add_style_class_name?.(DOCK_PANEL_READY_CLASS);
            else
                background.remove_style_class_name?.(DOCK_PANEL_READY_CLASS);
            this._setDockPanelPremiumStyle(entry, background);
        } catch {}
    }

    _removePanelBackdrop(entry) {
        if (!entry)
            return;
        if (entry.panelGlassFrameSignal) {
            try { global.stage.disconnect(entry.panelGlassFrameSignal); } catch {}
            entry.panelGlassFrameSignal = 0;
        }
        this._setPanelLiquidReady(entry, false);
        try { entry.panelLiquidSurface?.destroy(); } catch {}
        entry.panelLiquidSurface = null;
        entry.panelBackdropActor = null;
        entry.panelBackdropSource = null;
        entry.panelBackdropRoot = null;
    }

    _syncDockGlassBackgroundClass(entry, enabled) {
        const actor =
            this._watchDockPanelBackground(
                entry
            );
        if (!actor)
            return;

        try {
            const active =
                Boolean(
                    actor.has_style_class_name?.(
                        DOCK_GLASS_BACKGROUND_CLASS
                    )
                );

            if (enabled && !active) {
                actor.add_style_class_name?.(
                    DOCK_GLASS_BACKGROUND_CLASS
                );
            } else if (!enabled && active) {
                actor.remove_style_class_name?.(
                    DOCK_GLASS_BACKGROUND_CLASS
                );
            }
        } catch {}
    }

    _dockPanelPaintShouldOwn(entry) {
        // The old Ubuntu Dock ThemeManager can emit notify::style on every
        // workspace/activation relayout. Never re-assert its panel backdrop
        // while our Bottom Taskbar owns the sole visible glass surface.
        // Checking only _dockIsPanelMode() here previously resurrected the
        // second CSS painter even after _syncNativeDashEntryMode retired it.
        if (this.ownsBottomTaskbarChrome())
            return false;
        return Boolean(
            entry?.panelPaintActive ||
            this._dockIsPanelMode() ||
            this._dockModeTransitionTarget === false ||
            this._dockHandoffActive
        );
    }

    _disconnectDockPanelBackgroundWatcher(entry) {
        if (
            entry?.panelBackgroundActor &&
            entry.panelBackgroundStyleId
        ) {
            try {
                entry.panelBackgroundActor.disconnect(
                    entry.panelBackgroundStyleId
                );
            } catch {}
        }

        if (entry) {
            entry.panelBackgroundStyleId = 0;
            entry.panelBackgroundStyleGuard = false;
        }
    }

    _setDockPanelPremiumStyle(entry, actor) {
        if (
            !entry ||
            !actor ||
            entry.panelBackgroundStyleGuard
        ) {
            return;
        }

        const current =
            actor.get_style?.() ??
            actor.style ??
            '';

        const material = this._vliqSettings?.get_string?.('glass-style');
        const desired = material === 'charcoal'
            ? 'background-color: rgba(29,31,35,0.98); ' +
                'background-image: none; border-color: transparent; ' +
                'border-radius: 0px; box-shadow: inset 0 0 0 1px ' +
                'rgba(255,255,255,0.13);'
            : (material === 'milky'
                ? (() => {
                    const tokens = milkyPaintTokens(
                        this._readSharedCardAppearance());
                    return 'background-color: ' + tokens.fill + '; ' +
                        'background-image: none; border-color: transparent; ' +
                        'border-radius: 0px; box-shadow: ' + tokens.rim + ';';
                })()
                : (entry.panelLiquidReady
                    ? DOCK_PANEL_GLASS_STYLE
                    : DOCK_PANEL_PREMIUM_STYLE));
        if (current === desired)
            return;

        entry.panelBackgroundStyleGuard = true;
        try {
            actor.set_style?.(desired);
        } catch {}
        finally {
            entry.panelBackgroundStyleGuard = false;
        }
    }

    _watchDockPanelBackground(entry) {
        if (!entry?.container)
            return null;

        const actor =
            this._findDockPanelBackground(
                entry.container
            );
        if (!actor)
            return null;

        if (actor === entry.panelBackgroundActor)
            return actor;

        const previous =
            entry.panelBackgroundActor;

        if (previous) {
            this._removePanelBackdrop(entry);
            this._removeDockPanelBlur(previous);
            this._disconnectDockPanelBackgroundWatcher(
                entry
            );

            // A Dash-to-Dock theme/mode rebuild can replace the real
            // .dash-background actor while the old actor is still paintable
            // for a frame. Remove every VLIQ-owned paint marker from the old
            // actor and restore its captured inline style before following the
            // replacement. Otherwise rapid panel/dock switching can leave a
            // stale translucent or fully transparent strip behind.
            try {
                previous.remove_style_class_name?.(
                    DOCK_PANEL_BACKGROUND_CLASS
                );
            } catch {}
            try {
                previous.remove_style_class_name?.(
                    DOCK_GLASS_BACKGROUND_CLASS
                );
            } catch {}

            if (entry.panelPaintActive) {
                entry.panelBackgroundStyleGuard = true;
                try {
                    previous.set_style?.(
                        entry.panelBackgroundOriginalStyle ?? null
                    );
                } catch {}
                finally {
                    entry.panelBackgroundStyleGuard = false;
                }
            }
        }

        entry.panelBackgroundActor = actor;
        entry.panelBackgroundOriginalStyle =
            actor.get_style?.() ??
            actor.style ??
            null;
        entry.panelBackgroundStyleId = 0;
        entry.panelBackgroundStyleGuard = false;

        try {
            entry.panelBackgroundStyleId =
                actor.connect(
                    'notify::style',
                    () => {
                        if (
                            !this._enabled ||
                            entry.panelBackgroundActor !==
                                actor ||
                            entry.panelBackgroundStyleGuard
                        ) {
                            return;
                        }

                        if (
                            this._dockPanelPaintShouldOwn(
                                entry
                            )
                        ) {
                            // Ubuntu Dock's ThemeManager can write its Yaru
                            // opaque style synchronously during
                            // changed::extend-height. Re-assert our premium
                            // paint in the SAME signal turn, before the stage
                            // gets a chance to paint the black intermediate.
                            this._setDockPanelPremiumStyle(
                                entry,
                                actor
                            );
                        } else {
                            // Outside panel/handoff mode, remember the latest
                            // native style so restoration never jumps back to
                            // a stale panel-era theme.
                            entry.panelBackgroundOriginalStyle =
                                actor.get_style?.() ??
                                actor.style ??
                                null;
                        }
                    }
                );
        } catch {
            entry.panelBackgroundStyleId = 0;
        }

        return actor;
    }

    _applyDockPanelPaint(entry, enabled) {
        if (!entry?.container)
            return;

        const actor =
            this._watchDockPanelBackground(
                entry
            );

        if (!enabled) {
            this._removePanelBackdrop(entry);
            if (!entry.panelPaintActive)
                return;

            entry.panelPaintActive = false;

            if (actor) {
                this._removeDockPanelBlur(actor);

                try {
                    actor.remove_style_class_name?.(
                        DOCK_PANEL_BACKGROUND_CLASS
                    );
                } catch {}

                entry.panelBackgroundStyleGuard = true;
                try {
                    actor.set_style?.(
                        entry.panelBackgroundOriginalStyle ?? null
                    );
                } catch {}
                finally {
                    entry.panelBackgroundStyleGuard = false;
                }

                // Ask Ubuntu Dock to resolve the CURRENT mode's native style
                // now, instead of waiting for a later theme pass.
                try {
                    entry.nativeDock
                        ?._themeManager
                        ?.updateCustomTheme?.();
                } catch {}
            }

            return;
        }

        if (!actor)
            return;

        entry.panelPaintActive = true;

        actor.add_style_class_name?.(
            DOCK_PANEL_BACKGROUND_CLASS
        );
        // Native .dash-background retains its square translucent veil.
        // BACKGROUND blur must sit outside DockDash's offscreen FBO.
        this._removeDockPanelBlur(actor);
        this._setDockPanelPremiumStyle(
            entry,
            actor
        );
        this._ensurePanelBackdrop(entry, actor);
    }

    _syncNativeDashEntryMode(entry) {
        if (!entry?.container)
            return false;

        const panelMode =
            this._dockIsPanelMode();

        this._syncNativeDockBinding(entry);
        this._applyDockVerticalOffset(
            entry
        );
        this._watchDockPanelBackground(entry);

        if (this.ownsBottomTaskbarChrome()) {
            // The Windows-style bar has ONE glass owner: Main.panel.
            // Even a hidden Dash-to-Dock container can leave its own
            // Panel Mode .dash-background and stage-level glass visible.
            // Release both producers rather than only setting opacity 0.
            this._syncDockGlassBackgroundClass(entry, false);
            this._setDockPanelModeClass(entry.container, false);
            this._applyDockPanelPaint(entry, false);
            this._cleanupNativeDashManager(entry);
            return true;
        }

        if (panelMode) {
            this._syncDockGlassBackgroundClass(
                entry,
                false
            );
            this._setDockPanelModeClass(
                entry.container,
                true
            );
            this._applyDockPanelPaint(
                entry,
                true
            );

            // Panel mode deliberately has no Liquid Glass/refraction shader.
            this._cleanupNativeDashManager(entry);
            return true;
        }

        if (
            this._dockModeTransitionTarget === false
        ) {
            this._syncDockGlassBackgroundClass(
                entry,
                false
            );
            // Waiting for Ubuntu Dock's extended -> floating relayout to
            // settle. Preserve the known-good panel paint and keep glass off.
            this._setDockPanelModeClass(
                entry.container,
                true
            );
            this._applyDockPanelPaint(
                entry,
                true
            );
            this._cleanupNativeDashManager(entry);
            return true;
        }

        if (this._dockHandoffActive) {
            this._syncDockGlassBackgroundClass(
                entry,
                false
            );
            // Warm the floating glass behind the still-visible native fallback.
            this._setDockPanelModeClass(
                entry.container,
                true
            );
            this._applyDockPanelPaint(
                entry,
                true
            );

            if (this._externalGlobalStack)
                return true;

            if (
                !this._nativeDashIsReady(
                    entry.container
                )
            ) {
                this._cleanupNativeDashManager(
                    entry
                );
                return false;
            }

            return Boolean(
                this._attachNativeDashManager(
                    entry
                ) ||
                entry.manager
            );
        }

        this._setDockPanelModeClass(
            entry.container,
            false
        );
        this._applyDockPanelPaint(
            entry,
            false
        );
        this._syncDockGlassBackgroundClass(
            entry,
            true
        );

        if (this._externalGlobalStack)
            return true;

        if (
            !this._nativeDashIsReady(
                entry.container
            )
        ) {
            this._cleanupNativeDashManager(
                entry
            );
            return false;
        }

        return Boolean(
            this._attachNativeDashManager(entry) ||
            entry.manager
        );
    }

    _collectNativeDashContainers() {
        const found = [];
        const skip = global.window_group;

        const walk = actor => {
            if (!actor || actor === skip)
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

    _nativeDashIsReady(container) {
        if (!container)
            return false;

        try {
            return (
                container.get_stage?.() === global.stage &&
                container.mapped &&
                container.visible
            );
        } catch {
            return false;
        }
    }

    _cleanupNativeDashManager(entry) {
        if (!entry?.manager)
            return;

        entry.nativeVisibilityGate = null;
        entry.nativeVisibilityGateInstalled = false;
        entry.nativeGlassVisible = null;
        entry.nativeDockStableW = NaN;
        entry.nativeDockStableH = NaN;

        try {
            entry.manager._vliqRestoreSceneThrottle?.();
        } catch {}

        try {
            entry.manager.cleanup();
        } catch (error) {
            console.error(
                '[VLIQ][LiquidGlass] native dock manager cleanup failed: ' +
                error
            );
        }
        entry.manager = null;
    }

    _prepareUbuntuDockManagerInstance(entry, manager) {
        if (!entry || !manager)
            return;

        if (manager._vliqUbuntuDockRuntimePatched)
            return;

        manager._vliqUbuntuDockRuntimePatched = true;

        // Hot-swapped VLIQ revisions reuse the already-loaded vendor module
        // graph. Patch the INSTANCE so these fixes work immediately without a
        // GNOME Shell restart, regardless of which vendor revision is cached.
        manager._marginValue = 0;
        manager._glassExpand = 0;
        manager._currentMarginStyle = '';

        const originalApplyMargin =
            typeof manager._applyMargin === 'function'
                ? manager._applyMargin.bind(manager)
                : null;

        manager._applyMargin = () => {
            manager._marginValue = 0;
            manager._glassExpand = 0;
            manager._currentMarginStyle = '';

            if (
                manager.targetActor &&
                manager._originalStyle !== undefined
            ) {
                try {
                    manager.targetActor.set_style(
                        manager._originalStyle
                    );
                } catch {}
            }

            // Intentionally do not call the vendor implementation: Ubuntu
            // Dock owns every geometry/margin decision.
            void originalApplyMargin;
        };

        // Ubuntu Dock paint-only integration must use the native
        // .dash-background allocation verbatim. Older hot-cached vendor
        // revisions still run their generic stabilization + indicator-based
        // balancing path, which can change width after theme/style relayout.
        manager._stabilizeDockBounds =
            bounds => bounds;
        manager._findReferenceActor =
            () => null;
        manager._applyDockMargin =
            bounds => bounds;

        const originalReadDockBounds =
            typeof manager._readDockBounds === 'function'
                ? manager._readDockBounds.bind(manager)
                : null;

        if (originalReadDockBounds) {
            manager._readDockBounds = () => {
                const bounds = originalReadDockBounds();
                if (!bounds)
                    return bounds;

                const slider =
                    entry.nativeSlider ??
                    entry.nativeDock?._slider ??
                    null;
                const slide = Number(
                    slider?.slide_x ??
                    slider?.slideX ??
                    NaN
                );
                const animating =
                    Number.isFinite(slide) &&
                    slide > 0.001 &&
                    slide < 0.999;

                const valid =
                    Number.isFinite(bounds.baseW) &&
                    Number.isFinite(bounds.baseH) &&
                    bounds.baseW > 9 &&
                    bounds.baseH > 9;

                if (!animating && valid) {
                    entry.nativeDockStableW =
                        bounds.baseW;
                    entry.nativeDockStableH =
                        bounds.baseH;
                    return bounds;
                }

                if (
                    animating &&
                    Number.isFinite(
                        entry.nativeDockStableW
                    ) &&
                    Number.isFinite(
                        entry.nativeDockStableH
                    ) &&
                    entry.nativeDockStableW > 9 &&
                    entry.nativeDockStableH > 9
                ) {
                    // Autohide is a translation animation. Ubuntu Dock can
                    // expose a transient clipped allocation for one frame while
                    // relayout settles; never let that transient length/thickness
                    // become the glass shape. Position remains live.
                    return {
                        ...bounds,
                        baseW:
                            entry.nativeDockStableW,
                        baseH:
                            entry.nativeDockStableH,
                    };
                }

                return bounds;
            };
        }

        const originalSyncGeometry =
            typeof manager._syncGeometry ===
                'function'
                ? manager._syncGeometry.bind(
                    manager
                )
                : null;

        manager._syncGeometry = () => {
            manager._marginValue = 0;
            manager._glassExpand = 0;

            if (
                !this._nativeDockGlassVisible(
                    entry
                )
            ) {
                if (
                    manager.bgActor &&
                    manager.bgActor.opacity !== 0
                ) {
                    manager.bgActor.opacity = 0;
                }
                return;
            }

            originalSyncGeometry?.();
        };

        const originalLiveGeometry =
            typeof manager
                ._syncGlassGeometryLive ===
                'function'
                ? manager
                    ._syncGlassGeometryLive
                    .bind(manager)
                : null;

        manager._syncGlassGeometryLive = () => {
            if (
                !this._nativeDockGlassVisible(
                    entry
                )
            ) {
                return;
            }

            originalLiveGeometry?.();
        };
    }

    _finalizeUbuntuDockManagerInstance(entry) {
        const manager = entry?.manager;
        if (!manager)
            return;

        manager._marginValue = 0;
        manager._glassExpand = 0;
        manager._currentMarginStyle = '';

        // Older cached vendor managers add the generic transparency class to
        // the icon/reveal subtree during setup(). Remove it synchronously;
        // VLIQ transparently styles only the real .dash-background actor.
        try {
            manager.targetActor
                ?.remove_style_class_name?.(
                    'liquid-glass-transparent'
                );
        } catch {}

        try {
            manager._dockParent
                ?.remove_style_class_name?.(
                    'liquid-glass-transparent'
                );
        } catch {}

        const useGlassBackground =
            !this._dockIsPanelMode() &&
            this._dockModeTransitionTarget !== false &&
            !this._dockHandoffActive;

        this._syncDockGlassBackgroundClass(
            entry,
            useGlassBackground
        );

        try {
            // Prime the stable shape before the first autohide reveal so even
            // a dock that starts hidden has a valid non-transient geometry.
            manager._readDockBounds?.();
        } catch {}

        this._applyDockVerticalOffset(
            entry
        );
        this._ensureNativeDockPaintState(
            entry
        );
        this._syncNativeDockVisualState(
            entry
        );
    }

    _attachNativeDashManager(entry) {
        if (
            !entry ||
            entry.manager ||
            this._externalGlobalStack ||
            this._dockIsPanelMode() ||
            !this._nativeDashIsReady(entry.container)
        ) {
            return false;
        }

        try {
            entry.manager =
                new this._vendor.DashManager(
                    this._vendor.root,
                    entry.container,
                    this._settings,
                    this._logger
                );

            this._prepareUbuntuDockManagerInstance(
                entry,
                entry.manager
            );

            // Supported by newer vendor revisions; harmless when the process
            // is still using an older cached module.
            entry.manager.setPreserveNativeGeometry?.(
                true
            );
            entry.manager.setSceneFpsLimit?.(
                Math.max(
                    15,
                    Math.min(
                        24,
                        this._readSharedCardAppearance()
                            ?.sceneFps ?? 24
                    )
                )
            );

            entry.manager.setup();

            entry.manager.setMaterialOverride?.(
                () => this._applySharedDashMaterial(
                    entry.manager,
                    'dock'
                )
            );
            this._applySharedDashMaterial(
                entry.manager,
                'dock'
            );

            this._syncNativeDockBinding(entry);
            this._finalizeUbuntuDockManagerInstance(
                entry
            );

            return true;
        } catch (error) {
            console.error(
                '[VLIQ][LiquidGlass] native dock attach failed: ' +
                error
            );
            this._cleanupNativeDashManager(entry);
            return false;
        }
    }

    _findNativeDashToDock() {
        const containers =
            this._collectNativeDashContainers();
        if (containers.length === 0)
            return false;

        let active = 0;

        for (const container of containers) {
            let entry = this._nativeDashEntries.find(
                item => item.container === container
            );

            if (!entry) {
                entry = {
                    container,
                    manager: null,
                    destroyId: 0,
                    mappedId: 0,
                    nativeDock: null,
                    nativeDockStateId: 0,
                    nativeDockShowingId: 0,
                    nativeDockHidingId: 0,
                    nativeIntellihide: null,
                    nativeIntellihideId: 0,
                    nativeSlider: null,
                    nativeSliderId: 0,
                    nativeSliderAllocationId: 0,
                    nativeBox: null,
                    nativeBoxAllocationId: 0,
                    nativeOverviewHiddenId: 0,
                    nativeIntellihideTargetBox: null,
                    nativeIntellihideRectKey: '',
                    nativeLastSlideEndpoint: null,
                    nativeDockTransition: null,
                    nativeFixedModeSettling:
                        Boolean(
                            this._dockFixedSettleStageId
                        ),
                    nativeFixedSettleKey: '',
                    nativeFixedSettleFrames: 0,
                    nativeVisibilityGate: null,
                    nativeVisibilityGateInstalled: false,
                    nativeGlassVisible: null,
                    nativeDockStableW: NaN,
                    nativeDockStableH: NaN,
                    panelBackgroundActor: null,
                    panelBackgroundOriginalStyle: null,
                    panelBackgroundStyleId: 0,
                    panelBackgroundStyleGuard: false,
                    panelPaintActive: false,
                    panelBackdropActor: null,
                    panelBackdropSource: null,
                    panelBackdropRoot: null,
                    panelLiquidSurface: null,
                    panelLiquidReady: false,
                    panelGlassFrameSignal: 0,
                };
                this._nativeDashEntries.push(entry);

                try {
                    entry.destroyId = container.connect(
                        'destroy',
                        () => {
                            entry.destroyId = 0;
                            try {
                                this._releaseNativeDash(entry);
                            } finally {
                                this._scheduleNativeDashRescan();
                            }
                        }
                    );
                } catch {
                    entry.destroyId = 0;
                }

                try {
                    entry.mappedId = container.connect(
                        'notify::mapped',
                        () => {
                            if (!this._enabled)
                                return;

                            if (this._nativeDashIsReady(container)) {
                                this._syncNativeDashEntryMode(entry);
                            } else {
                                // Stop the vendored frame/theme sampler as soon
                                // as Ubuntu Dock leaves the stage. Continuing to
                                // query theme nodes on detached St actors causes
                                // the repeated "widget is not in the stage"
                                // warnings seen in the Shell journal.
                                this._cleanupNativeDashManager(entry);
                            }
                        }
                    );
                } catch {
                    entry.mappedId = 0;
                }
            }

            if (this._nativeDashIsReady(container)) {
                if (this._syncNativeDashEntryMode(entry))
                    active++;
            } else {
                this._cleanupNativeDashManager(entry);
            }
        }

        return active > 0 || containers.length > 0;
    }

    _releaseNativeDash(entry) {
        const index =
            this._nativeDashEntries.indexOf(entry);
        if (index >= 0)
            this._nativeDashEntries.splice(index, 1);

        if (entry.destroyId) {
            try {
                entry.container.disconnect(entry.destroyId);
            } catch {
                // Container may already be gone.
            }
            entry.destroyId = 0;
        }

        if (entry.mappedId) {
            try {
                entry.container.disconnect(entry.mappedId);
            } catch {
                // Container may already be gone.
            }
            entry.mappedId = 0;
        }

        this._disconnectNativeDockSignals(
            entry
        );
        entry.nativeDock = null;
        entry.nativeFixedModeSettling = false;
        entry.nativeFixedSettleKey = '';
        entry.nativeFixedSettleFrames = 0;

        this._removePanelBackdrop(entry);
        this._disconnectDockPanelBackgroundWatcher(
            entry
        );

        this._cleanupNativeDashManager(entry);
        this._syncDockGlassBackgroundClass(
            entry,
            false
        );
        this._applyDockPanelPaint(
            entry,
            false
        );
        this._setDockPanelModeClass(
            entry.container,
            false
        );
    }

    _scheduleNativeDashRescan() {
        // One retry chain at a time. Restarting the timer on every caller can
        // turn unrelated Shell events into a permanent polling loop.
        if (this._dashReconnectTimeoutId)
            return;

        let attempts = 0;
        let sourceId = 0;

        sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DASH_RESCAN_INTERVAL_MS,
            () => {
                let keepGoing = false;

                try {
                    attempts++;
                    const tracked =
                        this._findNativeDashToDock();

                    // Once a dock container is tracked, its destroy/mapped
                    // signals own lifecycle changes. Polling after success is
                    // both unnecessary and harmful because mode sync touches
                    // native theme state.
                    keepGoing =
                        !tracked &&
                        attempts <
                            DASH_RESCAN_IDLE_TICKS;
                } finally {
                    if (
                        !keepGoing &&
                        this._dashReconnectTimeoutId ===
                            sourceId
                    ) {
                        this._dashReconnectTimeoutId = 0;
                    }
                }

                return keepGoing
                    ? GLib.SOURCE_CONTINUE
                    : GLib.SOURCE_REMOVE;
            }
        );

        this._dashReconnectTimeoutId = sourceId;
    }

    _loadStylesheet() {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([
                this._vendor.root,
                'stylesheet.css',
            ])
        );
        if (!file.query_exists(null))
            return;

        const theme = St.ThemeContext
            .get_for_stage(global.stage)
            .get_theme();
        theme.load_stylesheet(file);
        this._stylesheet = file;
    }

    _unloadStylesheet() {
        if (!this._stylesheet)
            return;

        try {
            const theme = St.ThemeContext
                .get_for_stage(global.stage)
                .get_theme();
            theme.unload_stylesheet(this._stylesheet);
        } catch {
            // Theme may already be tearing down.
        }
        this._stylesheet = null;
    }

    _setupDiagnostics() {
        // Production stays sampler-free. The ring sampler is useful only for
        // explicit dump diagnostics and otherwise adds permanent background
        // timer/work to the Shell process.
        this._dumpSettingsId = this._settings.connect(
            'changed::enable-dump-shortcut',
            () => this._syncDumpKeybinding()
        );
        this._syncDumpKeybinding();
    }

    _syncDumpKeybinding() {
        const wanted = this._settings.get_boolean(
            'enable-dump-shortcut'
        );

        if (wanted && !this._glassRingSamplerActive) {
            try {
                this._vendor.startGlassRingSampler(50);
                this._glassRingSamplerActive = true;
            } catch {
                this._glassRingSamplerActive = false;
            }
        } else if (!wanted && this._glassRingSamplerActive) {
            try {
                this._vendor.stopGlassRingSampler();
            } catch {}
            this._glassRingSamplerActive = false;
        }

        if (wanted && !this._dumpKeybindingInstalled) {
            Main.wm.addKeybinding(
                'dump-loop-keybinding',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL |
                    Shell.ActionMode.OVERVIEW,
                () => this._toggleDumpLoop()
            );
            this._dumpKeybindingInstalled = true;
        } else if (!wanted && this._dumpKeybindingInstalled) {
            try {
                Main.wm.removeKeybinding('dump-loop-keybinding');
            } catch {
                // Binding may already be gone.
            }
            this._dumpKeybindingInstalled = false;
            this._stopDumpLoop();
        }
    }

    _toggleDumpLoop() {
        if (this._dumpLoopId) {
            this._stopDumpLoop();
            Main.notify('Liquid Glass', 'Diagnostic dump stopped');
            return;
        }

        try {
            this._vendor.flushGlassRing();
        } catch {
            // Ring is diagnostic-only.
        }

        const intervalMs = 100;
        const ticks = 600;
        let count = 0;

        this._dumpLoopId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            intervalMs,
            () => {
                try {
                    global._lgGlass?.dump();
                } catch {
                    // Keep the diagnostic loop alive.
                }

                count++;
                if (count < ticks)
                    return GLib.SOURCE_CONTINUE;

                this._dumpLoopId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );

        Main.notify(
            'Liquid Glass',
            'Diagnostic dump running for 60 seconds'
        );
    }

    _stopDumpLoop() {
        if (!this._dumpLoopId)
            return;

        try {
            GLib.source_remove(this._dumpLoopId);
        } catch {
            // Source may have completed already.
        }
        this._dumpLoopId = 0;
    }

    _installDebugState() {
        globalThis[DEBUG_STATE_KEY] = {
            status: () => ({
                enabled: this._enabled,
                vendorRoot: this._vendor?.root ?? null,
                liveEffects:
                    globalThis.global?._lgGlass?.count?.() ?? null,
                nativeDashManagers:
                    this._nativeDashEntries.length,
                topPanel: Boolean(this._topPanelIslands),
                popupGlassManager: Boolean(
                    this._popupGlassManager
                ),
                shellCardGlassManager: Boolean(
                    this._shellCardGlassManager
                ),
                previewGlassManager: Boolean(
                    this._previewGlassManager
                ),
                appGridBackdropManager: Boolean(
                    this._appGridBackdropManager
                ),
                overviewCloseGlassManager: Boolean(
                    this._overviewCloseGlassManager
                ),
                sharedAdaptiveTextManager: Boolean(
                    this._sharedAdaptiveTextManager
                ),
                orbGlassManager: Boolean(
                    this._orbGlassManager
                ),
                spotlightGlassManager: Boolean(
                    this._spotlightGlassManager
                ),
                glassOpacity:
                    this._vliqSettings?.get_int?.(
                        'glass-opacity'
                    ) ?? null,
                glassTintColor:
                    this._vliqSettings?.get_string?.(
                        'glass-tint-color'
                    ) ?? null,
                glassBlur:
                    this._vliqSettings?.get_int?.(
                        'glass-blur'
                    ) ?? null,
                glassStyle:
                    this._vliqSettings?.get_string?.(
                        'glass-style'
                    ) ?? null,
                frostAmount:
                    this._settings?.get_double?.(
                        'vliq-frost-amount'
                    ) ?? null,
                nativeNotificationStyler: Boolean(
                    this._notificationGlassManager
                ),
                osdManager: Boolean(this._osdManager),
                externalGlobalStack:
                    this._externalGlobalStack,
                managerHealth: {
                    ...this._managerHealth,
                },
            }),
            dump: () => {
                const status =
                    globalThis[DEBUG_STATE_KEY]?.status?.() ?? null;
                console.log(
                    '[VLIQ][LiquidGlass][full-status] ' +
                    JSON.stringify(status)
                );
                const upstream =
                    globalThis.global?._lgGlass?.dump?.() ?? null;
                return {status, upstream};
            },
        };
    }

    disable() {
        if (!this._enabled && !this._vendor)
            return;

        this._enabled = false;

        if (this._monitorsChangedId) {
            try {
                Main.layoutManager.disconnect(
                    this._monitorsChangedId
                );
            } catch {
                // Layout manager may already be tearing down.
            }
            this._monitorsChangedId = 0;
        }

        if (this._dashTimeoutId) {
            try {
                GLib.source_remove(this._dashTimeoutId);
            } catch {
                // Source may already be gone.
            }
            this._dashTimeoutId = 0;
        }

        if (this._dashReconnectTimeoutId) {
            try {
                GLib.source_remove(
                    this._dashReconnectTimeoutId
                );
            } catch {
                // Source may already be gone.
            }
            this._dashReconnectTimeoutId = 0;
        }

        this._stopDumpLoop();

        if (this._dumpSettingsId && this._settings) {
            try {
                this._settings.disconnect(this._dumpSettingsId);
            } catch {
                // Settings may already be tearing down.
            }
            this._dumpSettingsId = 0;
        }

        if (this._dumpKeybindingInstalled) {
            try {
                Main.wm.removeKeybinding('dump-loop-keybinding');
            } catch {
                // Binding may already be gone.
            }
            this._dumpKeybindingInstalled = false;
        }

        if (!this._externalGlobalStack) {
            try {
                this._vendor?.stopGlassRingSampler();
            } catch {
                // Diagnostic cleanup is best-effort.
            }
            this._glassRingSamplerActive = false;

            // Match upstream teardown ordering for shared compositor state.
            try {
                this._vendor?.adaptiveColorTweener?.stopAll();
            } catch {
                // Shared animation cleanup is best-effort.
            }
            try {
                this._vendor?.destroySharedBackgroundSource?.();
            } catch {
                // Shared background cleanup is best-effort.
            }
            try {
                this._vendor?.releaseAllClonedWindowActors?.();
            } catch {
                // Window clone cleanup is best-effort.
            }
        }

        const cleanup = (name, manager) => {
            if (!manager)
                return;
            try {
                manager.cleanup();
            } catch (error) {
                console.error(
                    '[VLIQ][LiquidGlass] ' +
                    name +
                    ' cleanup failed: ' +
                    error
                );
            }
        };

        this._cleanupTopPanelGlass();
        this._cancelDockModeTransition();
        this._cleanupDockVerticalOffsetWatch();

        for (const entry of [
            ...this._nativeDashEntries,
        ]) {
            this._releaseNativeDash(entry);
        }
        this._nativeDashEntries = [];
        this._cleanupDashToDockModeWatch();

        this._cleanupSharedCardAppearanceSync();

        cleanup('popupGlassManager', this._popupGlassManager);
        this._popupGlassManager = null;

        cleanup(
            'shellCardGlassManager',
            this._shellCardGlassManager
        );
        this._shellCardGlassManager = null;

        cleanup('previewGlassManager', this._previewGlassManager);
        this._previewGlassManager = null;

        cleanup(
            'appGridBackdropManager',
            this._appGridBackdropManager
        );
        this._appGridBackdropManager = null;

        cleanup(
            'wallpaperAtmosphereManager',
            this._wallpaperAtmosphereManager
        );
        this._wallpaperAtmosphereManager = null;

        cleanup(
            'overviewCloseGlassManager',
            this._overviewCloseGlassManager
        );
        this._overviewCloseGlassManager = null;

        cleanup(
            'sharedAdaptiveTextManager',
            this._sharedAdaptiveTextManager
        );
        this._sharedAdaptiveTextManager = null;

        cleanup(
            'orbGlassManager',
            this._orbGlassManager
        );
        this._orbGlassManager = null;

        cleanup(
            'spotlightGlassManager',
            this._spotlightGlassManager
        );
        this._spotlightGlassManager = null;

        this._cleanupNativeNotificationStyler();
        cleanup('osdManager', this._osdManager);

        this._notificationGlassManager = null;
        this._osdManager = null;

        if (!this._externalGlobalStack) {
            try {
                this._vendor?.setUtilsLogger?.(null);
            } catch {
                // Logger may already be detached.
            }
        }

        try {
            this._logger?.cleanup?.();
        } catch {
            // Logger cleanup is best-effort.
        }

        if (!this._externalGlobalStack)
            this._unloadStylesheet();

        if (globalThis[DEBUG_STATE_KEY])
            delete globalThis[DEBUG_STATE_KEY];

        this._logger = null;
        this._settings = null;
        this._vendor = null;
        this._ubuntuDockModule = null;
        this._ubuntuDockManager = null;
        this._externalGlobalStack = false;
        this._managerHealth = {};
    }
}

