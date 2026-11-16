import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = new URL('../gnome-shell/vliq@wonderer.tech/', import.meta.url);
const read = n => readFile(new URL(n, base), 'utf8');
const [paintSource, css, gpu, native, notifications, cards, popups] =
    await Promise.all([
        'milkyPaint.js', 'runtime.css', 'liquidGlassDock.js',
        'nativeCssIntegration.js', 'notificationGlass.js',
        'shellCards.js', 'popupGlass.js',
    ].map(read));
const {milkyPaintTokens, buildMilkyAppearanceCss, milkyInlineStyle} =
    new Function(paintSource.replace(/^export /gm, '') +
    '\nreturn {milkyPaintTokens, buildMilkyAppearanceCss, milkyInlineStyle};')();
const white = milkyPaintTokens('popup').fill;
const black = milkyPaintTokens('header').fill;
assert.equal(white, 'rgba(245,249,255,0.920)');
assert.equal(black, 'rgba(0,0,0,0.600)');
const actual = buildMilkyAppearanceCss({milky:true});
const surfaces = [
    '.vliq-liquid-popup-content',               // generic app/panel menus
    '.vliq-liquid-shell-card',                 // modal, Alt+Tab, dialogs
    '.vliq-app-preview-card.vliq-liquid-shell-card',
    '.vliq-native-notification-glass',         // top notification banners
    '.vliq-orb-face-v2',                       // launcher orb
    '.vliq-app-button',                        // Orb app buttons
    '.vliq-spotlight-glass-entry',
    '.vliq-spotlight-glass-results',
    '.vliq-milky-osd',                         // volume/brightness OSD
    '.dash-background.vliq-ubuntu-dock-glass-background',
    '.dash-background.vliq-ubuntu-dock-panel-background',
    '#overviewGroup .window-close.vliq-window-close-shared-glass',
    '#overviewGroup .window-icon.vliq-window-icon-shared-glass',
];
for (const target of surfaces) {
    assert.ok(actual.includes(target),
        'all Liquid surfaces must have a Milky counterpart: '+target);
    assert.ok(css.includes('.vliq-global-milky '+target),
        'static CSS fallback also covers '+target);
}
const firstMenu = actual.indexOf('.vliq-global-milky .vliq-liquid-popup-content');
assert.ok(firstMenu>=0);
const menuBody = actual.slice(actual.indexOf('{', firstMenu),
    actual.indexOf('}', firstMenu));
assert.ok(menuBody.includes('background-color: '+white),
    'generic app menu color must be Milky White 92%');
assert.ok(actual.includes('background-color: '+black),
    'header/taskbar must remain black 60%');
assert.match(gpu, /this\._syncMilkyOsdMaterial\(enabled\)/,
    'OSD native material should be enabled in Milky mode');
assert.match(gpu, /milkyPaintTokens\('popup'\)/,
    'Ubuntu Dock inline material should use the same white paint');
assert.match(notifications, /_syncMilkyBannerPaint\(material, state\)/,
    'notification manager must update real GNOME actor inline style');
assert.match(notifications, /this\._syncMilkyBannerPaint\(material, state\)/,
    'notification style must be applied during material updates');
assert.match(notifications, /_applyTextPolarity\(material, true\)/,
    'white notification card must always use readable dark foreground');
assert.match(notifications, /this\._syncMilkyBannerPaint\(\s*material,\s*this\._appearance/,
    'new banner in already-selected Milky must be white immediately');
assert.match(cards,/const CARD_CLASS = 'vliq-liquid-shell-card'/);
assert.match(popups,/const GLASS_CLASS = 'vliq-liquid-popup-content'/);
assert.match(native,/buildMilkyAppearanceCss\(state\)/);
assert.doesNotMatch(actual,/url\(|background-repeat:\s*repeat/,
    'no Grain or new texture render');
assert.equal(buildMilkyAppearanceCss({milky:false}), '');
// Exercise the exact production notification inline painter. The native
// banner was previously forced transparent !important, which defeated all
// late white CSS no matter how specific the selector.
const start=notifications.indexOf('    _syncMilkyBannerPaint(material, state) {');
const end=notifications.indexOf('    _readCornerRadius(actor) {',start);
assert.ok(start>0&&end>start);
const applyBanner=new Function('milkyInlineStyle','TEXT_LIGHT_CLASS',
    'TEXT_DARK_CLASS','return ({'+notifications.slice(start,end)+
    '})._syncMilkyBannerPaint;')(
    milkyInlineStyle,'vliq-notification-text-light','vliq-notification-text-dark');
const notificationsState={milky:true}, savedStyle='padding:4px;',
    transparentStyle=savedStyle+' background-color: transparent !important;';
const actor={
    style:transparentStyle,
    classes:new Set(),
    get_style(){return this.style;},
    set_style(v){this.style=v;},
    remove_style_class_name(v){this.classes.delete(v);},
    add_style_class_name(v){this.classes.add(v);},
};
const material={
    actor,originalInlineStyle:savedStyle,neutralInlineStyle:transparentStyle,
    useDarkText:null,wasMilky:false,
};
let samples=0,canceled=0,darkCalls=0;
const host={
    _cancelTextSample(){canceled++;},
    _applyTextPolarity(m,dark){
        if(dark){darkCalls++;m.useDarkText=true;
            m.actor.add_style_class_name('vliq-notification-text-dark');}
    },
    _scheduleTextSample(){samples++;},
};
applyBanner.call(host,material,notificationsState);
assert.match(actor.style,/rgba\(245,249,255,0\.920\)/,
    'notification banner is no longer transparent in Milky mode');
assert.equal(material.wasMilky,true);
assert.ok(darkCalls===1&&canceled===1);
assert.ok(actor.classes.has('vliq-notification-text-dark'));
applyBanner.call(host,material,{milky:false});
assert.equal(actor.style,transparentStyle,
    'switch to Liquid restores the exact previous transparent inline style');
assert.equal(material.useDarkText,null);
assert.equal(samples,1,'Liquid/Frosted resumes adaptive foreground sampling');

// Shader-independent backend must produce GNOME CSS *newlines*, not literal
// escaped "\\n" text that causes St.Theme to reject the stylesheet.
const methodStart=native.indexOf('    _milkyCss(state) {');
const methodEnd=native.indexOf('    _syncMilkyNativeActors(state) {',methodStart);
assert.ok(methodStart>0&&methodEnd>methodStart);
const nativeCss=new Function('milkyPaintTokens','buildMilkyAppearanceCss',
    'return ({'+native.slice(methodStart,methodEnd)+'})._milkyCss;')(
    milkyPaintTokens,buildMilkyAppearanceCss).call({}, {milky:true});
assert.match(nativeCss,/\.vliq-native-css\.vliq-global-milky \.notification-banner/);
assert.match(nativeCss,/\.vliq-native-css\.vliq-global-milky \.popup-menu-content/);
assert.match(nativeCss,/\.vliq-native-css\.vliq-global-milky \.switcher-list/);
assert.match(nativeCss,/\.vliq-native-css\.vliq-global-milky \.osd-window/);
assert.doesNotMatch(nativeCss,/\\n/,
    'Native CSS rules must be separated by actual newlines, not literal slash-n');

console.log('Milky parity: notifications, popup/app menus, dialogs, previews, Orb, Spotlight, Dock, OSD and overview; headers black, all other Liquid surfaces white PASS.');
