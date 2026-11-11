import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = f => readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/' + f, import.meta.url), 'utf8');
const [dock, panel, popup, shell, notify, orb, spotlight, css, overview] =
    await Promise.all(['liquidGlassDock.js', 'panelGlass.js', 'popupGlass.js',
        'shellCards.js', 'notificationGlass.js', 'orbGlass.js',
        'spotlightGlass.js', 'runtime.css', 'overviewCloseGlass.js'].map(read));

// Compile methods copied verbatim from shipped source, never a test stub.
function method(source, start, end, name, imports = {}) {
    const a = source.indexOf('    ' + start);
    const b = source.indexOf('    ' + end, a + start.length);
    assert.ok(a >= 0 && b > a, name + ' method boundaries');
    return new Function(...Object.keys(imports),
        'return ({' + source.slice(a, b) + '}).' + name + ';')(
        ...Object.values(imports));
}

// All managers consume the same live material flag. No user prefs rewritten.
let selected = 'milky';
const settings = {
    get_int() {return 4;},
    get_string(k) {return k === 'glass-style' ? selected : '#ffffff';},
};
const readAppearance = method(dock, '_readSharedCardAppearance() {',
    '_applySharedDashMaterial(', '_readSharedCardAppearance', {
        clampNumber: (x, min, max) => Math.max(min, Math.min(max, x)),
        parseHexRgb: () => [255, 255, 255],
    });
const source = {_vliqSettings: settings};
assert.equal(readAppearance.call(source).milky, true);
for (const name of ['liquid', 'frosted']) {
    selected = name;
    assert.equal(readAppearance.call(source).milky, false);
}
const classes = new Set();
const host = {
    add_style_class_name(v) {classes.add(v);},
    remove_style_class_name(v) {classes.delete(v);},
};
const syncClass = method(dock, '_syncMilkyAppearanceClass(enabled) {',
    '_applySharedCardAppearance()', '_syncMilkyAppearanceClass',
    {Main: {layoutManager: {uiGroup: host}}});
const classHost = {_syncMilkyOsdMaterial() {}};
syncClass.call(classHost, true);
assert.ok(classes.has('vliq-global-milky'));
syncClass.call(classHost, false);
assert.ok(!classes.has('vliq-global-milky'));
assert.match(dock, /_cleanupSharedCardAppearanceSync\(\)\s*\{\s*this\._syncMilkyAppearanceClass\(false\)/);

// Header panels must hide their shader actor and restore the actual
// pre-Milky paint opacity (not 255) when switching back.
const updatePanel = method(panel, 'updateAppearance() {',
    'setBounds(', 'updateAppearance');
let isMilky = true;
const material = {opacity: 177};
const ps = {_destroyed: false, _effect: null, _milky: false,
    _requestedOpacity: 177, _material: material,
    _readAppearance: () => ({milky: isMilky})};
updatePanel.call(ps);
assert.equal(material.opacity, 0);
isMilky = false;
updatePanel.call(ps);
assert.equal(material.opacity, 177);
assert.match(panel, /const nextOpacity = this\._milky \? 0 : this\._requestedOpacity/);

// Popup main and nested shader roots MUST be hidden; otherwise the
// permanent Milky CSS card would be painted on top of a LiquidEffect.
const updatePopup = method(popup, 'updateAppearance(state) {',
    '_setSceneWindowCapture(', 'updateAppearance');
let hidden = 0;
const popupState = {_effect: {}, _milky: false,
    _root: {hide() {hidden++;}},
    _dateInnerRoot: {hide() {hidden++;}}};
updatePopup.call(popupState, {milky: true});
assert.equal(hidden, 2);
const syncPopup = method(popup, '_sync(shaderOnly) {',
    '_syncShaderGeometry() {', '_sync');
syncPopup.call(popupState, false);
assert.equal(hidden, 4);

// Native Shell cards and notification banners no longer allocate a live
// capture scene or leave a second shader/filter visible behind the card.
const syncShell = method(shell, '_sync() {', 'syncFrame() {', '_sync');
let shellHidden = 0, released = 0;
syncShell.call({_destroyed: false, _target: {}, _milky: true,
    _material: {hide() {shellHidden++;}},
    _releaseSceneManager() {released++;}});
assert.equal(shellHidden, 1);
assert.equal(released, 1);
const syncNotify = method(notify, '_sync(material, shaderOnly) {',
    '_detach(actor) {', '_sync');
const actor = {}, banner = {actor, root: {hide() {hidden++;}}};
syncNotify.call({_appearance: {milky: true},
    _materials: new Map([[actor, banner]]),
    _releaseSceneManager() {released++;}}, banner, false);
assert.equal(hidden, 5);
assert.equal(released, 2);

// Orb and Spotlight retain native interactions but stop glass frame sync.
const syncOrb = method(orb, '_syncRegions() {',
    '_maybeSampleGlyph() {', '_syncRegions');
syncOrb.call({_appearance: {milky: true},
    _root: {hide() {hidden++;}}});
assert.equal(hidden, 6);
const syncSpotlight = method(spotlight, '_syncLoopState() {',
    '_syncActors() {', '_syncLoopState');
let stopped = 0;
syncSpotlight.call({_isActive: () => true,
    _appearance: {milky: true},
    _root: {hide() {hidden++;}},
    _stopStageLoop() {stopped++;}});
assert.equal(hidden, 7);
assert.equal(stopped, 1);

// Dock has a native Milky paint in floating/panel modes and hides the
// expensive old GPU backplate while all app icons remain GNOME-owned.
assert.match(dock, /DOCK_PANEL_MILKY_STYLE/);
assert.match(dock, /_nativeDockGlassVisible\(entry\)[\s\S]*?get_string\?\.\('glass-style'\) === 'milky'/);
assert.match(dock, /this\._syncNativeDockVisualState\(entry, true\)/);
for (const cls of [
    '#panel.vliq-liquid-top-panel.vliq-full-header',
    '#panel.vliq-liquid-top-panel.vliq-bottom-taskbar',
    '.vliq-liquid-popup-content',
    '.popup-menu-content.datemenu-popover',
    '.popup-menu-content.quick-settings',
    '.vliq-liquid-shell-card',
    '.vliq-native-notification-glass',
    '.vliq-orb-face-v2',
    '.vliq-app-button',
    '.vliq-spotlight-glass-entry',
    '.vliq-spotlight-glass-results',
    '.dash-background.vliq-ubuntu-dock-glass-background',
    '.dash-background.vliq-ubuntu-dock-panel-background',
]) assert.ok(css.includes('.vliq-global-milky ' + cls),
    'Missing native Milky material: ' + cls);
assert.match(css, /rgba\(245, 249, 255, 0\.24\) !important/);
assert.match(dock, /buildMilkyAppearanceCss\(state\)/,
    'live Milky controls must reach dynamic native stylesheet');

// OSD owns a separate legacy vendor render path. Its instance adapter
// must hide the shader even when the GJS vendor module was hot-cached.
const installOsd = method(dock, '_installMilkyOsdAdapter() {',
    '_syncMilkyAppearanceClass(enabled) {', '_installMilkyOsdAdapter');
let oldOsdPaint = 0, osdHidden = 0;
const osd = {_syncGeometry() {oldOsdPaint++;}};
const osdHost = {_osdManager: osd, _milkyModeActive: true};
installOsd.call(osdHost);
const osdClasses = new Set();
const osdState = {
    bgActor: {hide() {osdHidden++;}},
    targetBox: {
        add_style_class_name(name) {osdClasses.add(name);},
        remove_style_class_name(name) {osdClasses.delete(name);},
    },
};
osd._syncGeometry(osdState);
assert.equal(osdHidden, 1);
assert.equal(oldOsdPaint, 0);
assert.ok(osdClasses.has('vliq-milky-osd'));
osdHost._milkyModeActive = false;
osd._syncGeometry(osdState);
assert.equal(oldOsdPaint, 1);
assert.ok(!osdClasses.has('vliq-milky-osd'));

// Overview normally renders a sharp clone of every icon above its glass.
// Milky must restore native icon opacity before hiding that clone layer.
const updateOverview = method(overview, 'updateAppearance(\n' +
    '        state = this._readAppearance()\n    ) {',
    '_ignoreTreeNode(', 'updateAppearance');
const nativeIcon = {opacity: 0}, closeButton = {opacity: 255};
let overviewHidden = 0, overviewRepainted = 0;
const overviewHost = {
    _targets: new Map([
        [nativeIcon, {kind: 'icon', nativeOpacity: 187}],
        [closeButton, {kind: 'close'}],
    ]),
    _root: {hide() {overviewHidden++;}},
    _applyAppearance() {overviewRepainted++;},
    _lastRegionKey: '',
};
updateOverview.call(overviewHost, {milky: true});
assert.equal(nativeIcon.opacity, 187);
assert.equal(closeButton.opacity, 255);
assert.equal(overviewHidden, 1);
updateOverview.call(overviewHost, {milky: false});
assert.equal(nativeIcon.opacity, 0);
assert.equal(overviewRepainted, 1);
for (const cls of [
    '.vliq-milky-osd',
    '#overviewGroup .window-close.vliq-window-close-shared-glass',
    '#overviewGroup .window-icon.vliq-window-icon-shared-glass',
]) assert.ok(css.includes('.vliq-global-milky ' + cls),
    'global Milky missed native OSD/Overview ' + cls);

console.log('Global Milky native material, OSD/Overview visibility and reversible styles PASS.');
