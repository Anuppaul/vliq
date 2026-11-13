import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const [native, runtime, topbar, panel, css, schema, prefs, installer,
    distEffect, sourceEffect, release] = await Promise.all([
    'nativeCssIntegration.js', 'orbThemeRuntime.js', 'topBarIslands.js',
    'panelGlass.js', 'runtime.css',
    'schemas/org.gnome.shell.extensions.vliq.gschema.xml', 'prefs.js',
    '../install.sh', 'vendor/liquid-glass/dist/liquidEffect.js',
    'vendor/liquid-glass/src/liquidEffect.ts',
    '../../tools/build_ego_release.py',
].map(read));

// Native mode must not depend on vendor imports, GLSL or framebuffer effects.
assert.doesNotMatch(native,
    /^\s*import[^\n]*\b(?:Cogl|liquidEffect|windowClones|ShaderPipelines)\b/m);
assert.doesNotMatch(native, /new\s+(?:LiquidEffect|WindowCloneManager|GLSLEffect)\b/);
assert.match(native, /forceCssOnly: true/);
assert.match(topbar, /if \(!this\._forceCssOnly\) \{\s*this\._stageSignal/);
assert.match(topbar, /cssOnly: this\._forceCssOnly/);
assert.match(topbar, /if \(region\.cssOnly\)\s*ready = false/);
assert.match(panel, /if \(this\._cssOnly\)\s*return true;/);
assert.match(schema, /name="renderer-backend" type="s"/);
assert.match(schema, /choice value="native-css"/);
assert.match(schema, /<default>'auto'<\/default>/);
assert.match(schema, /name="renderer-runtime-status" type="s"/);
assert.match(prefs, /'Auto \(GPU with fallback\)'/);
assert.match(prefs, /'Native CSS \(no VLIQ shaders\)'/);
assert.match(installer, /"nativeCssIntegration\.js"/);
assert.match(release, /"nativeCssIntegration\.js"/);
assert.match(distEffect, /this\._shadersFailed = true/);
assert.match(sourceEffect, /this\._shadersFailed = true/);
assert.match(distEffect, /this\._pipelineFailures >= 3/);
assert.match(runtime, /onRendererFailure: error =>/);
assert.match(css, /\.vliq-native-css \.popup-menu-content/);
assert.match(css, /\.vliq-native-css\.vliq-native-css-dark/);

// Execute the shipped native integration, not a copy of its logic.
const nativeClass = native
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');
const listeners = new Map();
const host = {
    classes: new Set(),
    add_style_class_name(name) {this.classes.add(name);},
    remove_style_class_name(name) {this.classes.delete(name);},
};
const nativeMain = {
    uiGroup: host,
    panel: {},
    layoutManager: {uiGroup: host},
    extensionManager: {
        lookup(uuid) {
            if (uuid !== 'ubuntu-dock@ubuntu.com') return null;
            return {stateObj: {dockManager: {_allDocks: [{
                dash: {_dashContainer: {name: 'ubuntu-icons'},
                    _background: {name: 'ubuntu-background'}},
            }]}}};
        },
    },
};
const interfaceSettings = {
    color: 'default',
    get_string() {return this.color;},
    connect(signal, fn) {listeners.set(21, fn);return 21;},
    disconnect(id) {listeners.delete(id);},
};
let topbarOptions, cleanupCalls = 0, guards = 0;
class MockTopBar {
    constructor(opts) {topbarOptions = opts;}
    setup() {return true;}
    cleanup() {cleanupCalls++;}
    updateAppearance() {}
    setLauncherCallback(callback) {this.launcher = callback;}
    isBottomTaskbarActive() {return true;}
    ownsBottomTaskbarChrome() {return true;}
}
class MockGuard {
    setup() {guards++;}
    cleanup() {guards--;}
}
const NativeIntegration = new Function('Gio', 'Main', 'TopBarIslands',
    'FullscreenPanelChromeGuard', 'global', nativeClass +
    '\nreturn NativeCssIntegration;')(
    {Settings: class {constructor() {return interfaceSettings;}}},
    nativeMain, MockTopBar, MockGuard, {display: {}}
);
const nativeBackend = new NativeIntegration({vliqSettings: {}});
nativeBackend.enable();
assert.equal(topbarOptions.forceCssOnly, true);
assert.equal(topbarOptions.vendor, null);
assert.equal(topbarOptions.settings, null);
assert.equal(host.classes.has('vliq-native-css'), true);
assert.equal(guards, 1);
assert.equal(nativeBackend.isBottomTaskbarActive(), true);
assert.equal(topbarOptions.getDockEntries().length, 1,
    'reuse Ubuntu Dock rather than creating another dock');
interfaceSettings.color = 'prefer-dark';
listeners.get(21)();
assert.equal(host.classes.has('vliq-native-css-dark'), true);
let launches = 0;
nativeBackend.setBottomTaskbarLauncher(() => launches++);
nativeBackend._topPanelIslands.launcher();
assert.equal(launches, 1);
nativeBackend.disable();
assert.equal(host.classes.has('vliq-native-css'), false);
assert.equal(host.classes.has('vliq-native-css-dark'), false);
assert.equal(cleanupCalls, 1);
assert.equal(guards, 0);
assert.equal(listeners.size, 0);
nativeBackend.disable();
assert.equal(cleanupCalls, 1, 'cleanup is idempotent');

// Run the actual async runtime routing methods with controlled backends.
const begin = runtime.indexOf('    _publishRendererStatus(value) {');
const end = runtime.indexOf('\n    disable() {', begin);
assert.ok(begin >= 0 && end > begin);
const backendInstances = [];
let gpuFails = false;
class FakeGpu {
    constructor(opts) {this.opts = opts;this.disabled = false;
        backendInstances.push(this);}
    async enable() {if (gpuFails) throw Error('shader import failed');}
    disable() {this.disabled = true;}
    setBottomTaskbarLauncher(callback) {this.launcher = callback;}
}
class FakeNative {
    constructor() {this.disabled = false; backendInstances.push(this);}
    enable() {}
    disable() {this.disabled = true;}
    setBottomTaskbarLauncher(callback) {this.launcher = callback;}
}
const methods = new Function('LiquidGlassIntegration', 'NativeCssIntegration',
    'console', 'return ({' + runtime.slice(begin, end).replace(
        /}\s*(_switchRendererBackend\()/, '}, $1') + '});')(
    FakeGpu, FakeNative, {warn() {}}
);
function makeRuntime(selected = 'auto') {
    const stored = {'renderer-backend': selected, 'glass-style': 'frosted',
        'renderer-runtime-status': ''};
    const obj = {
        _disabled: false, _rendererGeneration: 0,
        _rendererSwitchPromise: Promise.resolve(),
        _rendererFailureReason: '', _liquidGlassIntegration: null,
        _settings: {
            get_string: key => stored[key],
            set_string: (key, value) => {stored[key] = value;},
        },
        _showAllApps() {},
        _syncOrbTaskbarMode() {},
    };
    obj._publishRendererStatus = methods._publishRendererStatus;
    obj._switchRendererBackend = methods._switchRendererBackend;
    return {obj, stored};
}
{
    const {obj, stored} = makeRuntime('native-css');
    const before = backendInstances.length;
    await obj._switchRendererBackend();
    assert.equal(backendInstances.length, before + 1);
    assert.ok(obj._liquidGlassIntegration instanceof FakeNative);
    assert.equal(stored['glass-style'], 'frosted',
        'CSS fallback MUST NOT overwrite Liquid/Frosted/Milky preference');
    assert.match(stored['renderer-runtime-status'], /Native CSS \(selected/);
}
{
    const {obj, stored} = makeRuntime();
    gpuFails = false;
    await obj._switchRendererBackend();
    const gpu = obj._liquidGlassIntegration;
    assert.ok(gpu instanceof FakeGpu);
    assert.match(stored['renderer-runtime-status'], /^Auto:/);
    // A late GLSL/Cogl compilation failure must replace the live GPU
    // backend after disabling it, never destroy actors inside shader paint.
    gpu.opts.onRendererFailure('Cogl unavailable');
    await obj._rendererSwitchPromise;
    assert.equal(gpu.disabled, true);
    assert.ok(obj._liquidGlassIntegration instanceof FakeNative);
    assert.match(stored['renderer-runtime-status'], /shader unavailable/);
    assert.equal(stored['renderer-backend'], 'auto');
    assert.equal(stored['glass-style'], 'frosted');
    obj._rendererFailureReason = '';
    await obj._switchRendererBackend();
    assert.ok(obj._liquidGlassIntegration instanceof FakeGpu,
        'auto mode can retry GPU after a failure without schema rewrites');
}
{
    const {obj, stored} = makeRuntime();
    gpuFails = true;
    await obj._switchRendererBackend();
    assert.ok(obj._liquidGlassIntegration instanceof FakeNative,
        'vendor startup exception must not remove native layout features');
    assert.match(stored['renderer-runtime-status'], /startup failed/);
    gpuFails = false;
    obj._disabled = true;
    obj._rendererGeneration++;
    const previous = obj._liquidGlassIntegration;
    await obj._switchRendererBackend();
    assert.equal(obj._liquidGlassIntegration, previous,
        'disable must prevent new async renderer initialization');
}
console.log('Native CSS backend routing, no-shader path, GNOME dark state, Dock reuse, fallback and cleanup PASS.');
