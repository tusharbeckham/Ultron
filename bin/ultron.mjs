#!/usr/bin/env node
import readline from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { banner, panel, line, status, fail, c, spinner, costMeter, table } from '../src/ui.mjs';
import { providers, getProvider, probeLocal, localBase, alfredBase, alfredModel, localLoadedModels } from '../src/providers.mjs';
import { boundedLoop, clampSteps } from '../src/loop.mjs';
import { notionSearch, notionPage } from '../src/notion.mjs';
import { discoverMcpAuthServer, registerClient, createPkcePair, createState, buildAuthorizeUrl, startLoopbackReceiver, exchangeCode, needsRefresh, NOTION_REST_AUTHORIZE, NOTION_REST_TOKEN } from '../src/notion-oauth.mjs';
import { saveToken, loadToken, deleteToken, tokenStorePath } from '../src/tokens.mjs';
import { recommendTier, getModel, listModels } from '../src/models.mjs';
import { loadAgents, loadPipeline, validatePipeline, computeWaves, toMermaid, runPipeline } from '../src/subagents.mjs';
import { loadHookConfig, fireHooks, guardToolUse } from '../src/hooks.mjs';
import { McpHttpClient } from '../src/mcp-http.mjs';
import { NOTION_MCP_RESOURCE } from '../src/notion-oauth.mjs';
import { PipelineProgress } from '../src/pipeline-progress.mjs';
import { commandExists, runCommand } from '../src/process.mjs';
import { indexProject, writeIndex } from '../src/indexer.mjs';
import { gitContext, reviewPatch } from '../src/git.mjs';
import { getPermissionProfile, requirePermission, permissionProfiles, resolveWithin } from '../src/permissions.mjs';
import * as guards from '../src/guards.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { appendSession, exportSession, sessionId } from '../src/sessions.mjs';
import { runInteractiveChat } from '../src/interactive.mjs';
import { McpClient } from '../src/mcp.mjs';
import { completion, commands as knownCommands } from '../src/completions.mjs';
import { serveAgent } from '../src/agent-protocol.mjs';

const BOOLEAN_FLAGS = new Set(['trust-all','stream','json','apply','no-browser']);
function parse(argv) { const flags = {}, pos = []; for (let i = 0; i < argv.length; i++) { const x = argv[i]; if (x.startsWith('--')) { const k = x.slice(2); if (BOOLEAN_FLAGS.has(k)) flags[k] = true; else { if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`--${k} requires a value`); flags[k] = argv[++i]; } } else pos.push(x); } return { pos, flags }; }
const print = (value, json = false) => console.log(json || typeof value !== 'string' ? JSON.stringify(value, null, 2) : value);
function help() { console.log(`${banner()}\n\nUsage:\n  ultron providers | capabilities [--provider <name>] | models --provider <name>\n  ultron ask|run|chat --provider <name> [--stream] [--json] [--session <id>] <prompt>\n  ultron index [path] [--output <file>]\n  ultron git [path] | patch <file> [--apply --profile balanced]\n  ultron mcp tools|call --command <executable> [--args '["..."]'] [--tool <name>] [--input '{}']\n  ultron session export <id> [--format jsonl|json|md] [--output <file>]\n  ultron completion bash|zsh|fish|powershell\n  ultron serve --provider <name>\n  ultron notion login [--path mcp|rest] [--no-browser] | notion status | notion logout\n  ultron notion tools | notion call --tool <name> [--input '{}']\n  ultron notion search <query> | notion page <id>\n  ultron agents | pipeline plan|graph|run <name> [--task "..."] [--budget N]\n  ultron registry [--provider <name>] | route "<task>"\n  ultron ide --editor code|codium|cursor|antigravity|zed [path]\n\nSecurity defaults: read-only permission profile, environment-only credentials, redacted sessions, no automatic shell execution.`); }
async function providerRows() { const rows = []; for (const [name,p] of Object.entries(providers)) { let ok = p.configured(); if (p.available) ok = ok && await p.available(); rows.push(line(name, `${p.description} · ${status(ok)}`)); } return rows; }
function requestOpts(flags, extra = {}) { return { model: flags.model, stream: !!flags.stream, timeoutMs: flags['timeout-ms'] ? Number(flags['timeout-ms']) : undefined, maxRetries: flags['max-retries'] ? Number(flags['max-retries']) : undefined, trustAll: flags['trust-all'], onRetry: info => { if (!flags.json) console.error(`${c.dim}retry ${info.attempt} in ${Math.round(info.delayMs)}ms${info.status ? ` · HTTP ${info.status}` : ''}${c.reset}`); }, ...extra }; }
async function askOnce(name, prompt, flags = {}) { const provider = getProvider(name), opts = requestOpts(flags, { messages: flags.messages, signal: flags.signal, onToken: flags.onToken || (token => { if (flags.stream && !flags.json) process.stdout.write(token); }) }); const waiting = (!flags.stream && !flags.json && !flags.quiet) ? spinner(`${name}${flags.model ? ` · ${flags.model}` : ''} thinking`, { stream: process.stderr }) : null; let result; try { result = provider.askDetailed ? await provider.askDetailed(prompt, opts) : { provider: name, model: flags.model || null, text: await provider.ask(prompt, opts), usage: null, estimatedCostUsd: null, rateLimit: {} }; } catch (error) { waiting?.fail(`${name} failed`); throw error; } waiting?.succeed(`${name}${result.model ? ` · ${result.model}` : ''}`); if (flags.stream && !flags.json) process.stdout.write('\n'); if (flags.session && !flags.noPersist) { await appendSession(flags.session, { type: 'turn', provider: name, model: result.model, prompt, text: result.text, usage: result.usage }); } return result; }
function usageLine(result) { if (!result?.usage) return; console.error(costMeter({ inputTokens: result.usage.inputTokens || 0, outputTokens: result.usage.outputTokens || 0, usd: result.estimatedCostUsd, model: result.model, budgetUsd: process.env.ULTRON_BUDGET_USD ? Number(process.env.ULTRON_BUDGET_USD) : null })); }

const DEFAULT_PROVIDER = () => process.env.ULTRON_DEFAULT_PROVIDER || 'alfred';

/** Fail with actionable guidance instead of a confusing connection error. */
async function preflight(name) {
  const provider = getProvider(name);
  if (name === 'alfred' || name === 'local') {
    const base = name === 'alfred' ? alfredBase() : localBase();
    if (await probeLocal({ base })) {
      if (name !== 'alfred') return;
      const loaded = await localLoadedModels({ base });
      const want = alfredModel();
      if (loaded.length && !loaded.includes(want)) {
        console.error(`${c.yellow}warning${c.reset} ${want} is not loaded. Loaded: ${loaded.join(', ')}`);
        console.error(`${c.dim}Load it with:  lms load ${want} -y     (or set ALFRED_MODEL to one of the above)${c.reset}\n`);
      }
      return;
    }
    throw new Error(
      `No local model server at ${base}.\n` +
      `  Start LM Studio, then:   lms server start && lms load ${alfredModel()} -y\n` +
      `  Different port/tool?     set ALFRED_BASE_URL (Ollama: http://localhost:11434/v1)\n` +
      `  Use a cloud model:       ultron chat --provider deepseek   (needs DEEPSEEK_API_KEY)`
    );
  }
  if (!provider.configured()) {
    const envHint = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', kimi: 'MOONSHOT_API_KEY', deepseek: 'DEEPSEEK_API_KEY', zai: 'ZAI_API_KEY' }[name];
    throw new Error(`Provider "${name}" is not configured${envHint ? `. Set ${envHint}` : ''}. Free alternative: ultron chat --provider alfred`);
  }
}

async function startChat(flags, pos) {
  const name = flags.provider || DEFAULT_PROVIDER();
  await preflight(name);
  if (flags.session === 'new' || !flags.session) flags.session = sessionId();
  const opening = pos.join(' ').trim();
  await runInteractiveChat({
    provider: name,
    model: flags.model || (name === 'alfred' ? alfredModel() : undefined),
    sessionId: flags.session,
    maxChars: flags['max-context-chars'] ? Number(flags['max-context-chars']) : undefined,
    stream: flags.stream !== false,
    root: path.resolve(flags.cwd || process.cwd()),
    opening,
    ask: async request => {
      const streamed = request.stream && !!providers[request.provider]?.capabilities?.streaming;
      const result = await askOnce(request.provider, request.prompt, { ...flags, ...request, stream: streamed, noPersist: true, json: true });
      return { ...result, streamed };
    },
    providerExists: value => !!providers[value],
    onUsage: () => {}
  });
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2)), cmd = pos.shift();
  // Bare `ultron` opens the interactive REPL. `ultron help` still prints usage.
  if (!cmd) { await startChat(flags, pos); return; }
  if (cmd === 'help' || cmd === '--help') { help(); return; }
  // `ultron "any free-form prompt"` — anything that isn't a known command is treated as
  // an opening question, answered, and then you stay in the REPL.
  if (!knownCommands.includes(cmd)) { await startChat(flags, [cmd, ...pos]); return; }
  if (cmd === 'providers') { if (flags.json) print(Object.fromEntries(Object.entries(providers).map(([n,p]) => [n,{description:p.description,configured:p.configured(),capabilities:p.capabilities||{}}])), true); else console.log(panel('Provider matrix', await providerRows())); return; }
  if (cmd === 'capabilities') { const selected = flags.provider ? { [flags.provider]: getProvider(flags.provider) } : providers, value = Object.fromEntries(Object.entries(selected).map(([n,p]) => [n,p.capabilities||{}])); if (flags.json) print(value,true); else console.log(panel('Provider capabilities',Object.entries(value).map(([n,caps])=>line(n,Object.entries(caps).filter(([,v])=>v).map(([k])=>k).join(', ')||'basic')))); return; }
  if (cmd === 'models') { const name=flags.provider||'openai',p=getProvider(name);if(!p.listModels)throw new Error(`${name} does not support model discovery`);const models=await p.listModels(requestOpts(flags));if(flags.json){print(models,true);return;}const rows=models.map(m=>[m.id||m.name||JSON.stringify(m),m.contextWindow||m.context_length||'',m.owned_by||m.owner||'']);console.log(table(['model','context','owner'],rows,{align:['left','right','left']}));return; }
  if (cmd === 'doctor') {
    const profile=getPermissionProfile(flags.profile);
    const root=path.resolve(flags.cwd||process.cwd());
    const localLive=await probeLocal();
    let notionStored=null; try { notionStored=loadToken('notion'); } catch { notionStored=null; }
    let agentNames=[],pipelineNames=[],hookSummary={},configErrors=[];
    try { agentNames=Object.keys(await loadAgents(root)); } catch(error){ configErrors.push(`agents: ${error.message}`); }
    try { pipelineNames=(await fsp.readdir(path.join(root,'.ultron','pipelines'))).filter(f=>f.endsWith('.json')).map(f=>f.replace(/\.json$/,'')); } catch { /* none */ }
    let pipelineStatus={};
    for (const name of pipelineNames) {
      try {
        const pipeline=await loadPipeline(root,name);
        const check=validatePipeline(pipeline, agentNames.length?await loadAgents(root):null);
        pipelineStatus[name]=check.valid?`valid · ${computeWaves(pipeline).length} waves`:`INVALID: ${check.errors.join('; ')}`;
        if(!check.valid) configErrors.push(`pipeline ${name}: ${check.errors.join('; ')}`);
      } catch(error){ pipelineStatus[name]=`INVALID: ${error.message}`; configErrors.push(`pipeline ${name}: ${error.message}`); }
    }
    try { const hooks=await loadHookConfig(root); hookSummary=Object.fromEntries(Object.entries(hooks.hooks).map(([event,list])=>[event,list.length])); if(hooks.unknownEvents?.length) configErrors.push(`hooks: unknown event(s) ${hooks.unknownEvents.join(', ')}`); }
    catch(error){ configErrors.push(`hooks: ${error.message}`); }

    const value={
      version:'0.5.0', node:process.version,
      terminal:process.stdout.isTTY?'interactive':'non-interactive',
      timeoutMs:Number(process.env.ULTRON_TIMEOUT_MS||60000),
      maxRetries:Number(process.env.ULTRON_MAX_RETRIES||2),
      permissionProfile:profile,
      providers:Object.fromEntries(Object.entries(providers).map(([n,p])=>[n,p.configured()])),
      localServer:{ baseUrl:localBase(), reachable:localLive },
      notion:{ connected:!!notionStored, workspace:notionStored?.workspaceName||null, expiresAt:notionStored?.expiresAt||null, needsRefresh:notionStored?needsRefresh(notionStored):null, envTokenPresent:!!process.env.NOTION_ACCESS_TOKEN, store:tokenStorePath() },
      subagents:{ root, agents:agentNames, pipelines:pipelineStatus },
      hooks:hookSummary,
      configErrors
    };
    if(flags.json) print(value,true);
    else console.log(panel('Ultron diagnostics',[
      ...(await providerRows()),
      line('node',process.version,'green'),
      line('terminal',value.terminal),
      line('profile',profile.name),
      line('timeout',`${value.timeoutMs}ms`),
      line('retries',String(value.maxRetries)),
      line('local server',`${value.localServer.baseUrl} · ${status(localLive)}`),
      line('notion',notionStored?`${notionStored.workspaceName||'connected'} · ${status(!needsRefresh(notionStored))}`:`not connected · ${status(false)}`),
      line('agents',agentNames.length?agentNames.join(', '):'none'),
      line('pipelines',pipelineNames.length?Object.entries(pipelineStatus).map(([n,s])=>`${n} (${s})`).join(', '):'none'),
      line('hooks',Object.entries(hookSummary).filter(([,n])=>n>0).map(([e,n])=>`${e}:${n}`).join(' ')||'none'),
      line('config errors',configErrors.length?String(configErrors.length):'0',configErrors.length?'red':'green')
    ]));
    if(configErrors.length) process.exitCode=1;
    return;
  }
  if (cmd === 'ask') { const name=flags.provider||'openai',prompt=pos.join(' ').trim();if(!prompt)throw new Error('A prompt is required');if(flags.session==='new')flags.session=sessionId();const result=await askOnce(name,prompt,flags);if(flags.json)print({...result,sessionId:flags.session||null},true);else if(!flags.stream)console.log(result.text);if(!flags.json)usageLine(result);return; }
  if (cmd === 'run') { const name=flags.provider||'openai',prompt=pos.join(' ').trim();if(!prompt)throw new Error('A goal is required');const result=await boundedLoop({provider:getProvider(name),prompt,model:flags.model,maxSteps:clampSteps(flags['max-steps']),onStep:(s,n)=>{if(!flags.json)console.error(`${c.dim}agentic pass ${s}/${n}${c.reset}`)}});if(flags.session)await appendSession(flags.session,{type:'bounded-run',provider:name,prompt,text:result.output,steps:result.steps,converged:result.converged});print(flags.json?result:result.output,flags.json);return; }
  if (cmd === 'chat') { await startChat(flags, pos); return; }
  if (cmd === 'index') {
    const profile = getPermissionProfile(flags.profile);
    // Indexing walks a whole tree and puts its contents in front of a model, so the
    // boundary matters more here than anywhere else: `index C:\Users` on a `read-only`
    // profile used to be permitted, because "read-only" constrained the verb and not
    // the object.
    const root = resolveWithin(profile, pos.shift() || process.cwd(), 'fileRead', 'project indexing');
    const index = await indexProject(root, {
      maxFiles: flags['max-files'] ? Number(flags['max-files']) : undefined,
      maxBytes: flags['max-bytes'] ? Number(flags['max-bytes']) : undefined
    });
    let output;
    if (flags.output) {
      output = resolveWithin(profile, flags.output, 'fileWrite', 'index writing');
      await writeIndex(index, output);
    }
    print(output ? { ...index, files: undefined, output } : index, true);
    return;
  }
  if (cmd === 'git') { const root=path.resolve(pos.shift()||process.cwd());print(await gitContext(root),true);return; }
  if (cmd === 'patch') {
    const raw = pos.shift();
    if (!raw) throw new Error('A patch file is required');
    const profile = getPermissionProfile(flags.profile);
    // Reading the patch needs fileRead; applying it needs fileWrite. Both are confined:
    // a patch file is chosen by whoever runs the command, and `patch --apply` writes
    // wherever the diff's headers point.
    const file = resolveWithin(profile, raw, 'fileRead', 'patch reading');
    const cwd = resolveWithin(profile, flags.cwd || process.cwd(), 'fileRead', 'patch target directory');
    if (flags.apply) requirePermission(profile, 'fileWrite', 'patch application');
    print(await reviewPatch(file, { cwd, apply: !!flags.apply }), true);
    return;
  }
  if (cmd === 'mcp') { const sub=pos.shift(),profile=getPermissionProfile(flags.profile);requirePermission(profile,'shell','MCP process launch');const command=flags.command;if(!command)throw new Error('--command is required');const client=new McpClient(command,flags.args?JSON.parse(flags.args):[],{timeoutMs:flags['timeout-ms']?Number(flags['timeout-ms']):30000});try{await client.start();if(sub==='tools')print(await client.listTools(),true);else if(sub==='call'){if(!flags.tool)throw new Error('--tool is required');print(await client.callTool(flags.tool,flags.input?JSON.parse(flags.input):{}),true);}else throw new Error('Use mcp tools|call');}finally{client.close();}return; }
  if (cmd === 'session') { const sub=pos.shift(),id=pos.shift();if(sub!=='export'||!id)throw new Error('Use session export <id>');const format=flags.format||'jsonl',destination=flags.output?path.resolve(flags.output):undefined,value=await exportSession(id,{format,destination});if(destination)print({sessionId:id,format,output:destination},true);else console.log(value);return; }
  if (cmd === 'completion') { console.log(completion(pos.shift()));return; }
  if (cmd === 'serve') { const name=flags.provider||'openai';await serveAgent({ask:async params=>askOnce(params.provider||name,params.prompt||'',{...flags,...params,json:true,stream:false})});return; }
  if (cmd === 'agents') {
    const root = path.resolve(flags.cwd || process.cwd());
    const agents = await loadAgents(root);
    const names = Object.keys(agents);
    if (flags.json) print(agents, true);
    else if (!names.length) console.log(panel('Subagents', [line('none', `create .ultron/agents/<name>.json under ${root}`)]));
    else console.log(panel('Subagents', names.map(n => line(n, `${agents[n].provider}${agents[n].model ? ` · ${agents[n].model}` : ''} · ${agents[n].permissionProfile}`))));
    return;
  }
  if (cmd === 'pipeline') {
    const sub = pos.shift();
    const name = pos.shift() || flags.pipeline;
    if (!sub || !name) throw new Error('Use pipeline plan|graph|run <name> [--task "..."]');
    const root = path.resolve(flags.cwd || process.cwd());
    const [agents, pipeline] = [await loadAgents(root), await loadPipeline(root, name)];
    const check = validatePipeline(pipeline, Object.keys(agents).length ? agents : null);
    if (!check.valid) { fail(`Invalid pipeline: ${check.errors.join('; ')}`); process.exitCode = 1; return; }

    if (sub === 'graph') { console.log(toMermaid(pipeline)); return; }
    if (sub === 'plan') {
      const waves = computeWaves(pipeline);
      const value = { pipeline: pipeline.name, valid: true, stages: pipeline.stages.length, waves, budget: pipeline.budget || null };
      if (flags.json) print(value, true);
      else console.log(panel(`Plan · ${pipeline.name}`, waves.map((wave, index) => line(`wave ${index + 1}`, wave.join(' ∥ ')))));
      return;
    }
    if (sub !== 'run') throw new Error('Use pipeline plan|graph|run <name>');

    const task = flags.task || pos.join(' ').trim();
    if (!task) throw new Error('pipeline run needs --task "<objective>"');
    const hookConfig = await loadHookConfig(root);
    // Hooks are user-supplied programs that run on every tool call, so they get the same
    // resource ceiling as the rest of the session. Egress is left alone: a hook that consults
    // a service is a legitimate design, and isolating it silently would break it.
    const hookOptions = {
      cwd: root,
      limits: guards.limitsForProfile(getPermissionProfile(flags.profile).name),
    };
    await fireHooks(hookConfig, 'sessionStart', { pipeline: pipeline.name }, hookOptions);

    // A pipeline is waves of parallel stages; a flat event log hides exactly that
    // structure. Render the waves live instead, and keep JSON output untouched.
    const progress = flags.json ? null : new PipelineProgress(pipeline, computeWaves(pipeline));
    progress?.start();

    let result;
    try {
      result = await runPipeline({
        pipeline, agents, task,
        concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
        budget: flags.budget ? { maxStageRuns: Number(flags.budget) } : null,
        onEvent: event => { progress?.handle(event); },
        invoke: async ({ agent, prompt, stage }) => {
          // A preToolUse hook may veto a stage before any provider call is made.
          await guardToolUse(hookConfig, 'subagent', { agent: agent.name, stage: stage.name }, hookOptions);
          const response = await askOnce(agent.provider, prompt, {
            ...flags, model: stage.model || agent.model, stream: false, json: true, noPersist: true, quiet: true,
            messages: agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }, { role: 'user', content: prompt }] : undefined
          });
          return { text: response.text, usage: response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : null, model: response.model };
        }
      });
    } finally {
      progress?.stop();
    }
    if (progress) console.error(`  ${progress.summary()}`);

    await fireHooks(hookConfig, 'sessionEnd', { pipeline: pipeline.name, ok: result.ok }, hookOptions);

    // A pipeline run is the one Ultron operation that spends real money at scale and
    // mutates a working tree, so it is the one that most needs a record nobody can
    // quietly rewrite afterwards. Fields go through the allowlist before they are
    // written: `task` is free-form text supplied by whoever ran the command, and a trail
    // is append-only, so a secret pasted into a task description once is there forever.
    try {
      guards.appendAudit(guards.auditPath(), {
        engine: 'ultron', event: 'pipeline-run',
        ok: !!result.ok, stageRuns: result.stageRuns ?? null,
        ...guards.redact({ pipeline: pipeline.name, task, reason: result.reason || '' })
      });
    } catch (error) {
      // A failure to audit must not destroy a completed run's output - but it must be
      // visible, because an audit trail with silent gaps is worse than none.
      console.error(`${c.dim}audit: could not append (${error.message})${c.reset}`);
    }
    if (flags.session) await appendSession(flags.session, { type: 'pipeline', pipeline: pipeline.name, task, ok: result.ok, reason: result.reason, stageRuns: result.stageRuns });
    if (flags.json) print(result, true);
    else {
      for (const [name, stage] of Object.entries(result.stages)) {
        console.log(`\n${c.dim}── ${name} ${stage.ok ? '' : `(${stage.skipped ? 'skipped' : 'failed'}: ${stage.reason})`}${c.reset}`);
        if (stage.text) console.log(stage.text);
      }
      console.error(`\n${c.dim}${result.ok ? 'complete' : `PARTIAL · ${result.reason}`} · ${result.stageRuns} stage runs · est $${result.estimatedCostUsd}${c.reset}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'notion') {
    const profile=getPermissionProfile(flags.profile);
    const sub=pos.shift(),arg=pos.join(' ').trim();
    if (sub==='login') {
      requirePermission(profile,'notion','Notion OAuth login');
      const rest = flags.path === 'rest';
      // State is generated BEFORE the receiver so the receiver can verify it.
      const state = createState();
      const receiver = await startLoopbackReceiver({ expectedState: state, timeoutMs: Number(flags['timeout-ms']||300000) });
      let authorizeUrl, tokenEndpoint, clientId, clientSecret = null, pkce = null;
      try {
        if (rest) {
          clientId = process.env.NOTION_OAUTH_CLIENT_ID; clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET || null;
          if (!clientId) throw new Error('NOTION_OAUTH_CLIENT_ID is required for --path rest');
          tokenEndpoint = NOTION_REST_TOKEN;
          authorizeUrl = buildAuthorizeUrl({ authorizationEndpoint: NOTION_REST_AUTHORIZE, clientId, redirectUri: receiver.redirectUri, state, extraParams: { owner: 'user' } });
        } else {
          const meta = await discoverMcpAuthServer({});
          if (!meta.registrationEndpoint) throw new Error('Notion authorization server advertises no registration_endpoint; retry with --path rest');
          ({ clientId } = await registerClient({ registrationEndpoint: meta.registrationEndpoint, redirectUri: receiver.redirectUri }));
          tokenEndpoint = meta.tokenEndpoint;
          pkce = createPkcePair();
          authorizeUrl = buildAuthorizeUrl({ authorizationEndpoint: meta.authorizationEndpoint, clientId, redirectUri: receiver.redirectUri, state, challenge: pkce.challenge });
        }
      } catch (error) { receiver.close(); throw error; }
      console.error(`${c.dim}Open this URL and sign in to Notion to authorize Ultron:${c.reset}`);
      console.log(authorizeUrl);
      if (!flags['no-browser'] && process.platform === 'win32') { try { await runCommand('cmd', ['/c','start','',authorizeUrl], { timeoutMs: 10000 }); } catch { /* user opens it manually */ } }
      const { code } = await receiver.waitForCode();
      const tokens = await exchangeCode({ tokenEndpoint, clientId, clientSecret, code, redirectUri: receiver.redirectUri, verifier: pkce?.verifier });
      saveToken('notion', { ...tokens, tokenEndpoint, clientId, clientSecret, path: rest ? 'rest' : 'mcp' });
      print({ connected: true, path: rest ? 'rest' : 'mcp', workspace: tokens.workspaceName || null, expiresAt: tokens.expiresAt, storedAt: tokenStorePath() }, true);
      return;
    }
    if (sub==='status') {
      const stored = loadToken('notion');
      print({ connected: !!stored, path: stored?.path || null, workspace: stored?.workspaceName || null, expiresAt: stored?.expiresAt || null, needsRefresh: stored ? needsRefresh(stored) : null, envTokenPresent: !!process.env.NOTION_ACCESS_TOKEN, store: tokenStorePath() }, true);
      return;
    }
    if (sub==='logout') {
      const removed = deleteToken('notion');
      print({ removed, note: 'Notion documents no token-revocation endpoint, so this only deletes the local copy. Remove the connection in Notion settings to fully revoke access.' }, true);
      return;
    }
    if (sub==='tools' || sub==='call') {
      requirePermission(profile,'notion','Notion MCP access');
      const client = new McpHttpClient(flags.url || NOTION_MCP_RESOURCE, { timeoutMs: flags['timeout-ms'] ? Number(flags['timeout-ms']) : 30000 });
      try {
        await client.start();
        if (sub==='tools') print(await client.listTools(), true);
        else {
          if (!flags.tool) throw new Error('--tool is required (e.g. --tool notion-search)');
          print(await client.callTool(flags.tool, flags.input ? JSON.parse(flags.input) : {}), true);
        }
      } finally { client.close(); }
      return;
    }
    requirePermission(profile,'notion','Notion access');
    if(sub==='search')print(await notionSearch(arg),true);
    else if(sub==='page')print(await notionPage(arg),true);
    else throw new Error('Use notion login|status|logout|search <query>|page <id>');
    return;
  }
  if (cmd === 'route') {
    const task = flags.task || pos.join(' ').trim();
    if (!task) throw new Error('A task description is required: ultron route "<task>"');
    const recommendation = recommendTier(task);
    const model = getModel(recommendation.modelId);
    const value = { task, ...recommendation, provider: model.provider, inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion, contextWindow: model.contextWindow };
    if (flags.json) print(value, true);
    else console.log(panel('Routing recommendation', [line('tier', String(value.tier)), line('model', value.modelId, 'green'), line('provider', value.provider), line('why', value.reason), line('price', value.provider === 'local' ? 'free' : (value.inputUsdPerMillion === 0 && value.outputUsdPerMillion === 0 ? 'unpriced (set env)' : `$${value.inputUsdPerMillion}/$${value.outputUsdPerMillion} per 1M`))]));
    return;
  }
  if (cmd === 'registry') {
    const rows = listModels({ provider: flags.provider });
    const priceLabel = m => m.provider === 'local' ? 'free' : (m.inputUsdPerMillion === 0 && m.outputUsdPerMillion === 0 ? 'unpriced (set env)' : `$${m.inputUsdPerMillion}/$${m.outputUsdPerMillion} per 1M`);
    if (flags.json) print(rows, true);
    else console.log(panel('Model registry', rows.slice().sort((a,b)=>a.tier-b.tier).map(m => line(`t${m.tier} ${m.id}`, `${m.provider} · ${m.contextWindow.toLocaleString('en-US')} ctx · ${priceLabel(m)}`))));
    return;
  }
  if (cmd === 'ide') { const editor=flags.editor||pos.shift()||'code',target=pos.shift()||process.cwd(),map={code:'code',codium:'codium',cursor:'cursor',antigravity:process.env.ULTRON_ANTIGRAVITY_COMMAND||'antigravity',zed:'zed'},executable=map[editor];if(!executable)throw new Error(`Unsupported editor: ${editor}`);if(!await commandExists(executable))throw new Error(`${executable} is not installed or not on PATH`);await runCommand(executable,[target],{timeoutMs:15000});return; }
  if (cmd === 'permissions') { print(permissionProfiles,true);return; }
  if (cmd === 'audit') {
    // Ultron had permission profiles but no record of what it actually did with them.
    // The trail is hash-chained and byte-compatible with Alfred's, so either system can
    // verify the other's history rather than each having to be trusted on its own word.
    const sub = pos.shift() || 'verify';
    const file = guards.auditPath();
    if (sub === 'verify') {
      const state = guards.verifyAudit(file);
      print({ auditLog: file, ...state }, true);
      if (!state.ok) process.exitCode = 2;
      return;
    }
    if (sub === 'checkpoint') {
      // A hash chain cannot detect its own tail being cut off. A witness stored apart
      // from the log can, which is the only reason this subcommand exists.
      print({ checkpoint: `${file}.checkpoints`, ...guards.checkpointAudit(file, `${file}.checkpoints`) }, true);
      return;
    }
    if (sub === 'show') {
      const limit = Number(flags.limit || 20);
      const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit) : [];
      print(lines.map(l => { try { return JSON.parse(l); } catch { return { malformed: l }; } }), true);
      return;
    }
    throw new Error(`Unknown audit subcommand '${sub}'. Use verify, checkpoint or show.`);
  }
  throw new Error(`Unknown command: ${cmd}`);
}
main().catch(error=>{fail(error.message);process.exitCode=1});
