import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../gnome-shell/vliq@wonderer.tech/',import.meta.url);
const [dock,paint]=await Promise.all([
    'liquidGlassDock.js','milkyPaint.js',
].map(n=>readFile(new URL(n,root),'utf8')));
const build=new Function(paint.replace(/^export /gm,'')+
    '\nreturn buildMilkyAppearanceCss;')();
const start=dock.indexOf('    _applyCardAppearanceStylesheet(');
const end=dock.indexOf('    isBottomTaskbarActive() {',start);
assert.ok(start>0&&end>start);

const written=new Map(),events=[];
const GLib={
    get_user_cache_dir:()=>'/tmp/vliq-appearance',
    build_filenamev:p=>p.join('/'),
    mkdir_with_parents(){},
    file_set_contents(p,c){written.set(p,c);},
};
const Gio={File:{new_for_path:path=>({
    path,delete(){events.push('delete:'+path);},
})}};
const Main={messageTray:{_banner:{queue_redraw(){}}}};
const theme={
    fail:false,
    load_stylesheet(file){
        if(this.fail){this.fail=false;throw Error('invalid CSS');}
        events.push('load:'+file.path);
    },
    unload_stylesheet(file){events.push('unload:'+file.path);},
};
const apply=new Function('GLib','Gio','Main','buildMilkyAppearanceCss',
    'console','return ({'+dock.slice(start,end)+
    '})._applyCardAppearanceStylesheet;')(
    GLib,Gio,Main,build,{warn(){}}
);
let accent='#4285f4';
const host={
    _cardCssCounter:0,_cardCssFile:null,_cardCssSignature:'',
    _readSystemAccentColor:()=>({color:accent}),
    _getShellTheme:()=>theme,
    _unloadCardAppearanceStylesheet(){
        if(!this._cardCssFile)return;
        theme.unload_stylesheet(this._cardCssFile);
        this._cardCssFile.delete();
        this._cardCssFile=null;
        this._cardCssSignature='';
    },
};
const state={milky:true,filterOpacity:.05};
apply.call(host,state);
const first=host._cardCssSignature,firstFile=host._cardCssFile.path;
assert.match(first,/rgba\(29,31,35,0\.600\)/);
assert.match(first,/rgba\(245,249,255,0\.920\)/);
assert.match(first,/vliq-global-milky #panel\.vliq-three-islands/);
assert.match(first,/vliq-global-milky .popup-menu-content.quick-settings/);
assert.doesNotMatch(first,/vliq-global-milky .vliq-native-notification-glass/);
assert.doesNotMatch(first,/vliq-global-milky .vliq-orb-face-v2/);
assert.doesNotMatch(first,/grain-|url\(/);
state.milkyOpacity=1;state.milkyBlack=true;state.milkyGrain=100;
apply.call(host,state);
assert.equal(host._cardCssSignature,first,
    'retired per-Milky values cannot modify fixed-theme CSS');
accent='#e62d42';
apply.call(host,state);
assert.notEqual(host._cardCssSignature,first,
    'unrelated semantic accent setting still updates its own CSS');
assert.ok(events.includes('unload:'+firstFile));
const valid=host._cardCssSignature,preserved=host._cardCssFile;
theme.fail=true;state.milky=false;
apply.call(host,state);
assert.equal(host._cardCssFile,preserved,
    'bad stylesheet load must not destroy current GNOME styling');
assert.equal(host._cardCssSignature,valid);
apply.call(host,state);
assert.ok(!host._cardCssSignature.includes(
    'vliq-global-milky #panel.vliq-three-islands'));
console.log('Fixed Milky: actual CSS theme load/unload scoped to header/menus, no grain, accent updates and rollback PASS.');
