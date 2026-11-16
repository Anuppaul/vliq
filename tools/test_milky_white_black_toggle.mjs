import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = name => readFile(new URL(name, base), 'utf8');
const [paint, schema, prefs, gpu, native] = await Promise.all([
    'milkyPaint.js',
    'schemas/org.gnome.shell.extensions.vliq.gschema.xml',
    'prefs.js', 'liquidGlassDock.js', 'nativeCssIntegration.js',
].map(read));

assert.match(schema, /<key name="milky-black" type="b">\s*<default>false<\/default>/,
    'white/black is one persisted boolean switch, off by default');
assert.match(prefs, /addSwitch\(milky, settings, 'milky-black',/,
    'Milky appearance must contain an actual White/Black toggle');
assert.doesNotMatch(prefs, /addIntSpin\(milky, settings, 'milky-whiteness'/,
    'White Balance slider is replaced, not duplicated');
assert.match(prefs, /'White = Off · Black = On'|Off = White.*On = Black/,
    'toggle UI explains both material choices');
assert.match(gpu, /'milky-black'/,
    'Auto/GPU backend must subscribe to material color changes');
assert.match(native, /'milky-black'/,
    'Native CSS backend must subscribe to material color changes');
assert.doesNotMatch(gpu, /get_int\('milky-whiteness'\)/,
    'old integer white balance must not determine current color');
assert.doesNotMatch(native, /getInt\('milky-whiteness'/,
    'native CSS must use the same boolean color switch');

const {milkyPaintTokens, buildMilkyAppearanceCss,
    buildMilkyGrainSvg, milkyInlineStyle} =
    new Function(paint.replace(/^export /gm, '') +
        '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss,' +
        'buildMilkyGrainSvg, milkyInlineStyle};')();
for (const opacity of [0, .47, 1]) {
    const alpha = opacity.toFixed(3);
    const white={milky:true, milkyBlack:false, milkyOpacity:opacity, milkyBorder:.26};
    const black={...white,milkyBlack:true};
    assert.equal(milkyPaintTokens(white).fill, 'rgba(255,255,255,'+alpha+')');
    assert.equal(milkyPaintTokens(black).fill, 'rgba(29,31,35,'+alpha+')');
    assert.match(buildMilkyAppearanceCss(white),
        new RegExp('rgba\\(255,255,255,' + alpha.replace('.', '\\.') + '\\)'));
    assert.match(buildMilkyAppearanceCss(black),
        new RegExp('rgba\\(29,31,35,' + alpha.replace('.', '\\.') + '\\)'));
    assert.ok(milkyInlineStyle(black).includes(milkyPaintTokens(black).fill));
    assert.ok(milkyInlineStyle(white).includes(milkyPaintTokens(white).fill));
}
const image=buildMilkyGrainSvg(.85);
assert.equal((image.match(/<circle /g)??[]).length,420);
assert.equal((image.match(/fill="#000000"/g)??[]).length,420,
    'all grain particles must be black');
assert.doesNotMatch(image, /fill="#ffffff"/,
    'grain must never include white flecks');
assert.equal(image,buildMilkyGrainSvg(.85),
    'tile is static and deterministic, not animated');
assert.notEqual(image,buildMilkyGrainSvg(.15),
    'grain intensity still controls visibility');
assert.match(buildMilkyAppearanceCss(
    {milky:true,milkyBlack:false,milkyOpacity:1},
    'file:///grain.svg'), /background-image: url\("file:\/\/\/grain.svg"\)/,
    'grain texture remains available even when white is opaque');
assert.match(buildMilkyAppearanceCss(
    {milky:true,milkyBlack:true,milkyOpacity:1},
    'file:///grain.svg'), /background-image: url\("file:\/\/\/grain.svg"\)/,
    'dark material retains black texture on charcoal substrate');

console.log('Milky material toggle: White/Black live settings, retained opacity, static black-only grain PASS.');
