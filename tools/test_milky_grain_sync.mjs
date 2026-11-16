import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
const [dock, prefs, schema, paint] = await Promise.all([
    'liquidGlassDock.js', 'prefs.js',
    'schemas/org.gnome.shell.extensions.vliq.gschema.xml',
    'milkyPaint.js',
].map(read));

assert.match(schema, /name="milky-grain" type="i">[\s\S]*?<default>28<\/default>/);
assert.match(schema, /name="milky-black" type="b">[\s\S]*?<default>false<\/default>/);
assert.match(prefs, /settings, 'milky-grain',[\s\S]*?'Micro-grain'/);
assert.match(prefs, /addSwitch\(milky, settings, 'milky-black'/);
assert.doesNotMatch(prefs, /addIntSpin\(milky, settings, 'milky-whiteness'/);
assert.match(dock, /'milky-black',[\s\S]*?'frost-density'/,
    'color toggle must trigger live appearance refresh');
assert.match(dock, /from '\.\/milkyPaint\.js'/,
    'GPU Auto renderer must use the canonical material helper');

const f = new Function(paint.replace(/^export /gm, '') +
    '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss, buildMilkyGrainSvg};')();
assert.equal(f.milkyPaintTokens({milkyOpacity:.24,milkyBlack:false}).fill,
    'rgba(255,255,255,0.240)');
assert.equal(f.milkyPaintTokens({milkyOpacity:.24,milkyBlack:true}).fill,
    'rgba(29,31,35,0.240)');
assert.equal(f.milkyPaintTokens({milkyOpacity:0,milkyBlack:false}).fill,
    'rgba(255,255,255,0.000)');
assert.equal(f.milkyPaintTokens({milkyOpacity:1,milkyBlack:true}).fill,
    'rgba(29,31,35,1.000)');
const tile=f.buildMilkyGrainSvg(.8);
assert.equal((tile.match(/<circle /g)??[]).length,420);
assert.equal((tile.match(/fill="#000000"/g)??[]).length,420);
assert.doesNotMatch(tile,/fill="#ffffff"/);
assert.equal(tile,f.buildMilkyGrainSvg(.8),'static noise must be deterministic');
const textured=f.buildMilkyAppearanceCss(
    {milky:true,milkyBlack:true,milkyOpacity:.4},
    'file:///tmp/grain.svg');
assert.match(textured,/background-image: url\("file:\/\/\/tmp\/grain.svg"\)/);
assert.match(textured,/rgba\(29,31,35,0\.400\)/);
assert.match(f.buildMilkyAppearanceCss({
    milky:true,milkyBlack:false,milkyOpacity:1,
},'file:///tmp/grain.svg'), /background-image: url\(/,
'opacity=100 does not silently disable the black grain');
assert.equal(f.buildMilkyAppearanceCss({milky:false,milkyBlack:true}),'');

const written = new Map(), removed = [], loaded = [], unloaded = [];
const GLib = {
    build_filenamev: parts => parts.join('/'),
    get_user_cache_dir: () => '/tmp/vliq-milky-test',
    mkdir_with_parents() {},
    file_set_contents(path,contents) {written.set(path,contents);},
};
const Gio = {File: {new_for_path(path) {
    return {
        path, get_uri() {return 'file://' + path;},
        delete() {removed.push(path);written.delete(path);},
    };
}}};
const theme = {
    rejectNext: false,
    load_stylesheet(file) {
        if (this.rejectNext) {
            this.rejectNext = false;
            throw Error('SVG CSS unsupported');
        }
        loaded.push(file.path);
    },
    unload_stylesheet(file) {unloaded.push(file.path);},
};
const Main = {messageTray:{_banner:{queue_redraw(){}}}};
const a=dock.indexOf('    _unloadCardAppearanceStylesheet(preserveGrain = false) {');
const b=dock.indexOf('    isBottomTaskbarActive() {',a);
assert.ok(a>=0&&b>a);
const methods = new Function('GLib','Gio','Main',
    'buildMilkyAppearanceCss','buildMilkyGrainSvg','clampNumber','console',
    'return ({' + dock.slice(a,b).replace(
        /}\s*(_applyCardAppearanceStylesheet\()/,'}, $1') + '\n});')(
    GLib,Gio,Main,f.buildMilkyAppearanceCss,f.buildMilkyGrainSvg,
    (v,lo,hi)=>Math.max(lo,Math.min(hi,v)),{warn(){}}
);
const state = {
    milky:true,milkyOpacity:.24,milkyBorder:.20,
    milkyBlack:false,milkyGrain:.28,filterOpacity:.05,
};
const host = {
    _cardCssFile:null,_cardGrainFile:null,_cardGrainStrength:-1,
    _cardCssSignature:'',_cardCssCounter:0,
    _getShellTheme:()=>theme,
    _readSystemAccentColor:()=>({color:'#4285f4'}),
    _readSharedCardAppearance:()=>state,
    _unloadCardAppearanceStylesheet:methods._unloadCardAppearanceStylesheet,
};
const apply=()=>methods._applyCardAppearanceStylesheet.call(host,state);
const svgWrites=()=>[...written.keys()].filter(x=>x.endsWith('.svg'));
apply();
assert.equal(host._cardGrainStrength,28);
const firstTile=host._cardGrainFile;
assert.equal(svgWrites().length,1);
assert.match(host._cardCssSignature,/rgba\(255,255,255,0\.240\)/);

state.milkyBlack=true;
apply();
assert.match(host._cardCssSignature,/rgba\(29,31,35,0\.240\)/);
assert.equal(host._cardGrainFile,firstTile,
    'switching White/Black reuses the existing black grain texture');
assert.equal(svgWrites().length,1);
state.milkyOpacity=.72;
apply();
assert.match(host._cardCssSignature,/rgba\(29,31,35,0\.720\)/);
assert.equal(host._cardGrainFile,firstTile,
    'opacity changes reuse the grain tile');

state.milkyGrain=.66;
apply();
const secondTile=host._cardGrainFile;
assert.notEqual(secondTile,firstTile);
assert.equal(host._cardGrainStrength,66);
assert.ok(removed.includes(firstTile.path));
theme.rejectNext=true;
state.milkyGrain=.95;
apply();
assert.equal(host._cardGrainFile,null,
    'unsupported grain must fall back to plain material CSS');
assert.match(host._cardCssSignature,/rgba\(29,31,35,0\.720\)/);
assert.match(host._cardCssSignature,/background-image: none !important/);
assert.equal(svgWrites().length,0);
assert.ok(removed.includes(secondTile.path));

state.milkyGrain=0;
apply();
assert.equal(host._cardGrainStrength,0);
state.milkyGrain=.44;
apply();
assert.equal(host._cardGrainStrength,44);
state.milky=false;
apply();
assert.equal(host._cardGrainFile,null);
assert.doesNotMatch(host._cardCssSignature,/file:\/\/\/tmp\/vliq-milky-test/);
methods._unloadCardAppearanceStylesheet.call(host);
assert.equal(host._cardCssFile,null);
assert.equal(host._cardGrainFile,null);
assert.ok(loaded.length>0&&unloaded.length>0);
console.log('Milky black grain: color switch, independent opacity, tile reuse, SVG failure recovery and cleanup PASS.');
