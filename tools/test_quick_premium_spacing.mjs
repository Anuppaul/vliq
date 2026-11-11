import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Premium Quick Settings layout uses GNOME 50 theme-based spacing and leaves
// the previously validated Bottom Taskbar/Calendar renderer untouched.
const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url), 'utf8');
const source = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/popupGlass.js', import.meta.url), 'utf8');

const start = css.indexOf('/* Premium Quick Settings spacing');
const end = css.indexOf('/* VLIQ Spotlight', start);
assert.ok(start >= 0 && end > start, 'premium Quick menu override exists');
const quick = css.slice(start, end);
function declarations(selector) {
    // Specific selectors can occur in a group that only sets radius before
    // the later material/spacing declaration. Inspect the final override.
    const at = quick.lastIndexOf(selector);
    assert.ok(at >= 0, 'missing CSS selector: ' + selector);
    const open = quick.indexOf('{', at);
    const close = quick.indexOf('}', open);
    assert.ok(open > at && close > open);
    return Object.fromEntries([...quick.slice(open + 1, close).matchAll(
        /^\s*([\w-]+):\s*([^;]+);/gm)].map(match =>
        [match[1], match[2].trim()]));
}
const grid = declarations('.vliq-liquid-popup-content.quick-settings .quick-settings-grid {');
assert.equal(grid['spacing-rows'], '10px');
assert.equal(grid['spacing-columns'], '10px');
assert.match(quick,
    /\.quick-settings-grid\s*\{\s*padding:\s*4px 2px 6px 2px;/,
    'grid keeps dedicated optical inset while spacing tokens come from the theme');

const parent = declarations(
    '.vliq-liquid-popup-content.quick-settings .quick-toggle-has-menu,');
assert.equal(parent['background-color'], 'rgba(219, 223, 229, 0.18) !important');
assert.equal(parent['border-radius'], '11px !important');
const nested = declarations(
    '.vliq-liquid-popup-content.quick-settings .quick-toggle-has-menu .quick-toggle,');
assert.equal(nested['background-color'], 'transparent !important');
assert.equal(nested['box-shadow'], 'none !important');
assert.match(quick, /\.quick-toggle-has-menu \.quick-toggle-menu-button:active/,
    'split-menu arrow stays interactive without its own card');

const divider = declarations('.vliq-liquid-popup-content.quick-settings .quick-toggle-separator {');
assert.equal(divider['background-color'], 'transparent !important');
const slider = declarations('.vliq-liquid-popup-content.quick-settings .quick-slider {');
assert.equal(slider.padding, '9px 11px');
const rows = declarations('.vliq-liquid-quick-menu-root .quick-toggle-menu .popup-menu-item {');
assert.equal(rows.margin, '3px 6px');
assert.equal(rows.padding, '9px 12px');
const separators = declarations(
    '.vliq-liquid-quick-menu-root .quick-toggle-menu .popup-separator-menu-item,');
assert.equal(separators['background-color'], 'transparent !important');

assert.ok(!quick.includes('display: none'),
    'separators and controls retain native geometry and menu semantics');
assert.ok(!quick.includes('height: 0'),
    'no forced height changes to native menu actors');
assert.ok(source.includes('if (this._isQuickSettings)'),
    'Quick Settings still has state and adaptive text handling');
assert.ok(css.includes('/* Date Menu: restrained cool gray-white cards'),
    'accepted Calendar appearance remains');
assert.ok(css.includes('#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:hover'),
    'existing gap-free taskbar UI remains');
console.log('Quick premium spacing, split-card ownership, safe divider cleanup and native control invariants PASS.');
