import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const read=n=>readFile(new URL(n,root),'utf8');
const [prefs,schema,dock,paint,vendorSchema,shader]=await Promise.all([
    'prefs.js','schemas/org.gnome.shell.extensions.vliq.gschema.xml',
    'liquidGlassDock.js','milkyPaint.js',
    'vendor/liquid-glass/schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml',
    'vendor/liquid-glass/shaders/glass.frag',
].map(read));

assert.match(prefs,/glassStyleValues = \['liquid', 'frosted', 'milky'\]/);
assert.match(schema,/<choice value="milky"\/>/);
const start=prefs.indexOf("title: 'Glass Material'");
const finish=prefs.indexOf("title: 'Liquid Glass Controls'",start);
const section=prefs.slice(start,finish);
assert.ok(start>=0&&finish>start);
assert.doesNotMatch(section,/const milky = new Adw\.PreferencesGroup/);
assert.doesNotMatch(section,/addIntSpin\(milky|addSwitch\(milky/);
assert.match(section,/Milky Glass/);
assert.match(section,/black headers|black at 60|60% black/);

// Keep retired values for schema migration, but not as user-facing inputs.
for(const key of ['milky-opacity','milky-border','milky-whiteness',
    'milky-black','milky-grain']){
    assert.match(schema,new RegExp('<key name="'+key+'"'));
    assert.doesNotMatch(dock,new RegExp("get_int\\('"+key+"'\\)"));
    assert.doesNotMatch(dock,new RegExp("get_boolean\\('"+key+"'\\)"));
}
assert.match(dock,/from '\.\/milkyPaint\.js'/);
assert.doesNotMatch(dock,/buildMilkyGrainSvg/);
assert.match(dock,/buildMilkyAppearanceCss\(state\)/);
const funcs=new Function(paint.replace(/^export /gm,'')+
    '\nreturn {milkyPaintTokens,buildMilkyAppearanceCss};')();
assert.equal(funcs.milkyPaintTokens('header').fill,'rgba(29,31,35,0.600)');
assert.equal(funcs.milkyPaintTokens('popup').fill,'rgba(245,249,255,0.920)');
assert.equal(funcs.buildMilkyAppearanceCss({milky:false}),'');

// Old optional upstream vendor uniforms stay neutral. No Liquid or Frosted
// tuning may be altered by selecting the native fixed Milky card.
const a=dock.indexOf('    _applyFrostedCrystalSettings() {');
const b=dock.indexOf('\n    async enable() {',a);
assert.ok(a>=0&&b>a);
const bridge=new Function('clampNumber',
    'return ({'+dock.slice(a,b)+'})._applyFrostedCrystalSettings;')(
    (v,lo,hi)=>Math.max(lo,Math.min(hi,v)));
const values=new Map([
    ['vliq-frost-amount',.8],['vliq-frost-grain',.62],
    ['vliq-frost-edge-glow',.52],['vliq-milky-mode',1],
    ['vliq-milky-opacity',.75],['vliq-milky-border',.7],
    ['vliq-milky-whiteness',.4],['glass-displacement-scale',58],
]);
const selected={
    'glass-style':'milky','frost-density':88,
    'frost-grain':62,'frost-edge-glow':52,
};
const ctx={
    _settings:{
        settings_schema:{has_key:key=>values.has(key)},
        get_double:key=>values.get(key),
        set_double:(key,val)=>values.set(key,val),
    },
    _vliqSettings:{
        get_string:key=>selected[key],
        get_int:key=>selected[key],
    },
};
bridge.call(ctx);
for(const key of ['vliq-milky-mode','vliq-milky-opacity',
    'vliq-milky-border','vliq-milky-whiteness'])
    assert.equal(values.get(key),0);
assert.equal(values.get('glass-displacement-scale'),58);
assert.ok(vendorSchema.includes('vliq-milky-mode'));
assert.match(shader,/uniform float vliq_milky_mode/);
selected['glass-style']='frosted';
bridge.call(ctx);
assert.equal(values.get('vliq-frost-amount'),.88);
selected['glass-style']='liquid';
bridge.call(ctx);
assert.equal(values.get('vliq-frost-amount'),0);
assert.equal(values.get('glass-displacement-scale'),58);
console.log('Fixed Milky: Material picker remains, sub-settings retired, vendor shader neutral, Frosted/Liquid intact PASS.');
