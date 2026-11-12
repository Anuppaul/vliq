import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = '../gnome-shell/vliq@wonderer.tech/';
const [glass, css, spotlight] = await Promise.all([
    'spotlightGlass.js', 'runtime.css', 'spotlightSearch.js',
].map(f => readFile(new URL(root + f, import.meta.url), 'utf8')));
assert.match(glass, /const SHARED_RADIUS = 18;/);
assert.match(glass, /_regions\(\) \{[\s\S]*?return \[\];/);
assert.doesNotMatch(
    glass.slice(glass.indexOf('    _regions() {'),
        glass.indexOf('    _syncEffectRegion() {')),
    /_regionFor\(\s*this\._target/,
    'the dark search input must never be sampled by LiquidEffect');

const cssBegin = css.indexOf('/* VLIQ Spotlight — GLOBAL dark rounded-rectangle');
assert.ok(cssBegin > 0);
const dark = css.slice(cssBegin);
assert.match(dark, /rgba\(28, 30, 35, 0\.98\) !important/);
assert.match(dark, /border-radius: 16px !important/);
assert.match(dark, /color: #f7f8fc !important/);
assert.match(dark, /\.vliq-global-milky \.search-entry\.vliq-spotlight-glass-entry/);
assert.match(dark, /vliq-shared-text-dark/);
assert.match(dark, /StLabel\.hint-text/);
assert.match(dark, /vliq-spotlight-results\.vliq-spotlight-glass-results/);
assert.doesNotMatch(dark, /#overviewGroup|\.vliq-search-surface/,
    'the standard GNOME App Grid search is not altered');
assert.match(spotlight, /style_class: 'search-entry vliq-spotlight-glass-entry'/);
assert.match(spotlight, /this\._onEntryKeyPress\(event\)/);

function method(start, end, name, injected = {}) {
    const a = glass.indexOf('    ' + start);
    const b = glass.indexOf('    ' + end, a + start.length);
    assert.ok(a >= 0 && b > a, name + ' source boundaries');
    return new Function(...Object.keys(injected),
        'return ({' + glass.slice(a, b) + '}).' + name + ';')(
        ...Object.values(injected));
}
const regions = method('_regions() {', '_syncEffectRegion() {', '_regions');
const input = {id: 'search-input'}, results = {id: 'results'};
const host = {
    _target: input, _resultsTarget: results,
    _regionFor(target) {
        return target === results && this._hasResults ? {id: 'results'} : null;
    }, _hasResults: false,
};
assert.deepEqual(regions.call(host), []);
host._hasResults = true;
assert.deepEqual(regions.call(host), [],
    'dark results must not enable the old GPU glass renderer');
host._hasResults = false;
assert.deepEqual(regions.call(host), [],
    'cleared queries cannot leave an old entry shader region');

const sync = method('_syncLoopState() {', '_syncActors() {',
    '_syncLoopState');
let hides = 0, stops = 0, stages = 0;
const runtime = {
    _appearance: {milky: false}, _isActive: () => true,
    _regions: () => [], _root: {hide() {hides++;}, visible: false},
    _stopStageLoop() {stops++;},
    _placeBelowHost() {stages++;},
    _lastRegionKey: 'stale',
    _lastSceneSyncUs: 22, _lastCullKey: 'old',
};
sync.call(runtime);
assert.equal(hides, 1);
assert.equal(stops, 1);
assert.equal(stages, 0);
assert.equal(runtime._lastRegionKey, '');
assert.equal(runtime._lastSceneSyncUs, 0);
assert.equal(runtime._lastCullKey, '');
runtime._regions = regions.bind(host);
sync.call(runtime);
assert.equal(stages, 0, 'result rows must not restart the GPU glass loop');
assert.equal(runtime._root.visible, false);
const list = css.slice(css.indexOf('/* VLIQ Spotlight: the RESULTS list'));
assert.ok(list.startsWith('/* VLIQ Spotlight: the RESULTS list'));
assert.match(list, /rgba\(28, 30, 35, 0\.98\)/);
assert.match(list, /border-radius: 16px !important/);
assert.match(list, /list-search-result-title/);
assert.match(list, /list-search-result-description/);
assert.match(list, /list-search-result:focus/);
assert.match(list, /rgba\(255, 255, 255, 0\.10\)/);
assert.match(list, /\.vliq-global-milky \.vliq-spotlight-card/);
assert.doesNotMatch(list, /#overviewGroup|\.vliq-search-surface/,
    'normal GNOME Overview search must not change');
console.log('Spotlight search and results globally dark, native, rounded PASS.');
