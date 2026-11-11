import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Native GNOME 50 date clock must follow the BACKDROP beneath its button,
// not the average luminance of a full-width Windows-style bottom taskbar.
// Exercise the real adaptive-text class without requiring a compositor.
const source = (await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/sharedAdaptiveText.js',
    import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+/gm, '');

let monotonic = 1_000_000;
const GLib = {get_monotonic_time: () => ++monotonic};
class Actor {
    constructor({name = '', classes = '', rect = [0, 0, 100, 40]} = {}) {
        this.name = name;
        this.classes = new Set(classes.split(' ').filter(Boolean));
        this.rect = rect;
        this.visible = true;
        this.mapped = true;
        this.opacity = 255;
        this.style = null;
        this.children = [];
        this.parent = null;
    }
    add_child(actor) {this.children.push(actor); actor.parent = this;}
    get_children() {return this.children;}
    get_parent() {return this.parent;}
    get_name() {return this.name;}
    get_style_class_name() {return [...this.classes].join(' ');}
    add_style_class_name(name) {this.classes.add(name);}
    remove_style_class_name(name) {this.classes.delete(name);}
    get_style() {return this.style;}
    set_style(style) {this.style = style;}
    get_paint_opacity() {return 255;}
    connect() {return 1;}
    has_style_pseudo_class() {return false;}
}
class Label extends Actor {}
class Entry extends Actor {}
const St = {Label, Entry};
const panel = new Actor({
    name: 'panel', classes: 'vliq-bottom-taskbar',
    rect: [0, 1040, 1920, 40],
});
const otherLabel = new Label({
    classes: 'native-indicator-label',
    rect: [20, 1046, 90, 22],
});
const right = new Actor();
const dateButton = new Actor({
    classes: 'panel-button clock-display',
    rect: [1670, 1040, 175, 40],
});
const clock = new Label({
    classes: 'clock', rect: [1685, 1046, 142, 22],
});
panel.add_child(otherLabel);
panel.add_child(right);
right.add_child(dateButton);
dateButton.add_child(clock);
const uiGroup = new Actor();
uiGroup.add_child(panel);
const Main = {
    panel,
    uiGroup,
};
panel.statusArea = {
    dateMenu: {
        _clockDisplay: clock,
        label_actor: clock,
        container: dateButton,
    },
};
const vendor = {getTransformedRect: actor => actor.rect};
const SharedAdaptiveTextManager = new Function(
    'GLib', 'St', 'Main', 'GLASS_TEXT_PALETTE', 'console',
    source + '\nreturn SharedAdaptiveTextManager;'
)(GLib, St, Main,
    {light: '#f7f8fc', dark: '#17191f'}, console);

const manager = new SharedAdaptiveTextManager({vendor});
manager._enabled = true;
manager._scan(true);
assert.ok(manager._targets.has(panel), 'native panel stays a target');
assert.ok(manager._targets.has(clock), 'right-hand native clock has local target');
assert.equal(manager._targets.get(clock).kind, 'surface',
    'clock reuses existing surface screenshot cadence');
assert.deepEqual(manager._textActors(panel), [otherLabel],
    'whole-panel sampling must not overwrite local clock polarity');
assert.deepEqual(manager._textActors(clock), [clock],
    'clock is styled directly, not by reparenting or a duplicate label');

const dateEntry = manager._visibleEntries('surface')
    .find(entry => entry.actor === clock);
assert.deepEqual(dateEntry.rect, dateButton.rect,
    'sample the padded button glass, not coloured clock glyphs');
manager._applyRootPolarity(panel, false);
assert.match(otherLabel.style, /color: #f7f8fc;/);
assert.equal(clock.style, null,
    'panel pass must not change the date label');

let useDarkText = manager._chooseDarkText(clock, 0.92);
assert.equal(useDarkText, true, 'white glass requires dark clock text');
manager._targets.get(clock).useDarkText = useDarkText;
manager._applyRootPolarity(clock, useDarkText);
assert.match(clock.style, /color: #17191f;/);
assert.ok(clock.classes.has('vliq-shared-text-dark'));

useDarkText = manager._chooseDarkText(clock, 0.015);
assert.equal(useDarkText, false, 'dark wallpaper requires white clock text');
manager._targets.get(clock).useDarkText = useDarkText;
manager._applyRootPolarity(clock, useDarkText);
assert.match(clock.style, /color: #f7f8fc;/);
assert.ok(clock.classes.has('vliq-shared-text-light'));
assert.ok(!clock.classes.has('vliq-shared-text-dark'));

// Switching back to 3-Part/Full must release local ownership and restore
// the original style; the normal panel polarity then owns the date again.
panel.classes.delete('vliq-bottom-taskbar');
manager._scan(true);
assert.ok(!manager._targets.has(clock));
assert.equal(clock.style, null,
    'leaving Bottom mode restores original GNOME clock style');
assert.ok(!clock.classes.has('vliq-shared-text-light'));
assert.deepEqual(manager._textActors(panel), [otherLabel, clock]);
manager._applyRootPolarity(panel, true);
assert.match(clock.style, /color: #17191f;/,
    'normal header returns to full-panel adaptive text');
manager.cleanup();

console.log('Bottom Taskbar Date: local white/dark glass contrast, native button sampling, and mode restoration PASS.');
