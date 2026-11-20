import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base='../gnome-shell/vliq@wonderer.tech/';
const [uiSource,configSource,effectSource,prefs,css]=await Promise.all([
    'wallpaperAtmospherePreferences.js','wallpaperAtmosphereConfig.js',
    'wallpaperAtmosphereEffect.js','prefs.js','runtime.css',
].map(name=>readFile(new URL(base+name,import.meta.url),'utf8')));

const config=new Function(configSource.replace(/^export\s+/gm,'')+
    '\nreturn {WALLPAPER_STYLES,WALLPAPER_MILKY_TINT,readWallpaperProfile};')();
const ui=new Function('WALLPAPER_STYLES','readWallpaperProfile',
    uiSource.replace(/^import[\s\S]*?;\s*$/gm,'')
        .replace(/^export\s+/gm,'')+
    '\nreturn addWallpaperAtmospherePreferences;'
)(config.WALLPAPER_STYLES,config.readWallpaperProfile);

class Actor {
    constructor(opts={}){Object.assign(this,opts);this.listeners=new Map();}
    connect(event,fn){
        const list=this.listeners.get(event)??[];
        list.push(fn);this.listeners.set(event,list);return list.length;
    }
    emit(event){for(const fn of this.listeners.get(event)??[])fn();}
}
class Group extends Actor {
    constructor(o){super(o);this.rows=[];}
    add(row){this.rows.push(row);}
}
class Combo extends Actor {
    constructor(o){super(o);this._selected=0;}
    get selected(){return this._selected;}
    set selected(v){this._selected=v;this.emit('notify::selected');}
}
const Adw={PreferencesGroup:Group,ComboRow:Combo,ActionRow:Actor};
const Gtk={StringList:{new:items=>items}};
class Settings {
    constructor(style='milky', userValue=style!=='milky'){
        this.userValue=userValue;
        this.data=new Map([
            ['wallpaper-style',style],
            ['wallpaper-runtime-status','Not initialized'],
            ['wallpaper-filmic',62],['wallpaper-grain',3],
        ]);
        this.listeners=new Map();this.writes=[];
    }
    get_string(k){return this.data.get(k);}
    get_user_value(k){return k==='wallpaper-style' && this.userValue ? {} : null;}
    connect(event,fn){
        const list=this.listeners.get(event)??[];
        list.push(fn);this.listeners.set(event,list);
        return list.length;
    }
    set_string(k,v){
        if(this.data.get(k)===v &&
            !(k==='wallpaper-style' && !this.userValue))return;
        if(k==='wallpaper-style')this.userValue=true;
        this.data.set(k,v);this.writes.push([k,v]);
        for(const fn of this.listeners.get('changed::'+k)??[])fn(this,k);
    }
}
const settings=new Settings();
const page={groups:[],add(group){this.groups.push(group);}};
const {presetRow,statusRow}=ui(page,settings,Adw,Gtk);
assert.equal(page.groups.length,2,'no old Fine Tune / Reset groups');
assert.equal(page.groups[0].rows.length,1);
assert.equal(page.groups[1].rows.length,1);
assert.equal(presetRow.title,'Wallpaper style');
assert.equal(presetRow.selected,0);
assert.deepEqual(presetRow.model,['Milky White','Original']);
assert.equal(statusRow.title,'Tint attachment');
assert.equal(settings.writes.length,0,'opening prefs must not rewrite GSettings');
assert.doesNotMatch(uiSource,/SpinRow|Gtk\.Adjustment|set_int\(/);
assert.doesNotMatch(uiSource,/Filmic|Vignette|Ambient|Grain|Contrast/);
// The active wallpaper manager must not import or instantiate this shader.
const managerSource=await readFile(new URL(base+'wallpaperAtmosphere.js',import.meta.url),'utf8');
assert.doesNotMatch(managerSource,/getWallpaperTintEffectClass|add_effect_with_name/);
assert.match(managerSource,/insert_child_above\\(overlay, actor\\)/);
assert.match(prefs,/addWallpaperAtmospherePreferences\(\s*wallpaperPage, settings, Adw, Gtk/);

settings.set_string('wallpaper-runtime-status',
    'Milky White tint attached to 3/3 loaded wallpaper sources');
assert.equal(statusRow.subtitle,
    'Milky White tint attached to 3/3 loaded wallpaper sources');
const beforeStyleWrites=settings.writes.length;
presetRow.selected=1;
assert.equal(settings.get_string('wallpaper-style'),'original');
assert.equal(config.readWallpaperProfile(settings).active,false);
presetRow.selected=0;
assert.equal(settings.get_string('wallpaper-style'),'milky');
assert.equal(config.readWallpaperProfile(settings).active,true);
assert.equal(settings.writes.length,beforeStyleWrites+2);

// An old running schema can still report Original as an unsaved default.
// The UI must display Milky and persist a deliberate Original opt-out.
const oldDefault=new Settings('original',false);
const oldPage={groups:[],add(group){this.groups.push(group);}};
const oldUI=ui(oldPage,oldDefault,Adw,Gtk);
assert.equal(oldUI.presetRow.selected,0);
assert.equal(oldDefault.writes.length,0);
oldUI.presetRow.selected=1;
assert.equal(oldDefault.get_string('wallpaper-style'),'original');
assert.equal(oldDefault.userValue,true);
assert.deepEqual(oldDefault.writes,[['wallpaper-style','original']]);
// Legacy styles appear as Milky but are not rewritten until the user
// explicitly chooses Original or Milky. Existing custom values are intact.
const legacy=new Settings('atmosphere');
const legacyPage={groups:[],add(group){this.groups.push(group);}};
const legacyUI=ui(legacyPage,legacy,Adw,Gtk);
assert.equal(legacyUI.presetRow.selected,0);
assert.equal(legacy.get_string('wallpaper-style'),'atmosphere');
assert.equal(legacy.writes.length,0);
legacyUI.presetRow.selected=1;
assert.equal(legacy.get_string('wallpaper-style'),'original');
assert.equal(legacy.data.get('wallpaper-filmic'),62);
assert.equal(legacy.data.get('wallpaper-grain'),3);

// The shader matches the exact accepted native Milky hover-card shade.
assert.match(css,/\.panel-button:hover,[\s\S]*?rgba\(245,\s*249,\s*255,\s*0\.24\)/);
assert.match(effectSource,/vec3\(245\.0 \/ 255\.0, 249\.0 \/ 255\.0, 255\.0 \/ 255\.0\)/);
assert.match(effectSource,/mix\(sourceColor, milky, 0\.24\)/);
assert.equal((effectSource.match(/texture2D\(cogl_sampler0, uv\)/g)??[]).length,1);
assert.doesNotMatch(effectSource,/uniform\s+|va_grain|va_vignette|va_filmic/);
assert.match(effectSource,
    /vec4\(tinted \* original\.a, original\.a\) \* cogl_color_in/);

// New GType avoids stale shader snippets when reloading GNOME Shell 50.
let registered=0,fragment='',hookCalls=0;
class Base {
    constructor(){this._init();}
    _init(){}
    add_glsl_snippet(hook,declarations,code,replace){
        assert.equal(hook,1);assert.equal(declarations,'');
        assert.equal(replace,true);fragment=code;hookCalls++;
    }
}
const Shell={GLSLEffect:Base};
const Clutter={ShaderEffect:class{}};
const Cogl={SnippetHook:{FRAGMENT:1}};
const GObject={registerClass(options,klass){
    assert.equal(options.GTypeName,'VLIQWallpaperMilkyTintEffectV1');
    registered++;return klass;
}};
const cacheKey=Symbol.for('vliq.wallpaper.milky.effect.v1');
const previous=globalThis[cacheKey];
delete globalThis[cacheKey];
try {
    const factory=new Function('Clutter','Cogl','GObject','Shell',
        effectSource.replace(/^import[\s\S]*?;\s*$/gm,'')
            .replace(/^export\s+/gm,'')+
        '\nreturn getWallpaperTintEffectClass;'
    )(Clutter,Cogl,GObject,Shell);
    const Effect=factory();
    assert.equal(factory(),Effect);
    assert.equal(registered,1);
    new Effect().vfunc_build_pipeline();
    assert.equal(hookCalls,1);
    assert.match(fragment,/mix\(sourceColor, milky, 0\.24\)/);
} finally {
    if(previous)globalThis[cacheKey]=previous;
    else delete globalThis[cacheKey];
}
console.log('Wallpaper UI: two modes, no legacy sliders, zero write on open, live status, fixed shade and GType reload PASS.');
