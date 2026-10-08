/** Fallback ONLY: actual production renderers with repository's dependency-free DOM contract.
 * This is not Chrome: no CSP, layout, network scheduling, SVG geometry or true worker coverage.
 */
import { readFileSync } from 'node:fs';
import { createContext,runInContext } from 'node:vm';
import { Element,Option,documentFromHtml } from '../../test/release-dom.ts';
function simpleMatches(selector){
 const last=selector.trim();
 const id=last.match(/#([\w-]+)/)?.[1];if(id&&this.id!==id)return false;
 const tag=last.match(/^[a-z][\w-]*/i)?.[0];if(tag&&this.tagName!==tag)return false;
 const outside=last.replace(/\[[^\]]*\]/g,'');
 for(const [,name]of outside.matchAll(/\.([\w-]+)/g))if(!this.classList.contains(name))return false;
 for(const [,name,value]of last.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g)){
  const key=name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
  const actual=name.startsWith('data-')?this.dataset[key]:this.getAttribute(name)??this[name];
  if(actual==null||value!==undefined&&actual!==value)return false;
 }return true;
}
function matchesChain(element,selector){
 const parts=selector.trim().split(/\s+(?![^\[]*\])/);
 const matches=(e,s)=>{
  if(s.includes(':first-child')){if(e.parentElement?.children[0]!==e)return false;s=s.replace(':first-child','')}
  if(s.includes(':last-child')){if(e.parentElement?.children.at(-1)!==e)return false;s=s.replace(':last-child','')}
  const neg=s.match(/:not\(([^)]+)\)/);if(neg){if(simpleMatches.call(e,neg[1]))return false;s=s.replace(neg[0],'')}
  return simpleMatches.call(e,s);
 };
 if(!matches(element,parts.pop()))return false;
 let parent=element.parentElement;while(parts.length){const part=parts.pop();while(parent&&!matches(parent,part))parent=parent.parentElement;if(!parent)return false;parent=parent.parentElement}return true;
}
Element.prototype.matches=function(selector){return selector.split(',').some(s=>matchesChain(this,s))};
Element.prototype.querySelectorAll=function(selector){return this.all().filter(e=>e.matches(selector))};
Element.prototype.dispatchEvent=function(event){event.target=this;return this.listeners.get(event.type)?.(event)};
Element.prototype.click=function(){return this.dispatchEvent({type:'click',preventDefault(){},stopPropagation(){}})};
Object.defineProperties(Element.prototype,{firstElementChild:{get(){return this.children[0]??null}},lastElementChild:{get(){return this.children.at(-1)??null}}});
class Event{constructor(type,opts={}){this.type=type;Object.assign(this,opts)}preventDefault(){}stopPropagation(){}}
export async function createDomRuntime(snapshot,fetchStub){
 const html=readFileSync(new URL('../../src/public/index.html',import.meta.url),'utf8'),document=documentFromHtml(html),storage={getItem:()=>null,setItem(){}};
 const window={matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:storage,setTimeout,clearTimeout,innerWidth:1440};
 Object.assign(globalThis,{document,window,Option,HTMLElement:Element,fetch:fetchStub});
 const app=readFileSync(new URL('../../src/public/app.js',import.meta.url),'utf8'),helpers={};
 for(const [,specifiers,path]of app.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];/g)){
  const exports=await import(new URL(`../../src/public/${path.replace(/^\.\//,'').replace(/^\//,'')}`,import.meta.url));
  for(const name of specifiers.split(',').map(s=>s.trim()).filter(Boolean))helpers[name]=exports[name];
 }
 const context=createContext({...helpers,document,window,HTMLElement:Element,Option,URLSearchParams,localStorage:storage,fetch:fetchStub,setTimeout,clearTimeout,resetExportMenu(){},fixture:snapshot,CSS:{escape:s=>s},Event,KeyboardEvent:Event});
 const source=app.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm,'').split('const urlParameters =')[0];
 runInContext(source+`\nsnapshot=fixture;sessionsByRepository=groupByRepository(snapshot.sessions);elements.repositoryFilter.value='all';populateRepositories();configureWindow();applyUrlAfterRender=()=>{};for(const button of windowButtons)button.addEventListener('click',()=>applyWindowPreset(button.dataset.windowPreset));elements.windowStart.addEventListener('change',()=>applyCustomWindow('start'));elements.windowEnd.addEventListener('change',()=>applyCustomWindow('end'));for(const filter of providerFilters)filter.addEventListener('change',()=>renderLine(dailyProviderSpend(activeView().dailySessions)));for(const button of viewButtons)button.addEventListener('click',()=>switchView(button.dataset.viewButton));document.querySelector('#sync-context').dataset.state='live';renderView();`,context);
 return {evaluate:async expression=>await runInContext(expression,context)};
}
