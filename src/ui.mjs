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
