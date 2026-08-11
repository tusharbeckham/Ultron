import readline from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { Conversation, CHAT_HELP, parseChatCommand } from './chat.mjs';
import { appendSession, loadSession, sessionId as createSessionId } from './sessions.mjs';

async function multiline(readLine, output) { output.write('multiline mode · finish with a single .\n'); const lines=[]; while(true){const line=await readLine('... ');if(line==null||line==='.')break;lines.push(line);}return lines.join('\n').trim(); }export async function handleChatCommand(command,{conversation,rl,output,providerExists=()=>true,root=process.cwd(),sessionDir,askLine}={}){
  const reply=text=>output.write(`${text}\n`);
  if(command.name==='help'){reply(CHAT_HELP);return{};}
  if(command.name==='exit'||command.name==='quit')return{exit:true};
  if(command.name==='clear'){conversation.clear();reply('conversation memory cleared');return{};}
  if(command.name==='provider'){if(!command.argument)throw new Error('Use /provider <name>');if(!providerExists(command.argument))throw new Error(`Unknown provider: ${command.argument}`);conversation.provider=command.argument;reply(`provider: ${conversation.provider}`);return{};}
  if(command.name==='model'){
    // `/model` alone REPORTS; `/model default` clears; `/model <id>` sets.
    if(!command.argument){reply(`model: ${conversation.model||'provider default'}`);return{};}
    conversation.model=command.argument==='default'?null:command.argument;
    reply(`model: ${conversation.model||'provider default'}`);return{};
  }
  if(command.name==='context'){reply(JSON.stringify(conversation.contextStats(),null,2));return{};}
  if(command.name==='index'){const index=await conversation.addIndex(command.argument||root);reply(`indexed ${index.fileCount} files · ${index.totalBytes} bytes${index.truncated?' · truncated':''}`);return{};}
  if(command.name==='git'){const git=await conversation.addGit(command.argument||root);reply(`git ${git.branch||'detached'} · ${git.status.length?`${git.status.length} changed path(s)`:'clean'}`);return{};}
  if(command.name==='add'){if(!command.argument)throw new Error('Use /add <project-relative-file>');const file=await conversation.addFile(command.argument,{root});reply(`attached ${file}`);return{};}
  if(command.name==='drop'){if(!command.argument)throw new Error('Use /drop <file|all>');reply(`removed ${conversation.dropFile(command.argument)} attachment(s)`);return{};}
  if(command.name==='multi')return{prompt:await multiline(askLine||(prompt=>rl.question(prompt)),output)};
  if(command.name==='save'){reply(`session: ${conversation.sessionId}`);return{};}
  if(command.name==='resume'){if(!command.argument)throw new Error('Use /resume <session-id>');const records=await loadSession(command.argument,sessionDir);conversation.sessionId=command.argument;const count=conversation.restore(records);reply(`resumed ${command.argument} · ${count} messages`);return{};}
  throw new Error(`Unknown chat command: /${command.name}. Use /help.`);
}

export async function runInteractiveChat({provider='alfred',model=null,sessionId=createSessionId(),maxChars,stream=true,root=process.cwd(),input=defaultInput,output=defaultOutput,ask,providerExists,sessionDir,onUsage=()=>{},banner:showBanner=true,opening=''}={}){
  if(!ask)throw new Error('Interactive chat requires an ask function');
  const conversation=new Conversation({provider,model,sessionId,maxChars});
  const rl=readline.createInterface({input,output,historySize:200});
  let closed=false;
  // readline emits 'line' eagerly, so lines that arrive while we are awaiting the model
  // would be dropped by rl.question(). Queue them instead — correct for TTY and pipes alike.
  const queued=[];
  let waiter=null;
  rl.on('line',value=>{ if(waiter){const resolve=waiter;waiter=null;resolve(value);} else queued.push(value); });
  rl.once('close',()=>{ closed=true; if(waiter){const resolve=waiter;waiter=null;resolve(null);} });
  const askLine=async promptText=>{
    if(queued.length)return queued.shift();
    if(closed)return null;
    output.write(promptText);
    return new Promise(resolve=>{waiter=resolve;});
  };
  const colour=!process.env.NO_COLOR&&output.isTTY;
  const tint=(code,text)=>colour?`\x1b[${code}m${text}\x1b[0m`:text;
  const label=()=>`${conversation.provider}${conversation.model?`:${conversation.model}`:''}`;

  if(showBanner){
    output.write(`\n${tint('1;94','ULTRON interactive')} ${tint('2',`· ${label()} · session ${sessionId}`)}\n`);
    output.write(`${tint('2','/help for commands · /exit to leave · Ctrl+C cancels a reply')}\n\n`);
  } else {
    output.write(`ULTRON interactive · provider ${provider} · session ${sessionId}\n`);
  }

  try{
    let pending=opening&&opening.trim()?opening.trim():null;
    while(true){
      let entered;
      if(pending!=null){entered=pending;pending=null;output.write(`${tint('1;36','› ')}${entered}\n`);}
      else{
        try{entered=await askLine(tint('1;36','› '));}
        catch(error){
          if(error?.code==='ABORT_ERR')continue;
          // stdin closed (piped input exhausted, or Ctrl+D): leave cleanly, not with an error.
          if(error?.code==='ERR_USE_AFTER_CLOSE'||/readline was closed/i.test(error?.message||''))break;
          throw error;
        }
        if(entered==null)break;
      }
      if(!entered.trim())continue;
      let prompt=entered;
      const command=parseChatCommand(entered);
      if(command){
        try{
          const action=await handleChatCommand(command,{conversation,rl,output,providerExists,root,sessionDir,askLine});
          if(action.exit)break;
          if(action.prompt==null)continue;
          prompt=action.prompt;
          if(!prompt)continue;
        }catch(error){output.write(`${tint('31','error')} ${error.message}\n`);continue;}
      }
      conversation.addUser(prompt);
      const controller=new AbortController();
      let cancelled=false;
      const cancel=()=>{cancelled=true;controller.abort(new Error('Cancelled by user'));output.write(`\n${tint('33','cancelling…')}\n`);};
      process.once('SIGINT',cancel);
      const started=Date.now();
      try{
        let firstToken=true;
        const result=await ask({provider:conversation.provider,model:conversation.model,prompt,messages:conversation.providerMessages(),stream,signal:controller.signal,
          onToken:token=>{if(firstToken){output.write(tint('2',`${label()} ▍\n`));firstToken=false;}output.write(token);}});
        if(result.streamed)output.write('\n');
        else output.write(`${tint('2',`${label()} ▍`)}\n${result.text}\n`);
        conversation.addAssistant(result.text);
        await appendSession(conversation.sessionId,{type:'turn',provider:conversation.provider,model:result.model||conversation.model,prompt,text:result.text,usage:result.usage},sessionDir);
        const seconds=((Date.now()-started)/1000).toFixed(1);
        const tokens=result.usage?`${result.usage.inputTokens}→${result.usage.outputTokens} tok · `:'';
        output.write(`${tint('2',`${tokens}${seconds}s`)}\n\n`);
        onUsage(result);
      }
      catch(error){
        if(cancelled||controller.signal.aborted)output.write(`${tint('33','response cancelled')} ${tint('2','· conversation is still active')}\n\n`);
        else output.write(`${tint('31','error')} ${error.message}\n\n`);
      }
      finally{process.removeListener('SIGINT',cancel);}
    }
  } finally { rl.close(); }
  return conversation.contextStats();
}
