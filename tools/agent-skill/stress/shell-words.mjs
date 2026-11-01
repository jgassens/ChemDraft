/** Parse transcript words only; never expand variables or execute agent commands.
 * POSIX backslashes escape outside single quotes; cmd uses caret and PowerShell
 * uses backtick. Windows paths therefore survive Windows shell payloads. */
export function shellWords(command, { platform = process.platform, shell = platform === 'win32' ? 'cmd' : 'posix' } = {}) {
  const words = [];
  let word = '', active = false, quote = '';
  const push = () => { if (active) words.push(word); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i], next = command[i + 1];
    const escape = shell === 'cmd' ? '^' : shell === 'powershell' ? '`' : '\\';
    if (quote) {
      if (char === quote) {
        if (shell === 'powershell' && quote === "'" && next === "'") { word += "'"; i++; }
        else quote = '';
      } else if (char === escape && next !== undefined &&
        (shell === 'powershell' && quote === '"' || shell === 'posix' && quote === '"' && /["\\$`\n]/.test(next))) {
        i++; if (next !== '\n') word += next;
      } else word += char;
    } else if (char === '"' || char === "'" && shell !== 'cmd') { quote = char; active = true; }
    else if (char === escape && next !== undefined) { i++; if (next !== '\n') { word += next; active = true; } }
    else if (char === '#' && !active && shell !== 'cmd') {
      while (i < command.length && command[i] !== '\n') i++;
      push(); words.push(';');
    } else if (/\s/.test(char)) { push(); if (char === '\n') words.push(';'); }
    else if (/[;&|<>]/.test(char)) {
      push(); let operator = char;
      if (/[<>]/.test(char) && next === char) { operator += next; i++; }
      words.push(operator);
    } else { word += char; active = true; }
  }
  if (quote) throw new Error('Unterminated quoted CLI command');
  push(); return words;
}

/** Explicit shell wrappers choose the payload dialect even on another host. */
export function shellPayload(command, options = {}) {
  let current = command, shell = options.shell ?? (options.platform === 'win32' || !options.platform && process.platform === 'win32' ? 'cmd' : 'posix');
  for (let depth = 0; depth < 10; depth++) {
    const wrapper = current.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+/);
    const executable = (wrapper?.[1] ?? wrapper?.[2] ?? wrapper?.[3] ?? '').split(/[\\/]/).at(-1).toLowerCase();
    const dialect = /^(?:sh|zsh|bash)(?:\.exe)?$/.test(executable) ? 'posix' :
      /^cmd(?:\.exe)?$/.test(executable) ? 'cmd' : /^(?:powershell|pwsh)(?:\.exe)?$/.test(executable) ? 'powershell' : null;
    if (!dialect) break;
    const rest = current.slice(wrapper[0].length);
    const flag = dialect === 'cmd' ? /^(?:(?:\/d|\/s)\s+)*\/c\s+/i.exec(rest) :
      /^(?:(?:-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+\S+)\s+)*(?:-[A-Za-z]*c[A-Za-z]*|--command|-Command)\s+/i.exec(rest);
    if (!flag) break;
    const payload = rest.slice(flag[0].length).trim();
    if (dialect === 'cmd') {
      current = payload.startsWith('"') && payload.endsWith('"') ? payload.slice(1, -1) : payload;
    } else {
      // A wrapper's single quoted command is literal; a double quoted command
      // follows the quoting of the launching shell (POSIX for POSIX wrappers).
      const words = shellWords(payload, { shell: dialect === 'posix' ? 'posix' : 'powershell' });
      current = dialect === 'posix' || words.length === 1 ? words[0] : payload;
    }
    shell = dialect;
  }
  return { command: current, shell };
}

export function unwrapShell(command, options = {}) { return shellPayload(command, options).command; }
export function commandWords(command, options = {}) {
  const payload = shellPayload(command, options);
  return shellWords(payload.command, { ...options, shell: payload.shell });
}
