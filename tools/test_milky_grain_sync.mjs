import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = filename => readFile(new URL(filename, root), 'utf8');
const [dock, prefs, schema] = await Promise.all([
    'liquidGlassDock.js', 'prefs.js',
    'schemas/org.gnome.shell.extensions.vliq.gschema.xml',
].map(read));

assert.match(schema, /name="milky-grain" type="i">[\s\S]*?<default>28<\/default>/);
assert.match(schema, /name="milky-whiteness" type="i">[\s\S]*?<range min="-100" max="100"\/>/);
assert.match(prefs, /settings, 'milky-grain',[\s\S]*?'Micro-grain'/);
assert.match(prefs, /settings, 'milky-whiteness',[\s\S]*?'White balance'/);
assert.match(prefs, /-100, 100, 1\);/);
assert.match(dock, /'milky-grain',[\s\S]*?'frost-density'/,
    'grain changes must trigger live appearance refresh');

const start = dock.indexOf('function milkyPaintTokens(');
const finish = dock.indexOf('function canonicalExtensionRoot(', start);
assert.ok(start > 0 && finish > start);
const f = new Function('clampNumber', dock.slice(start, finish) +
    '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss, buildMilkyGrainSvg};')(
    (value, lo, hi) => Math.min(hi, Math.max(lo, value)));
const original = f.milkyPaintTokens({
    milkyOpacity: 0.24, milkyWhiteness: 0, milkyBorder: 0.20,
});
assert.equal(original.fill, 'rgba(245,249,255,0.240)');
assert.equal(f.milkyPaintTokens({milkyWhiteness: 1}).fill,
    'rgba(255,255,255,1.000)',
    '+100 must produce fully opaque white even when base opacity is 24%');
assert.equal(f.milkyPaintTokens({
    milkyWhiteness: 1, milkyOpacity: 0,
}).fill, 'rgba(255,255,255,1.000)',
'white +100 is not defeated by stored opacity 0');
assert.equal(f.milkyPaintTokens({
    milkyWhiteness: 0.5, milkyOpacity: 0.24,
}).fill, 'rgba(250,252,255,0.620)',
'positive white balance ramps opacity continuously rather than jumping at +100');
assert.equal(f.milkyPaintTokens({
    milkyWhiteness: 0, milkyOpacity: 0.24,
}).fill, 'rgba(245,249,255,0.240)',
'white balance zero retains the original 24%-alpha Milky body');
assert.equal(f.milkyPaintTokens({milkyWhiteness: -1}).fill,
    'rgba(200,205,213,0.240)');
assert.equal(f.milkyPaintTokens({milkyWhiteness: -2}).fill,
    'rgba(200,205,213,0.240)', 'white balance is clamped');
assert.equal(f.milkyPaintTokens({milkyWhiteness: -1, milkyOpacity: 0.6}).fill,
    'rgba(200,205,213,0.600)', 'density is independent of white balance');
const svgLow = f.buildMilkyGrainSvg(0);
const svgHigh = f.buildMilkyGrainSvg(0.8);
assert.match(svgHigh, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
assert.match(svgHigh, /width="48" height="48"/);
assert.equal((svgHigh.match(/<circle /g) ?? []).length, 420);
assert.equal(svgHigh, f.buildMilkyGrainSvg(0.8), 'grain is deterministic');
assert.notEqual(svgLow, svgHigh, 'grain intensity controls transparency');
const textured = f.buildMilkyAppearanceCss(
    {milky: true, milkyWhiteness: -0.5}, 'file:///tmp/grain.svg');
assert.match(textured, /background-image: url\("file:\/\/\/tmp\/grain.svg"\) !important/);
assert.match(textured, /background-repeat: repeat !important/);
assert.match(textured, /background-color: rgba\(223,227,234,0\.240\)/);
const pureWhite = f.buildMilkyAppearanceCss({
    milky: true, milkyWhiteness: 1, milkyOpacity: 0.24, milkyGrain: 1,
}, 'file:///tmp/grain.svg');
assert.match(pureWhite, /rgba\(255,255,255,1\.000\)/);
assert.doesNotMatch(pureWhite, /file:\/\/\/tmp\/grain.svg/,
    'grain overlay must not darken a fully white surface');
assert.match(pureWhite, /background-image: none !important/,
    'full-white endpoint disables CSS noise');
for (const suffix of [
    'vliq-full-header',
    'vliq-full-header.vliq-top-header-ready',
    'vliq-bottom-taskbar',
    'vliq-bottom-taskbar.vliq-top-header-ready',
    'vliq-bottom-taskbar.vliq-bottom-taskbar-glass-attached',
]) assert.ok(pureWhite.includes(
    '.vliq-global-milky #panel.vliq-liquid-top-panel.' + suffix
), 'white-opacity override must beat shipped CSS on ' + suffix);
assert.doesNotMatch(f.buildMilkyAppearanceCss({milky: false},
    'file:///tmp/grain.svg'), /file:\/\/\/tmp/);

const saved = new Map(), removed = [], loaded = [], unloaded = [];
const theme = {
    rejectNext: false,
    load_stylesheet(file) {
        if (this.rejectNext) {
            this.rejectNext = false;
            throw new Error('bad CSS');
        }
        loaded.push(file.path);
    },
    unload_stylesheet(file) {unloaded.push(file.path);},
};
const GLib = {
    build_filenamev: items => items.join('/'),
    get_user_cache_dir: () => '/tmp/vliq-milky-test',
    mkdir_with_parents() {},
    file_set_contents(path, data) {saved.set(path, data);},
};
const Gio = {File: {new_for_path(path) {
    return {
        path, get_uri() {return 'file://' + path;},
        delete() {removed.push(path);saved.delete(path);},
    };
}}};
const Main = {messageTray: {_banner: {queue_redraw() {}}}};
const methodsStart = dock.indexOf('    _unloadCardAppearanceStylesheet(preserveGrain = false) {');
const applyStart = dock.indexOf('    _applyCardAppearanceStylesheet(', methodsStart);
const methodsEnd = dock.indexOf('    isBottomTaskbarActive() {', applyStart);
assert.ok(methodsStart >= 0 && applyStart > methodsStart &&
    methodsEnd > applyStart);
const methods = new Function('GLib', 'Gio', 'Main',
    'buildMilkyAppearanceCss', 'buildMilkyGrainSvg', 'clampNumber',
    'console', 'return ({' +
    dock.slice(methodsStart, methodsEnd).replace(
        /}\s*(_applyCardAppearanceStylesheet\()/, '}, $1') +
    '\n});')(GLib, Gio, Main, f.buildMilkyAppearanceCss,
    f.buildMilkyGrainSvg, (value, lo, hi) =>
        Math.min(hi, Math.max(lo, value)), {warn() {}});
const state = {
    milky: true, milkyOpacity: 0.24, milkyBorder: 0.20,
    milkyWhiteness: 0, milkyGrain: 0.28, filterOpacity: 0.05,
};
const host = {
    _cardCssFile: null, _cardGrainFile: null,
    _cardGrainStrength: -1, _cardCssSignature: '',
    _cardCssCounter: 0,
    _getShellTheme: () => theme,
    _readSystemAccentColor: () => ({color: '#4285f4'}),
    _readSharedCardAppearance: () => state,
    _unloadCardAppearanceStylesheet:
        methods._unloadCardAppearanceStylesheet,
};
const apply = () => methods._applyCardAppearanceStylesheet.call(host, state);
apply();
assert.equal(host._cardGrainStrength, 28);
const originalGrain = host._cardGrainFile;
const firstCss = host._cardCssSignature;
assert.match(firstCss, /background-repeat: repeat !important/);
assert.ok(saved.get(originalGrain.path)?.includes('<circle'));
const svgWrites = () => [...saved.keys()].filter(path => path.endsWith('.svg'));
assert.equal(svgWrites().length, 1);
state.milkyWhiteness = -0.8;
apply();
assert.ok(host._cardCssSignature.includes('rgba(209,214,221,0.240)'));
assert.equal(host._cardGrainFile, originalGrain,
    'white balance must reuse cached grain without regeneration');
assert.equal(svgWrites().length, 1);
state.milkyGrain = 0.66;
apply();
assert.equal(host._cardGrainStrength, 66);
assert.notEqual(host._cardGrainFile, originalGrain);
assert.ok(removed.includes(originalGrain.path),
    'old grain texture must be released after successful CSS swap');
const liveGrain = host._cardGrainFile;
const liveCss = host._cardCssSignature;
theme.rejectNext = true;
state.milkyGrain = 0.95;
apply();
assert.equal(host._cardGrainFile, liveGrain,
    'failed style replacement retains previous grain');
assert.equal(host._cardCssSignature, liveCss);
assert.equal(svgWrites().length, 1,
    'failed replacement must not leak temporary grain files');
state.milkyGrain = 0;
apply();
assert.equal(host._cardGrainFile, null);
assert.ok(removed.includes(liveGrain.path));
assert.match(host._cardCssSignature, /background-image: none !important/);
state.milkyGrain = 0.44;
apply();
assert.equal(host._cardGrainStrength, 44);
state.milkyWhiteness = 1;
apply();
assert.equal(host._cardGrainStrength, 0,
    'white +100 must suppress generated noise, irrespective of grain slider');
assert.equal(host._cardGrainFile, null);
assert.match(host._cardCssSignature, /rgba\(255,255,255,1\.000\)/);
assert.ok(!host._cardCssSignature.includes('grain-'),
    'no grain URL should remain in the fully white CSS');
state.milkyWhiteness = 0;
apply();
assert.equal(host._cardGrainStrength, 44,
    'moving White Balance off max restores the saved grain strength');
state.milky = false;
apply();
assert.equal(host._cardGrainFile, null);
assert.ok(!host._cardCssSignature.includes('file:///tmp/vliq-milky-test/'));
methods._unloadCardAppearanceStylesheet.call(host);
assert.equal(host._cardCssFile, null);
assert.equal(host._cardGrainFile, null);
assert.ok(unloaded.length > 0 && loaded.length > 0);
console.log('Milky grain and white balance: deterministic tile, live CSS, cache reuse, rollback and cleanup PASS.');
