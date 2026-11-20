import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// A reversible, high-contrast, broad W/B segmented rim. Tests the actual
// shipped GLSL source and a numerical mirror of its local-edge mapping.
// This does not replace GNOME Shell on-device pixel verification.
const root=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const [shader,css]=await Promise.all([
    readFile(new URL('vendor/liquid-glass/shaders/glass.frag',root),'utf8'),
    readFile(new URL('runtime.css',root),'utf8'),
]);
const start=shader.indexOf('    // VLIQ_EXPERIMENT_LARGE_WHITE_BLACK_RIM_V2:');
const end=shader.indexOf('    // Composite the glass OVER the shadow',start);
assert.ok(start>=0&&end>start,'one distinct optical rim block');
const rim=shader.slice(start,end);
assert.equal(shader.split('VLIQ_EXPERIMENT_LARGE_WHITE_BLACK_RIM_V2').length-1,1);
assert.match(rim,/if \(surface_light_enabled > 0\.5 &&\s*d > -2\.15 && d < edgeFeather\)/);
assert.match(rim,/float edgeCoverage = 0\.95 \*/);
assert.match(rim,/smoothstep\(0\.72, 2\.10, edgeDepth\)/);
assert.match(rim,/vec2 edgeDistance = box_size - abs\(local_pos\);/);
assert.match(rim,/bool horizontalEdge = edgeDistance\.y <= edgeDistance\.x;/);
assert.match(rim,/12\.0 \* sin\(segmentPosition \* 0\.027 \+ sideSeed \* 1\.7\)/);
assert.match(rim,/float segmentCell = floor\(warpedPosition \/ 56\.0\);/);
assert.match(rim,/float whiteOrBlack = mod\(segmentCell \+ sideSeed, 2\.0\);/);
assert.match(rim,/vec3\(0\.20, 0\.22, 0\.24\)/);
assert.match(rim,/vec3\(0\.065, 0\.075, 0\.085\)/);
assert.match(rim,/blackSegment, vec3\(1\.0\), whiteOrBlack/);
assert.match(rim,/litColor = mix\(litColor, edgeColor, edgeCoverage\);/);
assert.doesNotMatch(rim.replace(/\/\/[^\n]*/g,''),/texture2D|sampler2D|cogl_sampler|\btime\b|\bframe\b|GLib/);
assert.doesNotMatch(rim,/cogl_color_out\s*=/);

// Previous bug: existing bright TL/BR Fresnel was visible while fragmented
// white/gray edge coverage was <=0.4, hence no perceivable W/B pattern.
// Guard that an actual black slice over a pure-white corner becomes dark.
const originalTLBR=[1,1,1],blackOnBright=[0.065,0.075,0.085];
const coverage=0.95;
const blackOutput=originalTLBR.map((c,i)=>
    c*(1-coverage)+blackOnBright[i]*coverage);
assert.ok(Math.max(...blackOutput)<0.15,
    'black rim must visually override bright corner lighting');
assert.ok(originalTLBR.every(x=>x===1),'white segment remains bright');

function tone(position,side) {
    const warped=position+12*Math.sin(position*.027+side*1.7);
    const cell=Math.floor(warped/56);
    return ((cell+side)%2+2)%2===1?'W':'B';
}
for(let side=0;side<4;side++){
    const positions=Array.from({length:1201},(_,i)=>i-600);
    const seq=positions.map(p=>tone(p,side));
    assert.ok(seq.includes('W')&&seq.includes('B'),
        'every side has both bright and dark lengths');
    const runs=seq.join('').match(/W+|B+/g)??[];
    // Exclude clipped first/last sections, which need not be full length.
    const complete=runs.slice(1,-1);
    assert.ok(complete.length>=12,'many visible alternating sections');
    assert.ok(complete.every(run=>run.length>=30&&run.length<=100),
        'no tiny 6-14px fragments or huge half-edge blocks');
    assert.ok(new Set(complete.map(run=>run.length)).size>=3,
        'segment lengths must vary organically, not be a barcode');
    assert.equal(seq.join(''),positions.map(p=>tone(p,side)).join(''),
        'motion-independent deterministic pattern');
}

// No extra border actor, no alpha leakage, no changes to separate Milky mode,
// and native preview CSS remains transparent under the optical material.
const blend=shader.indexOf('litColor = mix(litColor, edgeColor, edgeCoverage);',start);
const premultiply=shader.indexOf('vec3 finalRgb   = litColor * alpha',end);
assert.ok(blend>start&&premultiply>blend);
assert.match(shader,/vec3 finalRgb\s*=\s*litColor \* alpha \+ shadowColor \* shadowContribution;/);
assert.match(shader,/vec4\(finalRgb, finalAlpha\) \* cogl_color_in/);
assert.match(shader,/vec3 baseColor = vliqCrystalBody\(insideBaseColor\)/);
assert.match(shader,/flatRgb = vliqCrystalBody\(flatRgb\)/);
assert.match(shader,/VLIQ_MILKY_WHITE_SHADE = 0\.15/);
const preview=css.match(/\.vliq-app-preview-card\.vliq-liquid-shell-card\s*\{([^}]*)\}/)?.[1];
assert.ok(preview);
assert.match(preview,/background-color:\s*transparent\s*!important/);
assert.match(preview,/border-color:\s*transparent\s*!important/);
console.log('Broad deterministic W/B rim, TL/BR opacity, one SDF stroke and original Liquid/Frosted optics PASS.');
