import { promises as fs } from 'node:fs';
import path from 'node:path';
import { indexProject } from './indexer.mjs';
import { gitContext } from './git.mjs';

const DEFAULT_SYSTEM = 'You are Ultron, a secure developer assistant. Use supplied project context, distinguish facts from assumptions, never claim to execute commands, and require explicit user approval before any mutating action.';
export const CHAT_HELP = `Interactive commands:
  /help                 Show commands
  /clear                Clear conversation memory
  /exit                 Leave chat
  /provider <name>      Switch provider
  /model <id>           Switch model (/model default clears override)
  /context              Show memory and attachments
  /index [path]         Add an ignore-aware project index summary
  /git [path]           Add current Git context
  /add <file>            Attach a text file (read-only)
  /drop <file|all>       Remove an attachment
  /multi                 Enter multiline mode; finish with a single .
  /save                  Confirm the active session id
  /resume <session-id>   Restore turns from a saved session`;

function textOf(message) { return typeof message.content === 'string' ? message.content : JSON.stringify(message.content); }
export class Conversation {
  constructor({ provider = 'openai', model = null, sessionId, maxChars = Number(process.env.ULTRON_CHAT_MAX_CHARS || 60000), system = DEFAULT_SYSTEM } = {}) { this.provider = provider; this.model = model; this.sessionId = sessionId; this.maxChars = maxChars; this.system = system; this.messages = []; this.attachments = new Map(); this.projectContext = []; this.omittedMessages = 0; }
  add(role, content) { if (!['user','assistant'].includes(role)) throw new Error(`Invalid chat role: ${role}`); this.messages.push({ role, content: String(content) }); this.compact(); }
  addUser(content) { this.add('user', content); } addAssistant(content) { this.add('assistant', content); }
  clear() { this.messages = []; this.projectContext = []; this.omittedMessages = 0; }
  compact() { while (this.characterCount() > this.maxChars && this.messages.length > 2) { this.messages.shift(); this.omittedMessages++; } }
  characterCount() { return this.messages.reduce((n,m)=>n+textOf(m).length,0) + [...this.attachments.values()].reduce((n,a)=>n+a.content.length,0) + this.projectContext.reduce((n,x)=>n+x.length,0); }
  contextStats() { return { provider:this.provider, model:this.model, sessionId:this.sessionId, turns:this.messages.filter(x=>x.role==='user').length, messages:this.messages.length, omittedMessages:this.omittedMessages, characters:this.characterCount(), maxCharacters:this.maxChars, attachments:[...this.attachments.keys()], projectContextItems:this.projectContext.length }; }
  providerMessages() { const context = []; if (this.omittedMessages) context.push(`${this.omittedMessages} earlier messages were omitted to stay within the configured context bound.`); if (this.projectContext.length) context.push(...this.projectContext); for (const [name,item] of this.attachments) context.push(`Attached file: ${name}\n\n${item.content}`); const system = context.length ? `${this.system}\n\nProject context:\n${context.join('\n\n---\n\n')}` : this.system; return [{role:'system',content:system},...this.messages]; }
  transcriptPrompt() { return this.providerMessages().map(m=>`${m.role.toUpperCase()}:\n${m.content}`).join('\n\n') + '\n\nASSISTANT:\n'; }
  async addFile(file, { root = process.cwd(), maxBytes = 65536 } = {}) { const resolved=path.resolve(root,file),relative=path.relative(path.resolve(root),resolved);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Attachment must be inside the project root');const stat=await fs.stat(resolved);if(!stat.isFile())throw new Error('Attachment is not a file');if(stat.size>maxBytes)throw new Error(`Attachment exceeds ${maxBytes} bytes`);const buffer=await fs.readFile(resolved);if(buffer.includes(0))throw new Error('Binary attachments are not supported');this.attachments.set(relative.split(path.sep).join('/'),{path:resolved,content:buffer.toString('utf8')});this.compact();return relative; }
  dropFile(name) { if(name==='all'){const count=this.attachments.size;this.attachments.clear();return count;}return this.attachments.delete(name)?1:0; }
  async addIndex(root=process.cwd()) { const index=await indexProject(root,{maxFiles:2000,maxBytes:1_000_000});const summary=`Project index (${index.root}): ${index.fileCount} files, ${index.totalBytes} bytes${index.truncated?', truncated':''}.\n${index.files.filter(f=>!f.binary).slice(0,500).map(f=>`- ${f.path} (${f.bytes} bytes)`).join('\n')}`;this.projectContext.push(summary);this.compact();return index; }
  async addGit(root=process.cwd()) { const git=await gitContext(root);this.projectContext.push(`Git context (${root}):\nBranch: ${git.branch||'unknown'}\nStatus:\n${git.status.join('\n')||'clean'}\nDiff stat:\n${git.diffStat.join('\n')||'none'}`);this.compact();return git; }
  restore(records=[]) { this.clear(); for(const record of records){if(record.type==='turn'){if(record.prompt)this.messages.push({role:'user',content:record.prompt});if(record.text)this.messages.push({role:'assistant',content:record.text});if(record.provider)this.provider=record.provider;if(record.model)this.model=record.model;}}this.compact();return this.messages.length; }
}

export function parseChatCommand(input) { const trimmed=input.trim();if(!trimmed.startsWith('/'))return null;const [name,...rest]=trimmed.slice(1).split(/\s+/);return {name:name.toLowerCase(),argument:rest.join(' ').trim()}; }
