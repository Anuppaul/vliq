import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Real GNOME 50 BottomTaskbarPreview implementation under test with mock
// native Meta.WindowActors / Clutter.Clones. No screenshots, duplicate Dock
// actors, idle compositor hooks, or fake window representations.
const source = (await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/bottomTaskbarPreview.js',
    import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');

let nextId = 0;
const timers = new Map();
const glib = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: 0,
    timeout_add(_priority, ms, callback) {
        const id = ++nextId;
        timers.set(id, {ms, callback});
        return id;
    },
    source_remove(id) {return timers.delete(id);},
};
function tick(ms) {
    const pending = [...timers];
    for (const [id, entry] of pending) {
        if (entry.ms <= ms && timers.has(id)) {
            timers.delete(id);
            entry.callback();
        }
    }
}
class Actor {
    constructor(properties = {}) {
        Object.assign(this, properties);
        this.children = [];
        this.parent = null;
        this.visible = true;
        this.mapped = true;
        this.hover = false;
        this.opacity = 255;
        this.width = properties.width ?? 36;
        this.height = properties.height ?? 40;
        this.x = properties.x ?? 0;
        this.y = properties.y ?? 0;
        this.handlers = new Map();
    }
    add_child(actor) {
        actor.parent?.remove_child(actor);
        this.children.push(actor);
        actor.parent = this;
    }
    remove_child(actor) {
        this.children = this.children.filter(x => x !== actor);
        if (actor.parent === this)
            actor.parent = null;
    }
    get_children() {return this.children;}
    get_parent() {return this.parent;}
    connect(signal, cb) {
        const id = ++nextId;
        this.handlers.set(id, {signal, cb});
        return id;
    }
    emit(signal) {
        for (const event of [...this.handlers.values()]) {
            if (event.signal === signal)
                event.cb();
        }
    }
    get_hover() {return this.hover;}
    set_hover(hover) {this.hover = hover;this.emit('notify::hover');}
    get_transformed_position() {return [this.x, this.y];}
    get_preferred_width() {
        return [0, this.children.length * 224 + 20];
    }
    get_preferred_height() {return [0, 178];}
    set_position(x, y) {this.x = x; this.y = y;}
    destroy() {
        this.parent?.remove_child(this);
        for (const child of [...this.children])
            child.destroy?.();
        this.destroyed = true;
    }
}
class Button extends Actor {
    constructor(properties) {super(properties);if (properties.child) this.add_child(properties.child);}
}
class Label extends Actor {
    constructor(properties) {
        super(properties);
        this.clutter_text = {};
    }
}
const sources = [];
class Clone extends Actor {
    constructor(properties) {
        super(properties);
        sources.push(properties.source);
    }
}
const Clutter = {
    Clone, BinLayout: class {},
    ActorAlign: {CENTER: 1},
};
const St = {Widget: Actor, BoxLayout: Actor, Button, Icon: Actor, Label};
const Pango = {EllipsizeMode: {END: 3}};
const uiGroup = new Actor({width: 1920, height: 1080});
const panelBox = new Actor({x: 0, y: 1036, width: 1920, height: 44});
let chromeAdds = 0, chromeRemoves = 0;
const layout = {
    uiGroup, panelBox,
    primaryMonitor: {x: 0, y: 0, width: 1920, height: 1080},
    addTopChrome(actor, settings) {
        assert.equal(settings.affectsStruts, false);
        assert.equal(settings.trackFullscreen, false);
        uiGroup.add_child(actor);
        chromeAdds++;
    },
    removeChrome(actor) {
        uiGroup.remove_child(actor);
        chromeRemoves++;
    },
};
let focusCount = 0;
const Main = {
    layoutManager: layout,
    activateWindow(window) {focusCount++;window.focused = true;},
};
const BottomTaskbarPreview = new Function(
    'Clutter','GLib','Pango','St','Main','global','console',
    source + '\nreturn BottomTaskbarPreview;'
)(Clutter,glib,Pango,St,Main,
    {stage: uiGroup, get_current_time: () => 123}, console);

function makeWindow(name, width = 1280, height = 720) {
    const actor = new Actor({width, height});
    const window = {
        title: name, actor, minimized: false, deleted: 0,
        get_compositor_private() {return actor;},
        get_frame_rect() {return {width, height};},
        get_title() {return name;},
        unminimize() {this.minimized = false;},
        delete() {this.deleted++;},
    };
    return window;
}
const windows = [makeWindow('Editor'), makeWindow('Terminal')];
const app = {get_id: () => 'example.desktop',
    get_name: () => 'Example', get_windows: () => windows};
const button = new Button({x: 950, y: 1036, width: 44});
uiGroup.add_child(button);
const item = {app, button};
const preview = new BottomTaskbarPreview({layout});

// Sustained hover lazily creates live clones above Bottom Taskbar.
preview.onButtonHover(item, true);
assert.equal(chromeAdds, 0, 'no heavy preview before hover delay');
assert.equal(timers.size, 1);
tick(200);
assert.equal(chromeAdds, 0, 'no early window-preview paint');
tick(260);
assert.equal(chromeAdds, 1);
assert.ok(preview._popup, 'preview popup appears after sustained hover');
assert.equal(preview._popup.get_children().length, 2);
assert.deepEqual(sources, windows.map(w => w.actor),
    'clone sources are real native Meta.WindowActors');
assert.ok(preview._popup.y + 178 < panelBox.y,
    'previews are placed ABOVE the taskbar');
assert.equal(windows[0].actor.visible, true,
    'native window actors are never hidden or reparented');

// Repeated hover on the same app does not rebuild thumbnail textures.
const popup = preview._popup;
preview.onButtonHover(item, true);
assert.equal(preview._popup, popup);
assert.equal(chromeAdds, 1);

// Pointer moves from icon to preview: grace period must avoid a blink.
preview.onButtonHover(item, false);
preview._popup.set_hover(true);
tick(500);
assert.equal(preview._popup, popup,
    'moving pointer onto preview does not dismiss it');
preview._popup.set_hover(false);
tick(260);
assert.equal(preview._popup, null);
assert.equal(chromeRemoves, 1);
assert.equal(timers.size, 0);

// Click a thumbnail focuses the real Meta.Window and closes the popup.
preview.onButtonHover(item, true);
tick(260);
const tiles = preview._popup.get_children();
tiles[1].get_children()[0].emit('clicked');
assert.equal(focusCount, 1);
assert.equal(windows[1].focused, true);
assert.equal(preview._popup, null);

// Closing from the thumbnail must call Meta.Window.delete only, not focus.
preview.onButtonHover(item, true);
tick(260);
const closeTile = preview._popup.get_children()[0];
const activateButton = closeTile.get_children()[0];
const close = closeTile.get_children()[1];
assert.notEqual(activateButton, close,
    'close and activate must be sibling buttons, never nested click targets');
close.emit('clicked');
assert.equal(windows[0].deleted, 1);
assert.equal(focusCount, 1);
assert.equal(preview._popup, null);

// Leaving before hover delay must cancel all scheduled paint.
preview.onButtonHover(item, true);
preview.onButtonHover(item, false);
tick(500);
assert.equal(preview._popup, null);
assert.equal(timers.size, 0);

// App removal or mode exit closes and untracks the preview.
preview.onButtonHover(item, true);
tick(260);
preview.closeForItem(item);
assert.equal(preview._popup, null);
preview.onButtonHover(item, true);
preview.destroy();
tick(1000);
assert.equal(preview._popup, null);
assert.equal(timers.size, 0);
assert.equal(chromeAdds, chromeRemoves,
    'all tracked preview actors are removed after cleanup');
assert.equal(uiGroup.get_children().length, 1,
    'native panel/app icon actors are never removed by preview cleanup');

// Window actors may disappear between get_windows and thumbnail creation
// while an app exits. That cannot crash a Shell hover callback.
const disposed = makeWindow('closing');
let compositorReads = 0;
disposed.get_compositor_private = () =>
    ++compositorReads === 1 ? disposed.actor : null;
windows.push(disposed);
const race = new BottomTaskbarPreview({layout});
race.onButtonHover(item, true);
tick(260);
assert.ok(race._popup, 'other live previews survive one stale window');
assert.equal(race._popup.get_children().length, 2,
    'destroyed Meta.WindowActor does not create a ghost thumbnail');
race.destroy();
windows.pop();
assert.equal(chromeAdds, chromeRemoves);

// On narrower monitors, a multiwindow application is safely bounded.
layout.primaryMonitor = {x: 0, y: 0, width: 480, height: 900};
panelBox.y = 856;
const narrow = new BottomTaskbarPreview({layout});
narrow.onButtonHover(item, true);
tick(260);
assert.equal(narrow._popup.get_children().length, 2,
    'one native thumbnail and an overflow count on narrow monitors');
assert.ok(narrow._popup.x >= 8);
narrow.destroy();
assert.equal(chromeAdds, chromeRemoves);

const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');
assert.ok(css.includes('.vliq-taskbar-window-previews'),
    'native preview popup has dedicated styling');
assert.ok(css.includes('.vliq-taskbar-preview-tile:hover'));

const installer = await readFile(new URL(
    '../gnome-shell/install.sh', import.meta.url
), 'utf8');
assert.ok(installer.includes('"bottomTaskbarPreview.js"'),
    'new runtime module must be shipped by hot installer/Store packaging');

console.log('Bottom Taskbar live previews: native clones, hover grace, window focus/close, cleanup, narrow monitor PASS.');
