import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const [prefs, schema, dock, vendorSchema, material, shader, paint] =
    await Promise.all([
        'prefs.js',
        'schemas/org.gnome.shell.extensions.vliq.gschema.xml',
        'liquidGlassDock.js',
        'vendor/liquid-glass/schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml',
        'vendor/liquid-glass/dist/rendering/material.js',
        'vendor/liquid-glass/shaders/glass.frag',
        'milkyPaint.js',
    ].map(read));

for (const [key, value, vendorKey, uniform] of [
    ['milky-opacity', 24, 'vliq-milky-opacity', 'vliq_milky_opacity'],
    ['milky-border', 20, 'vliq-milky-border', 'vliq_milky_border'],
]) {
    assert.match(schema, new RegExp('<key name="' + key +
        '" type="i">\\s*<default>' + value + '</default>'));
    assert.ok(prefs.includes("settings, '" + key + "'"));
    assert.ok(dock.includes("'" + key + "'"));
    assert.ok(dock.includes("'" + vendorKey + "'"));
    assert.ok(vendorSchema.includes('name="' + vendorKey + '"'));
    assert.ok(material.includes("'" + vendorKey + "'"));
    assert.ok(shader.includes('uniform float ' + uniform + ';'));
}
assert.match(schema, /<key name="milky-black" type="b">\s*<default>false<\/default>/);
assert.match(prefs, /addSwitch\(milky, settings, 'milky-black'/);
assert.doesNotMatch(prefs, /addIntSpin\(milky, settings, 'milky-whiteness'/);
assert.match(dock, /get_boolean\('milky-black'\)/);
assert.match(dock, /'milky-black'/);
assert.match(prefs, /milky\.set_sensitive\(settings\.get_string\('glass-style'\) === 'milky'\)/);
assert.match(prefs, /settings\.connect\('changed::glass-style', syncMilkyControls\)/);

const {milkyPaintTokens, buildMilkyAppearanceCss, buildMilkyGrainSvg} =
    new Function(paint.replace(/^export /gm, '') +
        '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss, buildMilkyGrainSvg};')();
const white=milkyPaintTokens({milkyOpacity:.24,milkyBorder:.20,milkyBlack:false});
const black=milkyPaintTokens({milkyOpacity:.24,milkyBorder:.20,milkyBlack:true});
assert.equal(white.fill,'rgba(255,255,255,0.240)');
assert.equal(black.fill,'rgba(29,31,35,0.240)');
assert.equal(white.rim,'inset 0 0 0 1px rgba(255,255,255,0.200)');
assert.equal(black.rim,white.rim);
assert.equal(milkyPaintTokens({milkyOpacity:0,milkyBlack:true}).fill,
    'rgba(29,31,35,0.000)');
assert.equal(milkyPaintTokens({milkyOpacity:1,milkyBlack:false}).fill,
    'rgba(255,255,255,1.000)');
assert.match(buildMilkyAppearanceCss({
    milky:true,milkyOpacity:.90,milkyBorder:.75,milkyBlack:true,
}), /rgba\(29,31,35,0\.900\)/);
assert.equal(buildMilkyAppearanceCss({milky:false,milkyBlack:true}), '',
    'the color toggle cannot override Liquid/Frosted modes');
const grain=buildMilkyGrainSvg(.82);
assert.equal((grain.match(/<circle /g)??[]).length,420);
assert.equal((grain.match(/fill="#000000"/g)??[]).length,420);
assert.doesNotMatch(grain,/fill="#ffffff"/);

// Real canonical-to-vendor bridge, not a stand-in for the source method.
const a=dock.indexOf('    _applyFrostedCrystalSettings() {');
const b=dock.indexOf('\n    async enable() {',a);
assert.ok(a>=0&&b>a);
const bridge=new Function('clampNumber',
    'return ({'+dock.slice(a,b)+'})._applyFrostedCrystalSettings;')(
    (value,lo,hi)=>Math.max(lo,Math.min(hi,value)));
const values=new Map([
    ['vliq-milky-mode',0],['vliq-milky-opacity',.24],
    ['vliq-milky-border',.20],['vliq-milky-whiteness',.83],
    ['vliq-frost-grain',.62],['vliq-frost-edge-glow',.52],
    ['vliq-frost-amount',0],['glass-displacement-scale',58],
]);
const user={
    'glass-style':'milky','milky-opacity':75,'milky-border':40,
    'milky-black':true,'frost-grain':62,'frost-edge-glow':52,'frost-density':88,
};
const ctx={
    _settings:{
        settings_schema:{has_key:key=>values.has(key)},
        get_double:key=>values.get(key),
        set_double:(key,value)=>values.set(key,value),
    },
    _vliqSettings:{
        get_string:key=>user[key],
        get_int:key=>user[key],
    },
};
bridge.call(ctx);
assert.equal(values.get('vliq-milky-mode'),1);
assert.equal(values.get('vliq-milky-opacity'),.75);
assert.equal(values.get('vliq-milky-border'),.4);
assert.equal(values.get('vliq-milky-whiteness'),0,
    'retired vendor White Balance uniform is neutralized, not user-controlled');
user['glass-style']='liquid';
bridge.call(ctx);
assert.equal(values.get('vliq-milky-mode'),0);
assert.equal(values.get('glass-displacement-scale'),58);
console.log('Milky controls: White/Black GSettings, opacity, rim, black-only grain, preserved vendor optics PASS.');
