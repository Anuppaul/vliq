import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Test the actual shipped Adwaita ComboRow -> VLIQ GSettings handler.
// The old guard "headerLayout.selected < 2" accidentally rejected the
// third "Bottom Taskbar" option (index 2) even though it was displayed.
const prefSource = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/prefs.js', import.meta.url
), 'utf8');
const schema = await readFile(new URL(
    '../gnome-shell/vliq@wonderer.tech/schemas/org.gnome.shell.extensions.vliq.gschema.xml',
    import.meta.url
), 'utf8');
const begin = prefSource.indexOf('const headerLayoutValues =');
const endMarker = 'topHeader.add(headerLayout);';
const end = prefSource.indexOf(endMarker, begin);
assert.ok(begin > 0 && end > begin, 'layout settings handler exists');
const handler = prefSource.slice(begin, end + endMarker.length);
assert.match(prefSource, /'3-Part Header'[\s\S]*'Full Header'[\s\S]*'Bottom Taskbar'/,
    'Adwaita ComboRow exposes all three modes');
assert.match(schema, /<choice value="bottom"\s*\/>/,
    'third mode is accepted by VLIQ GSettings schema');
assert.match(handler, /headerLayout\.selected < headerLayoutValues\.length/,
    'all available modes must share one bounds check');

function harness(initial = 'split') {
    const callbacks = new Map();
    const settings = {
        state: initial,
        writes: [],
        get_string(key) {
            assert.equal(key, 'top-header-layout');
            return this.state;
        },
        set_string(key, value) {
            assert.equal(key, 'top-header-layout');
            this.writes.push(value);
            this.state = value;
            callbacks.get('changed::' + key)?.();
        },
        connect(signal, cb) {callbacks.set(signal, cb);return 1;},
    };
    const row = {
        _selected: -1,
        callback: null,
        get selected() {return this._selected;},
        set selected(value) {
            this._selected = value;
            this.callback?.();
        },
        connect(name, callback) {
            assert.equal(name, 'notify::selected');
            this.callback = callback;
        },
    };
    const group = {add(item) {assert.equal(item, row);}};
    const getHooks = new Function('settings', 'headerLayout', 'topHeader',
        handler + '\nreturn {syncHeaderLayout, headerLayoutValues};');
    const h = getHooks(settings, row, group);
    return {row, settings, hooks: h};
}

const ui = harness();
assert.deepEqual(ui.hooks.headerLayoutValues, ['split', 'full', 'bottom']);
assert.equal(ui.row.selected, 0);
ui.row.selected = 1;
assert.deepEqual(ui.settings.writes, ['full']);
ui.row.selected = 2;
assert.equal(ui.settings.state, 'bottom',
    'clicking the third selector MUST persist Bottom Taskbar');
assert.deepEqual(ui.settings.writes, ['full', 'bottom'],
    'bidirectional binding must never duplicate writes');
assert.equal(ui.row.selected, 2);
ui.row.selected = 99;
assert.equal(ui.settings.writes.length, 2,
    'invalid selection must not damage stored layout');

const reopened = harness('bottom');
assert.equal(reopened.row.selected, 2,
    'Preferences must reopen showing the currently active bottom layout');
assert.equal(reopened.settings.writes.length, 0,
    'initial selection sync does not write to GSettings');
reopened.settings.set_string('top-header-layout', 'split');
assert.equal(reopened.row.selected, 0,
    'external gsettings changes should update the ComboRow');
reopened.settings.set_string('top-header-layout', 'bottom');
assert.equal(reopened.row.selected, 2,
    'external CLI selection should update the ComboRow');
assert.equal(reopened.settings.writes.length, 2);

console.log('Desktop Layout Preferences: split/full/bottom selection and live GSettings binding PASS.');
