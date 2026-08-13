import test from 'node:test';import assert from 'node:assert/strict';import { Writable } from 'node:stream';
import { c,strip,panel,line,status,fail,banner,pad,wrap,visibleLength,badge,table,kv,progressBar,spinner,costMeter,codeBlock,markdown,diff,tree,width } from '../src/ui.mjs';

function sink(){let text='';const stream=new Writable({write(chunk,enc,cb){text+=chunk.toString();cb();}});stream.isTTY=false;return{stream,read:()=>text};}

/* backward compatibility: other modules import these and must keep working */
test('existing exports still behave',()=>{assert.equal(typeof banner(),'string');assert.match(strip(banner()),/ULTRON/);assert.match(strip(status(true)),/ready/);assert.match(strip(status(false)),/not configured/);assert.equal(typeof c.reset,'string');assert.equal(typeof fail,'function');});
test('panel still frames rows',()=>{const out=strip(panel('Title',['alpha','beta']));assert.match(out,/Title/);assert.match(out,/alpha/);assert.match(out,/beta/);});
test('line still pads its label',()=>{assert.match(strip(line('model','gpt')),/^model\s+gpt$/);});

/* layout primitives */
test('visibleLength ignores ansi codes',()=>{assert.equal(visibleLength(`${c.red}abc${c.reset}`),3);assert.equal(visibleLength('abc'),3);});
test('pad aligns on visible width, not byte length',()=>{assert.equal(visibleLength(pad(`${c.red}ab${c.reset}`,6)),6);assert.equal(strip(pad('ab',5,'right')),'   ab');assert.equal(strip(pad('ab',6,'center')),'  ab  ');});
test('wrap breaks on words and keeps every word',()=>{const lines=wrap('the quick brown fox jumps over the lazy dog',12);assert.ok(lines.every(l=>l.length<=12));assert.equal(lines.join(' ').split(/\s+/).length,9);});
test('wrap preserves explicit newlines',()=>{assert.deepEqual(wrap('a\n\nb',20),['a','','b']);});
test('width clamps to a sane range',()=>{assert.equal(width(10),32);assert.equal(width(500),100);assert.equal(width(80),80);});

/* tables */
test('table aligns columns and uppercases headers',()=>{const out=strip(table(['name','tier'],[['alfred-coder','local'],['opus','frontier']]));assert.match(out,/NAME/);assert.match(out,/TIER/);const rows=out.split('\n');assert.equal(rows.length,4);assert.ok(rows[2].startsWith('alfred-coder'));});
test('table survives null and missing cells',()=>{const out=strip(table(['a','b'],[[null,undefined],['x']]));assert.equal(out.split('\n').length,4);});
test('table shrinks to fit a narrow terminal',()=>{const out=strip(table(['one','two'],[['x'.repeat(80),'y'.repeat(80)]],{max:40}));for(const row of out.split('\n')) assert.ok(row.length<=42,`row too wide: ${row.length}`);});

/* status widgets */
test('badge shouts in uppercase',()=>{assert.equal(strip(badge('gated')),'[GATED]');});
test('kv right-aligns keys',()=>{assert.match(strip(kv({model:'opus'},{gutter:8})),/^\s+model\s+opus$/);});
test('progressBar clamps and reports percent',()=>{assert.match(strip(progressBar(5,10)),/50%/);assert.match(strip(progressBar(20,10)),/100%/);assert.match(strip(progressBar(-5,10)),/0%/);});
test('progressBar does not divide by zero',()=>{assert.match(strip(progressBar(0,0)),/0%/);});

/* spinner: the piped-output path is what CI sees */
test('spinner degrades to plain lines when not a TTY',()=>{const {stream,read}=sink();const s=spinner('calling model',{stream});s.succeed('done');const out=strip(read());assert.match(out,/calling model/);assert.match(out,/done/);assert.ok(!out.includes('\x1b['),'must not emit ansi when disabled');});
test('spinner stop is idempotent and marks state',()=>{const {stream}=sink();const s=spinner('x',{stream});s.stop();s.stop();assert.equal(s.stopped,true);});
test('spinner succeed after stop does not double-print',()=>{const {stream,read}=sink();const s=spinner('x',{stream});s.stop();s.succeed('ignored');assert.ok(!strip(read()).includes('ignored'));});
test('spinner fail and warn render distinct marks',()=>{const a=sink(),b=sink();spinner('x',{stream:a.stream}).fail('bad');spinner('y',{stream:b.stream}).warn('meh');assert.match(strip(a.read()),/bad/);assert.match(strip(b.read()),/meh/);});
test('spinner update changes the label',()=>{const {stream,read}=sink();const s=spinner('first',{stream});s.update('second');s.succeed();assert.match(strip(read()),/second/);});

/* cost + rendering */
test('costMeter shows tokens, spend and budget',()=>{const out=strip(costMeter({inputTokens:1500,outputTokens:200,usd:0.0123,model:'deepseek',budgetUsd:1}));assert.match(out,/deepseek/);assert.match(out,/1,500/);assert.match(out,/\$0\.0123/);assert.match(out,/of \$1\.00/);});
test('costMeter omits spend when unknown',()=>{assert.ok(!strip(costMeter({inputTokens:1})).includes('$'));});
test('codeBlock numbers lines',()=>{const out=strip(codeBlock('a\nb','',{language:'js'}));assert.match(out,/1 a/);assert.match(out,/2 b/);});
test('codeBlock can omit numbers',()=>{assert.ok(!/1 a/.test(strip(codeBlock('a',{numbers:false}))));});
test('markdown renders headings, bold, code and bullets',()=>{const out=markdown('# Title\n- item\n**bold** and `code`');assert.match(strip(out),/Title/);assert.match(strip(out),/• item/);assert.match(strip(out),/bold and code/);});
test('diff colours added and removed lines differently',()=>{const out=diff('--- a\n+++ b\n+added\n-removed\n same');assert.ok(out.includes(c.green));assert.ok(out.includes(c.red));assert.match(strip(out),/ same/);});

/* tree */
test('tree draws nested branches with status marks',()=>{const out=strip(tree([{label:'plan',status:'done'},{label:'build',status:'running',children:[{label:'test',status:'pending'}]}]));assert.match(out,/plan/);assert.match(out,/build/);assert.match(out,/test/);assert.ok(out.includes('├─')||out.includes('└─'));});
test('tree accepts a single node',()=>{assert.match(strip(tree({label:'solo'})),/solo/);});
test('tree tolerates an unknown status',()=>{assert.match(strip(tree([{label:'x',status:'nonsense'}])),/x/);});
