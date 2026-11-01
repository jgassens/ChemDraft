import { describe, expect, it } from 'vitest';
// @ts-expect-error The harness modules are plain JavaScript.
import { shellWords, commandWords, shellPayload } from './shell-words.mjs';
// @ts-expect-error The harness modules are plain JavaScript.
import { cliCalls, heredocFiles } from './grader/extract.mjs';
// @ts-expect-error The harness modules are plain JavaScript.
import { spawnCommandSpec } from './spawn-command.mjs';

describe('shared transcript shell lexer', () => {
  it('applies POSIX quoting and concatenation without executing substitutions', () => {
    expect(shellWords(String.raw`pnpm --out 'a b'".svg" --smiles 'C/C=C\C' escaped\ word "$HOME"`, { platform: 'darwin' }))
      .toEqual(['pnpm', '--out', 'a b.svg', '--smiles', 'C/C=C\\C', 'escaped word', '$HOME']);
    expect(shellWords(String.raw`'C:\Users\x' "C:\Users\x" C:\Users\x`, { shell: 'posix' }))
      .toEqual(['C:\\Users\\x', 'C:\\Users\\x', 'C:Usersx']);
  });

  it('preserves Windows paths using the platform parameter and Windows escape rules', () => {
    expect(shellWords(String.raw`pnpm --dir C:\Users\x --out "C:\my files\a.svg" a^&b`, { platform: 'win32' }))
      .toEqual(['pnpm', '--dir', 'C:\\Users\\x', '--out', 'C:\\my files\\a.svg', 'a&b']);
    expect(shellWords("'it''s' `" + '"quoted`"' + ' "a` b"', { shell: 'powershell' }))
      .toEqual(["it's", '"quoted"', 'a b']);
  });

  for (const wrapper of ['cmd /c', 'cmd.exe /d /s /c', 'powershell -Command', 'powershell -c', 'pwsh -Command', 'pwsh -c']) {
    it(`extracts ChemDraft from ${wrapper} on a macOS host`, () => {
      const command = `${wrapper} "pnpm -s --dir C:\\path chemdraft render --smiles CCO --out C:\\Users\\x\\a.svg"`;
      expect(commandWords(command, { platform: 'darwin' })).toContain('C:\\Users\\x\\a.svg');
      expect(cliCalls(command, { platform: 'darwin' })).toMatchObject([{ verb: 'render', options: { smiles: ['CCO'], out: ['C:\\Users\\x\\a.svg'] } }]);
    });
  }

  it('lets explicit POSIX wrappers override a Windows host and supports nested wrappers', () => {
    expect(shellPayload(`/bin/bash -lc "pnpm -s chemdraft render --smiles 'C/C=C\\\\C'"`, { platform: 'win32' }).shell).toBe('posix');
    expect(cliCalls(`zsh -lc 'bash -c "pnpm -s chemdraft render --smiles CCO"'`)).toMatchObject([{ verb: 'render' }]);
    expect(cliCalls(`bash -cl 'pnpm -s chemdraft render --smiles CCO' argv0`)).toMatchObject([{ verb: 'render' }]);
    expect(commandWords(`cmd /c "echo x >C:\\Users\\x\\a.json"`)).toEqual(['echo', 'x', '>', 'C:\\Users\\x\\a.json']);
  });

  for (const header of ["cat >file.json <<'EOF'", "cat <<'EOF' > file.json", 'cat <<EOF >file.json', "tee file.json <<'EOF'", 'tee <<EOF file.json']) {
    it(`recovers retained batch input from ${header}`, () => {
      expect(heredocFiles(`${header}\n[{"smiles":"CCO"}]\nEOF\n`).get('file.json')).toBe('[{"smiles":"CCO"}]');
    });
  }

  it('launches the verifier pnpm shim using the runner Windows spawn helper', () => {
    const shim = 'C:\\tools\\pnpm.CMD';
    const specification = spawnCommandSpec('pnpm', ['-s', '--dir', 'C:\\my repo', 'chemdraft', 'stereo'], {
      platform: 'win32', environment: { PATH: 'C:\\tools', PATHEXT: '.CMD' }, exists: (candidate: string) => candidate === shim,
    });
    expect(specification.command).toBe('cmd.exe');
    expect(specification.args).toEqual(['/d', '/s', '/c', '"C:\\tools\\pnpm.CMD" "-s" "--dir" "C:\\my repo" "chemdraft" "stereo"']);
  });
});
