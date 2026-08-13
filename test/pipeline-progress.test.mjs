import test from 'node:test';import assert from 'node:assert/strict';import { Writable } from 'node:stream';
import { PipelineProgress } from '../src/pipeline-progress.mjs';
import { strip } from '../src/ui.mjs';

function sink(tty=false){let text='';const stream=new Writable({write(chunk,enc,cb){text+=chunk.toString();cb();}});stream.isTTY=tty;return{stream,read:()=>text};}

const PIPELINE = { name:'feature', stages:[{name:'plan'},{name:'code',depends_on:['plan']},{name:'test',depends_on:['plan']},{name:'review',depends_on:['code','test']}] };
const WAVES = [['plan'],['code','test'],['review']];

const make = (tty=false) => { const s = sink(tty); return { p: new PipelineProgress(PIPELINE, WAVES, { stream: s.stream }), read: s.read }; };

test('every stage starts pending',()=>{const {p}=make();assert.equal([...p.status.values()].every(v=>v==='pending'),true);assert.equal(p.total,4);});
test('a non-tty streams one line per event instead of repainting',()=>{const {p,read}=make(false);p.start();p.handle({type:'stage-start',stage:'plan',agent:'planner'});p.handle({type:'stage-ok',stage:'plan'});const out=strip(read());assert.match(out,/stage-start/);assert.match(out,/stage-ok/);assert.ok(!out.includes('wave 1'),'must not draw the tree when it cannot redraw');});
test('a tty draws the wave tree',()=>{const {p,read}=make(true);p.start();p.handle({type:'stage-start',stage:'plan',agent:'planner'});const out=strip(read());assert.match(out,/wave 1/);assert.match(out,/plan/);p.stop();});
test('stage-start marks a stage running and records its agent',()=>{const {p}=make();p.handle({type:'stage-start',stage:'code',agent:'coder'});assert.equal(p.status.get('code'),'running');assert.match(strip(p.detail.get('code')),/coder/);});
test('stage-ok advances the completed count',()=>{const {p}=make();p.handle({type:'stage-ok',stage:'plan'});assert.equal(p.done,1);assert.equal(p.status.get('plan'),'ok');});
test('stage-fail marks failure and still counts as resolved',()=>{const {p}=make();p.handle({type:'stage-fail',stage:'code',error:'boom'});assert.equal(p.status.get('code'),'fail');assert.equal(p.done,1);assert.match(strip(p.detail.get('code')),/boom/);});
test('the completed count never exceeds the total',()=>{const {p}=make();for(let i=0;i<10;i++) p.handle({type:'stage-ok',stage:'plan'});assert.equal(p.done,p.total);});

/* the honest-progress rule */
test('a loop resets the stage it returns to',()=>{const {p}=make();p.handle({type:'stage-ok',stage:'code'});assert.equal(p.done,1);p.handle({type:'loop',from:'review',to:'code'});assert.equal(p.status.get('code'),'pending','re-run work must not stay green');assert.equal(p.done,0,'progress that was undone must be un-counted');});
test('a loop is recorded and shown',()=>{const {p,read}=make(true);p.start();p.handle({type:'loop',from:'review',to:'code'});assert.equal(p.loops.length,1);assert.match(strip(read()),/loops/);p.stop();});
test('the completed count never goes below zero',()=>{const {p}=make();p.handle({type:'loop',from:'review',to:'code'});assert.equal(p.done,0);});
test('a loop to an unknown stage is ignored',()=>{const {p}=make();p.handle({type:'loop',from:'x',to:'not-a-stage'});assert.equal(p.done,0);});

/* wave roll-up */
test('a wave is running when any of its stages is',()=>{const {p,read}=make(true);p.start();p.handle({type:'stage-start',stage:'code',agent:'coder'});assert.match(strip(read()),/wave 2/);p.stop();});
test('a wave fails if any stage in it fails',()=>{const {p}=make();p.handle({type:'stage-ok',stage:'code'});p.handle({type:'stage-fail',stage:'test'});const nodes=p['#nodes']?.() ?? null;assert.equal(p.status.get('test'),'fail');});

/* resilience + summary */
test('an unknown event type is ignored',()=>{const {p}=make();p.handle({type:'something-new',stage:'plan'});assert.equal(p.status.get('plan'),'pending');});
test('stop is safe before start and twice',()=>{const {p}=make(true);p.stop();p.stop();p.start();p.stop();p.stop();});
test('the summary reports counts and elapsed time',()=>{const {p}=make();p.handle({type:'stage-ok',stage:'plan'});p.handle({type:'stage-fail',stage:'code'});const s=strip(p.summary());assert.match(s,/1 ok/);assert.match(s,/1 failed/);assert.match(s,/not reached/);assert.match(s,/s$/);});
test('the summary mentions loops when they happened',()=>{const {p}=make();p.handle({type:'loop',from:'review',to:'code'});assert.match(strip(p.summary()),/1 loop/);});
test('a clean summary omits failure and loop noise',()=>{const {p}=make();for(const stage of ['plan','code','test','review']) p.handle({type:'stage-ok',stage});const s=strip(p.summary());assert.match(s,/4 ok/);assert.ok(!s.includes('failed'));assert.ok(!s.includes('loop'));});
test('rendering encodes cleanly in the active encoding',()=>{const {p,read}=make(true);p.start();p.handle({type:'stage-start',stage:'plan',agent:'planner'});p.stop();Buffer.from(read(),'utf8');});
