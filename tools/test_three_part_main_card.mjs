import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// 3-Part Header: Liquid/Frosted use bounded glass materials and Milky
// uses the existing native card, with no nested button or layout changes.
const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');
const top = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/topBarIslands.js', import.meta.url
), 'utf8');
const start = css.indexOf('/* GNOME 50 3-Part Header:');
const end = css.indexOf('/* User-selectable FULL Top Header.', start);
assert.ok(start >= 0 && end > start, 'isolated 3-Part appearance block');
const section = css.slice(start, end);
function declarations(selector) {
    const at = section.indexOf(selector);
    assert.ok(at >= 0, 'missing selector ' + selector);
    const open = section.indexOf('{', at), close = section.indexOf('}', open);
    return section.slice(open, close);
}
for (const id of ['panelLeft', 'panelCenter', 'panelRight']) {
    const island = '#panel.vliq-three-islands #' + id + '.vliq-panel-island';
    const ready = '#panel.vliq-three-islands #' + id + '.vliq-panel-island-ready';
    const milky = '.vliq-global-milky ' + island;
    const fallback = '#panel.vliq-three-islands #' + id +
        '.vliq-panel-island-css-fallback';
    assert.match(declarations(island), /rgba\(232, 242, 255, 0\.13\)/,
        'shader fallback cannot be opaque');
    assert.match(declarations(ready), /background-color: transparent !important/,
        'Liquid/Frosted material is the only ready painter');
    for (const selector of [milky, fallback]) {
        const body = declarations(selector);
        assert.match(body, /rgba\(245, 249, 255, 0\.24\)/);
        assert.match(body, /rgba\(255, 255, 255, 0\.20\)/);
        assert.match(body, /border-radius: 16px/);
    }
    const inactive = '.vliq-global-milky ' + island +
        '.vliq-panel-island-inactive';
    assert.match(declarations(inactive), /background-color: transparent !important/);
}
assert.match(top, /\{cornerRadius: RADIUS, cssOnly: this\._forceCssOnly\}/,
    '3-Part allocates bounded Liquid/Frosted shaders unless native CSS is selected');
assert.match(top, /\{cornerRadius: RADIUS, cssOnly: true\}/,
    'GPU failure has safe CSS-only fallback');
assert.match(top, /vliq-panel-island-css-fallback/,
    'fallback class persists until layout is rebuilt');
assert.match(top, /vliq-panel-island-inactive/,
    'native empty GNOME boxes remain hidden');
assert.match(css, /#panel\.vliq-liquid-top-panel\.vliq-full-header/);
assert.match(css, /#panel\.vliq-liquid-top-panel\.vliq-bottom-taskbar/);
assert.match(css, /\.vliq-liquid-popup-content\.datemenu-popover \.calendar/);
assert.match(css, /\.vliq-liquid-popup-content\.quick-settings \.quick-toggle/);
console.log('3-Part Liquid/Frosted shader, Milky CSS and safe fallback PASS.');
