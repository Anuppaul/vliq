import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Executes the shipped native popup inner-material constructor branch.
// Date Menu keeps ONLY the existing outer LiquidEffect; its inner GNOME
// cards are ordinary St.CSS tiles. Quick Settings retains its nested GPU
// glass treatment. No GNOME display or offscreen renderer is needed.
const popup = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/popupGlass.js', import.meta.url
), 'utf8');
const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');

const start = popup.indexOf('        let dateInnerRoot = null;');
const end = popup.indexOf('\n        try {\n            const paintRoot', start);
assert.ok(start >= 0 && end > start,
    'existing PopupGlassSurface inner-material construction remains present');
const initializer = new Function('Clutter', 'DATE_INNER_PAD', 'root',
    popup.slice(start, end) + '\nreturn {' +
    'dateInnerRoot,dateInnerLiquidBox,dateInnerClone,dateInnerEffect};');

let newEffects = 0;
let newActors = 0;
class MockActor {
    constructor() {newActors++;this.children=[];}
    set_size() {}
    hide() {}
    set_clip_to_allocation() {}
    set_position() {}
    add_child(child) {this.children.push(child);}
    add_effect(effect) {this.effect=effect;}
}
class MockEffect {
    constructor() {newEffects++;}
    setPadding() {}
    setIsDock() {}
    setSurfaceLightEnabled() {}
    setCornerRadius() {}
    setBlurMethod() {}
    setMultiRegionMode() {}
}
const vendor = {UnpickableActor: MockActor, LiquidEffect: MockEffect};
const Clutter = {Clone: MockActor};
const fakeThis = menuType => ({
    _isDateMenu: menuType === 'date',
    _isQuickSettings: menuType === 'quick',
    _vendor: vendor, _settings: {},
});
const date = initializer.call(fakeThis('date'), Clutter, 20, {nativeOuter: true});
assert.equal(date.dateInnerRoot, null,
    'Date Menu must not allocate a second root inside the popover');
assert.equal(date.dateInnerEffect, null,
    'Date Menu must not instantiate nested LiquidEffect');
assert.equal(newEffects, 0, 'Date creates zero additional GPU effects');
assert.equal(newActors, 0, 'Date creates zero redundant inner clone actors');

const quick = initializer.call(fakeThis('quick'), Clutter, 20, {nativeOuter: true});
assert.ok(quick.dateInnerRoot, 'Quick Settings keeps its previous inner pods');
assert.ok(quick.dateInnerEffect, 'Quick Settings keeps LiquidEffect pods');
assert.equal(newEffects, 1, 'Quick Settings still creates one nested effect');

assert.ok(popup.includes('this._scanDateCardActors(false);'),
    'Date keeps adaptive card text scan even without nested shader');

const dateBlockStart = css.indexOf('/* Date Menu flat card material');
const quickBlockStart = css.indexOf('/* Quick Settings ', dateBlockStart);
assert.ok(dateBlockStart >= 0 && quickBlockStart > dateBlockStart,
    'flat card CSS is scoped exclusively to the Date Menu');
const flatCss = css.slice(dateBlockStart, quickBlockStart);
assert.match(flatCss, /background-color:\s*rgba\(245, 249, 255, 0\.24\)\s*!important/,
    'idle Calendar cards permanently display the taskbar hover fill');
assert.match(flatCss, /box-shadow:\s*inset 0 0 0 1px rgba\(255, 255, 255, 0\.20\)\s*!important/,
    'idle Calendar cards permanently display the taskbar hover inset rim');
assert.doesNotMatch(flatCss, /rgba\(255, 255, 255, 0\.06\)/,
    'old 6% resting veil never appears');
assert.match(flatCss, /rgba\(245, 249, 255, 0\.24\)/,
    'Date card hover matches taskbar app-icon hover fill exactly');
assert.match(flatCss, /inset 0 0 0 1px rgba\(255, 255, 255, 0\.20\)/,
    'Date hover draws the same ONE inset rim as app icons');
assert.match(flatCss, /rgba\(245, 249, 255, 0\.34\)/,
    'Date pressed fill matches taskbar app icon');
assert.match(flatCss, /rgba\(255, 255, 255, 0\.32\)/,
    'Date pressed inset rim matches app icon');
assert.match(flatCss, /border:\s*0\s*!important/,
    'Date cards do not draw any second border');
assert.match(flatCss, /box-shadow:\s*none\s*!important/,
    'Date card idle surface has no double border/shadow');
assert.match(flatCss, /border-radius:\s*9px\s*!important/,
    'Date card radius matches the app icon card');
for (const klass of ['datemenu-today-button','calendar',
    'events-button','world-clocks-button','weather-button',
    'message','message-list-clear-button'])
    assert.ok(flatCss.includes('.' + klass),
        'missing CSS card ' + klass);

assert.ok(css.includes('.vliq-liquid-date-menu-shell'),
    'the original Liquid Glass outer popover remains intact');
assert.ok(css.includes('-arrow-border-color: transparent !important'),
    'GNOME BoxPointer border stays suppressed');
assert.ok(css.includes('.vliq-liquid-popup-content.quick-settings .quick-toggle'),
    'Quick Settings nested GPU pods remain untouched');

console.log('Calendar: outer Liquid Glass only, exact taskbar icon hover on inner cards, no double border, Quick Settings intact PASS.');
