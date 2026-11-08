import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Regression for VLIQ's *one* adaptive icy-blue edge, within the existing
// LiquidEffect shader. Tests its source-level SDF/alpha/contrast contract and
// a numeric reproduction of its documented coefficients. These assertions
// are not a replacement for live GNOME Shell 50 compositor screenshots.
const base = '../gnome-shell/vliq@wonderer.tech/';
const shader = await readFile(
    new URL(base + 'vendor/liquid-glass/shaders/glass.frag', import.meta.url),
    'utf8'
);
const css = await readFile(
    new URL(base + 'runtime.css', import.meta.url), 'utf8'
);

const start = shader.indexOf('vec3 vliqAdaptiveCardEdgeColor(');
const end = shader.indexOf('// [NEW] Adjust color saturation, contrast, brightness', start);
assert.ok(start > 0 && end > start);
const helpers = shader.slice(start, end);
const blend = shader.indexOf('litColor = mix(litColor, edgeColor, edgeCoverage);');
const premultiply = shader.indexOf('vec3 finalRgb   = litColor * alpha');
const earlierExit = shader.indexOf('if (early_exit_enabled > 0.5 && debug_view < 0.5 && -d >= interiorThreshold)');
assert.ok(blend > earlierExit && premultiply > blend,
    'the new rim must be applied only at full-path edges before premultiplied-alpha');
assert.equal(shader.split('vliqAdaptiveCardEdgeCoverage(d);').length - 1, 1,
    'one actual rim per glass region, not layered strokes');

assert.match(helpers, /vec3\(0\.76, 0\.88, 1\.00\)/,
    'icy blue on dark surfaces');
assert.match(helpers, /vec3\(0\.54, 0\.62, 0\.70\)/,
    'desaturated blue-gray rather than saturated steel-blue on white');
assert.match(helpers, /dot\(backdrop, vec3\(0\.2126, 0\.7152, 0\.0722\)\)/);
assert.match(helpers, /dot\(body, vec3\(0\.2126, 0\.7152, 0\.0722\)\)/);
assert.match(helpers, /float lightBackdrop = smoothstep\(0\.32, 0\.75, contextLuma\)/);
assert.match(helpers, /smoothstep\(0\.06, 0\.88, depth\)/);
assert.match(helpers, /smoothstep\(0\.42, 1\.65, depth\)/);
assert.match(helpers, /hairline \* 0\.40 \+ innerFeather \* 0\.05/);
assert.match(shader, /if \(surface_light_enabled > 0\.5 &&\s*d > -1\.65 && d < edgeFeather\)/,
    'no accidental edge treatment on application windows or full-screen FBO');
assert.match(shader, /edgeCoverage \*= mix\(1\.0, 0\.58, brightEdge\);/,
    'retain backdrop-aware rim contrast');
assert.match(shader, /vec3 edgeColor = mix\(edgeDark, edgeLight, cornerGlint\);/,
    'light only in TL and BR, dark-gray elsewhere');
assert.match(shader, /edgeCoverage \*= mix\(0\.52, 1\.0, cornerGlint\);/,
    'non-highlighted edges must retain a thin visible rim');
assert.match(shader, /vec3\(0\.36, 0\.38, 0\.41\)/,
    'dark-region slate gray, not white');
assert.match(shader, /vec3\(0\.18, 0\.20, 0\.23\)/,
    'bright-region charcoal gray, not white');
assert.match(shader, /\(0\.76 - edgeLight\.r\) \/ \(0\.76 - 0\.54\)/,
    'reuse selected light color without repeated luminance sampling');
assert.match(shader, /edgeCoverage \*= mix\(\s*1\.0,\s*0\.87,/,
    'Frosted has a calmer optical contour without losing contrast');
assert.match(shader, /float insideMask = 1\.0 - outsideTransition;/);
assert.match(shader, /vec3 finalRgb\s*=\s*litColor \* alpha \+ shadowColor \* shadowContribution;/);
assert.doesNotMatch(helpers, /texture2D|sampler2D|cogl_sampler|time|frame|new Texture/i,
    'contrast adaptation must reuse already-sampled color, no fetches/no animated grain');
assert.doesNotMatch(shader.slice(blend - 600, premultiply), /cogl_color_out\s*=/,
    'no separate quad or unmasked compositing for blue rim');

// The existing native preview remains a single refractive material: a
// separate CSS border/veil must not silently return.
const preview = css.match(/\.vliq-app-preview-card\.vliq-liquid-shell-card\s*\{([^}]*)\}/)?.[1];
assert.ok(preview);
assert.match(preview, /background-color:\s*transparent\s*!important/);
assert.match(preview, /border-color:\s*transparent\s*!important/);

// Numerical contrast check using the shader's exact color and SDF constants.
const clamp = x => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};
const rgbLuma = rgb => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
const mix = (a, b, t) => a * (1 - t) + b * t;
function opticalEdge(backdrop, body, frost, cornerGlint,
    signedDistance = -0.2) {
    const context = mix(
        rgbLuma(backdrop),
        rgbLuma(body),
        smoothstep(0.15, 0.75, clamp(frost)) * 0.82
    );
    const lightBackdrop = smoothstep(0.32, 0.75, context);
    const lightColor = [0.76, 0.88, 1.0].map((v, i) =>
        mix(v, [0.54, 0.62, 0.70][i], lightBackdrop)
    );
    const darkColor = [0.36, 0.38, 0.41].map((v, i) =>
        mix(v, [0.18, 0.20, 0.23][i], lightBackdrop)
    );
    const chosen = darkColor.map((v, i) => mix(v, lightColor[i],
        cornerGlint));
    const depth = Math.max(-signedDistance, 0);
    const hairline = 1 - smoothstep(0.06, 0.88, depth);
    const feather = 1 - smoothstep(0.42, 1.65, depth);
    const band = Math.min(0.46, Math.max(0, hairline * 0.40 +
        feather * 0.05));
    const coverage = band * mix(0.52, 1, cornerGlint) *
        mix(1, 0.58, lightBackdrop) *
        mix(1, 0.87, clamp(frost));
    return {
        color: chosen,
        coverage,
        final: body.map((v, i) => mix(v, chosen[i], coverage)),
    };
}
function cornerGlint(x, y) {
    const topLeft = (1 - smoothstep(0, 0.36, x)) *
        (1 - smoothstep(0, 0.36, y));
    const bottomRight = smoothstep(0.64, 1, x) *
        smoothstep(0.64, 1, y) * 0.68;
    return clamp(topLeft + bottomRight);
}
const white = [0.98, 0.98, 0.98];
const black = [0.05, 0.06, 0.075];
const TL = [0.02, 0.02], BR = [0.98, 0.98];
const TR = [0.98, 0.02], BL = [0.02, 0.98];
assert.ok(cornerGlint(...TL) > 0.98 &&
    cornerGlint(...BR) > 0.66);
assert.equal(cornerGlint(...TR), 0, 'TR uses gray not white');
assert.equal(cornerGlint(...BL), 0, 'BL uses gray not white');
for (const body of [white, black, [0.5, 0.48, 0.42]]) {
    const topLeft = opticalEdge(body, body, 0, cornerGlint(...TL));
    const bottomRight = opticalEdge(body, body, 0, cornerGlint(...BR));
    const topRight = opticalEdge(body, body, 0, cornerGlint(...TR));
    const bottomLeft = opticalEdge(body, body, 0, cornerGlint(...BL));
    const midEdge = opticalEdge(body, body, 0, cornerGlint(0.5, 0));
    assert.deepEqual(topRight, bottomLeft,
        'non-glint edges share the same neutral-gray material');
    assert.deepEqual(midEdge, topRight,
        'all straight edges retain the same dark-gray hairline');
    assert.ok(rgbLuma(topLeft.color) > rgbLuma(topRight.color) + 0.25,
        'TL remains the brighter white/icy highlight');
    assert.ok(rgbLuma(bottomRight.color) > rgbLuma(topRight.color) + 0.14,
        'BR remains brighter than its neutral-gray neighbors');
    assert.ok(topRight.coverage > 0 && topRight.coverage < topLeft.coverage,
        'gray rim remains subtle but visible beyond TL/BR');
    assert.ok(topLeft.coverage <= 0.46,
        'single edge stroke must not become opaque or doubled');
}
const whiteGray = opticalEdge(white, white, 0, 0);
const darkGray = opticalEdge(black, black, 0, 0);
assert.ok(rgbLuma(whiteGray.final) < rgbLuma(white) - 0.03,
    'charcoal contour visible on light backgrounds');
assert.ok(rgbLuma(darkGray.final) > rgbLuma(black) + 0.03,
    'soft slate-gray contour distinguishable on dark backgrounds');
assert.ok(opticalEdge(black, black, 0, 0, -1.65).coverage < 0.0001,
    'rim must stop before 1.65px inward');
assert.equal(opticalEdge(black, black, 0, 0, -3.10).coverage, 0,
    'old 3.1px border must no longer be present');
const frosted = opticalEdge(black, [0.93, 0.95, 0.98], 0.88, 0);
assert.ok(frosted.coverage < darkGray.coverage,
    'Frosted Crystal gray rim remains restrained');

// Shader keeps original quick-settings glass regions, exact 16:9 running
// window previews and zero extra actors/passes (CI also runs their own tests).
assert.match(shader, /multi_region_mode > 0\.5/);
assert.match(shader, /vec4\(finalRgb, finalAlpha\) \* cogl_color_in/);
console.log('Thin split-tone Liquid Glass rim: TL/BR bright, neutral-gray elsewhere and native clipping PASS.');
