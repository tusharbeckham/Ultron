const enabled = !process.env.NO_COLOR && process.stdout.isTTY;
const esc = n => enabled ? `\x1b[${n}m` : '';
export const c = { reset:esc(0), bold:esc(1), dim:esc(2), blue:esc(94), cyan:esc(36), green:esc(32), yellow:esc(33), red:esc(31), gray:esc(90) };
export function banner(){ return `${c.bold}${c.blue}ULTRON${c.reset} ${c.dim}CLI · model-agnostic engineering console${c.reset}`; }
export function strip(s){ return String(s).replace(/\x1b\[[0-9;]*m/g,''); }
function clip(value,width){const text=strip(value);return text.length<=width?value:`${text.slice(0,Math.max(1,width-1))}…`;}
export function line(label,value,tone='cyan'){const color=c[tone]||'';return `${color}${String(label).padEnd(13)}${c.reset} ${value}`;}
export function panel(title,rows=[],columns=process.stdout.columns||88){const terminal=Math.max(32,Number(columns));const width=Math.min(88,terminal,Math.max(32,title.length+6,...rows.map(x=>strip(x).length+4)));const inner=width-4;const shownTitle=strip(clip(title,width-6));const top=`┌─ ${c.bold}${shownTitle}${c.reset} ${'─'.repeat(Math.max(1,width-shownTitle.length-5))}┐`;return [top,...rows.map(r=>{const shown=clip(r,inner);return `│ ${shown}${' '.repeat(Math.max(0,inner-strip(shown).length))} │`;}),`└${'─'.repeat(width-2)}┘`].join('\n');}
export function status(ok){return ok?`${c.green}ready${c.reset}`:`${c.yellow}not configured${c.reset}`;}
export function fail(message){console.error(`${c.red}error${c.reset} ${message}`);}

/* ── UI kit ───────────────────────────────────────────────────────────────────
 * Zero dependencies, TTY-aware, and safe when piped: anything animated degrades
 * to plain lines when stdout is not a TTY (so logs and CI stay readable).
 * `enabled` above already honours NO_COLOR.
 * ---------------------------------------------------------------------------*/

export const width = (columns=process.stdout.columns) => Math.max(32, Math.min(100, Number(columns)||88));

/** Visible length, ignoring ANSI colour codes. */
export const visibleLength = s => strip(s).length;

/** Pad to `n` visible columns (ANSI-safe, unlike String.padEnd). */
export function pad(value,n,align='left'){
  const gap=Math.max(0,n-visibleLength(value));
  if(align==='right') return `${' '.repeat(gap)}${value}`;
  if(align==='center'){const l=Math.floor(gap/2);return `${' '.repeat(l)}${value}${' '.repeat(gap-l)}`;}
  return `${value}${' '.repeat(gap)}`;
}

/** Word-wrap to `n` columns. `panel` clips; this preserves content. */
export function wrap(text,n=72){
  const out=[];
  for(const paragraph of String(text).split('\n')){
    if(!paragraph.trim()){out.push('');continue;}
    let line='';
    for(const word of paragraph.split(/\s+/)){
      if(!line) line=word;
      else if(visibleLength(line)+1+visibleLength(word)<=n) line+=` ${word}`;
      else {out.push(line);line=word;}
    }
    if(line) out.push(line);
  }
  return out;
}

/** A small uppercase tag. `tone` is a key of `c`. */
export function badge(text,tone='cyan'){return `${c[tone]||''}${c.bold}[${String(text).toUpperCase()}]${c.reset}`;}

/** Aligned columns. `align` is per-column: 'left' | 'right' | 'center'. */
export function table(headers,rows,{align=[],max=width()}={}){
  const body=rows.map(r=>r.map(v=>v==null?'':String(v)));
  const cols=headers.length;
  const widths=headers.map((h,i)=>Math.max(visibleLength(String(h)),...body.map(r=>visibleLength(r[i]||''))));
  // Shrink the widest column first until the table fits the terminal.
  let total=()=>widths.reduce((a,b)=>a+b,0)+(cols-1)*2;
  while(total()>max){
    const widest=widths.indexOf(Math.max(...widths));
    if(widths[widest]<=6) break;
    widths[widest]-=1;
  }
  const clipCell=(v,n)=>visibleLength(v)<=n?v:`${strip(v).slice(0,Math.max(1,n-1))}…`;
  const head=headers.map((h,i)=>`${c.dim}${pad(clipCell(String(h).toUpperCase(),widths[i]),widths[i],align[i])}${c.reset}`).join('  ');
  const rule=`${c.gray}${widths.map(w=>'─'.repeat(w)).join('  ')}${c.reset}`;
  const lines=body.map(r=>r.map((v,i)=>pad(clipCell(v,widths[i]),widths[i],align[i])).join('  '));
  return [head,rule,...lines].join('\n');
}

/** Key/value block, keys right-aligned into a gutter. */
export function kv(pairs,{gutter=14}={}){
  return Object.entries(pairs)
    .map(([k,v])=>`${c.dim}${pad(k,gutter,'right')}${c.reset}  ${v==null?`${c.gray}-${c.reset}`:v}`)
    .join('\n');
}

/** A [====----] bar. `total` of 0 renders empty rather than dividing by zero. */
export function progressBar(done,total,{size=24,tone='blue'}={}){
  const ratio=total>0?Math.max(0,Math.min(1,done/total)):0;
  const filled=Math.round(ratio*size);
  const pct=String(Math.round(ratio*100)).padStart(3);
  return `${c[tone]||''}${'█'.repeat(filled)}${c.gray}${'░'.repeat(size-filled)}${c.reset} ${pct}% ${c.dim}${done}/${total}${c.reset}`;
}

/**
 * Spinner for slow model calls - the biggest UX gap in a model CLI is silence.
 * Degrades to a single printed line when not a TTY, and is safe to stop twice.
 */
export function spinner(label,{stream=process.stdout,interval=90}={}){
  const frames=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  const animate=enabled&&stream.isTTY;
  const started=Date.now();
  let i=0,timer=null,stopped=false,text=label;
  const elapsed=()=>`${((Date.now()-started)/1000).toFixed(1)}s`;
  const paint=()=>{stream.write(`\r${c.blue}${frames[i++%frames.length]}${c.reset} ${text} ${c.dim}${elapsed()}${c.reset}\x1b[K`);};
  const clear=()=>{if(animate) stream.write('\r\x1b[K');};
  if(animate){paint();timer=setInterval(paint,interval).unref?.();timer=timer||null;}
  else stream.write(`… ${text}\n`);
  const finish=(mark,tone,message)=>{
    if(stopped) return;
    stopped=true;
    if(timer) clearInterval(timer);
    clear();
    stream.write(`${c[tone]||''}${mark}${c.reset} ${message??text} ${c.dim}${elapsed()}${c.reset}\n`);
  };
  return {
    update(next){text=next;if(!animate) stream.write(`… ${next}\n`);},
    succeed(m){finish('✓','green',m);},
    fail(m){finish('✗','red',m);},
    warn(m){finish('!','yellow',m);},
    stop(){if(stopped)return;stopped=true;if(timer)clearInterval(timer);clear();},
    get stopped(){return stopped;},
  };
}

/** Tokens and spend, for the budget ladder. */
export function costMeter({inputTokens=0,outputTokens=0,usd=null,model=null,budgetUsd=null}={}){
  const parts=[];
  if(model) parts.push(`${c.cyan}${model}${c.reset}`);
  parts.push(`${c.dim}in${c.reset} ${inputTokens.toLocaleString()}`);
  parts.push(`${c.dim}out${c.reset} ${outputTokens.toLocaleString()}`);
  if(usd!=null){
    const over=budgetUsd!=null&&usd>budgetUsd;
    parts.push(`${over?c.red:c.green}$${Number(usd).toFixed(4)}${c.reset}`);
    if(budgetUsd!=null) parts.push(`${c.dim}of $${Number(budgetUsd).toFixed(2)}${c.reset}`);
  }
  return parts.join(`${c.gray} · ${c.reset}`);
}

/** Framed code, optionally numbered. */
export function codeBlock(code,{language='',numbers=true,max=width()}={}){
  const lines=String(code).replace(/\n$/,'').split('\n');
  const gutter=numbers?String(lines.length).length:0;
  const head=`${c.gray}┌─${c.reset}${language?` ${c.dim}${language}${c.reset} `:''}${c.gray}${'─'.repeat(Math.max(1,max-language.length-5))}${c.reset}`;
  const body=lines.map((l,i)=>{
    const n=numbers?`${c.gray}${pad(String(i+1),gutter,'right')}${c.reset} `:'';
    return `${c.gray}│${c.reset} ${n}${l}`;
  });
  return [head,...body,`${c.gray}└${'─'.repeat(max-1)}${c.reset}`].join('\n');
}

/** Minimal terminal markdown: headings, **bold**, `code`, and - bullets. */
export function markdown(text){
  return String(text).split('\n').map(line=>{
    const heading=/^(#{1,6})\s+(.*)$/.exec(line);
    if(heading) return `${c.bold}${c.blue}${heading[2]}${c.reset}`;
    if(/^\s*[-*]\s+/.test(line)) line=line.replace(/^(\s*)[-*]\s+/,`$1${c.cyan}•${c.reset} `);
    return line
      .replace(/\*\*([^*]+)\*\*/g,`${c.bold}$1${c.reset}`)
      .replace(/`([^`]+)`/g,`${c.yellow}$1${c.reset}`);
  }).join('\n');
}

/** Unified-diff colouring. Headers dim, +green, -red. */
export function diff(patch){
  return String(patch).split('\n').map(line=>{
    if(/^(\+\+\+|---|diff |index |@@)/.test(line)) return `${c.dim}${line}${c.reset}`;
    if(line.startsWith('+')) return `${c.green}${line}${c.reset}`;
    if(line.startsWith('-')) return `${c.red}${line}${c.reset}`;
    return line;
  }).join('\n');
}

/**
 * Tree view for subagent pipelines.
 * Nodes: { label, status?, children?: Node[] }
 */
export function tree(nodes,{prefix=''}={}){
  const marks={ok:`${c.green}✓${c.reset}`,done:`${c.green}✓${c.reset}`,fail:`${c.red}✗${c.reset}`,
    running:`${c.blue}●${c.reset}`,pending:`${c.gray}○${c.reset}`,skipped:`${c.gray}−${c.reset}`,
    warn:`${c.yellow}!${c.reset}`};
  const list=Array.isArray(nodes)?nodes:[nodes];
  const out=[];
  list.forEach((node,i)=>{
    const last=i===list.length-1;
    const mark=node.status?`${marks[node.status]||marks.pending} `:'';
    out.push(`${prefix}${c.gray}${last?'└─':'├─'}${c.reset} ${mark}${node.label}`);
    if(node.children?.length){
      out.push(tree(node.children,{prefix:`${prefix}${c.gray}${last?'   ':'│  '}${c.reset}`}));
    }
  });
  return out.join('\n');
}
