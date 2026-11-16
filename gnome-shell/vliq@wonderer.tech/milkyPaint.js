// Shared Milky material calculations for GPU-backed and shader-free VLIQ.
// No imports or GNOME rendering dependencies: deterministic pure CSS tokens.
const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

// Single source for Milky colors across every VLIQ-owned native Shell card.
// Keep Liquid/Frosted selectors completely untouched by these optional rules.
export function milkyPaintTokens(state = {}) {
    const opacity = clampNumber(state.milkyOpacity ?? 0.24, 0, 1);
    const border = clampNumber(state.milkyBorder ?? 0.20, 0, 1);
    // 0 is the original shade; negative values reduce whiteness and
    // positive values brighten toward pure white without changing density.
    const white = clampNumber(state.milkyWhiteness ?? 0, -1, 1);
    const rgb = [245, 249, 255].map((channel, index) => Math.round(
        white < 0
            ? channel + ([200, 205, 213][index] - channel) * -white
            : channel + (255 - channel) * white
    ));
    // White Balance is a *visible coverage* control at positive values.
    // Previously RGB reached #fff at +100 but retained Milky Opacity's
    // default 24% alpha, so a dark wallpaper still looked gray. Blend up
    // the alpha continuously: 0 = chosen opacity; +100 = solid #ffffff.
    // Negative White Balance leaves user-set opacity unchanged.
    const coverage = Math.max(0, white);
    const effectiveOpacity = opacity + (1 - opacity) * coverage;
    return {
        fill: 'rgba(' + rgb.join(',') + ',' +
            effectiveOpacity.toFixed(3) + ')',
        rim: border <= 0 ? 'none' :
            'inset 0 0 0 1px rgba(255,255,255,' +
                border.toFixed(3) + ')',
    };
}

// Fixed, deterministic CSS tile: never schedule GPU shader work or timers.
export function buildMilkyGrainSvg(intensity) {
    const strength = clampNumber(intensity, 0, 1);
    const dots = [];
    let seed = 0x51a7bd;
    const next = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    for (let i = 0; i < 420; i++) {
        const x = (next() * 48).toFixed(2);
        const y = (next() * 48).toFixed(2);
        const radius = (0.25 + next() * 0.42).toFixed(2);
        const bright = next() >= 0.5;
        const alpha = (strength * (0.05 + next() * 0.18)).toFixed(3);
        dots.push('<circle cx="' + x + '" cy="' + y +
            '" r="' + radius + '" fill="' +
            (bright ? '#ffffff' : '#18212c') +
            '" fill-opacity="' + alpha + '"/>');
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'width="48" height="48" viewBox="0 0 48 48">' +
        dots.join('') + '</svg>';
}

function milkyGrainCss(uri) {
    return uri
        ? '  background-image: url("' + uri + '") !important;\n' +
            '  background-repeat: repeat !important;\n'
        : '  background-image: none !important;\n';
}

export function buildMilkyAppearanceCss(state = {}, grainUri = '') {
    // Charcoal reuses native flat surface handling, but must NEVER inherit
    // Milky's white density/shade/edge controls or generated paint.
    if (!state.milky)
        return '';
    const {fill, rim} = milkyPaintTokens(state);
    // At +100 the entire card must be flat, solid #FFFFFF. A residual
    // dark grain image would otherwise break the full-white guarantee.
    const grain = milkyGrainCss(
        clampNumber(state.milkyWhiteness ?? 0, -1, 1) >= 1
            ? '' : grainUri
    );
    const roots = [
        // St.Theme is NOT a browser CSS engine: do not use :not().
        // Explicitly clear inactive islands after the main Milky paint.
        ...['panelLeft', 'panelCenter', 'panelRight'].map(id =>
            '.vliq-global-milky #panel.vliq-three-islands #' + id +
            '.vliq-panel-island'),
        // Match static global-Milky selectors *including ready classes*.
        // Otherwise runtime.css has higher specificity and its 24%-alpha
        // white wins even after the live dynamic stylesheet loads.
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-full-header',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-full-header.vliq-top-header-ready',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-bottom-taskbar',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-bottom-taskbar.vliq-top-header-ready',
        '.vliq-global-milky #panel.vliq-liquid-top-panel.vliq-bottom-taskbar.vliq-bottom-taskbar-glass-attached',
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
        grain +
        '  border: 0 !important;\n' +
        '  box-shadow: ' + rim + ' !important;\n' +
        '}\n' + inactive.join(',\n') + ' {\n' +
        '  background-color: transparent !important;\n' +
        '  background-image: none !important;\n' +
        '  border: 0 !important;\n' +
        '  box-shadow: none !important;\n' +
        '}\n';
}

