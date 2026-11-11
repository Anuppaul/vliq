import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exact paint-token parity test for GNOME Shell 50 native popup cards.
// The target is the Bottom Taskbar's ORIGINAL app icon hover/pressed paint,
// not an independently chosen close colour. Only popup CSS and Quick shader
// interaction are changed: no native panel layout or Dock geometry edits.
const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css',
    import.meta.url
), 'utf8');
const popup = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/popupGlass.js',
    import.meta.url
), 'utf8');

const appStart = css.indexOf('/* Per-icon visual feedback');
const dateStart = css.indexOf('/* Date Menu: restrained cool gray-white cards');
const dateEnd = css.indexOf('/* Quick Settings ', dateStart);
const quickStart = css.indexOf(
    '/* Bottom Taskbar icon-style interaction shared');
const quickEnd = css.indexOf('/* VLIQ Spotlight', quickStart);
assert.ok(appStart >= 0 && dateStart > appStart &&
    dateEnd > dateStart && quickStart > dateEnd &&
    quickEnd > quickStart,
'hover paint blocks must exist in popup and taskbar scopes');

const appCss = css.slice(appStart, css.indexOf(
    '#panel.vliq-bottom-taskbar .vliq-taskbar-apps', appStart));
const dateCss = css.slice(dateStart, dateEnd);
const quickCss = css.slice(quickStart, quickEnd);

function declarations(source, selector) {
    const index = source.indexOf(selector);
    assert.ok(index >= 0, 'missing style selector: ' + selector);
    const opening = source.indexOf('{', index);
    const closing = source.indexOf('}', opening);
    assert.ok(opening > index && closing > opening);
    const body = source.slice(opening + 1, closing);
    const found = Object.fromEntries([...body.matchAll(
        /^\s*([\w-]+):\s*([^;]+);/gm
    )].map(m => [m[1], m[2].trim()]));
    return found;
}
const appHover = declarations(appCss,
    '#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:hover');
const appActive = declarations(appCss,
    '#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:active');
const dateBase = declarations(dateCss,
    '.vliq-liquid-popup-content.datemenu-popover .datemenu-today-button,');
const dateHover = declarations(dateCss,
    '.vliq-liquid-popup-content.datemenu-popover .datemenu-today-button:hover');
const dateActive = declarations(dateCss,
    '.vliq-liquid-popup-content.datemenu-popover .datemenu-today-button:active');
const quickHover = declarations(quickCss,
    '.vliq-liquid-popup-content.quick-settings .quick-toggle:hover');
const quickActive = declarations(quickCss,
    '.vliq-liquid-popup-content.quick-settings .quick-toggle:active');
const overlayHover = declarations(quickCss,
    '.vliq-liquid-quick-menu-root .quick-toggle-menu .popup-menu-item:hover');
const overlayActive = declarations(quickCss,
    '.vliq-liquid-quick-menu-root .quick-toggle-menu .popup-menu-item:active');

const quickBase = declarations(quickCss,
    '.vliq-liquid-popup-content.quick-settings .quick-toggle,');
const overlayBase = declarations(quickCss,
    '.vliq-liquid-quick-menu-root .quick-toggle-menu,');
for (const [name, style] of [
    ['Quick tile idle', quickBase],
    ['Quick tile hover', quickHover],
    ['Quick expanded menu idle', overlayBase],
    ['Quick expanded-row hover', overlayHover],
]) {
    assert.equal(style['background-color'],
        'rgba(219, 223, 229, 0.18) !important',
        name + ' has the same permanent cool gray-white as Calendar');
    assert.equal(style['box-shadow'],
        'inset 0 0 0 1px rgba(220, 225, 232, 0.15) !important',
        name + ' uses exactly the Calendar resting inset rim');
    assert.equal(style.border, '0 !important',
        name + ' cannot add a second native border');
}
for (const [name, style] of [
    ['Quick tile pressed', quickActive],
    ['Quick expanded-row pressed', overlayActive],
]) {
    assert.equal(style['background-color'],
        'rgba(219, 223, 229, 0.27) !important',
        name + ' uses the Calendar pressed gray');
    assert.equal(style['box-shadow'],
        'inset 0 0 0 1px rgba(220, 225, 232, 0.24) !important',
        name + ' uses the Calendar pressed inset rim');
}

assert.equal(dateBase['background-color'],
    'rgba(219, 223, 229, 0.18) !important',
    'Calendar inner cards use softened gray-white even without hover');
assert.equal(dateHover['background-color'], dateBase['background-color'],
    'Calendar hover does not change the idle card fill');
assert.equal(dateHover['box-shadow'], dateBase['box-shadow'],
    'Calendar hover does not produce a second inset highlight');
assert.equal(dateActive['background-color'],
    'rgba(219, 223, 229, 0.27) !important',
    'pressed Calendar cards retain a slightly stronger gray fill');
assert.equal(dateBase['border-radius'], '9px !important');
assert.ok(dateCss.includes('.calendar:hover'),
    'calendar grid has a separately transparent rule');

assert.equal(declarations(quickCss,
    '.vliq-liquid-popup-content.quick-settings .quick-toggle,')
    ['transition-duration'], '120ms',
    'Quick card interaction uses original 120ms timing');
for (const selector of [
    '.events-button:hover',
    '.world-clocks-button:hover', '.weather-button:hover',
    '.message:hover', '.message-list-clear-button:hover',
    '.quick-slider:hover',
    '.quick-settings-system-item .icon-button:hover',
]) {
    assert.ok(dateCss.includes(selector) || quickCss.includes(selector),
        'missing target card hover: ' + selector);
}
assert.ok(!quickCss.includes('.quick-toggle-has-menu:hover'),
    'the same GNOME QuickToggle cannot draw two nested hover outlines');
assert.ok(quickCss.includes('.quick-toggle:checked'),
    'checked Quick toggle retains the same neutral tile paint');
assert.ok(css.includes('.vliq-liquid-quick-menu-root .vliq-quick-active StLabel'),
    'checked state remains communicated by native GNOME accent text');

const fnStart = popup.indexOf('    _dateCardResponse(actor, klass, quickState = null) {');
const fnEnd = popup.indexOf('\n    _syncDateInnerRegions(', fnStart);
assert.ok(fnStart >= 0 && fnEnd > fnStart);
const response = new Function('return ({' +
    popup.slice(fnStart, fnEnd) + '})._dateCardResponse;')();
const actor = {name: 'native-quick-toggle'};
const ctx = {
    _isDateMenu: false, _isQuickSettings: true,
    _dateCardResponses: new Map([[actor, 0.9]]),
};
assert.equal(response.call(ctx, actor, 'quick-toggle',
    {pressed: true, engaged: true, selected: true}), 0,
'Quick nested shader cannot add a SECOND hover/pressed highlight');
assert.equal(ctx._dateCardResponses.get(actor), 0,
'shader hover response resets to neutral base without changing checked state');

assert.ok(css.includes('.vliq-liquid-quick-menu-root .vliq-quick-active StLabel'),
    'native Quick Settings ON/checked text accent remains intact');
assert.ok(css.includes(
    '.vliq-liquid-popup-content.datemenu-popover .calendar-day.calendar-today'),
    'calendar today accent remains intact');
assert.ok(css.includes('#panel.vliq-bottom-taskbar .vliq-taskbar-app-button:hover'),
    'the previously accepted taskbar icon paint is still present');

console.log('Popup cards: permanent cool gray-white Calendar/Quick tiles, no hover flash or double rim, native accent retained PASS.');
