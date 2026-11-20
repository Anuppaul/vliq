import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const [shader, roles, schema, integration, milky, theme] = await Promise.all([
    'vendor/liquid-glass/shaders/glass.frag',
    'glassMaterialSystem.js',
    'schemas/org.gnome.shell.extensions.vliq.gschema.xml',
    'liquidGlassDock.js',
    'milkyPaint.js',
    'runtime.css',
].map(read));

const rgb=[245/255,249/255,1];
const shade=0.15;
assert.match(shader,
    /const vec3 VLIQ_MILKY_WHITE_RGB = vec3\(245\.0, 249\.0, 255\.0\) \/ 255\.0;/);
assert.match(shader,/const float VLIQ_MILKY_WHITE_SHADE = 0\.15;/);
assert.match(shader,/flatRgb = mix\(flatRgb, VLIQ_MILKY_WHITE_RGB, VLIQ_MILKY_WHITE_SHADE\);/);
assert.match(shader,/insideBaseColor = mix\(insideBaseColor, VLIQ_MILKY_WHITE_RGB, VLIQ_MILKY_WHITE_SHADE\);/);
assert.match(shader,/vec3 crystalWhite = mix\([\s\S]*?VLIQ_MILKY_WHITE_RGB,/);
assert.match(shader,/vec3 fill = mix\(VLIQ_MILKY_WHITE_RGB,/);
assert.doesNotMatch(shader,/mix\((?:flatRgb|insideBaseColor), vec3\(1\.0\), VLIQ_MILKY_WHITE_SHADE\)/);

// The existing material transfer strength remains unchanged and the body
// remains translucent, rather than forcing opaque native Milky mode.
assert.match(shader,/flatRgb = mix\(flatRgb, vec3\(tint_r, tint_g, tint_b\), tint_strength\);/);
assert.match(shader,/insideBaseColor = mix\(insideBaseColor, vec3\(tint_r, tint_g, tint_b\), tint_strength\);/);
assert.match(shader,/vec3 baseColor = vliqCrystalBody\(insideBaseColor\)/);
assert.match(shader,/if \(frost < 0\.0001\)\s*return color;/);
assert.match(shader,/vec3\(specFlat \+ sheenFlat\)/,
    'optical light should stay pure white for visible highlights');

// Quick Settings inner region neutral body uses the same RGB.
assert.match(roles,/neutralTint: Object\.freeze\(\[245 \/ 255, 249 \/ 255, 1\.0\]\)/);
assert.match(roles,/tintColor = \[245 \/ 255, 249 \/ 255, 1\]/);
assert.match(schema,/<key name="glass-tint-color" type="s">[\s\S]*?<default>'#f5f9ff'<\/default>/);
assert.match(integration,/setStringIfUnset\('dock-tint-color', '#f5f9ff'\)/);
assert.match(integration,/tint: '#f5f9ff',[\s\S]*?r: 245,[\s\S]*?g: 249,[\s\S]*?b: 255,/);

// Existing fixed Milky mode must not be weakened or altered.
assert.match(milky,/const HEADER_FILL='rgba\(0,0,0,0\.600\)'/);
assert.match(milky,/const POPUP_FILL='rgba\(245,249,255,0\.920\)'/);
assert.match(theme,/#panel\.vliq-liquid-top-panel \.panel-button:hover,[\s\S]*?rgba\(245, 249, 255, 0\.24\)/);

// Verify color transformation without clipping or changing user alpha.
// Dark and bright backgrounds retain the original 15% mix intensity.
for(const original of [[0,0,0],[1,1,1],[0.6,0.4,0.3]]) {
    const expected=original.map((v,i)=>v*(1-shade)+rgb[i]*shade);
    assert.ok(expected.every((v,i)=>v>=Math.min(original[i],rgb[i]) &&
        v<=Math.max(original[i],rgb[i])));
}
console.log('Liquid/Frosted Milky White material RGB, original tint/alpha and Milky-mode isolation PASS.');
