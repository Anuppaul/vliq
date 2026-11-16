import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const [css, paint, popup, native] = await Promise.all([
    'runtime.css', 'milkyPaint.js',
    'popupGlass.js', 'nativeCssIntegration.js',
].map(read));

const {milkyPaintTokens, buildMilkyAppearanceCss} =
    new Function(paint.replace(/^export /gm, '') +
        '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss};')();
const expected = milkyPaintTokens('popup').fill;
assert.equal(expected, 'rgba(245,249,255,0.920)',
    'the expanded menu should match the original Milky Quick Settings card');

// In GNOME QuickSettingsMenu, expanding the arrow opens a sibling overlay,
// not a descendant of popup-menu-content.quick-settings. The .quick-toggle-menu
// actor is the actual card backplate; the parent container stays transparent.
assert.match(popup, /QUICK_ROOT_CLASS = 'vliq-liquid-quick-menu-root'/);
assert.match(popup, /this\._menu\?\.actor\?\.add_style_class_name\?\.\(/);
assert.match(popup, /this\._menu\?\._overlay/);
const expanded = '.vliq-global-milky .vliq-liquid-quick-menu-root .quick-toggle-menu';
function body(source, selector) {
    const start = source.indexOf(selector);
    assert.ok(start >= 0, 'missing selector: ' + selector);
    const open = source.indexOf('{', start);
    const close = source.indexOf('}', open);
    assert.ok(open > start && close > open, 'bad stylesheet rule for ' + selector);
    return source.slice(open + 1, close);
}

for (const sheet of [
    css,
    buildMilkyAppearanceCss({milky: true}),
    native,
]) {
    if (sheet === native) {
        // The shader-free backend transforms the shared selectors; it must
        // not invent a second, weaker 18%-alpha overlay material.
        assert.match(sheet, /buildMilkyAppearanceCss\(state\)/);
        continue;
    }
    const rule = body(sheet, expanded);
    assert.ok(rule.includes('background-color: ' + expected + ' !important;'),
        'expanded Wi-Fi/Wired/Bluetooth/Power menus must retain 92% white opacity');
    assert.match(rule, /background-image:\s*none\s*!important/,
        'expanded submenu must have no texture/shader image');
    assert.doesNotMatch(rule, /opacity:\s*0?\.[0-8]\d*/,
        'expanded submenu may not silently fade its own background');
}

// Only the actual submenu card gets the 92% backplate. The container must
// remain transparent, otherwise two 92% layers stack to ~99.4% opacity.
const container = body(css,
    '.vliq-liquid-quick-menu-root .quick-toggle-menu-container');
assert.match(container, /background-color:\s*transparent\s*!important/);
assert.doesNotMatch(css,
    /\.vliq-global-milky[^{]*\.quick-toggle-menu-container\s*\{[^}]*rgba\(245,\s*249,\s*255,\s*0\.92/,
    'never paint an additional opaque menu container');
assert.match(css,
    /\.vliq-global-milky \.vliq-liquid-quick-menu-root \.quick-toggle-menu StLabel/,
    'expanded list labels must use readable dark text over white');
assert.match(css,
    /\.vliq-global-milky \.vliq-liquid-quick-menu-root \.quick-toggle-menu \.vliq-quick-active StLabel/,
    'selected-row text must retain GNOME accent');
assert.match(css, /\.vliq-liquid-quick-menu-root \.quick-toggle-menu \.popup-menu-item \{/,
    'GNOME option rows remain individually clickable and spaced');
assert.equal(buildMilkyAppearanceCss({milky: false}), '',
    'Liquid and Frosted must not receive the fixed Milky popup styling');
console.log('Quick expanded menu: stable 92% white opacity across overlays, no stacked backplates, readable text, native input and mode isolation PASS.');
