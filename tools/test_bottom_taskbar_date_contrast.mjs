import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Native GNOME 50 Date/Clock is user-pinned pure white in Bottom Taskbar.
// It must never switch to dark text, even when the background is bright.
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
assert.equal(manager._targets.get(clock).kind, 'fixed-clock',
    'clock must not be subject to contrast sampling');
assert.deepEqual(manager._textActors(panel), [otherLabel],
    'whole-panel sampling must not overwrite local clock polarity');
assert.deepEqual(manager._textActors(clock), [clock],
    'clock is styled directly, not by reparenting or a duplicate label');

assert.ok(!manager._visibleEntries('surface')
    .some(entry => entry.actor === clock),
    'clock is excluded from adaptive screenshots');
assert.match(clock.style, /color: #ffffff;/,
    'clock is pure white immediately when Bottom Taskbar becomes active');

manager._applyRootPolarity(panel, false);
assert.match(otherLabel.style, /color: #f7f8fc;/);
assert.match(clock.style, /color: #ffffff;/,
    'whole-panel styling must not turn the clock dark');

// Simulate a different theme or an external restyle while taskbar is active.
clock.set_style('color: #000000;');
manager._scan(true);
assert.match(clock.style, /color: #ffffff;/,
    'next scan restores white even when an external theme sets black');
manager._applyRootPolarity(clock, true);
assert.match(clock.style, /color: #ffffff;/,
    'contrast decisions cannot turn the fixed clock black');

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

const css = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/runtime.css', import.meta.url
), 'utf8');
assert.match(css, /#panel\.vliq-bottom-taskbar #panelRight \.clock\s*\{\s*color:\s*#ffffff\s*!important;/,
    'Bottom Taskbar GNOME Date/Clock has an explicit white CSS fallback');

// Native DateMenuButton carries the clock-display class. Its background
// must remain clear in every pseudo-state; the neighboring Quick Settings
// button still owns the original rounded hover feedback.
for (const state of ['', ':hover', ':focus', ':active', ':checked']) {
    const selector = '#panel.vliq-bottom-taskbar #panelRight ' +
        '.panel-button.clock-display' + state;
    assert.ok(css.includes(selector),
        'Date/Clock transparent override covers ' + (state || 'idle'));
}

const dateClear = css.match(
    /\/\* Bottom Date\/Clock is text-only[\s\S]*?\{([^}]+)\}/
)?.[1] ?? '';
assert.match(dateClear, /background-color:\s*transparent\s*!important/,
    'Date hover never paints a center rounded card');
assert.match(dateClear, /box-shadow:\s*none\s*!important/,
    'Date hover no longer paints inset card outline');
assert.ok(css.includes('#panel.vliq-bottom-taskbar #panelRight .panel-button:hover'),
    'other native controls keep their hover styling');

console.log('Bottom Taskbar Date: pure white text on all backgrounds and native mode restoration PASS.');
