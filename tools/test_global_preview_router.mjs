import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = '../gnome-shell/vliq@wonderer.tech/';
const runtime = await readFile(new URL(root + 'orbThemeRuntime.js', import.meta.url), 'utf8');
const preview = await readFile(new URL(root + 'bottomTaskbarPreview.js', import.meta.url), 'utf8');
const taskbar = await readFile(new URL(root + 'bottomTaskbar.js', import.meta.url), 'utf8');

function extract(start, end) {
    const i = runtime.indexOf('    ' + start);
    const j = runtime.indexOf('    ' + end, i + start.length);
    assert.ok(i >= 0 && j > i, 'missing runtime method ' + start);
    return runtime.slice(i, j).trim();
}
const methods = new Function('return ({' + [
    extract('_globalPreviewItem(app, anchorActor, preferredSide) {', '_showAppPreview('),
    extract('_showAppPreview(app, anchorActor, preferredSide = null) {', '_createWindowPreviewTile('),
    extract('_scheduleAppPreviewHide(anchorActor = null) {', '_cancelAppPreviewHide()'),
    extract('_cancelAppPreviewHide() {', '_hideAppPreview('),
].join(',\n') + '});')();

const events = [];
const manager = {
    onButtonHover(item, hovering) {events.push({item, hovering});},
    close() {events.push({close: true});},
};
const app = {get_windows: () => [{
    skip_taskbar: false, get_compositor_private: () => ({})
}]};
const stoppedApp = {get_windows: () => []};
const dock = {get_parent: () => ({}), visible: true};
const another = {get_parent: () => ({}), visible: true};
const host = {
    ...methods, _globalWindowPreview: manager,
    _globalPreviewItems: new WeakMap(), _globalPreviewAnchor: null,
};
assert.equal(host._showAppPreview(app, dock, 'right'), true);
assert.equal(events[0].item.button, dock);
assert.equal(events[0].item.app, app);
assert.equal(events[0].item.side, 'right');
assert.equal(events[0].hovering, true);
host._showAppPreview(app, dock, 'right');
assert.equal(events[1].item, events[0].item, 'stable identity');
host._showAppPreview(app, another, 'left');
assert.equal(events[2].item.button, another);
host._scheduleAppPreviewHide(dock);
assert.equal(events.length, 3, 'late leave cannot dismiss new preview');
host._scheduleAppPreviewHide(another);
assert.equal(events.at(-1).hovering, false);
assert.equal(events.at(-1).item, events[2].item);
assert.equal(host._showAppPreview(stoppedApp, dock, 'top'), false);
assert.equal(events.at(-1).close, true);
assert.equal(host._globalPreviewAnchor, null);

assert.match(runtime, /import \{BottomTaskbarPreview\} from '\.\/bottomTaskbarPreview\.js'/);
assert.match(runtime, /new BottomTaskbarPreview\(\{\s*layout: Main\.layoutManager/);
assert.match(runtime, /this\._globalWindowPreview\.onButtonHover\(item, true\)/);
assert.match(runtime, /this\._globalWindowPreview\.onButtonHover\(item, false\)/);
assert.match(runtime, /this\._globalWindowPreview\?\.destroy\?\.\(\)/);
assert.match(taskbar, /new BottomTaskbarPreview\(\{/);
assert.match(preview, /new Clutter\.Clone\(\{/);
assert.match(preview, /this\._activateWindow\(window\)/);
assert.match(preview, /window\.delete\(global\.get_current_time/);
assert.match(preview, /this\._monitorForItem\(item\)/);
assert.match(preview, /const placements = \{/);
assert.doesNotMatch(preview, /new LiquidEffect|\.screenshot\(|before-update/);
console.log('Global native live previews: Orb and Ubuntu Dock reuse Bottom Taskbar component PASS.');
