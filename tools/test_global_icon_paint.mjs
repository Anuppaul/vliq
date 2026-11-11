import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The accepted Bottom Taskbar app-icon paint and white running dot must be
// reproduced across native Ubuntu Dock, Overview Dash and the VLIQ Orb.
// No cloned app buttons, separate dot actors, input wrappers or frame timers.
const root = '../gnome-shell/vliq@wonderer.tech/';
const [css, orb, bottom, preview] = await Promise.all([
    'runtime.css', 'orbThemeRuntime.js', 'bottomTaskbar.js',
    'bottomTaskbarPreview.js',
].map(f => readFile(new URL(root + f, import.meta.url), 'utf8')));

const start = css.indexOf('/* VLIQ app icon consistency');
assert.ok(start >= 0, 'shared Dock/Orb style block exists');
const shared = css.slice(start);
function rule(needle) {
    const at = shared.indexOf(needle);
    assert.ok(at >= 0, 'missing selector: ' + needle);
    const begin = shared.indexOf('{', at);
    const end = shared.indexOf('}', begin);
    return shared.slice(begin + 1, end);
}
function matchesReference(actual, token, state) {
    assert.ok(actual.includes(token),
        'global ' + state + ' differs from accepted Bottom Taskbar: ' + token);
}
const hover = rule('#dashtodockDashContainer .dash-item-container .app-well-app:hover .overview-icon');
const pressed = rule('#dashtodockDashContainer .dash-item-container .app-well-app:active .overview-icon');
const bottomHoverStart = css.indexOf(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:hover,');
const bottomPressedStart = css.indexOf(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:active {');
assert.ok(bottomHoverStart >= 0 && bottomPressedStart >= 0);
const bottomHover = css.slice(css.indexOf('{', bottomHoverStart),
    css.indexOf('}', bottomHoverStart));
const bottomPressed = css.slice(css.indexOf('{', bottomPressedStart),
    css.indexOf('}', bottomPressedStart));
for (const [name, base, global] of [
    ['hover', bottomHover, hover],
    ['pressed', bottomPressed, pressed],
]) {
    for (const token of [
        name === 'hover'
            ? 'rgba(245, 249, 255, 0.24)'
            : 'rgba(245, 249, 255, 0.34)',
        name === 'hover'
            ? 'rgba(255, 255, 255, 0.20)'
            : 'rgba(255, 255, 255, 0.32)',
    ]) {
        assert.ok(base.includes(token), 'original taskbar paint changed');
        matchesReference(global, token, name);
    }
}
for (const selector of [
    '#dashtodockDashContainer .dash-item-container .app-well-app:hover .overview-icon',
    '#dashtodockDashContainer .dash-item-container .overview-tile:hover .overview-icon',
    '#dashtodockDashContainer .dash-item-container .show-apps:hover .overview-icon',
    '#overviewGroup #dash .dash-item-container .app-well-app:hover .overview-icon',
    '#overviewGroup #dash .dash-item-container .overview-tile:hover .overview-icon',
    '#overviewGroup #dash .dash-item-container .show-apps:hover .overview-icon',
    '.vliq-app-button:hover',
    '.vliq-app-button:focus',
    '.vliq-app-button:active',
    '.vliq-global-milky .vliq-app-button:hover',
]) {
    assert.ok(shared.includes(selector),
        'global native hover state missing: ' + selector);
}
for (const selector of [
    '#dashtodockDashContainer .app-well-app-running-dot',
    '#dashtodockDashContainer .app-grid-running-dot',
    '#overviewGroup #dash .app-well-app-running-dot',
    '#overviewGroup #dash .app-grid-running-dot',
    '.vliq-running-dot',
    '#panel.vliq-bottom-taskbar .vliq-taskbar-running-dot',
]) assert.ok(shared.includes(selector),
    'global native dot missing: ' + selector);
const dot = rule('#dashtodockDashContainer .app-well-app-running-dot');
const existingDot = css.slice(css.indexOf(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-running-dot {'));
for (const token of [
    'min-width: 5px', 'min-height: 5px',
    'rgba(235, 244, 255, 0.94)', 'border-radius: 999px',
]) {
    assert.ok(existingDot.includes(token),
        'original Bottom Taskbar running dot changed');
    assert.ok(dot.includes(token), 'native Dock dot parity lost');
}
assert.match(orb, /const dotSize = 5;/,
    'Orb running dot is exactly the same 5px size');
assert.match(orb, /style_class: 'vliq-running-dot'/);
assert.match(orb, /this\._globalWindowPreview\.onButtonHover\(item, true\)/,
    'global native thumbnail preview must still be active');
assert.match(bottom, /style_class: 'vliq-taskbar-running-dot'/);
assert.match(preview, /new Clutter\.Clone\(/);
assert.doesNotMatch(shared, /add_child\(|new St\.Widget|new Clutter\.Clone|set_size\(/,
    'global paint must never create extra indicator actors');
assert.doesNotMatch(shared, /\.dash-item-container\s*\{/,
    'never paint one solid card around an entire app icon row');
console.log('Global app hover and 5px native running indicators PASS.');
