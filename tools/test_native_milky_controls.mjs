import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const [native,paint]=await Promise.all([
    'nativeCssIntegration.js','milkyPaint.js',
].map(n=>readFile(new URL(n,root),'utf8')));
const m=new Function(paint.replace(/^export /gm,'')+
    '\nreturn {milkyPaintTokens,buildMilkyAppearanceCss,MilkyActorPainter,milkyCardActors};')();
assert.doesNotMatch(native,/buildMilkyGrainSvg|getInt\('milky-|get_int\('milky-|get_boolean\?\.\('milky-/,
    'retired Milky inputs cannot control native runtime materials');
assert.match(native,/key === 'glass-style'/);
assert.match(native,/buildMilkyAppearanceCss\(state\)/);

const saved=new Map(),loads=[],unloads=[],classes=new Set();
const GLib={
    get_user_cache_dir:()=>'/tmp/vliq-fixed-native',
    build_filenamev:parts=>parts.join('/'),
    mkdir_with_parents(){},
    file_set_contents(path,data){saved.set(path,data);},
};
const Gio={
    File:{new_for_path(path){return {
        path,get_uri(){return 'file://'+path;},
        delete(){saved.delete(path);},
    };}},
    Settings:class {constructor(){return interfaceSettings;}},
};
const theme={
    load_stylesheet(f){loads.push(saved.get(f.path));},
    unload_stylesheet(f){unloads.push(f.path);},
};
const St={ThemeContext:{get_for_stage(){return {get_theme:()=>theme};}}};
const widget=style=>({
    style,
    get_style(){return this.style;},
    set_style(v){this.style=v;},
    add_style_class_name(v){classes.add(v);},
    remove_style_class_name(v){classes.delete(v);},
});
const header=widget('height:36px;'),quick=widget('padding:3px;'),
    date=widget('margin:2px;');
header.statusArea={
    quickSettings:{menu:{box:quick}},
    dateMenu:{menu:{box:date}},
};
const rootActor={
    add_style_class_name(c){classes.add(c);},
    remove_style_class_name(c){classes.delete(c);},
};
const Main={layoutManager:{uiGroup:rootActor},uiGroup:rootActor,
    panel:header,extensionManager:{lookup(){return null;}}};
const interfaceHandlers=new Map();
let id=0;
const interfaceSettings={
    color:'default',get_string(){return this.color;},
    connect(signal,callback){interfaceHandlers.set(++id,callback);return id;},
    disconnect(key){interfaceHandlers.delete(key);},
};
const settingsHandlers=new Map();
const values={
    'glass-style':'milky','milky-opacity':100,'milky-black':true,
    'milky-grain':99,'milky-border':100,
};
const settings={
    reads:[],
    get_string(key){this.reads.push(key);return values[key];},
    connect(signal,callback){
        assert.equal(signal,'changed');
        settingsHandlers.set(++id,callback);return id;
    },
    disconnect(k){settingsHandlers.delete(k);},
    change(key,value){
        values[key]=value;
        for(const callback of settingsHandlers.values())callback(this,key);
    },
};
let opts;
class TopBar{
    _layoutMode='bottom';
    constructor(options){opts=options;}
    setup(){return true;}
    cleanup(){}
    updateAppearance(){}
    setLauncherCallback(){}
}
class Guard{setup(){}cleanup(){}}
const body=native.replace(/^import[\s\S]*?;\s*$/gm,'')
    .replace(/^export /gm,'');
const Native=new Function('Gio','GLib','St','Main','TopBarIslands',
    'FullscreenPanelChromeGuard','milkyPaintTokens',
    'buildMilkyAppearanceCss','MilkyActorPainter','milkyCardActors',
    'global','console',body+'\nreturn NativeCssIntegration;')(
    Gio,GLib,St,Main,TopBar,Guard,m.milkyPaintTokens,
    m.buildMilkyAppearanceCss,m.MilkyActorPainter,m.milkyCardActors,
    {display:{},stage:{}},{log(){},warn(){}}
);
const backend=new Native({vliqSettings:settings});
backend.enable();
assert.equal(opts.forceCssOnly,true);
assert.equal(opts.readAppearance().milky,true);
assert.match(header.style,/rgba\(29,31,35,0\.600\)/);
assert.match(quick.style,/rgba\(245,249,255,0\.920\)/);
assert.match(date.style,/rgba\(245,249,255,0\.920\)/);
assert.equal(loads.length,1);
assert.equal([...saved.keys()].filter(k=>k.endsWith('.svg')).length,0);
const prior=backend._milkyCssSignature;
for(const key of ['milky-opacity','milky-black','milky-grain','milky-border']){
    settings.change(key,key==='milky-black'?false:0);
}
assert.equal(loads.length,1,'retired Milky settings do not reload CSS');
assert.equal(backend._milkyCssSignature,prior);
assert.ok(settings.reads.every(k=>k==='glass-style'),
    'native renderer must read only the material selector');
interfaceSettings.color='prefer-dark';
for(const cb of interfaceHandlers.values())cb();
assert.match(header.style,/rgba\(29,31,35,0\.600\)/);
assert.match(quick.style,/rgba\(245,249,255,0\.920\)/);
assert.match(loads.at(-1),/rgba\(245,249,255,0\.920\)/);
settings.change('glass-style','liquid');
assert.equal(classes.has('vliq-global-milky'),false);
assert.equal(header.style,'height:36px;');
assert.equal(quick.style,'padding:3px;');
assert.equal(date.style,'margin:2px;');
backend.disable();
assert.equal(settingsHandlers.size,0);
assert.equal(interfaceHandlers.size,0);
assert.equal(saved.size,0);
assert.ok(unloads.length>0);
console.log('Native CSS fixed Milky: black header 60%, white Quick/Date, no grain/slider reads, Dark Style and cleanup PASS.');
