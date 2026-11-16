import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Superpowers TDD: this test must fail against the prior stylesheet-only
// Milky implementation, and pass only when real St.Widget inline styles are
// synchronized from canonical GSettings in both rendering backends.
const base = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const [paintSrc, gpuSrc, nativeSrc, topbarSrc] = await Promise.all([
    'milkyPaint.js', 'liquidGlassDock.js', 'nativeCssIntegration.js',
    'topBarIslands.js',
].map(name => readFile(new URL(name, base), 'utf8')));
assert.match(paintSrc, /export class MilkyActorPainter/,
    'an actor-level style updater is required instead of relying only on theme reloads');
assert.match(gpuSrc, /_syncMilkyNativeActors\(state\)/,
    'GPU renderer must apply the same paint to actual GNOME actors');
assert.match(nativeSrc, /_syncMilkyNativeActors\(state\)/,
    'shader-free renderer must directly style actual GNOME actors');
assert.match(topbarSrc, /_onLayoutChanged/,
    'panel layout transitions must be considered when choosing paint owners');

const {MilkyActorPainter, milkyInlineStyle, milkyCardActors} =
    new Function(paintSrc.replace(/^export /gm, '') +
        '\nreturn {MilkyActorPainter, milkyInlineStyle, milkyCardActors};')();

function actor(original = '', classes = []) {
    const entries = new Set(classes);
    return {
        inlineStyle: original, writes: 0,
        get_style() {return this.inlineStyle;},
        set_style(next) {this.inlineStyle = next;this.writes++;},
        has_style_class_name(name) {return entries.has(name);},
        add_style_class_name(name) {entries.add(name);},
    };
}
const panel = actor('height: 36px;');
const quick = actor('padding: 4px;');
const date = actor();
const left = actor('', ['vliq-panel-island']);
const center = actor('', ['vliq-panel-island', 'vliq-panel-island-inactive']);
const right = actor('', ['vliq-panel-island']);
const ctx = {panel: Object.assign(panel, {
    _leftBox: left, _centerBox: center, _rightBox: right,
    statusArea: {quickSettings: {menu: {box: quick}},
        dateMenu: {menu: {box: date}}},
})};
const baseState = {milky: true, milkyOpacity: .72,
    milkyWhiteness: .8, milkyBorder: .26, milkyGrain: .59,
    systemDarkTaskbar: false};
const painter = new MilkyActorPainter();
const mode = { _layoutMode: 'bottom' };
const actors = milkyCardActors(ctx.panel, mode, baseState);
painter.sync(actors, baseState);
assert.match(panel.get_style(), /background-color:\s*rgba\(253,254,255,0\.944\)/);
assert.match(panel.get_style(), /rgba\(255,255,255,0\.260\)/);
assert.match(quick.get_style(), /rgba\(253,254,255,0\.944\)/);
assert.match(date.get_style(), /rgba\(253,254,255,0\.944\)/);
assert.ok(panel.get_style().startsWith('height: 36px;'),
    'must retain pre-existing inline layout CSS');
assert.ok(quick.get_style().startsWith('padding: 4px;'),
    'must retain native Quick Settings layout CSS');
const oldWrites=panel.writes;
painter.sync(milkyCardActors(ctx.panel,mode,baseState),baseState);
assert.equal(panel.writes,oldWrites,
    'same saved values must not trigger redundant native style writes');
const solid={...baseState,milkyWhiteness:1,milkyOpacity:0};
painter.sync(milkyCardActors(ctx.panel,mode,solid),solid);
assert.match(panel.get_style(), /background-color:\s*rgba\(255,255,255,1\.000\)/);
assert.match(quick.get_style(), /rgba\(255,255,255,1\.000\)/);
const transparent={...baseState,milkyWhiteness:0,milkyOpacity:0,milkyBorder:0};
painter.sync(milkyCardActors(ctx.panel,mode,transparent),transparent);
assert.match(panel.get_style(), /rgba\(245,249,255,0\.000\)/);
assert.match(panel.get_style(), /box-shadow:\s*none/);

// When switching from Bottom to 3-Part the parent bar must become
// transparent again; only live non-inactive native islands remain Milky.
mode._layoutMode='split';
painter.sync(milkyCardActors(ctx.panel,mode,baseState),baseState);
assert.equal(panel.get_style(),'height: 36px;');
assert.match(left.get_style(), /rgba\(253,254,255,0\.944\)/);
assert.match(right.get_style(), /rgba\(253,254,255,0\.944\)/);
assert.equal(center.get_style(),'',
    'inactive island must not be revived by inline styling');

mode._layoutMode='bottom';
const nativeDark={...baseState,systemDarkTaskbar:true};
painter.sync(milkyCardActors(ctx.panel,mode,nativeDark),nativeDark);
assert.equal(panel.get_style(),'height: 36px;',
    'GNOME Dark Style continues to own the Bottom Taskbar');
assert.match(quick.get_style(), /rgba\(253,254,255,0\.944\)/,
    'the dark taskbar must not force the Milky popup dark');
painter.sync([], {...baseState,milky:false});
assert.equal(panel.get_style(),'height: 36px;');
assert.equal(quick.get_style(),'padding: 4px;');
assert.equal(date.get_style(),'');
assert.equal(left.get_style(),'');
assert.equal(right.get_style(),'');

// Another extension may replace native styling; restoring VLIQ must not
// wipe out that newer owner's writes.
painter.sync(milkyCardActors(ctx.panel,mode,baseState),baseState);
quick.inlineStyle='background-color: red;';
painter.clear();
assert.equal(quick.get_style(),'background-color: red;');
assert.equal(panel.get_style(),'height: 36px;');
assert.match(milkyInlineStyle(baseState), /rgba\(253,254,255,0\.944\)/);
console.log('Milky native actors: GPU + CSS bindings, inline painting, same-value no-op, layout, restore and Dark Style PASS.');
