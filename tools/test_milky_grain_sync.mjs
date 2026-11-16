import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const read=n=>readFile(new URL(n,base),'utf8');
const [dock,paint]=await Promise.all([
    'liquidGlassDock.js','milkyPaint.js',
].map(read));
assert.doesNotMatch(paint,/buildMilkyGrainSvg|<circle |fill-opacity/);
assert.doesNotMatch(dock,/buildMilkyGrainSvg|grain-[^'"]+\.svg/);
assert.doesNotMatch(dock,/_cardGrainFile|_cardGrainStrength/);

const {buildMilkyAppearanceCss} =
    new Function(paint.replace(/^export /gm,'')+
        '\nreturn {buildMilkyAppearanceCss};')();
const css=buildMilkyAppearanceCss({milky:true});
assert.match(css,/rgba\(29,31,35,0\.600\)/);
assert.match(css,/rgba\(245,249,255,0\.920\)/);
assert.doesNotMatch(css,/background-repeat:\s*repeat|url\(/);
assert.equal(buildMilkyAppearanceCss({milky:false}),'');

const paths=new Map(),loads=[],unloads=[],deletes=[];
const theme={
    rejectNext:false,
    load_stylesheet(file){
        if(this.rejectNext){this.rejectNext=false;throw Error('bad CSS');}
        loads.push(file.path);
    },
    unload_stylesheet(file){unloads.push(file.path);},
};
const GLib={
    get_user_cache_dir:()=>'/tmp/vliq-fixed',
    build_filenamev:parts=>parts.join('/'),
    mkdir_with_parents(){},
    file_set_contents(path,data){paths.set(path,data);},
};
const Gio={File:{new_for_path(path){
    return {path,delete(){deletes.push(path);paths.delete(path);}};
}}};
const Main={messageTray:{_banner:{queue_redraw(){}}}};
const begin=dock.indexOf('    _unloadCardAppearanceStylesheet() {');
const finish=dock.indexOf('    isBottomTaskbarActive() {',begin);
assert.ok(begin>=0&&finish>begin);
const methods=new Function('GLib','Gio','Main',
    'buildMilkyAppearanceCss','console',
    'return ({'+dock.slice(begin,finish).replace(
        /}\s*(_applyCardAppearanceStylesheet\()/,'}, $1')+'});')(
    GLib,Gio,Main,buildMilkyAppearanceCss,{warn(){}}
);
const state={milky:true,filterOpacity:.05},
    host={
        _cardCssFile:null,_cardCssSignature:'',_cardCssCounter:0,
        _readSystemAccentColor:()=>({color:'#4285f4'}),
        _getShellTheme:()=>theme,
        _unloadCardAppearanceStylesheet:methods._unloadCardAppearanceStylesheet,
    };
const apply=()=>methods._applyCardAppearanceStylesheet.call(host,state);
apply();
const first=host._cardCssSignature,oldPath=host._cardCssFile.path;
assert.equal(loads.length,1);
assert.match(first,/rgba\(29,31,35,0\.600\)/);
assert.match(first,/rgba\(245,249,255,0\.920\)/);
assert.equal([...paths.keys()].filter(x=>x.endsWith('.svg')).length,0);
state.milkyOpacity=0;
state.milkyBlack=false;
state.milkyGrain=100;
state.milkyBorder=100;
apply();
assert.equal(loads.length,1,
    'legacy saved Milky slider values cannot repaint the fixed material');
state.milky=false;
apply();
assert.equal(loads.length,2);
assert.ok(unloads.includes(oldPath));
assert.ok(!host._cardCssSignature.includes('vliq-global-milky'));
theme.rejectNext=true;
state.milky=true;
apply();
assert.equal(loads.length,2,'invalid CSS retains previously active theme');
assert.equal(host._cardCssSignature.includes('vliq-global-milky'),false);
apply();
assert.equal(loads.length,3);
methods._unloadCardAppearanceStylesheet.call(host);
assert.equal(host._cardCssFile,null);
assert.equal([...paths.keys()].filter(x=>x.endsWith('.svg')).length,0);
assert.ok(deletes.length>0);
console.log('Fixed Milky: no SVG grain allocations, static header/popup CSS, cached legacy values ignored, load rollback PASS.');
