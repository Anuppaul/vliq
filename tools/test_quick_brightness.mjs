import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const src = await readFile(new URL('quickBrightness.js', root), 'utf8');
const runtime = await readFile(new URL('orbThemeRuntime.js', root), 'utf8');
const prefs = await readFile(new URL('prefs.js', root), 'utf8');
const schema = await readFile(new URL(
    'schemas/org.gnome.shell.extensions.vliq.gschema.xml', root
), 'utf8');
const installer = await readFile(
    new URL('../gnome-shell/install.sh', import.meta.url), 'utf8'
);
const builder = await readFile(
    new URL('../tools/build_ego_release.py', import.meta.url), 'utf8'
);

class Signals {
    constructor() {this.listeners = new Map(); this.serial = 0;}
    connect(name, callback) {
        const id = ++this.serial;
        this.listeners.set(id, {name, callback});
        return id;
    }
    disconnect(id) {
        assert.ok(this.listeners.delete(id), 'disconnect a live signal');
    }
    emit(name, ...args) {
        for (const {name: n, callback} of [...this.listeners.values()]) {
            if (n === name)
                callback(this, ...args);
        }
    }
    get count() {return this.listeners.size;}
}

class MockActor extends Signals {
    constructor(name = 'unnamed') {
        super();
        this.name = name;
        this.parent = null;
        this.destroyed = false;
    }
    get_parent() {return this.parent;}
    destroy() {
        this.destroyed = true;
        if (this.parent)
            this.parent.remove(this);
    }
}

class Grid extends MockActor {
    constructor() {
        super('quick-settings-grid');
        this.children = [];
    }
    add_child(actor) {
        assert.ok(!this.children.includes(actor));
        this.children.push(actor);
        actor.parent = this;
        this.emit('child-added', actor);
    }
    remove(actor) {
        this.children.splice(this.children.indexOf(actor), 1);
        actor.parent = null;
    }
    get_children() {return [...this.children];}
    set_child_above_sibling(actor, sibling) {
        assert.equal(actor.parent, this);
        assert.equal(sibling.parent, this);
        this.remove(actor);
        this.children.splice(this.children.indexOf(sibling) + 1, 0, actor);
        actor.parent = this;
    }
    set_child_below_sibling(actor, sibling) {
        assert.equal(actor.parent, this);
        this.remove(actor);
        if (sibling === null)
            this.children.unshift(actor);
        else
            this.children.splice(this.children.indexOf(sibling), 0, actor);
        actor.parent = this;
    }
}

class Slider extends Signals {
    constructor() {super(); this._value = 0; this.accessible_name = '';}
    get value() {return this._value;}
    set value(v) {
        this._value = v;
        this.emit('notify::value');
    }
}

class QuickSlider extends MockActor {
    constructor(props) {
        super('vliq-fallback-slider');
        this.props = props;
        this.menu = {actor: new MockActor('quick-toggle-menu')};
        this.slider = new Slider();
        this.classes = [];
        this.destroyed = false;
    }
    add_style_class_name(value) {this.classes.push(value);}
    destroy() {
        this.slider.listeners.clear();
        super.destroy();
    }
}

class BrightnessContrastEffect {
    constructor() {this.brightness = 0;}
    set_brightness(value) {
        assert.ok(value <= 0 && value >= -0.5);
        this.brightness = value;
    }
}

// GNOME Shell 50's Meta.Compositor uses a ref-counted unredirect inhibit.
// Native OSD has matching disable_unredirect()/enable_unredirect() calls.
// Simulate direct scanout bypassing uiGroup brightness when count == 0.
class Compositor {
    constructor() {
        this.inhibitCount = 0;
        this.disableCalls = 0;
        this.enableCalls = 0;
        this.shouldFail = false;
    }
    disable_unredirect() {
        if (this.shouldFail)
            throw new Error('compositor rejected direct scanout inhibition');
        this.disableCalls++;
        this.inhibitCount++;
    }
    enable_unredirect() {
        assert.ok(this.inhibitCount > 0, 'refcount underflow');
        this.enableCalls++;
        this.inhibitCount--;
    }
    sceneBrightnessVisibleOnFullscreen() {
        return this.inhibitCount > 0;
    }
}

class Host {
    constructor(name = 'host', children = []) {
        this.name = name;
        this.children = children;
        this.effects = new Map();
        this.added = 0;
        this.removed = 0;
    }
    contains(actor) {return this.children.includes(actor);}
    get_effect(name) {return this.effects.get(name) ?? null;}
    add_effect_with_name(name, effect) {
        assert.equal(this.get_effect(name), null);
        this.effects.set(name, effect);
        this.added++;
    }
    remove_effect(effect) {
        for (const [name, value] of this.effects) {
            if (effect === value) {
                this.effects.delete(name);
                this.removed++;
                return;
            }
        }
        throw new Error('Effect not owned');
    }
}

const idleSources = new Map();
let nextIdle = 0;
const GLib = {
    PRIORITY_DEFAULT_IDLE: 100,
    SOURCE_REMOVE: false,
    idle_add(_priority, callback) {
        const id = ++nextIdle;
        idleSources.set(id, callback);
        return id;
    },
    source_remove(id) {return idleSources.delete(id);},
};
function flushIdle() {
    for (let cycles = 0; cycles < 20 && idleSources.size; cycles++) {
        const scheduled = [...idleSources.values()];
        idleSources.clear();
        for (const fn of scheduled)
            fn();
    }
    assert.equal(idleSources.size, 0, 'no runaway idle sync loop');
}

class Settings extends Signals {
    constructor() {
        super();
        this.data = new Map([
            ['quick-brightness-enabled', true],
            ['quick-soft-brightness', 100],
            ['quick-brightness-status', 'Not initialized'],
        ]);
    }
    get_boolean(key) {return this.data.get(key);}
    get_int(key) {return this.data.get(key);}
    get_string(key) {return this.data.get(key);}
    set_boolean(key, value) {this.data.set(key, value); this.emit('changed::' + key);}
    set_int(key, value) {this.data.set(key, value); this.emit('changed::' + key);}
    set_string(key, value) {this.data.set(key, value); this.emit('changed::' + key);}
}
const grid = new Grid();
const output = new MockActor('sound-output');
const input = new MockActor('sound-input');
const hardware = new MockActor('gnome-native-brightness');
for (const actor of [output, input, hardware])
    grid.add_child(actor);

const menu = {
    _grid: grid,
    items: [],
    addItem(item, span) {
        assert.equal(span, 2, 'brightness should be full width like sound');
        this.items.push(item);
        grid.add_child(item);
    },
};
const brightnessManager = new Signals();
brightnessManager.globalScale = null;
const Main = {
    panel: {
        statusArea: {
            quickSettings: {
                menu,
                _volumeOutput: {_output: output},
                _volumeInput: {_input: input},
                _brightness: {quickSettingsItems: [hardware]},
            },
        },
    },
    brightnessManager,
};
// GNOME Shell 50 uiGroup owns the normal window group, top-window group,
// panel, Quick Settings and system overlays. window_group alone did NOT
// cover the entire desktop; this fixture catches that original regression.
const windowGroup = new Host('windows');
const topWindowGroup = new Host('top-windows');
const panelScene = new Host('panel-and-quick-settings');
const uiGroup = new Host('GNOME-uiGroup', [
    windowGroup, topWindowGroup, panelScene,
]);
const stage = new Host('root-stage', [uiGroup]);
Main.layoutManager = {uiGroup};
const compositor = new Compositor();
const global = {
    window_group: windowGroup,
    top_window_group: topWindowGroup,
    stage,
    compositor,
};
const Clutter = {BrightnessContrastEffect};

const executable = src.replace(/^import .*?;\s*$/gm, '').replace(/^export /gm, '');
const api = new Function(
    'Clutter', 'GLib', 'Main', 'QuickSlider', 'global',
    executable + '\nreturn {QuickBrightnessManager, clampSoftBrightness, softwareDimFactor, getQuickBrightnessActors, getFullDesktopBrightnessHost};'
)(Clutter, GLib, Main, QuickSlider, global);

assert.equal(api.clampSoftBrightness(10), 30);
assert.equal(api.clampSoftBrightness(120), 100);
assert.equal(api.clampSoftBrightness(Number.NaN), 100);
assert.equal(api.softwareDimFactor(100), 0);
assert.equal(api.getFullDesktopBrightnessHost(), uiGroup,
    'compositor effect must target GNOME uiGroup with windows and shell');
assert.ok(uiGroup.contains(windowGroup));
assert.ok(uiGroup.contains(topWindowGroup));
assert.ok(uiGroup.contains(panelScene));
assert.notEqual(api.getFullDesktopBrightnessHost(), global.stage,
    'root-stage effects are forbidden');
assert.equal(api.softwareDimFactor(30), -0.5);
assert.ok(api.softwareDimFactor(70) < 0);

const settings = new Settings();
const controller = new api.QuickBrightnessManager(settings);
controller.setup();
flushIdle();
assert.equal(controller._softwareSlider instanceof QuickSlider, true);
assert.deepEqual(grid.get_children().map(a => a.name),
    ['sound-output', 'vliq-fallback-slider',
     'sound-input', 'gnome-native-brightness']);
assert.match(settings.get_string('quick-brightness-status'), /^Software/);
assert.equal(controller._softwareSlider.slider.accessible_name,
    'Brightness (software dimming)');
assert.equal(uiGroup.effects.size, 0,
    '100% brightness must not allocate a GPU dimming effect');
assert.equal(compositor.inhibitCount, 0,
    '100% must preserve fullscreen direct scanout');
assert.equal(compositor.disableCalls, 0,
    'no compositor inhibition until GPU dimming starts');
assert.equal(windowGroup.effects.size, 0,
    'a windows-only effect must NEVER be used for full-screen dimming');
assert.equal(menu.items.length, 1, 'only one native-looking fallback created');

controller._softwareSlider.slider.value = 0.70;
flushIdle();
assert.equal(settings.get_int('quick-soft-brightness'), 70);
assert.equal(uiGroup.effects.size, 1,
    'software dimming must include panel, Quick Settings and windows');
assert.equal(windowGroup.effects.size, 0,
    'do not dim only window_group; that was the reported partial effect');
assert.equal(stage.effects.size, 0,
    'global.stage root shader may blank the desktop');
assert.equal(compositor.inhibitCount, 1,
    'full-screen video must route through uiGroup compositor while dimmed');
assert.equal(compositor.disableCalls, 1,
    'one disable_unredirect call per active dimming lease');
assert.equal(compositor.sceneBrightnessVisibleOnFullscreen(), true);
const dimEffect = controller._effect;
assert.ok(dimEffect.brightness < 0);
assert.ok(dimEffect.brightness > -0.5);
assert.equal(controller._effectHost, uiGroup);
assert.equal(menu.items.length, 1, 'never duplicate slider during settings updates');

// Slider stays stable on Quick Settings reconnect and duplicate signals.
grid.emit('child-added', new MockActor('dummy'));
brightnessManager.emit('changed');
flushIdle();
assert.equal(grid.get_children().filter(a =>
    a.name === 'vliq-fallback-slider').length, 1);
assert.equal(compositor.inhibitCount, 1);
assert.equal(compositor.disableCalls, 1,
    'slider updates may NEVER accumulate global compositor holds');

// Drag brightness continuously while fullscreen; no ref-count churn.
controller._softwareSlider.slider.value = 0.45;
flushIdle();
assert.equal(compositor.inhibitCount, 1);
assert.equal(compositor.disableCalls, 1);
assert.equal(compositor.enableCalls, 0);
assert.equal(uiGroup.effects.size, 1);

controller._softwareSlider.slider.value = 1;
flushIdle();
assert.equal(settings.get_int('quick-soft-brightness'), 100);
assert.equal(uiGroup.effects.size, 0, '100% removes GPU pass');
assert.equal(compositor.inhibitCount, 0,
    '100% must immediately re-enable direct scanout');
assert.equal(compositor.enableCalls, 1);
assert.equal(compositor.sceneBrightnessVisibleOnFullscreen(), false);
assert.equal(uiGroup.removed, 1);

// GNOME 50 hardware backlight appears: switch to the already existing
// native BrightnessItem and never build a second native slider.
settings.set_int('quick-soft-brightness', 55);
flushIdle();
assert.equal(uiGroup.effects.size, 1);
brightnessManager.globalScale = {value: 0.6};
brightnessManager.emit('changed');
flushIdle();
assert.equal(uiGroup.effects.size, 0,
    'hardware mode removes software GPU effect');
assert.equal(compositor.inhibitCount, 0,
    'switching to native hardware restores direct scanout');
assert.equal(controller._softwareSlider, null,
    'hardware mode destroys fallback widget');
assert.deepEqual(grid.get_children().map(a => a.name),
    ['sound-output', 'gnome-native-brightness', 'sound-input']);
assert.match(settings.get_string('quick-brightness-status'), /^Hardware/);
assert.equal(settings.get_int('quick-soft-brightness'), 55,
    'switching hardware must preserve saved software brightness');
assert.equal(menu.items[0].menu.actor.destroyed, true,
    'removed slider overlay must be destroyed');

// Hotplug back to no supported hardware: recreate one software slider
// and restore old GNOME ordering before inserting fallback.
brightnessManager.globalScale = null;
brightnessManager.emit('changed');
flushIdle();
assert.deepEqual(grid.get_children().map(a => a.name),
    ['sound-output', 'vliq-fallback-slider',
     'sound-input', 'gnome-native-brightness']);
assert.equal(settings.get_int('quick-soft-brightness'), 55);
assert.equal(uiGroup.effects.size, 1);

// Disable restores GNOME actors and GPU state; re-enable is reversible.
settings.set_boolean('quick-brightness-enabled', false);
flushIdle();
assert.deepEqual(grid.get_children().map(a => a.name),
    ['sound-output', 'sound-input', 'gnome-native-brightness']);
assert.equal(controller._softwareSlider, null);
assert.equal(uiGroup.effects.size, 0);
assert.equal(compositor.inhibitCount, 0,
    'disabling brightness restores compositor optimisations');
assert.equal(settings.get_string('quick-brightness-status'), 'Off');
settings.set_boolean('quick-brightness-enabled', true);
flushIdle();
assert.equal(grid.get_children().filter(a =>
    a.name === 'vliq-fallback-slider').length, 1);

// GNOME async indicator additions must be handled on a single deferred
// idle, without polling/monkeypatching the GNOME QuickSettings prototype.
controller.cleanup();
flushIdle();
assert.equal(uiGroup.effects.size, 0, 'hot-swap must release GPU dimmer');
assert.equal(compositor.inhibitCount, 0,
    'hot-swap must release exactly the acquired fullscreen lease');
assert.equal(compositor.disableCalls, compositor.enableCalls,
    'all direct scanout inhibitor reference counts balance');
assert.equal(grid.count, 0, 'child-added signal must be disconnected');
assert.equal(settings.count, 0);
assert.equal(brightnessManager.count, 0);
assert.equal(controller._softwareSlider, null);
assert.deepEqual(grid.get_children().map(a => a.name),
    ['sound-output', 'sound-input', 'gnome-native-brightness']);

// A missing compositor GPU API must NOT create a fake control that cannot
// actually dim the display.
const unavailableSettings = new Settings();
const previousHost = Main.layoutManager.uiGroup;
// No full desktop scene: absolutely no fallback to the partial window group.
Main.layoutManager.uiGroup = null;
const unavailable = new api.QuickBrightnessManager(unavailableSettings);
unavailable.setup();
flushIdle();
assert.equal(unavailable._softwareSlider, null);
assert.match(unavailableSettings.get_string('quick-brightness-status'),
    /Unavailable/);
unavailable.cleanup();
Main.layoutManager.uiGroup = previousHost;

// A malformed scene (missing top window layer) must also fail closed.
const missingTop = global.top_window_group;
global.top_window_group = null;
const invalidSettings = new Settings();
const invalid = new api.QuickBrightnessManager(invalidSettings);
invalid.setup();
flushIdle();
assert.equal(invalid._softwareSlider, null);
assert.equal(uiGroup.effects.size, 0);
assert.equal(windowGroup.effects.size, 0);
assert.equal(stage.effects.size, 0);
invalid.cleanup();
global.top_window_group = missingTop;

// The root stage must never be accepted as a host, even if it owns both
// window groups (e.g. after an incompatible Shell layout change).
Main.layoutManager.uiGroup = stage;
const unsafeSettings = new Settings();
const unsafe = new api.QuickBrightnessManager(unsafeSettings);
unsafe.setup();
flushIdle();
assert.equal(unsafe._softwareSlider, null);
assert.equal(stage.effects.size, 0);
unsafe.cleanup();
Main.layoutManager.uiGroup = uiGroup;

// Unsupported GNOME compositor: do not introduce a partial brightness
// effect that falsely claims to dim fullscreen video.
const originalCompositor = global.compositor;
global.compositor = {
    disable_unredirect() {},
    // Missing enable_unredirect must fail before acquiring anything.
};
const noApiSettings = new Settings();
noApiSettings.data.set('quick-soft-brightness', 70);
const noApi = new api.QuickBrightnessManager(noApiSettings);
noApi.setup();
flushIdle();
assert.equal(uiGroup.effects.size, 0);
assert.equal(noApi._effect, null);
assert.equal(noApi._unredirectHeld, false);
assert.match(noApiSettings.get_string('quick-brightness-status'),
    /Unavailable: fullscreen compositing API missing/);
noApi.cleanup();
global.compositor = originalCompositor;

// Failure after acquiring direct scanout inhibition (e.g., GPU effect
// constructor/attachment exception) must release the global counter.
const originalAddEffect = uiGroup.add_effect_with_name;
uiGroup.add_effect_with_name = () => {
    throw new Error('GPU shader attach refused');
};
const failedSettings = new Settings();
failedSettings.data.set('quick-soft-brightness', 65);
const failed = new api.QuickBrightnessManager(failedSettings);
failed.setup();
flushIdle();
assert.equal(uiGroup.effects.size, 0);
assert.equal(compositor.inhibitCount, 0, 'failure must release inhibitor');
assert.equal(failed._unredirectHeld, false);
assert.match(failedSettings.get_string('quick-brightness-status'),
    /Unavailable: software dimming failed/);
failed.cleanup();
uiGroup.add_effect_with_name = originalAddEffect;

// A second extension may already own an effect under the same name.
// Collision MUST fail before obtaining a fullscreen compositor lease.
const foreignEffect = new BrightnessContrastEffect();
uiGroup.add_effect_with_name('vliq-quick-brightness-software-dim',
    foreignEffect);
const conflictSettings = new Settings();
conflictSettings.data.set('quick-soft-brightness', 65);
const conflict = new api.QuickBrightnessManager(conflictSettings);
const disableBeforeConflict = compositor.disableCalls;
conflict.setup();
flushIdle();
assert.equal(conflict._effect, null);
assert.equal(conflict._unredirectHeld, false);
assert.equal(compositor.disableCalls, disableBeforeConflict,
    'foreign effect must be detected before acquiring a compositor lease');
assert.equal(compositor.inhibitCount, 0);
assert.equal(uiGroup.get_effect('vliq-quick-brightness-software-dim'),
    foreignEffect, 'never remove another extension effect');
assert.match(conflictSettings.get_string('quick-brightness-status'),
    /Unavailable: existing brightness effect/);
conflict.cleanup();
assert.equal(compositor.inhibitCount, 0);
uiGroup.remove_effect(foreignEffect);

// Mutter's counter is shared with OSK/OSD and other extensions.
// Releasing VLIQ's ONE lease must not release another owner's hold.
compositor.disable_unredirect(); // Native OSD-like external owner
const nestedSettings = new Settings();
nestedSettings.data.set('quick-soft-brightness', 60);
const nested = new api.QuickBrightnessManager(nestedSettings);
nested.setup();
flushIdle();
assert.equal(compositor.inhibitCount, 2);
nested.cleanup();
assert.equal(compositor.inhibitCount, 1,
    'disabling VLIQ may not decrement the native OSD inhibitor');
compositor.enable_unredirect(); // OSD releases its own hold
assert.equal(compositor.inhibitCount, 0);
assert.equal(compositor.disableCalls, compositor.enableCalls);

// If the running compositor object changes, release exactly the one
// acquired on the original compositor rather than an unrelated instance.
const retainedSettings = new Settings();
retainedSettings.data.set('quick-soft-brightness', 60);
const retained = new api.QuickBrightnessManager(retainedSettings);
retained.setup();
flushIdle();
assert.equal(compositor.inhibitCount, 1);
global.compositor = new Compositor();
retained.cleanup();
assert.equal(compositor.inhibitCount, 0);
assert.equal(global.compositor.inhibitCount, 0);
global.compositor = originalCompositor;

assert.match(runtime, /new QuickBrightnessManager\(this\._settings\)/);
assert.match(runtime, /this\._quickBrightnessManager\?\.cleanup\(\)/);
assert.match(prefs, /Brightness below Sound/);
assert.match(schema, /<key name="quick-brightness-enabled" type="b">\s*<default>true<\/default>/);
assert.match(schema, /<key name="quick-soft-brightness" type="i">\s*<default>100<\/default>/);
assert.match(installer, /"quickBrightness.js"/);
assert.match(builder, /"quickBrightness.js"/);
assert.match(src, /compositor\.disable_unredirect\(\)/,
    'fullscreen video scanout bypass must be inhibited');
assert.match(src, /compositor\?\.enable_unredirect\?\.\(\)/,
    'release compositor inhibition on GPU effect teardown');
assert.doesNotMatch(src, /global\.compositor\.disable_unredirect\(\)/,
    'direct scanout ref must be owned by controller, not a global call at import');
assert.match(src, /Main\.layoutManager\?\.uiGroup/,
    'the renderer must target the entire GNOME compositor scene');
assert.doesNotMatch(src, /const host = global\.window_group/,
    'do not regress to windows-only brightness');
assert.doesNotMatch(src, /global\.stage\.add_effect/,
    'do not attach shader to dangerous root stage');
assert.doesNotMatch(src,
    /Shell\.Screenshot|global\.stage\.add_effect|Gio\.DBus|GLib\.timeout_add|force\s*push/,
    'do not use screenshots, root-stage shaders, DDC access or polling');
console.log(
    'Quick Settings brightness: full GNOME desktop incl. panel/overlays, ' +
    'fullscreen video unredirect inhibition (balanced), hardware hotplug, ' +
    'async add, no duplicate, cleanup, unavailable API PASS.'
);
