import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Regression: a fine, continuously varying optical rim, not a black/white
// dashed line. Uses shipped shader text and numerical reference calculations.
// Real GPU paint must still be reviewed in a GNOME Shell 50 session.
const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const [shader, css] = await Promise.all([
    readFile(new URL('vendor/liquid-glass/shaders/glass.frag', root), 'utf8'),
    readFile(new URL('runtime.css', root), 'utf8'),
]);
const start = shader.indexOf('    // VLIQ_EXPERIMENT_SOFT_OPTICAL_RIM_V3:');
const end = shader.indexOf('    // Composite the glass OVER the shadow', start);
assert.ok(start > 0 && end > start, 'find fine optical edge shader block');
const rim = shader.slice(start, end);
assert.equal(shader.split('VLIQ_EXPERIMENT_SOFT_OPTICAL_RIM_V3').length - 1, 1);
assert.doesNotMatch(rim, /VLIQ_EXPERIMENT_LARGE_WHITE_BLACK_RIM_V2/);
assert.match(rim,
    /if \(surface_light_enabled > 0\.5 &&\s*d > -1\.15 && d < edgeFeather\)/);
assert.match(rim,
    /float edgeCoverage = 0\.53 \*\s*\(1\.0 - smoothstep\(0\.06, 1\.15, edgeDepth\)\)/);
assert.match(rim, /vec2 edgeDistance = box_size - abs\(local_pos\);/);
assert.match(rim, /float warpedPosition = segmentPosition \+/);
assert.match(rim,
    /9\.0 \* sin\(segmentPosition \* 0\.022 \+ sideSeed \* 1\.7\)/);
assert.match(rim,
    /float flowingLight = 0\.5 \+ 0\.5 \* cos\(/);
assert.match(rim,
    /warpedPosition \* 0\.0476 \+ sideSeed \* 1\.3/);
assert.match(rim,
    /float highlightBlend = clamp\(\s*0\.24 \+ 0\.59 \* flowingLight \+ 0\.10 \* cornerGlint,/);
assert.match(rim, /vec3 edgeSlate = mix\(/);
assert.match(rim, /vec3 edgePearl = mix\(/);
assert.match(rim,
    /vec3 edgeColor = mix\(\s*edgeSlate, edgePearl, highlightBlend/);
assert.match(rim, /edgeCoverage \*= mix\(\s*1\.0, 0\.90,/);
assert.match(rim, /litColor = mix\(litColor, edgeColor, edgeCoverage\);/);
assert.doesNotMatch(rim.replace(/\/\/[^\n]*/g, ''),
    /\bfloor\b|\bstep\(|\bmod\(|texture2D|sampler2D|cogl_sampler|\btime\b|\bframe\b|GLib/i,
    'no sharp segment boundaries, extra samples, animated noise or timers');
assert.doesNotMatch(rim, /cogl_color_out\s*=/,
    'do not introduce a second independent shader output');

// Numerical mirror: colors vary smoothly, with no pure opaque white or
// black segments and no extra stripe deeper than 1.15px.
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mix=(a,b,t)=>a*(1-t)+b*t;
const smoothstep=(a,b,x)=>{
    const t=clamp((x-a)/(b-a));
    return t*t*(3-2*t);
};
function toneAt(position,side,cornerGlint=0,brightEdge=0.5,frost=0) {
    const warpedPosition=position+
        9*Math.sin(position*0.022+side*1.7);
    const flowingLight=0.5+0.5*Math.cos(
        warpedPosition*0.0476+side*1.3);
    const weight=clamp(0.24+0.59*flowingLight+0.10*cornerGlint,0.18,0.93);
    const slate=[0.47,0.52,0.58].map((v,i)=>
        mix(v,[0.34,0.38,0.43][i],brightEdge));
    const pearl=[245/255,249/255,1].map((v,i)=>
        mix(v,[0.76,0.88,1.0][i],0.38));
    const rgb=slate.map((v,i)=>mix(v,pearl[i],weight));
    const coverageAt=depth=>0.53*
        (1-smoothstep(0.06,1.15,depth))*mix(1,0.90,frost);
    return {rgb,weight,coverageAt};
}
for(let side=0;side<4;side++) {
    const samples=Array.from({length:501},(_,i)=>
        toneAt(i-250,side));
    const light=samples.map(x=>x.weight);
    assert.ok(Math.max(...light)-Math.min(...light)>0.4,
        'long gentle pearl/slate highlights must still be visible');
    for(let i=1;i<samples.length;i++) {
        assert.ok(Math.abs(light[i]-light[i-1])<0.04,
            'no hard W/B boundary; every neighboring pixel must blend');
        for(let c=0;c<3;c++) {
            assert.ok(Math.abs(samples[i].rgb[c]-samples[i-1].rgb[c])<0.04,
                'no perceptible alternating black/white cuts');
        }
    }
    assert.ok(samples.every(s=>
        s.rgb.every(c=>c>0.3&&c<1.01)),
    'dark rim is optical slate rather than solid black');
    assert.deepEqual(
        samples.map(({rgb,weight})=>({rgb,weight})),
        Array.from({length:501},(_,i)=>{
            const {rgb,weight}=toneAt(i-250,side);
            return {rgb,weight};
        }),
        'rim has no time-varying output'
    );
}
const sample=toneAt(14,0,0,0.5);
assert.equal(sample.coverageAt(1.15),0);
assert.equal(sample.coverageAt(1.7),0);
assert.ok(sample.coverageAt(0)>0.5&&sample.coverageAt(0)<=0.53);
assert.ok(sample.coverageAt(0.9)<0.08,
    'inner edge must fade to glass well before the old thick stripe');
assert.ok(toneAt(14,0,0,0.5,0.88).coverageAt(0) <
    sample.coverageAt(0), 'Frosted diffuse rim remains calmer');

// Preserve the full compositor-alpha and original optical-body contracts.
const blend=shader.indexOf('litColor = mix(litColor, edgeColor, edgeCoverage);',start);
const premultiply=shader.indexOf('vec3 finalRgb   = litColor * alpha',end);
assert.ok(blend>start && premultiply>blend);
assert.match(shader,
    /vec3 finalRgb\s*=\s*litColor \* alpha \+ shadowColor \* shadowContribution;/);
assert.match(shader,/vec4\(finalRgb, finalAlpha\) \* cogl_color_in/);
assert.match(shader,/vec3 baseColor = vliqCrystalBody\(insideBaseColor\)/);
assert.match(shader,/flatRgb = vliqCrystalBody\(flatRgb\)/);
assert.match(shader,/VLIQ_MILKY_WHITE_SHADE = 0\.15/);
const preview=css.match(
    /\.vliq-app-preview-card\.vliq-liquid-shell-card\s*\{([^}]*)\}/)?.[1];
assert.ok(preview);
assert.match(preview,/background-color:\s*transparent\s*!important/);
assert.match(preview,/border-color:\s*transparent\s*!important/);
console.log('Fine <1.15px smooth pearl/slate optical rim, original Liquid/Frosted alpha and no flashing PASS.');
