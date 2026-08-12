import test from 'node:test';import assert from 'node:assert/strict';
import { SCHEMA,PASS,RETRY,REROUTE,ESCALATE,ABORT,VERDICTS,ADVANCE,REMEDY,ALTERNATIVE,TIER_UP,STOP,NODE_KINDS,MAX_SAME_REASON_RETRIES,MAX_SAME_REASON_REROUTES,MAX_SAME_REASON_ESCALATIONS,MAX_GATE_REJECTIONS,DEFAULT_REASON_CODES,normalizeVerdict,isGauntletSpec,validateGauntlet,executionOrder,parseVerdict,AttemptLedger,ProgressTracker,route } from '../src/gauntlet.mjs';

const WORK = { name:'build', kind:'work', agent:'coder' };
const spec = (...nodes) => ({ schema:SCHEMA, nodes });
const GATE = { name:'review', kind:'gate', agent:'reviewer', on:{ [PASS]:'ship', [RETRY]:'fix', [REROUTE]:'redesign', [ESCALATE]:'opus' } };
const v = (verdict, code='X', extra={}) => ({ verdict, reasons: verdict===PASS?[]:[{code}], remedy:null, confidence:null, ...extra });

/* schema detection + additive migration */
test('a legacy pipeline is left alone',()=>{assert.deepEqual(validateGauntlet({stages:[{name:'a'}]}),[]);assert.equal(isGauntletSpec({stages:[]}),false);});
test('a gauntlet spec is detected',()=>{assert.equal(isGauntletSpec({schema:SCHEMA}),true);});
test('a minimal spec is valid',()=>{assert.deepEqual(validateGauntlet(spec(WORK)),[]);});
test('nodes are required',()=>{assert.ok(validateGauntlet(spec()).includes('spec has no nodes'));});

/* node validation */
test('duplicate names are rejected',()=>{assert.ok(validateGauntlet(spec(WORK,{...WORK})).some(e=>e.includes('duplicate')));});
test('a node needs an agent',()=>{assert.ok(validateGauntlet(spec({name:'x',kind:'work'})).some(e=>e.includes('missing agent')));});
test('an unknown agent is rejected when the roster is known',()=>{assert.ok(validateGauntlet(spec(WORK),{other:{}}).some(e=>e.includes('unknown agent')));});
test('unknown kind is rejected',()=>{assert.ok(validateGauntlet(spec({name:'x',kind:'wat',agent:'a'})).some(e=>e.includes('unknown kind')));});
test('approval is a valid kind',()=>{assert.deepEqual(validateGauntlet(spec({name:'ok',kind:'approval',agent:'manager'})),[]);assert.ok(NODE_KINDS.includes('approval'));});
test('timeout must be positive',()=>{for(const bad of [0,-1,'soon']) assert.ok(validateGauntlet(spec({...WORK,timeout:bad})).some(e=>e.includes('timeout')));});

/* gates */
test('a gate needs routing',()=>{assert.ok(validateGauntlet(spec({name:'g',kind:'gate',agent:'a'})).some(e=>e.includes("needs an 'on' map")));});
test('a RETRY edge without a REROUTE edge is rejected',()=>{assert.ok(validateGauntlet(spec(WORK,{name:'g',kind:'gate',agent:'a',on:{[RETRY]:'build'}})).some(e=>e.includes('no REROUTE edge')));});
test('an invalid verdict key is rejected',()=>{assert.ok(validateGauntlet(spec(WORK,{name:'g',kind:'gate',agent:'a',on:{MAYBE:'build'}})).some(e=>e.includes('is not a verdict')));});
test('routing to an unknown node is rejected',()=>{assert.ok(validateGauntlet(spec({name:'g',kind:'gate',agent:'a',on:{[PASS]:'nowhere',[REROUTE]:'nowhere'}})).some(e=>e.includes('unknown node')));});
test('gate back-edges are not cycles',()=>{assert.deepEqual(validateGauntlet(spec(WORK,{name:'g',kind:'gate',agent:'a',depends_on:['build'],on:{[PASS]:'build',[RETRY]:'build',[REROUTE]:'build'}})),[]);});

/* deps + cycles + compensation + budget */
test('depends_on must reference a real node',()=>{assert.ok(validateGauntlet(spec({...WORK,depends_on:['ghost']})).some(e=>e.includes('unknown node')));});
test('dependency cycles are rejected',()=>{assert.ok(validateGauntlet(spec({name:'a',agent:'x',depends_on:['b']},{name:'b',agent:'x',depends_on:['a']})).some(e=>e.includes('cycle')));});
test('compensation must be a real harness capability',()=>{assert.ok(validateGauntlet(spec({...WORK,compensate:'rm-rf'}),null,['git-commit']).some(e=>e.includes('not a harness capability')));});
test('a valid compensator is accepted',()=>{assert.deepEqual(validateGauntlet(spec({...WORK,compensate:'git-commit'}),null,['git-commit']),[]);});
test('budget values must be positive',()=>{assert.ok(validateGauntlet({...spec(WORK),budget:{maxNodeRuns:0}}).some(e=>e.includes('maxNodeRuns')));});
test('a valid budget is accepted',()=>{assert.deepEqual(validateGauntlet({...spec(WORK),budget:{maxNodeRuns:10,maxUsdEstimate:1.5}}),[]);});

/* execution order */
test('dependencies come first',()=>{const o=executionOrder([{name:'b',depends_on:['a']},{name:'a'}]);assert.ok(o.indexOf('a')<o.indexOf('b'));});
test('a cycle throws',()=>{assert.throws(()=>executionOrder([{name:'a',depends_on:['b']},{name:'b',depends_on:['a']}]),/cycle/);});

/* verdict parsing - fail closed */
test('a bare object parses',()=>{assert.equal(parseVerdict('{"verdict":"PASS"}').verdict,PASS);});
test('json wrapped in prose and fences parses',()=>{assert.equal(parseVerdict('Sure!\n```json\n{"verdict":"PASS"}\n```\ndone').verdict,PASS);});
test('a lowercase verdict is normalized',()=>{assert.equal(parseVerdict('{"verdict":"pass"}').verdict,PASS);});
test('string reasons are accepted',()=>{assert.equal(parseVerdict('{"verdict":"RETRY","reasons":["TESTS_FAILED"]}').reasons[0].code,'TESTS_FAILED');});
test('unparseable output ABORTS rather than passing',()=>{for(const junk of ['','looks fine','not json','{{{']) assert.equal(parseVerdict(junk).verdict,ABORT,junk);});
test('a non-pass verdict with no reasons aborts',()=>{assert.equal(parseVerdict('{"verdict":"RETRY"}').verdict,ABORT);});
test('an unknown verdict aborts',()=>{assert.equal(parseVerdict('{"verdict":"MAYBE"}').verdict,ABORT);});
test('braces inside strings do not confuse the extractor',()=>{assert.equal(parseVerdict('{"verdict":"RETRY","reasons":[{"code":"X","detail":"a } brace"}]}').reasons[0].code,'X');});

/* ledger */
test('passes are not recorded',()=>{const l=new AttemptLedger();l.record('b',v(PASS));assert.equal(l.entries.length,0);});
test('counts are per node and code',()=>{const l=new AttemptLedger();l.record('b',v(RETRY,'T'));l.record('b',v(RETRY,'T'));l.record('o',v(RETRY,'T'));assert.equal(l.count('b','T'),2);assert.equal(l.count('o','T'),1);assert.equal(l.count('b','Z'),0);});
test('forbidsRetry trips at the threshold',()=>{const l=new AttemptLedger();assert.equal(l.forbidsRetry('n','S'),false);l.record('n',v(RETRY,'S'));l.record('n',v(RETRY,'S'));assert.equal(l.forbidsRetry('n','S'),true);});
test('the prompt block names what not to repeat',()=>{const l=new AttemptLedger();l.record('n',{verdict:RETRY,reasons:[{code:'T',detail:'3 failing'}]});const b=l.asPromptBlock('n');assert.match(b,/ALREADY TRIED/);assert.match(b,/3 failing/);});
test('the prompt block is scoped to its node',()=>{const l=new AttemptLedger();l.record('a',v(ABORT,'A'));assert.equal(l.asPromptBlock('b'),'');});

/* progress */
test('identical output is a repeat',()=>{const p=new ProgressTracker();assert.equal(p.observe('n','same'),false);assert.equal(p.observe('n','same'),true);});
test('whitespace and case are not progress',()=>{const p=new ProgressTracker();p.observe('n','Hello   World');assert.equal(p.observe('n','hello world'),true);});
test('tracking is per node',()=>{const p=new ProgressTracker();p.observe('a','x');assert.equal(p.observe('b','x'),false);});

/* routing */
test('pass advances',()=>{const r=route(v(PASS),GATE);assert.equal(r.action,ADVANCE);assert.equal(r.target,'ship');});
test('retry takes the remedy edge',()=>{assert.equal(route(v(RETRY),GATE).target,'fix');});
test('an explicit remedy overrides the edge',()=>{assert.equal(route({...v(RETRY),remedy:'hotfix'},GATE).target,'hotfix');});
test('reroute takes the alternative edge',()=>{assert.equal(route(v(REROUTE),GATE).action,ALTERNATIVE);});
test('escalate tiers up',()=>{assert.equal(route(v(ESCALATE),GATE).action,TIER_UP);});
test('abort stops',()=>{assert.equal(route(v(ABORT),GATE).action,STOP);});

/* the structural guarantees */
test('a third retry on the same reason is forced to reroute',()=>{const l=new AttemptLedger();const vv=v(RETRY,'T');assert.equal(route(vv,GATE,l).action,REMEDY);l.record('review',vv);assert.equal(route(vv,GATE,l).action,REMEDY);l.record('review',vv);const third=route(vv,GATE,l);assert.equal(third.action,ALTERNATIVE);assert.equal(third.verdict,REROUTE);assert.equal(third.forced,true);assert.match(third.reason,/anti-thrash/);});
test('a different reason may still retry',()=>{const l=new AttemptLedger();l.record('review',v(RETRY,'T'));l.record('review',v(RETRY,'T'));assert.equal(route(v(RETRY,'OTHER'),GATE,l).action,REMEDY);});
test('no progress forces reroute on the first attempt',()=>{const r=route(v(RETRY),GATE,new AttemptLedger(),{noProgress:true});assert.equal(r.action,ALTERNATIVE);assert.equal(r.forced,true);assert.match(r.reason,/no progress/);});
test('confidence cannot buy a pass',()=>{const l=new AttemptLedger();const vv={...v(RETRY,'S'),confidence:1};l.record('review',vv);l.record('review',vv);assert.equal(route(vv,GATE,l).forced,true);});
test('reroute is bounded and then escalates',()=>{const l=new AttemptLedger();const vv=v(RETRY,'S');l.record('review',vv);l.record('review',vv);l.recordReroute('review','S');l.recordReroute('review','S');const r=route(vv,GATE,l);assert.equal(r.action,TIER_UP);assert.equal(r.verdict,ESCALATE);});
test('escalation is bounded and then aborts',()=>{const l=new AttemptLedger();const vv=v(RETRY,'S');l.record('review',vv);l.record('review',vv);l.recordReroute('review','S');l.recordReroute('review','S');l.recordEscalation('review','S');const r=route(vv,GATE,l);assert.equal(r.action,STOP);assert.match(r.reason,/partial result/);});
test('a gate-requested escalation is also bounded',()=>{const l=new AttemptLedger();l.recordEscalation('review','TOO_HARD');const r=route(v(ESCALATE,'TOO_HARD'),GATE,l);assert.equal(r.action,STOP);assert.match(r.reason,/known-failing/);});

/* missing edges fail closed */
test('retry without any edge aborts',()=>{const r=route(v(RETRY),{name:'g',kind:'gate',on:{[PASS]:'n'}});assert.equal(r.action,STOP);assert.equal(r.verdict,ABORT);});
test('anti-thrash without a reroute edge aborts',()=>{const l=new AttemptLedger();const vv=v(RETRY,'S');l.record('g',vv);l.record('g',vv);const r=route(vv,{name:'g',kind:'gate',on:{[RETRY]:'fix'}},l);assert.equal(r.action,STOP);assert.equal(r.forced,true);});
test('escalate without an edge aborts',()=>{assert.equal(route(v(ESCALATE),{name:'g',kind:'gate',on:{[PASS]:'n'}}).verdict,ABORT);});

/* renamed failures must not escape the ladder - the worst bug found in this engine */
test('the rejection cap is code independent',()=>{const l=new AttemptLedger();for(let i=0;i<MAX_GATE_REJECTIONS;i++) l.record('review',{verdict:RETRY,reasons:[{code:`NOVEL_${i}`}]});assert.equal(l.exhausted('review'),true);const r=route(v(RETRY,'BRAND_NEW'),GATE,l);assert.equal(r.action,ALTERNATIVE);assert.equal(r.forced,true);assert.match(r.reason,/regardless of reason code/);});
test('rejections are counted per gate',()=>{const l=new AttemptLedger();for(let i=0;i<MAX_GATE_REJECTIONS;i++) l.record('review',{verdict:RETRY,reasons:[{code:`C${i}`}]});assert.equal(l.exhausted('review'),true);assert.equal(l.exhausted('other'),false);});
test('under the cap a novel code may still retry',()=>{const l=new AttemptLedger();l.record('review',v(RETRY,'ONE'));assert.equal(route(v(RETRY,'TWO'),GATE,l).action,REMEDY);});
test('unknown codes fold into OTHER keeping the original as detail',()=>{const folded=normalizeVerdict({verdict:RETRY,reasons:[{code:'INVENTED',detail:'d'}]});assert.equal(folded.reasons[0].code,'OTHER');assert.match(folded.reasons[0].detail,/INVENTED/);});
test('known codes pass through untouched',()=>{const original={verdict:RETRY,reasons:[{code:'TESTS_FAILED'}]};assert.equal(normalizeVerdict(original),original);});
test('an empty vocabulary disables normalisation',()=>{const original={verdict:RETRY,reasons:[{code:'ANYTHING'}]};assert.equal(normalizeVerdict(original,[]),original);});
test('folded codes accumulate against one counter',()=>{const l=new AttemptLedger();for(const label of ['A','B','C']) l.record('review',normalizeVerdict({verdict:RETRY,reasons:[{code:label}]}));assert.equal(l.forbidsRetry('review','OTHER'),true);});
test('the default vocabulary includes OTHER as the escape hatch',()=>{assert.ok(DEFAULT_REASON_CODES.includes('OTHER'));});

/* the bounds themselves are the contract with Alfred */
test('ladder bounds match the documented contract',()=>{assert.equal(MAX_SAME_REASON_RETRIES,2);assert.equal(MAX_SAME_REASON_REROUTES,2);assert.equal(MAX_SAME_REASON_ESCALATIONS,1);assert.deepEqual(VERDICTS,['PASS','RETRY','REROUTE','ESCALATE','ABORT']);});
