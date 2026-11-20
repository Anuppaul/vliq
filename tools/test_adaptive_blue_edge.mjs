import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Experimental Liquid/Frosted border: white/gray irregular static
// fragments INSIDE the original thin SDF rim; no extra paint layer.
const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const [shader, css] = await Promise.all([
    readFile(new URL('vendor/liquid-glass/shaders/glass.frag', root), 'utf8'),
    readFile(new URL('runtime.css', root), 'utf8'),
]);

const helperStart = shader.indexOf('vec3 vliqAdaptiveCardEdgeColor(');
const helperEnd = shader.indexOf('// [NEW] Adjust color saturation, contrast, brightness', helperStart);
assert.ok(helperStart > 0 && helperEnd > helperStart);
const helpers = shader.slice(helperStart, helperEnd);
const edgeStart = shader.indexOf('    // Single thin optical rim for native GNOME cards.');
const edgeEnd = shader.indexOf('    // Composite the glass OVER the shadow', edgeStart);
assert.ok(edgeStart > 0 && edgeEnd > edgeStart);
const rim = shader.slice(edgeStart, edgeEnd);
const premultiply = shader.indexOf('vec3 finalRgb   = litColor * alpha');
assert.ok(premultiply > edgeEnd);
assert.match(rim,/if \(surface_light_enabled > 0\.5 &&\s*d > -1\.65 && d < edgeFeather\)/);
assert.match(rim,/vliqAdaptiveCardEdgeColor\(/);
assert.match(rim,/vliqAdaptiveCardEdgeCoverage\(d\)/);
assert.equal(shader.split('vliqAdaptiveCardEdgeCoverage(d);').length - 1,1);
assert.match(helpers,/smoothstep\(0\.06, 0\.88, depth\)/);
assert.match(helpers,/smoothstep\(0\.42, 1\.65, depth\)/);
assert.match(helpers,/hairline \* 0\.40 \+ innerFeather \* 0\.05/);
assert.match(helpers,/dot\(backdrop, vec3\(0\.2126, 0\.7152, 0\.0722\)\)/);
assert.match(helpers,/dot\(body, vec3\(0\.2126, 0\.7152, 0\.0722\)\)/);
assert.match(rim,/float brightEdge = clamp\(/);

// The segment uses actual local card coordinates, deterministic warped
// 10px cells and a per-side seed; it must not crawl on every frame.
assert.match(rim,/vec2 edgeDistance = box_size - abs\(local_pos\);/);
assert.match(rim,/bool horizontalEdge = edgeDistance\.y <= edgeDistance\.x;/);
assert.match(rim,/float warpedPosition = segmentPosition \+/);
assert.match(rim,/4\.0 \* sin\(segmentPosition \* 0\.075 \+ sideSeed \* 1\.7\)/);
assert.match(rim,/float segmentCell = floor\(warpedPosition \/ 10\.0\);/);
assert.match(rim,/float whiteOrGray = step\(0\.48,/);
assert.match(rim,/VLIQ_MILKY_WHITE_RGB, whiteOrGray/);
assert.match(rim,/edgeCoverage \*= mix\(0\.72, 1\.0, whiteOrGray\)/);
assert.match(rim,/edgeCoverage \*= mix\(1\.0, 0\.58, brightEdge\)/);
assert.match(rim,/edgeCoverage \*= mix\(\s*1\.0,\s*0\.87,/);
assert.match(rim,/litColor = mix\(litColor, edgeColor, edgeCoverage\);/);
assert.doesNotMatch(rim,/time|frame|texture2D|sampler2D|cogl_sampler|GLib/i);
assert.doesNotMatch(rim,/cogl_color_out\s*=|shadowAlpha/);
assert.match(shader,/float insideMask = 1\.0 - outsideTransition;/);
assert.match(shader,/vec3 finalRgb\s*=\s*litColor \* alpha \+ shadowColor \* shadowContribution;/);
assert.match(shader,/vec4\(finalRgb, finalAlpha\) \* cogl_color_in/);

// Numerical mirror of the GPU hash: both tones appear for every edge,
// the sequence is deterministic, and warped cells vary in length.
const fract=x=>x-Math.floor(x);
function tone(position,side) {
    const warped=position+4*Math.sin(position*.075+side*1.7);
    const cell=Math.floor(warped/10);
    return fract(Math.sin(cell*127.1+side*311.7)*43758.5453) >= .48 ? 'W':'G';
}
const sequence = Array.from({length:301},(_,i)=>tone(i-150,0)).join('');
assert.equal(sequence,Array.from({length:301},(_,i)=>tone(i-150,0)).join(''));
assert.ok(sequence.includes('W') && sequence.includes('G'));
const changes=sequence.match(/WG|GW/g)??[];
assert.ok(changes.length >= 5,'border needs multiple visible alternating fragments');
const runs=sequence.match(/W+|G+/g)??[];
assert.ok(new Set(runs.map(run=>run.length)).size >= 3,
    'do not produce uniform barcode stripes');
for(let side=0;side<4;side++) {
    const all=Array.from({length:401},(_,i)=>tone(i-200,side));
    assert.ok(all.includes('W')&&all.includes('G'),
        'each side receives white and gray segments');
}

// Existing Frosted and Liquid optical properties, transparent cutoff,
// plus the native card's only rim/opacity, remain unchanged.
assert.match(shader,/flatRgb = vliqCrystalBody\(flatRgb\)/);
assert.match(shader,/vec3 baseColor = vliqCrystalBody\(insideBaseColor\)/);
assert.match(shader,/float edgeBand = \(1\.0 - smoothstep/);
assert.match(shader,/VLIQ_MILKY_WHITE_SHADE = 0\.15/);
const preview=css.match(/\.vliq-app-preview-card\.vliq-liquid-shell-card\s*\{([^}]*)\}/)?.[1];
assert.ok(preview);
assert.match(preview,/background-color:\s*transparent\s*!important/);
assert.match(preview,/border-color:\s*transparent\s*!important/);
console.log('Experimental static irregular white-gray Liquid/Frosted single optical rim PASS.');
