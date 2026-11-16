import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const read=f=>readFile(new URL(f,base),'utf8');
const [paint,prefs,schema,gpu,native]=await Promise.all([
    'milkyPaint.js','prefs.js',
    'schemas/org.gnome.shell.extensions.vliq.gschema.xml',
    'liquidGlassDock.js','nativeCssIntegration.js',
].map(read));
const fn=new Function(paint.replace(/^export /gm,'')+
    '\nreturn {milkyPaintTokens,buildMilkyAppearanceCss};')();
const header=fn.milkyPaintTokens('header'),
    popup=fn.milkyPaintTokens('popup');
assert.equal(header.fill,'rgba(0,0,0,0.600)');
assert.equal(popup.fill,'rgba(245,249,255,0.920)');
for(const state of [
    {milkyOpacity:0,milkyBlack:false,milkyBorder:0,milkyGrain:0},
    {milkyOpacity:1,milkyBlack:true,milkyBorder:1,milkyGrain:1},
]){
    assert.equal(fn.milkyPaintTokens('header',state).fill,header.fill);
    assert.equal(fn.milkyPaintTokens('popup',state).fill,popup.fill);
}
const section=prefs.slice(prefs.indexOf("title: 'Glass Material'"),
    prefs.indexOf("title: 'Liquid Glass Controls'"));
assert.match(section,/Milky Glass/);
assert.doesNotMatch(section,/addIntSpin\(milky|addSwitch\(milky/);
for(const key of ['milky-opacity','milky-black','milky-grain',
    'milky-border','milky-whiteness']){
    assert.match(schema,new RegExp('<key name="'+key+'"'));
    assert.doesNotMatch(gpu,new RegExp("get_int\\('"+key+"'\\)|get_boolean\\('"+key+"'\\)"));
    assert.doesNotMatch(native,new RegExp("getInt\\('"+key+"'\\)|get_boolean\\?\\.\\('"+key+"'\\)"));
}
assert.doesNotMatch(gpu,/buildMilkyGrainSvg/);
assert.doesNotMatch(native,/buildMilkyGrainSvg/);
const css=fn.buildMilkyAppearanceCss({milky:true},'file:///ignore.svg');
assert.doesNotMatch(css,/file:\/\/\/ignore\.svg|url\(/);
assert.match(css,/rgba\(0,0,0,0\.600\)/);
assert.match(css,/rgba\(245,249,255,0\.920\)/);
console.log('Retired Milky sliders and White/Black toggle: legacy schema preserved, runtime ignores old keys PASS.');
