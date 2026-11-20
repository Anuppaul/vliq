import {
    WALLPAPER_STYLES,
    readWallpaperProfile,
} from './wallpaperAtmosphereConfig.js';

// A single fixed tint replaces the retired five-channel Atmosphere editor.
// Opening preferences never writes settings or modifies GNOME's image URI.
export function addWallpaperAtmospherePreferences(
    page, settings, Adw, Gtk
) {
    const appearance = new Adw.PreferencesGroup({
        title: 'Wallpaper appearance',
        description:
            'Milky White adds the same soft whitish shade as VLIQ hover cards. ' +
            'No vignette, grain, grading, extra blur or wallpaper-file changes.',
    });
    page.add(appearance);

    const presetRow = new Adw.ComboRow({
        title: 'Wallpaper style',
        subtitle: 'Milky White (24% tint) or the untouched Original.',
        model: Gtk.StringList.new(
            WALLPAPER_STYLES.map(style => style.label)
        ),
    });
    appearance.add(presetRow);

    let syncing = false;
    const syncStyle = () => {
        const {style} = readWallpaperProfile(settings);
        const index = WALLPAPER_STYLES.findIndex(item => item.id === style);
        if (presetRow.selected === index)
            return;
        syncing = true;
        try {
            presetRow.selected = index;
        } finally {
            syncing = false;
        }
    };
    presetRow.connect('notify::selected', () => {
        if (syncing)
            return;
        const style = WALLPAPER_STYLES[presetRow.selected]?.id;
        const saved = settings.get_string('wallpaper-style');
        // When a live Shell still has the old unset Original default,
        // selecting Original must persist a real opt-out even though the
        // effective old schema value already reads 'original'.
        const needsExplicitOptOut = style === 'original' &&
            settings.get_user_value?.('wallpaper-style') === null;
        if (style && (saved !== style || needsExplicitOptOut))
            settings.set_string('wallpaper-style', style);
    });
    settings.connect('changed::wallpaper-style', syncStyle);
    syncStyle();

    const renderer = new Adw.PreferencesGroup({
        title: 'Live wallpaper renderer',
        description:
            'The tint is applied only to real GNOME wallpaper actors. ' +
            'The attachment count is diagnostic, not proof of GPU pixels.',
    });
    page.add(renderer);

    const statusRow = new Adw.ActionRow({
        title: 'Tint attachment',
        subtitle: settings.get_string('wallpaper-runtime-status'),
    });
    renderer.add(statusRow);
    settings.connect('changed::wallpaper-runtime-status', () => {
        statusRow.subtitle = settings.get_string('wallpaper-runtime-status');
    });

    return {presetRow, statusRow};
}
