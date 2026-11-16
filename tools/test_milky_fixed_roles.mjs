import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Fails on adjustable Milky; passes only when scoped materials are fixed.
const root=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');
const [paintSource,prefs,gpu,native,css]=await Promise.all([
    'milkyPaint.js','prefs.js','liquidGlassDock.js',
    'nativeCssIntegration.js','runtime.css',
].map(read));
const paint=new Function(paintSource.replace(/^export /gm,'')+
    '\nreturn {milkyPaintTokens,buildMilkyAppearanceCss,'+
    'milkyInlineStyle,milkyCardActors,MilkyActorPainter};')();
const {milkyPaintTokens,buildMilkyAppearanceCss,milkyInlineStyle,
    milkyCardActors,MilkyActorPainter}=paint;

const black=milkyPaintTokens('header');
const white=milkyPaintTokens('popup');
assert.equal(black.fill,'rgba(0,0,0,0.600)');
assert.equal(black.rim,'none');
assert.equal(white.fill,'rgba(245,249,255,0.920)');
assert.match(white.rim,/rgba\(255,255,255,0\.200\)/);
assert.match(milkyInlineStyle({},'header'),/rgba\(0,0,0,0\.600\)/);
assert.match(milkyInlineStyle({},'popup'),/rgba\(245,249,255,0\.920\)/);

for(const state of [
    {milkyOpacity:0,milkyBlack:false,milkyGrain:1,milkyBorder:1},
    {milkyOpacity:1,milkyBlack:true,milkyGrain:0,milkyBorder:0},
]){
    assert.equal(milkyPaintTokens('header',state).fill,black.fill);
    assert.equal(milkyPaintTokens('popup',state).fill,white.fill);
}
const generated=buildMilkyAppearanceCss({milky:true},'file:///unused-grain.svg');
assert.match(generated,/rgba\(0,0,0,0\.600\)/);
assert.match(generated,/rgba\(245,249,255,0\.920\)/);
assert.doesNotMatch(generated,/url\(|background-repeat:\s*repeat/);
// Headers remain black, while every other Liquid Glass target adopts
// the same fixed white material. No additional actor is constructed.
for(const target of [
    '.vliq-native-notification-glass',
    '.vliq-orb-face-v2','.vliq-app-button','.vliq-app-preview-card',
    '.vliq-spotlight-glass-results','.vliq-ubuntu-dock-glass-background',
    '.vliq-milky-osd','#overviewGroup .window-close',
]){
    assert.ok(generated.includes(target),
        'existing Liquid target missing Milky White: '+target);
}
for(const target of [
    '.vliq-global-milky .vliq-native-notification-glass',
    '.vliq-global-milky .vliq-orb-face-v2',
    '.vliq-global-milky .dash-background',
]){
    assert.ok(css.includes(target),
        'static CSS must cover existing Liquid surface: '+target);
}
assert.match(css,/rgba\(0,\s*0,\s*0,\s*0\.60\)/);
assert.match(css,/rgba\(245,\s*249,\s*255,\s*0\.92\)/);
assert.doesNotMatch(gpu,/buildMilkyGrainSvg\(/);
assert.doesNotMatch(native,/buildMilkyGrainSvg\(/);
assert.doesNotMatch(native,/'milky-grain'/);

const controls=prefs.slice(prefs.indexOf("title: 'Glass Material'"),
    prefs.indexOf("title: 'Liquid Glass Controls'"));
assert.match(controls,/Milky Glass/,'material picker stays');
assert.doesNotMatch(controls,/addIntSpin\(milky|addSwitch\(milky/,
    'remove Milky-specific preference controls');
assert.doesNotMatch(controls,
    /new Adw\.PreferencesGroup\(\{\s*title: 'Milky Glass'/,
    'remove Milky settings group');

function actor(original='',classes=[]){
    const set=new Set(classes);
    return {
        style:original,get_style(){return this.style;},
        set_style(x){this.style=x;},
        has_style_class_name(x){return set.has(x);},
    };
}
const panel=actor('height:36px;'),quick=actor('padding:3px;'),
    date=actor('margin:2px;'),left=actor('', ['vliq-panel-island']),
    center=actor('', ['vliq-panel-island','vliq-panel-island-inactive']),
    right=actor('', ['vliq-panel-island']);
panel._leftBox=left;panel._centerBox=center;panel._rightBox=right;
panel.statusArea={quickSettings:{menu:{box:quick}},dateMenu:{menu:{box:date}}};
const painter=new MilkyActorPainter(),state={milky:true},
    mode={_layoutMode:'bottom'};
painter.sync(milkyCardActors(panel,mode,state),state);
assert.match(panel.style,/rgba\(0,0,0,0\.600\)/);
assert.match(quick.style,/rgba\(245,249,255,0\.920\)/);
assert.match(date.style,/rgba\(245,249,255,0\.920\)/);
assert.ok(quick.style.startsWith('padding:3px;'));
mode._layoutMode='split';
painter.sync(milkyCardActors(panel,mode,state),state);
assert.equal(panel.style,'height:36px;');
assert.match(left.style,/rgba\(0,0,0,0\.600\)/);
assert.equal(center.style,'');
assert.match(right.style,/rgba\(0,0,0,0\.600\)/);
mode._layoutMode='bottom';
painter.sync(milkyCardActors(panel,mode,{...state,systemDarkTaskbar:true}),
    {...state,systemDarkTaskbar:true});
assert.match(panel.style,/rgba\(0,0,0,0\.600\)/);
painter.clear();
assert.equal(panel.style,'height:36px;');
assert.equal(quick.style,'padding:3px;');
assert.equal(date.style,'margin:2px;');
assert.equal(left.style,'');assert.equal(right.style,'');
console.log('Milky fixed roles: 60% black headers and all Liquid surfaces white, no controls or grain PASS.');
