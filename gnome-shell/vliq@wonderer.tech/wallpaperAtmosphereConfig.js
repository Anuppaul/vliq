// Fixed wallpaper material. The tint matches the native VLIQ hover-card
// background in runtime.css; no color grading, grain, blur or animation.
export const WALLPAPER_MILKY_TINT = Object.freeze({
    red: 245,
    green: 249,
    blue: 255,
    opacity: 0.24,
});

export const WALLPAPER_STYLES = Object.freeze([
    Object.freeze({
        id: 'milky',
        label: 'Milky White',
        description: 'The same soft 24% whitish tint as VLIQ hover cards.',
    }),
    Object.freeze({
        id: 'original',
        label: 'Original',
        description: 'Unmodified GNOME wallpaper; no VLIQ tint pass.',
    }),
]);

export function readWallpaperProfile(settings) {
    let savedStyle = 'milky';
    try {
        savedStyle = settings?.get_string('wallpaper-style') ?? 'milky';
    } catch {}

    // Old Natural/Cinematic/Atmosphere/Custom values are intentionally
    // treated as Milky White without rewriting the user's GSettings.
    // An explicitly saved Original still remains an opt-out.
    const style = savedStyle === 'original' ? 'original' : 'milky';
    return {style, active: style === 'milky'};
}
