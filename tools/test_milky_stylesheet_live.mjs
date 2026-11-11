import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise shipped VLIQ methods, not a reimplementation of Milky CSS.
// A user's Milky slider change must reach the actual St.Theme stylesheet.
const source = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/liquidGlassDock.js',
    import.meta.url), 'utf8');
const start = source.indexOf('function milkyPaintTokens(');
const end = source.indexOf('function canonicalExtensionRoot(', start);
assert.ok(start >= 0 && end > start);
const clampNumber = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const build = new Function('clampNumber',
    source.slice(start, end) + '\nreturn buildMilkyAppearanceCss;')(
    clampNumber);

const begin = source.indexOf('    _applyCardAppearanceStylesheet(');
const finish = source.indexOf('    isBottomTaskbarActive() {', begin);
assert.ok(begin > 0 && finish > begin);

const written = new Map();
const events = [];
const GLib = {
    build_filenamev: parts => parts.join('/'),
    get_user_cache_dir: () => '/tmp/vliq-test',
    mkdir_with_parents() {},
    file_set_contents(path, css) {written.set(path, css);},
};
const Gio = {
    File: {new_for_path: path => ({
        path, delete() {events.push('delete:' + path);},
    })},
};
const Main = {messageTray: {_banner: {queue_redraw() {}}}};
const theme = {
    rejectNext: false,
    load_stylesheet(file) {
        events.push('load:' + file.path);
        if (this.rejectNext) {
            this.rejectNext = false;
            throw new Error('Invalid stylesheet');
        }
    },
    unload_stylesheet(file) {
        events.push('unload:' + file.path);
    },
};
const apply = new Function(
    'GLib', 'Gio', 'Main', 'buildMilkyAppearanceCss',
    'return ({' + source.slice(begin, finish) +
        '})._applyCardAppearanceStylesheet;')(
    GLib, Gio, Main, build);
const host = {
    _cardCssCounter: 0, _cardCssFile: null, _cardCssSignature: '',
    _getShellTheme: () => theme,
    _readSystemAccentColor: () => ({color: '#4285f4'}),
    _unloadCardAppearanceStylesheet() {
        if (this._cardCssFile) {
            theme.unload_stylesheet(this._cardCssFile);
            this._cardCssFile.delete();
            this._cardCssFile = null;
            this._cardCssSignature = '';
        }
    },
};
const state = {
    milky: true, milkyOpacity: 0.24, milkyBorder: 0.20,
    milkyWhiteness: 0, filterOpacity: 0.05,
};
apply.call(host, state);
const first = host._cardCssSignature;
assert.ok(first.includes('rgba(245,249,255,0.240)'));
assert.doesNotMatch(first, /:not\(/,
    'St.Theme does not support browser-only negation selectors');
assert.ok(first.includes('.vliq-panel-island.vliq-panel-island-inactive'));
const previousPath = host._cardCssFile.path;
state.milkyOpacity = 0.74;
state.milkyBorder = 0.5;
state.milkyWhiteness = 0.8;
apply.call(host, state);
assert.ok(host._cardCssSignature.includes('rgba(253,254,255,0.740)'));
assert.ok(host._cardCssSignature.includes('rgba(255,255,255,0.500)'));
assert.notEqual(host._cardCssSignature, first,
    'changes in the 3 sliders must reload the actual stylesheet');
assert.ok(events.includes('unload:' + previousPath),
    'old CSS must be unloaded only after replacement loads');
const preserved = host._cardCssFile;
const preservedCss = host._cardCssSignature;
theme.rejectNext = true;
state.milkyOpacity = 0.99;
apply.call(host, state);
assert.equal(host._cardCssFile, preserved,
    'invalid replacement must keep existing working native Milky card');
assert.equal(host._cardCssSignature, preservedCss);
state.milky = false;
apply.call(host, state);
assert.ok(!host._cardCssSignature.includes(
    'vliq-global-milky #panel.vliq-three-islands #panelLeft'),
    'switching back to Liquid/Frosted removes Milky overrides');
console.log('Milky native CSS sliders, hot swap, rollback, mode exit PASS.');
