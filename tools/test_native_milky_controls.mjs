import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const [native, source] = await Promise.all([
    'nativeCssIntegration.js', 'milkyPaint.js',
].map(f => readFile(new URL(f, base), 'utf8')));
const paint = new Function(source.replace(/^export /gm, '') +
    '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss, buildMilkyGrainSvg, MilkyActorPainter, milkyCardActors};')();

assert.match(native, /_milkySettingsSignal/);
assert.match(native, /'milky-opacity', 'milky-black'/);
assert.match(native, /'milky-border', 'milky-grain'/);
assert.match(native, /_refreshMilkyAppearance\(\)/);
assert.match(native, /buildMilkyAppearanceCss\(state, grainUri\)/);

const files = new Map(), removals = [], applied = [], unloaded = [];
const GLib = {
    get_user_cache_dir: () => '/tmp/vliq-native-test',
    build_filenamev: parts => parts.join('/'),
    mkdir_with_parents() {},
    file_set_contents(path, contents) {files.set(path, contents);},
};
const Gio = {
    Settings: class {
        constructor() {return systemSettings;}
    },
    File: {new_for_path(path) {
        return {
            path,
            get_uri() {return 'file://' + path;},
            delete() {removals.push(path);files.delete(path);},
        };
    }},
};
const theme = {
    rejectSvg: false,
    load_stylesheet(file) {
        const css = files.get(file.path);
        assert.ok(css);
        if (this.rejectSvg && css.includes('background-image: url('))
            throw Error('St cannot read SVG URL');
        applied.push(css);
    },
    unload_stylesheet(file) {unloaded.push(file.path);},
};
const St = {ThemeContext: {
    get_for_stage() {return {get_theme: () => theme};},
}};
const classes = new Set();
const host = {
    add_style_class_name(name) {classes.add(name);},
    remove_style_class_name(name) {classes.delete(name);},
};
let next = 1;
const systemHandlers = new Map();
const systemSettings = {
    color: 'default',
    get_string() {return this.color;},
    connect(_signal, fn) {
        const id = next++;systemHandlers.set(id, fn);return id;
    },
    disconnect(id) {systemHandlers.delete(id);},
};
const settingsHandlers = new Map();
const values = {
    'glass-style': 'milky', 'milky-opacity': 24,
    'milky-black': false, 'milky-border': 20,
    'milky-grain': 28,
};
const settings = {
    get_string(key) {return values[key];},
    get_int(key) {return values[key];},
    get_boolean(key) {return values[key] === true;},
    connect(signal, fn) {
        assert.equal(signal, 'changed');
        const id = next++;settingsHandlers.set(id, fn);return id;
    },
    disconnect(id) {settingsHandlers.delete(id);},
    change(key, value) {
        values[key] = value;
        for (const fn of settingsHandlers.values())
            fn(this, key);
    },
};
const Main = {layoutManager: {uiGroup: host},
    uiGroup: host, panel: {}, extensionManager: {lookup() {return null;}}};
let panelOptions = null;
class TopBar {
    constructor(options) {panelOptions = options;}
    setup() {return true;}
    cleanup() {}
    updateAppearance() {}
    setLauncherCallback() {}
}
class Guard {
    setup() {}
    cleanup() {}
}
const body = native.replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export /gm, '');
const NativeIntegration = new Function('Gio', 'GLib', 'St', 'Main',
    'TopBarIslands', 'FullscreenPanelChromeGuard', 'milkyPaintTokens',
    'buildMilkyAppearanceCss', 'buildMilkyGrainSvg',
    'MilkyActorPainter', 'milkyCardActors', 'global', 'console',
    body + '\nreturn NativeCssIntegration;')(
    Gio, GLib, St, Main, TopBar, Guard, paint.milkyPaintTokens,
    paint.buildMilkyAppearanceCss, paint.buildMilkyGrainSvg,
    paint.MilkyActorPainter, paint.milkyCardActors,
    {stage: {}, display: {}}, {warn() {}, log() {}}
);
const backend = new NativeIntegration({vliqSettings: settings});
backend.enable();
assert.ok(classes.has('vliq-native-css'));
assert.ok(classes.has('vliq-global-milky'),
    'native fallback must recognize selected Milky appearance');
assert.equal(panelOptions.forceCssOnly, true);
assert.equal(panelOptions.readAppearance().milky, true,
    'panel reads current Milky settings, not hard-coded false');
assert.ok(applied.at(-1).includes('rgba(255,255,255,0.240)'));
assert.ok(applied.at(-1).includes('grain-'),
    'initial static grain uses saved slider');
const firstGrain = backend._milkyGrainFile.path;

settings.change('milky-opacity', 68);
assert.ok(applied.at(-1).includes('rgba(255,255,255,0.680)'),
    'Opacity changes immediately repaint white card without GPU mode');
assert.equal(backend._milkyGrainFile.path, firstGrain,
    'Opacity change reuses static noise tile');
settings.change('milky-border', 70);
assert.ok(applied.at(-1).includes('rgba(255,255,255,0.700)'),
    'Edge Highlight changes immediately repaint card');
settings.change('milky-black', true);
assert.ok(applied.at(-1).includes('rgba(29,31,35,0.680)'),
    'Black toggle must preserve 68% Milky Opacity');
assert.equal(backend._milkyGrainFile.path, firstGrain,
    'Black toggle retains black-only grain tile');
settings.change('milky-black', false);
assert.ok(applied.at(-1).includes('rgba(255,255,255,0.680)'),
    'White toggle restores pure white at unchanged opacity');
assert.equal(backend._milkyGrainStrength, 28);

theme.rejectSvg = true;
settings.change('milky-grain', 88);
assert.ok(applied.at(-1).includes('rgba(255,255,255,0.680)'),
    'if SVG image fails, CSS must still apply latest selected color');
assert.ok(applied.at(-1).includes('background-image: none !important'),
    'SVG failure fallback must remove optional grain, not entire material');
assert.ok(backend._milkyStyleFile,
    'renderer must keep a working stylesheet after SVG rejection');
assert.equal([...files.keys()].filter(x => x.endsWith('.svg')).length, 0,
    'SVG import failure does not leak created noise textures');

settings.change('glass-style', 'liquid');
assert.equal(classes.has('vliq-global-milky'), false);
assert.equal(backend._milkyStyleFile, null);
assert.equal(panelOptions.readAppearance().milky, false);
const stylesBefore = applied.length;
settings.change('milky-opacity', 21);
assert.equal(applied.length, stylesBefore,
    'Milky slider changes do not override Liquid/Frosted styles');
backend.disable();
assert.equal(classes.has('vliq-native-css'), false);
assert.equal(settingsHandlers.size, 0, 'all canonical settings signals disconnected');
assert.equal(systemHandlers.size, 0, 'native Dark Style signal disconnected');
assert.equal(files.size, 0, 'generated stylesheets and tiles are cleaned up');
assert.ok(unloaded.length > 0);
console.log('Native CSS Milky: live 4 sliders, solid white, SVG failure recovery, mode switch and cleanup PASS.');
