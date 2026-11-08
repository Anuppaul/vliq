import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {addUbuntuDockPreferences} from './nativeDockPreferences.js';
import {addWallpaperAtmospherePreferences} from './wallpaperAtmospherePreferences.js';

const LIQUID_GLASS_SCHEMA =
    'org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com';

function createLiquidGlassSettings(extensionDir) {
    // Store packages place both VLIQ and renderer schema XML in the
    // *top-level* schemas/ directory so EGO can compile them together.
    // Development installs may still keep an additional compiled vendor
    // schema directory. Always prefer the Store-compatible source.
    const directories = [
        extensionDir.get_child('schemas'),
        extensionDir.get_child('vendor')
            .get_child('liquid-glass')
            .get_child('schemas'),
    ];

    for (const folder of directories) {
        const compiled =
            folder.get_child('gschemas.compiled');
        if (!compiled.query_exists(null))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                folder.get_path(),
                Gio.SettingsSchemaSource.get_default(),
                false
            );
            const schema = source.lookup(LIQUID_GLASS_SCHEMA, true);
            if (schema)
                return new Gio.Settings({settings_schema: schema});
        } catch (error) {
            console.warn(
                '[VLIQ][Store] preferences schema source unavailable: ' +
                error
            );
        }
    }

    const fallback =
        Gio.SettingsSchemaSource.get_default()?.lookup?.(
            LIQUID_GLASS_SCHEMA, true
        ) ?? null;
    if (fallback)
        return new Gio.Settings({settings_schema: fallback});

    throw new Error(
        'Liquid Glass schema missing; reinstall VLIQ from a complete ZIP.'
    );
}

function addPage(window, title, iconName, description = null) {
    const page = new Adw.PreferencesPage({
        title,
        icon_name: iconName,
    });

    if (description)
        page.description = description;

    window.add(page);
    return page;
}

function addSwitch(group, settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addIntSpin(group, settings, key, title, subtitle, min, max, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: step,
            page_increment: step * 5,
            value: settings.get_int(key),
        }),
        digits: 0,
    });

    let syncing = false;
    const sync = () => {
        syncing = true;
        row.value = settings.get_int(key);
        syncing = false;
    };

    row.connect('notify::value', () => {
        if (!syncing)
            settings.set_int(key, Math.round(row.value));
    });
    settings.connect('changed::' + key, sync);
    group.add(row);
    return row;
}

function addDoubleSpin(
    group,
    settings,
    key,
    title,
    subtitle,
    min,
    max,
    step,
    digits = 2
) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: step,
            page_increment: step * 5,
            value: settings.get_double(key),
        }),
        digits,
    });

    let syncing = false;
    const sync = () => {
        syncing = true;
        row.value = settings.get_double(key);
        syncing = false;
    };

    row.connect('notify::value', () => {
        if (!syncing)
            settings.set_double(key, row.value);
    });
    settings.connect('changed::' + key, sync);
    group.add(row);
    return row;
}

function addResetRow(group, title, subtitle, callback) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.Button({
        label: 'Reset',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', callback);
    row.add_suffix(button);
    row.activatable_widget = button;
    group.add(row);
    return row;
}


function installedApplications() {
    const seen = new Set();
    const apps = [];

    for (const info of Gio.AppInfo.get_all()) {
        let visible = true;
        try {
            visible =
                info.should_show?.() !== false;
        } catch {}

        const id = info.get_id?.() ?? '';
        if (!visible || !id || seen.has(id))
            continue;

        seen.add(id);
        apps.push({
            id,
            name:
                info.get_display_name?.() ??
                info.get_name?.() ??
                id,
            icon: info.get_icon?.() ?? null,
        });
    }

    apps.sort((a, b) =>
        a.name.localeCompare(
            b.name,
            undefined,
            {
                sensitivity: 'base',
                numeric: true,
            }
        )
    );
    return apps;
}

export default class VLIQPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const advanced = createLiquidGlassSettings(this.dir);

        window.set_search_enabled?.(true);
        window.set_default_size?.(760, 720);

        // -----------------------------------------------------------------
        // Appearance
        // -----------------------------------------------------------------
        const appearancePage = addPage(
            window,
            'Appearance',
            'preferences-desktop-appearance-symbolic'
        );

        // Independent styles: choosing Frosted Crystal never rewrites the
        // existing Liquid v10 Advanced optics or user tint/blur preferences.
        // Gio.Settings makes this switch persistent and live while Shell runs.
        const materialGroup = new Adw.PreferencesGroup({
            title: 'Glass Material',
            description:
                'Choose one material for VLIQ surfaces. The change applies live without restarting GNOME Shell.',
        });
        appearancePage.add(materialGroup);

        const glassStyle = new Adw.ComboRow({
            title: 'Material style',
            subtitle:
                'Liquid Glass retains the glossy v10 optics. Frosted Crystal adds soft diffusion, matte grain and subtle crystal edges.',
            model: Gtk.StringList.new([
                'Liquid Glass',
                'Frosted Crystal',
            ]),
        });
        const glassStyleValues = ['liquid', 'frosted'];
        let syncingGlassStyle = false;
        const syncGlassStyle = () => {
            syncingGlassStyle = true;
            glassStyle.selected = Math.max(
                0,
                glassStyleValues.indexOf(settings.get_string('glass-style'))
            );
            syncingGlassStyle = false;
        };
        syncGlassStyle();
        glassStyle.connect('notify::selected', () => {
            if (!syncingGlassStyle && glassStyle.selected < 2)
                settings.set_string(
                    'glass-style',
                    glassStyleValues[glassStyle.selected]
                );
        });
        settings.connect('changed::glass-style', syncGlassStyle);
        materialGroup.add(glassStyle);

        const frost = new Adw.PreferencesGroup({
            title: 'Frosted Crystal',
            description:
                'Independent controls for the matte material. Liquid Glass settings are saved separately and are never overwritten.',
        });
        appearancePage.add(frost);
        addIntSpin(
            frost, settings, 'frost-density',
            'Frost density',
            'Diffuses background detail through a satin-matte crystal surface.',
            0, 100, 2
        );
        addIntSpin(
            frost, settings, 'frost-grain',
            'Micro-grain',
            'Screen-static, fine crystalline texture with no extra texture pass.',
            0, 100, 2
        );
        addIntSpin(
            frost, settings, 'frost-edge-glow',
            'Crystal edge glow',
            'Soft glints along the refractive crystal perimeter.',
            0, 100, 2
        );
        const syncFrostControls = () => {
            frost.set_sensitive(
                settings.get_string('glass-style') === 'frosted'
            );
        };
        syncFrostControls();
        settings.connect('changed::glass-style', syncFrostControls);

        const glass = new Adw.PreferencesGroup({
            title: 'Liquid Glass Controls',
            description:
                'Original v10 appearance values are retained when switching to Frosted Crystal.',
        });
        appearancePage.add(glass);

        addIntSpin(
            glass, settings, 'glass-blur',
            'Blur',
            'Base backdrop blur. Both materials apply extra diffusion when above zero; zero disables it.',
            0, 80, 1
        );
        addIntSpin(
            glass, settings, 'glass-opacity',
            'Tint strength',
            'Amount of white or custom tint mixed into the glass.',
            0, 100, 1
        );
        addIntSpin(
            glass, settings, 'glass-filter-opacity',
            'White filter',
            'Neutral veil above refraction and below native content.',
            0, 20, 1
        );

        const tint = new Adw.EntryRow({
            title: 'Tint color',
            text: settings.get_string('glass-tint-color'),
        });
        tint.connect('changed', () => {
            const value = tint.text.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(value))
                settings.set_string('glass-tint-color', value);
        });
        settings.connect('changed::glass-tint-color', () => {
            const value = settings.get_string('glass-tint-color');
            if (tint.text !== value)
                tint.text = value;
        });
        glass.add(tint);

        const optics = new Adw.PreferencesGroup({
            title: 'Optics',
            description:
                'Fine material tuning. These controls affect the shared refractive character.',
        });
        appearancePage.add(optics);

        addDoubleSpin(
            optics, advanced, 'glass-displacement-scale',
            'Refraction',
            'Edge lens displacement strength.',
            0, 60, 0.5, 1
        );
        addDoubleSpin(
            optics, advanced, 'glass-chroma-strength',
            'Chromatic fringe',
            'RGB dispersion at refractive edges.',
            0, 8, 0.1, 1
        );
        addDoubleSpin(
            optics, advanced, 'glass-specular-intensity',
            'Specular',
            'Directional surface highlight strength.',
            0, 2, 0.05, 2
        );
        addDoubleSpin(
            optics, advanced, 'glass-rim-intensity',
            'Rim light',
            'Fresnel-style edge lighting strength.',
            0, 2, 0.05, 2
        );
        addDoubleSpin(
            optics, advanced, 'glass-sheen-intensity',
            'Sheen',
            'Soft highlight across the glass surface.',
            0, 1, 0.02, 2
        );

        const dateMenu = new Adw.PreferencesGroup({
            title: 'Date Menu',
            description:
                'Independent calibration for the clock and calendar popup.',
        });
        appearancePage.add(dateMenu);

        addIntSpin(
            dateMenu, settings, 'date-menu-glass-blur',
            'Blur',
            'Date Menu blur radius only.',
            0, 20, 1
        );
        addIntSpin(
            dateMenu, settings, 'date-menu-glass-opacity',
            'Tint',
            'Date Menu tint strength only.',
            0, 20, 1
        );
        addIntSpin(
            dateMenu, settings, 'date-menu-glass-filter-opacity',
            'White filter',
            'Date Menu neutral white veil only.',
            0, 20, 1
        );

        // -----------------------------------------------------------------
        // Wallpaper — VLIQ Atmosphere
        // -----------------------------------------------------------------
        const wallpaperPage = addPage(
            window,
            'Wallpaper',
            'preferences-desktop-wallpaper-symbolic',
            'Premium native wallpaper grading; Original keeps GNOME intact.'
        );
        addWallpaperAtmospherePreferences(
            wallpaperPage, settings, Adw, Gtk
        );

        // -----------------------------------------------------------------
        // Terminal — native compositor backdrop, not a GTK overlay.
        // -----------------------------------------------------------------
        const terminalPage = addPage(
            window,
            'Terminal',
            'utilities-terminal-symbolic',
            'Native Ptyxis background blur on GNOME Shell 50.'
        );
        const terminalGroup = new Adw.PreferencesGroup({
            title: 'VLIQ Terminal Glass — experimental',
            description:
                'Requires a transparent native Ptyxis background (for example 0.88 opacity). Blur is painted behind the window; text and other applications remain unchanged.',
        });
        terminalPage.add(terminalGroup);

        addSwitch(
            terminalGroup,
            settings,
            'terminal-backdrop-blur-enabled',
            'Real backdrop blur',
            'Opt in to one native GPU background blur effect per Ptyxis window. Disabled by default.'
        );

        const terminalRadius = addIntSpin(
            terminalGroup,
            settings,
            'terminal-backdrop-blur-radius',
            'Background blur strength',
            'Strength 4–36 (legacy sigma scale); GNOME 50 uses radius = strength × 2. Higher values cost more GPU work.',
            4, 36, 1
        );
        const syncTerminalSensitivity = () => {
            terminalRadius.sensitive = settings.get_boolean(
                'terminal-backdrop-blur-enabled'
            );
        };
        syncTerminalSensitivity();
        settings.connect(
            'changed::terminal-backdrop-blur-enabled',
            syncTerminalSensitivity
        );

        const terminalStatus = new Adw.ActionRow({
            title: 'Live compositor attachment',
            subtitle: settings.get_string('terminal-backdrop-blur-status'),
        });
        terminalGroup.add(terminalStatus);
        settings.connect(
            'changed::terminal-backdrop-blur-status',
            () => {
                terminalStatus.subtitle = settings.get_string(
                    'terminal-backdrop-blur-status'
                );
            }
        );

        // -----------------------------------------------------------------
        // Search
        // -----------------------------------------------------------------
        const searchPage = addPage(
            window,
            'Search',
            'system-search-symbolic'
        );

        const spotlight = new Adw.PreferencesGroup({
            title: 'Spotlight Search',
            description:
                'Fast native-style application search without opening GNOME Overview.',
        });
        searchPage.add(spotlight);

        addSwitch(
            spotlight,
            settings,
            'spotlight-enabled',
            'Enable Spotlight Search',
            'Super+Space opens VLIQ Search. GNOME’s input-source shortcut is restored automatically when this is disabled.'
        );

        const spotlightShortcut = new Adw.ActionRow({
            title: 'Shortcut',
            subtitle: 'Open or close VLIQ Search',
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: '<Super>space',
            valign: Gtk.Align.CENTER,
        });
        spotlightShortcut.add_suffix(shortcutLabel);
        spotlight.add(spotlightShortcut);

        const spotlightPosition = addIntSpin(
            spotlight,
            settings,
            'spotlight-vertical-position',
            'Vertical position',
            'Position from the top of the active monitor (%). Lower values move the search bar up.',
            8, 55, 1
        );

        const syncSpotlightSensitivity = () => {
            const enabled =
                settings.get_boolean(
                    'spotlight-enabled'
                );
            spotlightShortcut.sensitive =
                enabled;
            spotlightPosition.sensitive =
                enabled;
        };
        syncSpotlightSensitivity();
        settings.connect(
            'changed::spotlight-enabled',
            syncSpotlightSensitivity
        );

        // -----------------------------------------------------------------
        // Menus
        // -----------------------------------------------------------------
        const menusPage = addPage(
            window,
            'Menus',
            'open-menu-symbolic'
        );

        const quickBrightnessGroup = new Adw.PreferencesGroup({
            title: 'Quick Settings Brightness',
            description:
                'A Brightness bar immediately below Sound. GNOME hardware backlight is reused when available; desktop monitors without backlight use reversible software dimming.',
        });
        menusPage.add(quickBrightnessGroup);

        addSwitch(
            quickBrightnessGroup,
            settings,
            'quick-brightness-enabled',
            'Brightness below Sound',
            'Use GNOME’s native slider or a software dimmer for external displays. ON by default.'
        );

        const softwareBrightnessRow = addIntSpin(
            quickBrightnessGroup,
            settings,
            'quick-soft-brightness',
            'Software brightness (%)',
            'Only used without hardware backlight. 100% = original image, no GPU effect. Range 30–100%; cannot boost physical monitor backlight.',
            30, 100, 1
        );

        const brightnessStatus = new Adw.ActionRow({
            title: 'Brightness control mode',
            subtitle: settings.get_string('quick-brightness-status'),
        });
        quickBrightnessGroup.add(brightnessStatus);

        const syncBrightnessControls = () => {
            softwareBrightnessRow.sensitive =
                settings.get_boolean('quick-brightness-enabled') &&
                settings.get_string('quick-brightness-status')
                    .startsWith('Software');
            brightnessStatus.subtitle =
                settings.get_string('quick-brightness-status');
        };
        syncBrightnessControls();
        settings.connect(
            'changed::quick-brightness-enabled', syncBrightnessControls
        );
        settings.connect(
            'changed::quick-brightness-status', syncBrightnessControls
        );


        const panelMenus = new Adw.PreferencesGroup({
            title: 'Panel Menu Behavior',
            description:
                'Control how an already-open panel menu reacts when the pointer crosses another panel icon.',
        });
        menusPage.add(panelMenus);

        addSwitch(
            panelMenus,
            settings,
            'panel-menu-hover-switch',
            'Switch menus on hover',
            'When off, ChatGPT, Codex, EasyEffects, Quick Settings and other panel menus open only by click or keyboard.'
        );

        const hoverDelayRow = addIntSpin(
            panelMenus,
            settings,
            'panel-menu-hover-delay-ms',
            'Hover switch delay',
            'How long the pointer must remain over another panel icon before switching.',
            0, 1000, 25
        );

        const syncHoverDelaySensitivity = () => {
            hoverDelayRow.sensitive =
                settings.get_boolean('panel-menu-hover-switch');
        };
        syncHoverDelaySensitivity();
        settings.connect(
            'changed::panel-menu-hover-switch',
            syncHoverDelaySensitivity
        );

        // -----------------------------------------------------------------
        // Dock
        // -----------------------------------------------------------------
        const dockPage = addPage(
            window,
            'Dock',
            'go-bottom-symbolic'
        );

        // Bind directly to Ubuntu Dock's *installed* native GSettings
        // schema, not a duplicate VLIQ key or a replacement dock.
        // Native Dash-to-Dock remains the only hide/show state machine.
        addUbuntuDockPreferences(dockPage, Gio, Gtk, Adw);

        const dock = new Adw.PreferencesGroup({
            title: 'VLIQ Floating Dock Offset',
            description:
                'Optional VLIQ-only vertical adjustment of the real Ubuntu Dock. Auto-hide and intellihide continue using the native fully-shown bounds. Panel mode ignores this offset.',
        });
        dockPage.add(dock);

        addIntSpin(
            dock, settings, 'dock-vertical-offset',
            'Vertical offset',
            'Positive moves the floating dock up; negative moves it down.',
            -64, 64, 1
        );

        addResetRow(
            dock,
            'Reset dock position',
            'Return the floating dock to Ubuntu Dock’s native vertical position.',
            () => settings.reset('dock-vertical-offset')
        );

        // -----------------------------------------------------------------
        // Orb
        // -----------------------------------------------------------------
        const orbPage = addPage(
            window,
            'Orb',
            'applications-system-symbolic'
        );

        const orbAppearance = new Adw.PreferencesGroup({
            title: 'Orb Appearance',
            description:
                'Desktop Orb visibility, size and icon.',
        });
        orbPage.add(orbAppearance);

        addSwitch(
            orbAppearance, settings, 'orb-enabled',
            'Show Orb',
            'Keep the VLIQ Orb on the desktop.'
        );
        addIntSpin(
            orbAppearance, settings, 'orb-size',
            'Size',
            'Orb diameter in pixels.',
            20, 80, 1
        );
        addIntSpin(
            orbAppearance, settings, 'orb-opacity',
            'Opacity',
            'Orb opacity percentage.',
            0, 100, 1
        );

        const icon = new Adw.EntryRow({
            title: 'Orb icon',
            text: settings.get_string('orb-icon'),
        });
        settings.bind(
            'orb-icon',
            icon,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        orbAppearance.add(icon);

        const orbBehavior = new Adw.PreferencesGroup({
            title: 'Orb Behavior',
            description:
                'Idle hiding, fading and launcher timing.',
        });
        orbPage.add(orbBehavior);

        addSwitch(
            orbBehavior, settings, 'auto-hide-orb',
            'Auto-hide',
            'Slide the Orb to the nearest monitor edge while idle.'
        );
        addIntSpin(
            orbBehavior, settings, 'auto-hide-delay',
            'Auto-hide delay',
            'Milliseconds before hiding.',
            0, 10000, 100
        );
        addSwitch(
            orbBehavior, settings, 'auto-fade-orb',
            'Auto-fade',
            'Fade the Orb while idle when auto-hide is off.'
        );
        addIntSpin(
            orbBehavior, settings, 'auto-fade-delay',
            'Auto-fade delay',
            'Milliseconds before fading.',
            0, 30000, 250
        );
        addIntSpin(
            orbBehavior, settings, 'hover-delay',
            'Launcher hover delay',
            'Milliseconds before the radial launcher opens.',
            0, 1200, 25
        );
        addIntSpin(
            orbBehavior, settings, 'close-delay',
            'Launcher close delay',
            'Milliseconds before the radial launcher closes.',
            0, 1800, 25
        );

        const launcher = new Adw.PreferencesGroup({
            title: 'Radial Launcher',
            description:
                'Layout, animation, previews and indicators.',
        });
        orbPage.add(launcher);

        const appSource = new Adw.ComboRow({
            title: 'App source',
            subtitle:
                'Choose what appears around the Orb. Scroll on the Orb to move between pages when the selected source has more apps than fit at once.',
            model: Gtk.StringList.new([
                'Dock Apps',
                'Custom Apps',
                'All Apps',
            ]),
        });
        const appSourceValues = [
            'dock',
            'custom',
            'all',
        ];
        let syncingAppSource = false;
        const syncAppSource = () => {
            syncingAppSource = true;
            const value =
                settings.get_string(
                    'orb-app-source'
                );
            appSource.selected = Math.max(
                0,
                appSourceValues.indexOf(value)
            );
            syncingAppSource = false;
        };
        syncAppSource();
        appSource.connect(
            'notify::selected',
            () => {
                if (syncingAppSource)
                    return;
                settings.set_string(
                    'orb-app-source',
                    appSourceValues[
                        appSource.selected
                    ] ?? 'dock'
                );
            }
        );
        settings.connect(
            'changed::orb-app-source',
            syncAppSource
        );
        launcher.add(appSource);

        const customApps = installedApplications();
        const customPicker =
            new Adw.ExpanderRow({
                title: 'Custom apps',
                subtitle: '',
            });
        launcher.add(customPicker);

        const customRows = new Map();
        let syncingCustomApps = false;

        const syncCustomApps = () => {
            const selected =
                settings.get_strv(
                    'orb-custom-apps'
                );
            const selectedSet =
                new Set(selected);

            syncingCustomApps = true;
            for (
                const [id, row] of
                customRows
            ) {
                row.active =
                    selectedSet.has(id);
            }
            syncingCustomApps = false;

            const validSelectedCount =
                selected.filter(
                    id => customRows.has(id)
                ).length;
            customPicker.subtitle =
                validSelectedCount === 1
                    ? '1 app selected'
                    : `${validSelectedCount} apps selected`;
            customPicker.sensitive =
                settings.get_string(
                    'orb-app-source'
                ) === 'custom';
        };

        for (const app of customApps) {
            const row = new Adw.SwitchRow({
                title: app.name,
                subtitle: app.id,
            });

            if (app.icon) {
                const image = new Gtk.Image({
                    gicon: app.icon,
                    pixel_size: 24,
                    valign: Gtk.Align.CENTER,
                });
                row.add_prefix?.(image);
            }

            row.connect(
                'notify::active',
                () => {
                    if (syncingCustomApps)
                        return;

                    const selected =
                        settings.get_strv(
                            'orb-custom-apps'
                        );
                    const next =
                        selected.filter(
                            id => id !== app.id
                        );

                    if (row.active)
                        next.push(app.id);

                    settings.set_strv(
                        'orb-custom-apps',
                        next
                    );
                }
            );

            customRows.set(app.id, row);
            customPicker.add_row(row);
        }

        syncCustomApps();
        settings.connect(
            'changed::orb-custom-apps',
            syncCustomApps
        );
        settings.connect(
            'changed::orb-app-source',
            syncCustomApps
        );

        const orbGeometry =
            new Adw.ComboRow({
                title: 'Geometry',
                subtitle:
                    'Change the shape of the Orb launcher without changing app source, paging or interactions.',
                model: Gtk.StringList.new([
                    'Orbit',
                    'Star',
                    'Molecule',
                    'Spiral',
                    'Petal',
                ]),
            });
        const orbGeometryValues = [
            'orbit',
            'star',
            'molecule',
            'spiral',
            'petal',
        ];
        let syncingOrbGeometry = false;
        const syncOrbGeometry = () => {
            syncingOrbGeometry = true;
            const value =
                settings.get_string(
                    'orb-geometry'
                );
            orbGeometry.selected =
                Math.max(
                    0,
                    orbGeometryValues
                        .indexOf(value)
                );
            syncingOrbGeometry = false;
        };
        syncOrbGeometry();
        orbGeometry.connect(
            'notify::selected',
            () => {
                if (syncingOrbGeometry)
                    return;
                settings.set_string(
                    'orb-geometry',
                    orbGeometryValues[
                        orbGeometry.selected
                    ] ?? 'orbit'
                );
            }
        );
        settings.connect(
            'changed::orb-geometry',
            syncOrbGeometry
        );
        launcher.add(orbGeometry);

        addIntSpin(
            launcher, settings, 'icon-size',
            'Icon size',
            'Application icon button diameter.',
            20, 80, 1
        );
        addIntSpin(
            launcher, settings, 'icon-gap',
            'Icon gap',
            'Minimum edge gap between launcher icons.',
            0, 64, 1
        );
        addIntSpin(
            launcher, settings, 'ring-gap',
            'Geometry spacing',
            'Distance between Orbit rings or the main levels of Star, Molecule, Spiral and Petal layouts.',
            0, 160, 2
        );
        addIntSpin(
            launcher, settings, 'animation-ms',
            'Animation',
            'Open and close animation duration.',
            0, 600, 10
        );
        addIntSpin(
            launcher, settings, 'app-preview-size',
            'App preview size',
            'Live window preview size percentage.',
            50, 180, 5
        );
        addSwitch(
            launcher, settings, 'show-tooltips',
            'Tooltips',
            'Show application names on hover.'
        );
        addSwitch(
            launcher, settings, 'show-running-indicator',
            'Running indicators',
            'Show active application dots.'
        );

        const ringMode = new Adw.ComboRow({
            title: 'Layout depth',
            subtitle:
                'Automatic or fixed geometry depth. Orbit uses rings; other shapes extend their own structure.',
            model: Gtk.StringList.new([
                'Auto',
                '2 levels',
                '3 levels',
                '4 levels',
            ]),
        });
        const ringValues = ['auto', '2', '3', '4'];
        const syncRing = () => {
            const value = settings.get_string('ring-mode');
            ringMode.selected = Math.max(
                0,
                ringValues.indexOf(value)
            );
        };
        syncRing();
        ringMode.connect('notify::selected', () => {
            settings.set_string(
                'ring-mode',
                ringValues[ringMode.selected] ?? 'auto'
            );
        });
        settings.connect('changed::ring-mode', syncRing);
        launcher.add(ringMode);

        const orbReset = new Adw.PreferencesGroup({
            title: 'Position',
        });
        orbPage.add(orbReset);

        addResetRow(
            orbReset,
            'Reset Orb position',
            'Return the Orb to its default desktop position.',
            () => {
                settings.reset('orb-x');
                settings.reset('orb-y');
            }
        );

        // -----------------------------------------------------------------
        // Performance
        // -----------------------------------------------------------------
        const performancePage = addPage(
            window,
            'Performance',
            'utilities-system-monitor-symbolic'
        );

        const renderer = new Adw.PreferencesGroup({
            title: 'Renderer',
            description:
                'Tune expensive live scene synchronization without reducing native Shell input or geometry frame rate.',
        });
        performancePage.add(renderer);

        addIntSpin(
            renderer,
            settings,
            'glass-live-scene-fps',
            'Live scene FPS',
            '24–30 is recommended. Higher values refresh refracted windows more often and use more GPU/CPU time.',
            15, 60, 5
        );

        // VLIQ intentionally exposes only the curated controls above.
        // The vendored renderer's duplicate developer-oriented pages stay
        // hidden so Preferences remains compact and product-focused.
    }
}
