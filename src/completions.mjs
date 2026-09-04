// Shell completions. Kept in sync with the command router in bin/ultron.mjs and the
// provider table in src/providers.mjs — there is a test asserting both stay aligned.
export const commands = [
  'providers', 'capabilities', 'models', 'registry', 'route', 'doctor',
  'ask', 'run', 'chat', 'index', 'git', 'patch', 'ai', 'mcp', 'session',
  'agents', 'pipeline', 'notion', 'completion', 'serve', 'permissions', 'audit', 'ide', 'help'
];
export const providerNames = ['alfred', 'openai', 'anthropic', 'kimi', 'deepseek', 'zai', 'local', 'custom', 'kiro', 'claude-code', 'openclaw'];
export const subcommands = Object.freeze({
  pipeline: ['plan', 'graph', 'run'],
  notion: ['login', 'status', 'logout', 'tools', 'call', 'search', 'page'],
  mcp: ['tools', 'call'],
  ai: ['commit', 'pr', 'review', 'changelog'],
  session: ['export'],
  audit: ['verify', 'checkpoint', 'show'],
  completion: ['bash', 'zsh', 'fish', 'powershell']
});

export function completion(shell) {
  const words = commands.join(' ');
  const providerWords = providerNames.join(' ');
  const allSubs = [...new Set(Object.values(subcommands).flat())].join(' ');

  if (shell === 'bash') {
    return `_ultron(){ local cur="${'${COMP_WORDS[COMP_CWORD]}'}" prev="${'${COMP_WORDS[COMP_CWORD-1]}'}";
  case "$prev" in
    pipeline) COMPREPLY=( $(compgen -W "${subcommands.pipeline.join(' ')}" -- "$cur") ); return;;
    notion)   COMPREPLY=( $(compgen -W "${subcommands.notion.join(' ')}" -- "$cur") ); return;;
    mcp)      COMPREPLY=( $(compgen -W "${subcommands.mcp.join(' ')}" -- "$cur") ); return;;
    --provider) COMPREPLY=( $(compgen -W "${providerWords}" -- "$cur") ); return;;
  esac
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") ); }
complete -F _ultron ultron\n`;
  }
  if (shell === 'zsh') return `#compdef ultron\n_arguments '1:command:(${words})' '2:subcommand:(${allSubs})' '*:argument'\n`;
  if (shell === 'fish') {
    const lines = commands.map(x => `complete -c ultron -f -n '__fish_use_subcommand' -a '${x}'`);
    for (const [command, subs] of Object.entries(subcommands)) {
      lines.push(`complete -c ultron -f -n '__fish_seen_subcommand_from ${command}' -a '${subs.join(' ')}'`);
    }
    lines.push(`complete -c ultron -f -l provider -a '${providerWords}'`);
    return lines.join('\n') + '\n';
  }
  if (shell === 'powershell') {
    return `Register-ArgumentCompleter -Native -CommandName ultron -ScriptBlock {
  param($wordToComplete, $commandAst)
  $text = $commandAst.ToString()
  $pool = switch -Regex ($text) {
    '\\bpipeline\\s+\\S*$' { '${subcommands.pipeline.join(' ')}' }
    '\\bnotion\\s+\\S*$'   { '${subcommands.notion.join(' ')}' }
    '\\bmcp\\s+\\S*$'      { '${subcommands.mcp.join(' ')}' }
    '--provider\\s+\\S*$'  { '${providerWords}' }
    default                { '${words}' }
  }
  $pool.Split(' ') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}\n`;
  }
  throw new Error(`Unsupported shell: ${shell}`);
}
