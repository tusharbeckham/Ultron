const version=()=>process.env.NOTION_VERSION||'2026-03-11';
function token(){if(!process.env.NOTION_ACCESS_TOKEN) throw new Error('NOTION_ACCESS_TOKEN is required'); return process.env.NOTION_ACCESS_TOKEN;}
async function call(path,options={}){
  const apiBase=['https:','','api.notion.com','v1'].join('/');
  const res=await fetch(`${apiBase}${path}`,{...options,headers:{Authorization:`Bearer ${token()}`,'Notion-Version':version(),'Content-Type':'application/json',...(options.headers||{})}});
  const body=await res.json(); if(!res.ok) throw new Error(body.message||`Notion HTTP ${res.status}`); return body;
}
export async function notionSearch(query){return call('/search',{method:'POST',body:JSON.stringify({query,page_size:20})});}
export async function notionPage(id){return call(`/pages/${encodeURIComponent(id)}`);}
