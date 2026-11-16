import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const read=n=>readFile(new URL(n,root),'utf8');
const [src,gpu,native]=await Promise.all([
    'milkyPaint.js','liquidGlassDock.js','nativeCssIntegration.js',
].map(read));
assert.match(gpu,/_syncMilkyNativeActors\(state\)/);
assert.match(native,/_syncMilkyNativeActors\(state\)/);
const {MilkyActorPainter,milkyCardActors,milkyInlineStyle}=
    new Function(src.replace(/^export /gm,'')+
        '\nreturn {MilkyActorPainter,milkyCardActors,milkyInlineStyle};')();

const a=(style='',classes=[])=>({
    style,classes:new Set(classes),writes:0,
    get_style(){return this.style;},
    set_style(v){this.style=v;this.writes++;},
    has_style_class_name(v){return this.classes.has(v);},
});
const panel=a('height:36px;'),quick=a('padding:3px;'),date=a('padding:4px;'),
    left=a('', ['vliq-panel-island']),
    right=a('', ['vliq-panel-island']),
    center=a('', ['vliq-panel-island','vliq-panel-island-inactive']);
panel._leftBox=left;panel._centerBox=center;panel._rightBox=right;
panel.statusArea={quickSettings:{menu:{box:quick}},dateMenu:{menu:{box:date}}};
const painter=new MilkyActorPainter(),selected={milky:true},layout={_layoutMode:'bottom'};
const paint=state=>painter.sync(milkyCardActors(panel,layout,state),state);
paint(selected);
assert.match(panel.style,/rgba\(0,0,0,0\.600\)/);
assert.match(quick.style,/rgba\(245,249,255,0\.920\)/);
assert.match(date.style,/rgba\(245,249,255,0\.920\)/);
assert.match(quick.style,/rgba\(255,255,255,0\.200\)/);
assert.ok(panel.style.startsWith('height:36px;'));
assert.ok(quick.style.startsWith('padding:3px;'));
const before=panel.writes;
paint({...selected,milkyOpacity:.99,milkyBlack:false,milkyGrain:1});
assert.equal(panel.writes,before,
    'legacy Milky sliders never change fixed hardcoded paint');

layout._layoutMode='split';paint(selected);
assert.equal(panel.style,'height:36px;');
assert.match(left.style,/rgba\(0,0,0,0\.600\)/);
assert.match(right.style,/rgba\(0,0,0,0\.600\)/);
assert.equal(center.style,'');
layout._layoutMode='full';paint(selected);
assert.match(panel.style,/rgba\(0,0,0,0\.600\)/);
assert.equal(left.style,'');assert.equal(right.style,'');
layout._layoutMode='bottom';paint({...selected,systemDarkTaskbar:true});
assert.match(panel.style,/rgba\(0,0,0,0\.600\)/,
    'native Dark Style must not override fixed Black 60%');
assert.match(quick.style,/rgba\(245,249,255,0\.920\)/,
    'Quick/Calendar remain Milky White in Dark Style');
painter.sync([],{milky:false});
assert.equal(panel.style,'height:36px;');
assert.equal(quick.style,'padding:3px;');
assert.equal(date.style,'padding:4px;');
assert.equal(left.style,'');assert.equal(right.style,'');
paint(selected);
quick.style='background-color: orange;';
painter.clear();
assert.equal(quick.style,'background-color: orange;',
    'newer third-party style owners are never overwritten by cleanup');
assert.equal(panel.style,'height:36px;');
assert.match(milkyInlineStyle({},'header'),/rgba\(0,0,0,0\.600\)/);
assert.match(milkyInlineStyle({},'popup'),/rgba\(245,249,255,0\.920\)/);
console.log('Fixed Milky native actor paint: roles, header mode transitions, Dark Style and reversible originals PASS.');
