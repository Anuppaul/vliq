import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Regression: identical native panel hover/clock paint in every VLIQ header
// layout and both material modes, without duplicating menus or native actors.
const root = '../gnome-shell/vliq@wonderer.tech/';
const read = file => readFile(new URL(root + file, import.meta.url), 'utf8');
const [css, popup, topbar, dock] = await Promise.all([
    read('runtime.css'), read('popupGlass.js'),
    read('topBarIslands.js'), read('liquidGlassDock.js'),
]);
function rule(selector) {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, 'missing shared selector: ' + selector);
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    assert.ok(open > at && close > open);
    return css.slice(open, close);
}
const button = '#panel.vliq-liquid-top-panel .panel-button';
assert.match(rule(button + ' {'), /border-radius: 9px !important;/);
assert.match(rule(button + ' {'), /transition-duration: 120ms;/);
for (const [state, fill, rim] of [
    ['hover', '0.24', '0.20'], ['focus', '0.24', '0.20'],
    ['active', '0.34', '0.32'], ['checked', '0.34', '0.32'],
]) {
    const style = rule(button + ':' + state);
    assert.ok(style.includes('rgba(245, 249, 255, ' + fill + ')'),
        'global ' + state + ' hover fill must match taskbar icons');
    assert.ok(style.includes('rgba(255, 255, 255, ' + rim + ')'),
        'global ' + state + ' rim must match taskbar icons');
}
for (const name of ['vliq-three-islands',
                    'vliq-full-header', 'vliq-bottom-taskbar']) {
    assert.ok(topbar.includes(name) && topbar.includes('vliq-liquid-top-panel'),
        'common header class must apply in ' + name);
}
const clockStart = css.indexOf('/* GNOME/Yaru can draw two MORE pills');
const clockEnd = css.indexOf('}', clockStart);
assert.ok(clockStart >= 0 && clockEnd > clockStart);
const clockRules = css.slice(clockStart, clockEnd);
for (const state of ['', ':hover', ':focus', ':active', ':checked']) {
    for (const child of ['.clock-display-box', '.clock']) {
        assert.ok(clockRules.includes(
            '#panel.vliq-liquid-top-panel .clock-display' + state + ' ' + child),
        'clock duplicate pill must be cleared: ' + state + ' ' + child);
    }
}
for (const prop of [
    'background-color: transparent !important',
    'background-image: none !important',
    'border: 0 !important',
    'box-shadow: none !important',
]) assert.ok(clockRules.includes(prop));
assert.doesNotMatch(clockRules, /^\s*color\s*:/m,
    'shared clock rules must keep native/adaptive text color');
assert.ok(css.includes(
    '#panel.vliq-bottom-taskbar #panelRight .clock-display .clock,'),
    'Bottom Taskbar must retain its separate fixed white clock text');
assert.ok(css.includes(
    '#panel.vliq-bottom-taskbar #panelRight .panel-button:hover,'),
    'accepted Bottom Taskbar hover rules remain for backwards compatibility');

const calendarStart = css.indexOf(
    '/* Date Menu: restrained cool gray-white cards');
const quickStart = css.indexOf(
    '/* Quick Settings inner cards: same always-visible cool gray-white paint');
assert.ok(calendarStart >= 0 && quickStart > calendarStart);
const calendar = css.slice(calendarStart,
    css.indexOf('/* Quick Settings ', calendarStart));
const quick = css.slice(quickStart,
    css.indexOf('/* VLIQ Spotlight', quickStart));
for (const fragment of [calendar, quick]) {
    assert.doesNotMatch(fragment,
        /vliq-(three-islands|full-header|bottom-taskbar)/,
        'popup inner cards must remain layout-independent');
    assert.doesNotMatch(fragment, /glass-style.*(liquid|frosted)/,
        'popup inner cards must remain material-independent');
    assert.match(fragment, /rgba\(219, 223, 229, 0\.18\)/,
        'popup inner cards stay permanent cool gray-white');
}
assert.match(calendar, /\.calendar:hover/);
assert.match(quick, /spacing-rows: 10px;/);
assert.match(quick, /spacing-columns: 10px;/);
assert.match(popup, /this\._isDateMenu/);
assert.match(popup, /this\._isQuickSettings/);
assert.match(dock, /this\._popupGlassManager\.setup\(\)/);
assert.match(dock, /this\._popupGlassManager\?\.updateAppearance\(state\)/);
assert.match(dock, /this\._applyFrostedCrystalSettings\(\)/);
assert.match(dock, /'glass-style'/);
console.log('Global header Date/Quick paint in 3-Part/Full/Bottom and Liquid/Frosted PASS.');
