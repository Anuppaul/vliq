import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// 3-Part Header: native hover-card material becomes the persistent island
// face, with no nested button card and no regressions in other layouts.
const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');
const top = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/topBarIslands.js', import.meta.url
), 'utf8');
const start = css.indexOf('/* GNOME 50 three-part header: the accepted milky');
const end = css.indexOf('/* User-selectable FULL Top Header.', start);
assert.ok(start > 0 && end > start, '3-part paint has one isolated block');
const block = css.slice(start, end);
function body(selector) {
    const i = block.indexOf(selector);
    assert.ok(i >= 0, 'missing selector: ' + selector);
    const open = block.indexOf('{', i);
    const close = block.indexOf('}', open);
    return block.slice(open + 1, close);
}
const groups = ['panelLeft', 'panelCenter', 'panelRight'];
for (const group of groups) {
    const selector = '#panel.vliq-three-islands #' + group + '.vliq-panel-island';
    const ready = '#panel.vliq-three-islands #' + group + '.vliq-panel-island-ready';
    const inactive = selector + '.vliq-panel-island-inactive';
    for (const s of [selector, ready]) {
        // Ready state can no longer erase the accepted hover card.
        const rule = body(s);
        assert.match(rule, /rgba\(245, 249, 255, 0\.24\) !important;/,
            'main ' + group + ' must use the accepted hover fill');
        assert.match(rule, /rgba\(255, 255, 255, 0\.20\) !important;/,
            'main ' + group + ' must use the accepted hover rim');
        assert.match(rule, /border-radius: 16px !important;/);
    }
    assert.match(body(inactive), /background-color: transparent !important;/,
        'empty ' + group + ' must remain hidden');
    assert.match(body(inactive), /box-shadow: none !important;/,
        'empty ' + group + ' must not leave a rim');
}
for (const state of ['', ':hover', ':focus', ':active', ':checked']) {
    const rule = body('#panel.vliq-three-islands .vliq-panel-island ' +
        '.panel-button' + state);
    assert.match(rule, /background-color: transparent !important;/,
        '3-part indicator ' + state + ' cannot create a second card');
    assert.match(rule, /box-shadow: none !important;/);
}
assert.match(css, /#panel\.vliq-liquid-top-panel \.panel-button:hover/,
    'shared hover remains available in Full and Bottom layouts');
assert.match(css, /#panel\.vliq-bottom-taskbar #panelRight \.panel-button:hover/,
    'Bottom Taskbar retains its accepted hover paint');
assert.match(css, /\.vliq-liquid-popup-content\.datemenu-popover \.calendar/,
    'Calendar internal styling is unchanged');
assert.match(css, /\.vliq-liquid-popup-content\.quick-settings \.quick-toggle/,
    'Quick Settings internal styling is unchanged');
assert.match(top, /new PanelGlassSurface\([\s\S]*?\{cornerRadius: RADIUS\}/,
    '3-Part glass renderer remains active in both material modes');
assert.match(top, /vliq-panel-island-inactive/,
    'runtime continues to hide empty GNOME boxes');
console.log('3-Part main milky card across ready/idle, no nested hover PASS.');
