import { loadToken } from './tokens.mjs';
import { NOTION_VERSION } from './notion-oauth.mjs';

const version=()=>process.env.NOTION_VERSION||NOTION_VERSION;
/** Resolution order: NOTION_ACCESS_TOKEN env (back-compat) -> encrypted token store key 'notion'. */
export function notionToken(){
  if(process.env.NOTION_ACCESS_TOKEN) return process.env.NOTION_ACCESS_TOKEN;
  const stored=loadToken('notion');
  if(stored?.accessToken) return stored.accessToken;
  throw new Error("No Notion token. Set NOTION_ACCESS_TOKEN or run: ultron notion login");
}
function token(){return notionToken();}
async function call(path,options={}){
  const apiBase=['https:','','api.notion.com','v1'].join('/');
  const res=await fetch(`${apiBase}${path}`,{...options,headers:{Authorization:`Bearer ${token()}`,'Notion-Version':version(),'Content-Type':'application/json',...(options.headers||{})}});
  const body=await res.json(); if(!res.ok) throw new Error(body.message||`Notion HTTP ${res.status}`); return body;
}
export async function notionSearch(query){return call('/search',{method:'POST',body:JSON.stringify({query,page_size:20})});}
export async function notionPage(id){return call(`/pages/${encodeURIComponent(id)}`);}
