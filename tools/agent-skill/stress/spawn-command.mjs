import path from 'node:path';
import { existsSync } from 'node:fs';

function pathValue(environment) {
  return environment.PATH ?? environment.Path ?? '';
}

// cmd.exe parses this one command-line argument before the npm .cmd shim sees
// it.  Quote each value so shell metacharacters remain data, and double percent
// signs because npm's shims are batch files (where %% represents a literal %).
export function quoteWindowsCmdArgument(value) {
  return `"${String(value)
    .replace(/(["])/g, '\\$1')
    .replace(/([%])/g, '%%')
    .replace(/([\^&|<>()])/g, '^$1')}"`;
}

export function resolveWindowsCommand(command, {
  platform = process.platform,
  environment = process.env,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32' || path.win32.dirname(command) !== '.') return command;
  const extensions = command.includes('.')
    ? ['']
    : (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const directory of pathValue(environment).split(';').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

export function spawnCommandSpec(command, args, {
  platform = process.platform,
  environment = process.env,
  exists = existsSync,
} = {}) {
  // Node fixtures work on Windows too, without relying on executable shebangs.
  const binary = command.endsWith('.mjs') ? process.execPath : command;
  const commandArgs = command.endsWith('.mjs') ? [command, ...args] : args;
  if (platform !== 'win32') return { command: binary, args: commandArgs };

  const resolved = resolveWindowsCommand(binary, { platform, environment, exists });
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command: resolved, args: commandArgs };
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `${quoteWindowsCmdArgument(resolved)} ${commandArgs.map(quoteWindowsCmdArgument).join(' ')}`],
  };
}

