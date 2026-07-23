import readline from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { Conversation, CHAT_HELP, parseChatCommand } from './chat.mjs';
import { appendSession, loadSession, sessionId as createSessionId } from './sessions.mjs';

async function multiline(rl, output) { output.write('multiline mode · finish with a single .\n'); const lines=[]; while(true){const line=await rl.question('... ');if(line==='.')break;lines.push(line);}return lines.join('\n').trim(); }
export async function handleChatCommand(command,{conversation,rl,output,providerExists=()=>true,root=process.cwd(),sessionDir}={}){
  const reply=text=>output.write(`${text}\n`);
  if(command.name==='help'){reply(CHAT_HELP);return{};}
  if(command.name==='exit'||command.name==='quit')return{exit:true};
  if(command.name==='clear'){conversation.clear();reply('conversation memory cleared');return{};}
  if(command.name==='provider'){if(!command.argument)throw new Error('Use /provider <name>');if(!providerExists(command.argument))throw new Error(`Unknown provider: ${command.argument}`);conversation.provider=command.argument;reply(`provider: ${conversation.provider}`);return{};}
  if(command.name==='model'){conversation.model=!command.argument||command.argument==='default'?null:command.argument;reply(`model: ${conversation.model||'provider default'}`);return{};}
  if(command.name==='context'){reply(JSON.stringify(conversation.contextStats(),null,2));return{};}
  if(command.name==='index'){const index=await conversation.addIndex(command.argument||root);reply(`indexed ${index.fileCount} files · ${index.totalBytes} bytes${index.truncated?' · truncated':''}`);return{};}
  if(command.name==='git'){const git=await conversation.addGit(command.argument||root);reply(`git ${git.branch||'detached'} · ${git.status.length?`${git.status.length} changed path(s)`:'clean'}`);return{};}
  if(command.name==='add'){if(!command.argument)throw new Error('Use /add <project-relative-file>');const file=await conversation.addFile(command.argument,{root});reply(`attached ${file}`);return{};}
  if(command.name==='drop'){if(!command.argument)throw new Error('Use /drop <file|all>');reply(`removed ${conversation.dropFile(command.argument)} attachment(s)`);return{};}
  if(command.name==='multi')return{prompt:await multiline(rl,output)};
  if(command.name==='save'){reply(`session: ${conversation.sessionId}`);return{};}
  if(command.name==='resume'){if(!command.argument)throw new Error('Use /resume <session-id>');const records=await loadSession(command.argument,sessionDir);conversation.sessionId=command.argument;const count=conversation.restore(records);reply(`resumed ${command.argument} · ${count} messages`);return{};}
  throw new Error(`Unknown chat command: /${command.name}. Use /help.`);
}

export async function runInteractiveChat({provider='openai',model=null,sessionId=createSessionId(),maxChars,stream=true,root=process.cwd(),input=defaultInput,output=defaultOutput,ask,providerExists,sessionDir,onUsage=()=>{}}={}){
  if(!ask)throw new Error('Interactive chat requires an ask function');const conversation=new Conversation({provider,model,sessionId,maxChars});const rl=readline.createInterface({input,output});
  output.write(`ULTRON interactive · provider ${provider} · session ${sessionId}\nType /help for commands. Ctrl+C cancels a response; /exit leaves chat.\n`);
  try{
    while(true){let entered;try{entered=await rl.question('you › ');}catch(error){if(error?.code==='ABORT_ERR')continue;throw error;}if(!entered.trim())continue;let prompt=entered;const command=parseChatCommand(entered);if(command){try{const action=await handleChatCommand(command,{conversation,rl,output,providerExists,root,sessionDir});if(action.exit)break;if(action.prompt==null)continue;prompt=action.prompt;if(!prompt)continue;}catch(error){output.write(`error ${error.message}\n`);continue;}}
      conversation.addUser(prompt);const controller=new AbortController();let cancelled=false;const cancel=()=>{cancelled=true;controller.abort(new Error('Cancelled by user'));output.write('\ncancelling response…\n');};process.once('SIGINT',cancel);
      try{const result=await ask({provider:conversation.provider,model:conversation.model,prompt,messages:conversation.providerMessages(),stream,signal:controller.signal,onToken:token=>output.write(token)});if(result.streamed)output.write('\n');else output.write(`ai  › ${result.text}\n`);conversation.addAssistant(result.text);await appendSession(conversation.sessionId,{type:'turn',provider:conversation.provider,model:result.model||conversation.model,prompt,text:result.text,usage:result.usage},sessionDir);onUsage(result);}
      catch(error){if(cancelled||controller.signal.aborted)output.write('response cancelled; conversation remains active\n');else output.write(`error ${error.message}\n`);}
      finally{process.removeListener('SIGINT',cancel);}
    }
  } finally { rl.close(); }
  return conversation.contextStats();
}
