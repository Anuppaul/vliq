import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Regression for the real shipped PopupGlassManager/PopupGlassSurface paths.
// No native input or animation may wait for expensive shader initialization.
const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const source = await readFile(new URL('popupGlass.js', root), 'utf8');
const css = await readFile(new URL('runtime.css', root), 'utf8');

const openStart = source.indexOf('        this._patchedOpen = function (...args) {');
const openEnd = source.indexOf('\n        this._patchedDestroy = function', openStart);
assert.ok(openStart >= 0 && openEnd > openStart);
const openBlock = source.slice(openStart, openEnd).trim();
const quickMenu = {isOpen: false};
const dateMenu = {isOpen: false};
const events = [];
const manager = {
    _enabled: true,
    _surfaces: new Map(),
    _originalOpen(...args) {
        events.push('GNOME-native-open');
        this.isOpen = true;
        return args[0] ?? 'opened';
    },
    _scheduleIdleAttach(menu) {
        events.push('idle-material-attach');
        assert.equal(menu, quickMenu);
    },
    _scheduleDeferredAttach() {events.push('delayed-120ms-attach');},
    _cancelDeferredAttach() {events.push('cancel-deferred');},
    _cancelPanelHoverSwitch() {},
    attach() {events.push('synchronous-shader-attach');},
};
const Main = {panel: {statusArea: {quickSettings: {menu: quickMenu}}}};
const BoxPointer = {PopupAnimation: {FADE: Symbol('fade')}};
const patched = new Function('manager', 'Main', 'BoxPointer',
    openBlock + '\nreturn this._patchedOpen;').call(
    manager, manager, Main, BoxPointer);
patched.call(quickMenu, 'clicked');
assert.deepEqual(events, ['GNOME-native-open', 'idle-material-attach'],
    'first click opens GNOME now and defers costly shader/material setup');
events.length = 0;
quickMenu.isOpen = false;
patched.call(quickMenu, BoxPointer.PopupAnimation.FADE);
assert.deepEqual(events, ['GNOME-native-open', 'idle-material-attach'],
    'first Quick FADE must not wait for the generic 120ms hover path');
events.length = 0;
manager._surfaces.set(quickMenu, {});
patched.call(quickMenu, 'clicked');
assert.equal(events.includes('idle-material-attach'), false,
    'already attached Quick Settings does not reallocate a glass scene');
events.length = 0;
patched.call(dateMenu, BoxPointer.PopupAnimation.FADE);
assert.ok(events.includes('delayed-120ms-attach'),
    'other GNOME hover menus retain their existing low-cost debounce');

// In setup prewarm Quick Settings first, not Calendar 350ms ahead of it.
const prewarmStart = source.indexOf('    _scheduleSystemPopupPrewarm() {');
const prewarmEnd = source.indexOf('\n    _ensureStageSync() {', prewarmStart);
const prewarm = source.slice(prewarmStart, prewarmEnd);
assert.ok(prewarm.indexOf('statusArea?.quickSettings?.menu') <
    prewarm.indexOf('statusArea?.dateMenu?.menu'));
assert.match(prewarm, /this\._surfaces\.has\(menu\)/);

// Check real first-frame CSS state transitions. Shader file loading alone
// cannot suppress the fallback: only the first successfully composited
// GPU frame may do that. Milky is already painted by native CSS.
const fStart = source.indexOf('    _syncQuickFirstPaintFallback() {');
const fEnd = source.indexOf('\n    updateAppearance(state) {', fStart);
assert.ok(fStart > 0 && fEnd > fStart);
const refresh = new Function('return ({' +
    source.slice(fStart, fEnd) + '})._syncQuickFirstPaintFallback;')();
const classes = new Set();
const popup = {
    _isQuickSettings: true, _milky: false,
    _quickFirstPaintFallback: false,
    _effect: {_shadersLoaded: true, _diagCompositedPaintCount: 0},
    _box: {
        add_style_class_name(name) {classes.add(name);},
        remove_style_class_name(name) {classes.delete(name);},
    },
};
refresh.call(popup);
assert.equal(classes.has('vliq-quick-first-paint'), true,
    'first Quick popup card must remain visible before first GPU composite');
popup._effect._diagCompositedPaintCount = 1;
refresh.call(popup);
assert.equal(classes.has('vliq-quick-first-paint'), false,
    'remove first-frame CSS after shader actually painted');
popup._effect._diagCompositedPaintCount = 0;
popup._milky = true;
refresh.call(popup);
assert.equal(classes.size, 0, 'Milky uses its ordinary CSS body only');
assert.match(source, /syncFrame\(\) \{[\s\S]*?this\._syncQuickFirstPaintFallback\(\);/);
assert.match(source, /remove_style_class_name\?\.\('vliq-quick-first-paint'\)/);
const firstFrame = css.match(
    /\.vliq-liquid-popup-content\.quick-settings\.vliq-quick-first-paint\s*\{([^}]*)\}/
)?.[1];
assert.ok(firstFrame, 'Quick first-frame CSS material is present');
assert.match(firstFrame, /background-color: rgba\(231, 235, 244, 0\.52\) !important/);
assert.match(firstFrame, /border: 0 !important/);
assert.match(firstFrame, /box-shadow: none !important/);
console.log('Quick Settings: native first click, prioritized prewarm, compositor-ready CSS handoff and cleanup PASS.');
