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
assert.equal(quick.dateInnerRoot, null,
    'Quick Settings no longer allocates a second GPU/clone root');
assert.equal(quick.dateInnerEffect, null,
    'Quick Settings cards use CSS, not a nested LiquidEffect');
assert.equal(newEffects, 0,
    'both native popups create no nested GPU effects');
assert.equal(newActors, 0,
    'both native popups create no redundant scene-clone actors');

assert.ok(popup.includes('this._scanDateCardActors(false);'),
    'Date keeps adaptive card text scan even without nested shader');

const dateBlockStart = css.indexOf('/* Date Menu: restrained cool gray-white cards');
const quickBlockStart = css.indexOf('/* Quick Settings ', dateBlockStart);
assert.ok(dateBlockStart >= 0 && quickBlockStart > dateBlockStart,
    'gray-white card CSS scoped to Date Menu only');
const flatCss = css.slice(dateBlockStart, quickBlockStart);
assert.match(flatCss, /rgba\(219, 223, 229, 0\.18\)/,
    'idle inner cards use soft gray-white rather than bright milky white');
assert.match(flatCss, /rgba\(220, 225, 232, 0\.15\)/,
    'inner card subtle inset uses cool gray rim');
assert.match(flatCss, /border:\s*0\s*!important/,
    'inner cards do not draw a native second border');
assert.match(flatCss, /border-radius:\s*9px\s*!important/,
    'inner cards retain 9px radius');
for (const klass of ['datemenu-today-button', 'events-button',
    'world-clocks-button', 'weather-button', 'message',
    'message-list-clear-button'])
    assert.ok(flatCss.includes('.' + klass),
        'missing gray-white inner card ' + klass);
const calendarGrid = flatCss.match(
    /\.vliq-liquid-popup-content\.datemenu-popover \.calendar,\n[\s\S]*?\{([^}]+)\}/)?.[1];
assert.ok(calendarGrid, 'native calendar grid must have explicit no-card rule');
assert.match(calendarGrid, /background-color:\s*transparent\s*!important/,
    'calendar grid stays transparent over outer Liquid Glass');
assert.match(calendarGrid, /box-shadow:\s*none\s*!important/,
    'calendar grid never receives a card rim');
assert.doesNotMatch(flatCss, /rgba\(245, 249, 255, 0\.24\)/,
    'removed milky-white fill cannot return to Date inner cards');

assert.ok(css.includes('.vliq-liquid-date-menu-shell'),
    'the original Liquid Glass outer popover remains intact');
assert.ok(css.includes('-arrow-border-color: transparent !important'),
    'GNOME BoxPointer border stays suppressed');
assert.ok(css.includes('.vliq-liquid-popup-content.quick-settings .quick-toggle'),
    'Quick Settings native toggle controls remain styled');

console.log('Calendar: gray-white inner cards, transparent calendar grid, one outer Liquid Glass, no double rim and no nested Quick shader PASS.');
