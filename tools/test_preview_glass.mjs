import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Run the *shipped* GJS glass manager with mock Clutter actors so lifecycle,
// laziness, geometry and teardown are verified without requiring a display.
const shellSource = (await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/shellCards.js', import.meta.url
), 'utf8')).replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');

let nextId = 1;
class Actor {
    constructor({style_class = '', name = ''} = {}) {
        this._classes = new Set(style_class.split(/\s+/).filter(Boolean));
        this._name = name;
        this._children = [];
        this._signals = new Map();
        this.parent = null;
        this.visible = true;
        this.mapped = false;
        this.opacity = 255;
        this.scale_x = 1;
        this.scale_y = 1;
        this.translation_x = 0;
        this.translation_y = 0;
        this.x = 0;
        this.y = 0;
        this.width = 1;
        this.height = 1;
        this._pivot = [0.5, 0.5];
    }
    get_name() {return this._name;}
    get_style_class_name() {return [...this._classes].join(' ');}
    add_style_class_name(name) {this._classes.add(name);}
    remove_style_class_name(name) {this._classes.delete(name);}
    get_parent() {return this.parent;}
    get_children() {return this._children.slice();}
    set_no_layout() {}
    set_clip_to_allocation() {}
    set_size(w, h) {this.width = w; this.height = h;}
    get_size() {return [this.width, this.height];}
    set_position(x, y) {this.x = x; this.y = y;}
    set_scale(x, y) {this.scale_x = x; this.scale_y = y;}
    set_pivot_point(x, y) {this._pivot = [x, y];}
    get_pivot_point() {return this._pivot;}
    get_transformed_position() {return [this.x, this.y];}
    get_transformed_size() {return [this.width, this.height];}
    get_allocation_box() {
        return {x1: this.x, y1: this.y, get_width: () => this.width,
            get_height: () => this.height};
    }
    get_paint_opacity() {return this.opacity;}
    set_opacity(value) {this.opacity = value;}
    add_child(child) {child.parent?.remove_child(child); child.parent = this;
        this._children.push(child);}
    remove_child(child) {
        this._children = this._children.filter(item => item !== child);
        if (child.parent === this) child.parent = null;
    }
    insert_child_below(child, target) {
        child.parent?.remove_child(child);
        const index = this._children.indexOf(target);
        if (index < 0) throw new Error('target is not attached');
        child.parent = this;
        this._children.splice(index, 0, child);
    }
    insert_child_at_index(child, index) {
        child.parent?.remove_child(child);
        child.parent = this;
        this._children.splice(index, 0, child);
    }
    add_effect(effect) {this.effect = effect;}
    queue_redraw() {}
    show() {this.visible = true;}
    hide() {this.visible = false;}
    ensure_style() {}
    get_theme_node() {return {get_border_radius: () => 16};}
    connect(signal, callback) {
        const id = nextId++;
        this._signals.set(id, {signal, callback});
        return id;
    }
    disconnect(id) {this._signals.delete(id);}
    emit(signal) {
        for (const {signal: registered, callback} of [...this._signals.values()])
            if (registered === signal) callback(this);
    }
    destroy() {
        this.emit('destroy');
        for (const child of this._children.slice()) child.destroy();
        this.parent?.remove_child(this);
        this._signals.clear();
    }
}
class MockEffect {
    constructor({owner}) {
        this.owner = owner;
        this.glassGeometry = null;
        this._shadersLoaded = false;
        this._pipelines = {composite: null};
        this.uniformValues = new Map();
        this._uniforms = {
            set: (name, value) => this.uniformValues.set(name, value),
        };
    }
    setPadding(value) {this.padding = value;}
    setShadowMaxRadius(value) {this.shadowMargin = value;}
    setIsDock(value) {this.isDock = value;}
    setSurfaceLightEnabled(enabled) {
        this.uniformValues.set('surface_light_enabled', enabled ? 1 : 0);
    }
    setLiveGeometryHook(callback) {this.geometryHook = callback;}
    setResolution(w, h) {this.resolution = [w, h];}
    setGlassGeometry(x, y, w, h) {this.glassGeometry = [x, y, w, h];}
}
class MockWindowClones {
    constructor() {MockWindowClones.created++;}
    setCullRect(rect) {this.cullRect = rect;}
    applyBgCloneClip(rect) {this.bgClip = rect;}
    sync() {this.syncCount = (this.syncCount ?? 0) + 1;}
    destroy() {MockWindowClones.destroyed++;}
}
MockWindowClones.created = 0;
MockWindowClones.destroyed = 0;
const vendor = {
    UnpickableActor: Actor,
    LiquidEffect: MockEffect,
    WindowCloneManager: MockWindowClones,
    root: '/fake-vliq-vendor',
    setPositionIfChanged: (actor, x, y) => actor.set_position(x, y),
    setSizeIfChanged: (actor, w, h) => actor.set_size(w, h),
    setTranslationIfChanged: (actor, x, y) => {
        actor.translation_x = x;
        actor.translation_y = y;
    },
};
let sceneUs = 1000000;
const stage = {
    width: 1920,
    height: 1080,
    _signals: new Map(),
    connect(name, handler) {
        const id = nextId++;
        this._signals.set(id, {name, handler});
        return id;
    },
    disconnect(id) {this._signals.delete(id);},
    update() {
        for (const {name, handler} of [...this._signals.values()])
            if (name === 'before-update') handler();
    },
};
const uiGroup = new Actor({name: 'uiGroup'});
const cardLayer = new Actor({name: 'vliq-layer'});
uiGroup.add_child(cardLayer);
const Manager = new Function(
    'Clutter', 'GLib', 'St', 'Main', 'global',
    'VLIQ_GLASS_ADAPTERS', 'VLIQ_GLASS_ROLES',
    'applyVLIQGlassRole', 'console',
    shellSource + '\nreturn ShellCardGlassManager;'
)(
    {BinLayout: class {}},
    {get_monotonic_time: () => sceneUs},
    {Widget: Actor, Bin: class {}, Corner: {
        TOPLEFT: 0, TOPRIGHT: 1, BOTTOMRIGHT: 2, BOTTOMLEFT: 3,
    }},
    {uiGroup},
    {stage},
    {shellCard: {inheritGlobalTint: true, inheritGlobalBlur: true,
        multiRegion: false}},
    {shellCard: {tintStrength: .026}},
    (effect, _role, appearance) => {effect.appearance = appearance;},
    {log() {}, error() {}, warn() {}}
);
const manager = new Manager({
    vendor,
    settings: {
        get_double: () => 1,
    },
    readAppearance: () => ({
        r: 255, g: 255, b: 255, opacity: 0.02,
        blur: 7, sceneFps: 24,
    }),
    manualOnly: true,
});
manager.setup();
assert.equal(manager._watched.size, 0, 'no global Shell actor scan');
assert.equal(stage._signals.size, 0, 'no idle compositor callback');
assert.equal(manager.attachPreview(new Actor({style_class: 'unrelated'})), false);

const makePreview = () => {
    const card = new Actor({style_class: 'vliq-app-preview-card'});
    card.set_position(235, 170);
    card.set_size(315, 196);
    cardLayer.add_child(card);
    return card;
};
const card = makePreview();
assert.equal(manager.attachPreview(card), true);
assert.equal(manager._surfaces.size, 1);
assert.equal(manager.attachPreview(card), true);
assert.equal(manager._surfaces.size, 1, 'no duplicate effect per card');
assert.equal(card._classes.has('vliq-liquid-shell-card'), true);
const surface = manager._surfaces.get(card);
assert.equal(surface._material.parent, card,
    'preview glass must belong to the native card, not its sibling');
assert.equal(card._children[0], surface._material,
    'refractive actor is FIRST child underneath live thumbnails');
assert.equal(cardLayer._children.includes(surface._material), false,
    'avoid stale sibling mapping/opacity and obscured preview glass');
assert.equal(surface._previewInTarget, true);
assert.equal(surface._material.scale_x, 1,
    'parent handles GNOME preview zoom without double scaling');
assert.equal(surface._effect.owner, 'vliq-shell-card');
assert.equal(surface._effect.appearance.cornerRadius, 16);
assert.equal(stage._signals.size, 0, 'unmapped card adds no frame loop');

card.mapped = true;
card.opacity = 150;
card.scale_x = 0.96;
card.scale_y = 0.96;
card.emit('notify::mapped');
assert.equal(stage._signals.size, 1, 'one visible preview frame callback');
sceneUs += 10000;
stage.update();
assert.equal(surface._material.opacity, 255,
    'glass inherits parent fade; does not square its opacity');
assert.equal(surface._material.scale_x, 1);
assert.equal(surface._material.scale_y, 1);
assert.equal(surface._material.translation_x, 0);
assert.equal(surface._material.translation_y, 0);
sceneUs += 100000;
stage.update();
assert.equal(surface._sceneManager !== null, true);
assert.equal(MockWindowClones.created, 1);
// GNOME maps the background material after its parent has been laid out.
// The actor mock has no compositor, so supply that mapping explicitly.
surface._material.mapped = true;
surface._effect.geometryHook();
assert.deepEqual(surface._effect.glassGeometry,
    [104, 104, 315, 196], 'bounded real glass, not fullscreen FBO');
assert.deepEqual(surface._effect.resolution, [523, 404]);

// Destruction of the native hover card releases the scene and the
// compositor frame signal without touching other GNOME native actors.
card.destroy();
assert.equal(manager._surfaces.size, 0);
assert.equal(stage._signals.size, 0);
assert.equal(MockWindowClones.destroyed, 1);

// A different window preview can attach after the first was destroyed.
const second = makePreview();
second.mapped = true;
assert.equal(manager.attachPreview(second), true);
assert.equal(manager._surfaces.size, 1);

manager.cleanup();
assert.equal(manager._surfaces.size, 0);
assert.equal(stage._signals.size, 0);
assert.equal(manager._watched.size, 0);

const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');
const previewBlock = css.match(/\.vliq-app-preview-card\s*\{([^}]*)\}/);
const liveBlock = css.match(/\.vliq-app-preview-card\.vliq-liquid-shell-card\s*\{([^}]*)\}/);
assert.ok(previewBlock && liveBlock);
assert.doesNotMatch(previewBlock[1], /rgba\(\s*8\s*,\s*9\s*,\s*12\s*,\s*0\.94/);
assert.match(previewBlock[1], /rgba\(232,\s*243,\s*255,\s*0\.18\)/);
// The preview owns exactly ONE visual material: the refractive LiquidEffect.
// Non-glass fallback is kept, but any loaded preview glass must not have its
// own white underlay or a duplicate hover/focus tint.
assert.match(liveBlock[1],
    /background-color:\s*transparent\s*!important\s*;/);
assert.doesNotMatch(liveBlock[1], /rgba\(/);
assert.match(liveBlock[1], /border-color:\s*transparent/);
const hoverCss = css.match(
    /\.vliq-window-preview-tile:hover,\s*\.vliq-window-preview-tile:focus\s*\{([^}]*)\}/
)?.[1];
assert.ok(hoverCss);
assert.match(hoverCss, /background-color:\s*transparent\s*;/);
assert.doesNotMatch(hoverCss, /rgba\(/);

const liquidCode = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/liquidGlassDock.js',
    import.meta.url
), 'utf8');
const genericFilterPos = liquidCode.indexOf(
    "' .vliq-liquid-shell-card {"
) >= 0
    ? liquidCode.indexOf("' .vliq-liquid-shell-card {")
    : liquidCode.indexOf("'.vliq-liquid-shell-card {");
const previewOverridePos = liquidCode.indexOf(
    "'.vliq-app-preview-card.vliq-liquid-shell-card {"
);
const panelPos = liquidCode.indexOf("'#panel.vliq-liquid-top-panel {");
assert.ok(
    genericFilterPos >= 0 &&
    previewOverridePos > genericFilterPos &&
    panelPos > previewOverridePos,
    'global filter must be overridden for preview AFTER the generic !important rule'
);
// Dynamic filter remains active for other cards and is not globally removed.
assert.match(liquidCode, /filterOpacity\.toFixed\(3\)/);

const orbSource = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/orbThemeRuntime.js', import.meta.url
), 'utf8');
assert.match(orbSource, /attachPreviewGlass\?\.\(card\)/);
console.log('Preview Liquid Glass-only material, no white/hover layers, scoped global CSS, lifecycle and fallback PASS.');
