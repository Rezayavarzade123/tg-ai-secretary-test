import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Windows support has two halves and only one of them can be run here.
//
// The JavaScript half is tested for real elsewhere (hardware flags, env files).
// The PowerShell half cannot be executed on a Linux CI box without downloading a
// 70 MB runtime, so this file does the next best thing: it tokenises the scripts
// the way PowerShell does (strings, comments, here-strings), then checks the things
// that actually break real installers — unbalanced braces, syntax that only exists
// in PowerShell 7 while the scripts claim 5.1, and the two front ends drifting
// apart in which commands they offer.

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * Split PowerShell source into code and non-code, and check bracket balance.
 *
 * Handles: 'single' ("''" escapes), "double" (`"`" and backtick escapes),
 * @"..."@ and @'...'@ here-strings, # line comments and <# block comments #>.
 * Returns the source with everything but code replaced by spaces, so later checks
 * cannot match text inside a help string.
 */
function analysePowerShell(source, name) {
  const code = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < code.length; i += 1) if (code[i] !== '\n') code[i] = ' ';
  };
  const stack = [];
  const pairs = { '}': '{', ')': '(', ']': '[' };
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    // Block comment first: <# ... #>
    if (c === '<' && source[i + 1] === '#') {
      const end = source.indexOf('#>', i + 2);
      assert.notEqual(end, -1, `${name}: unterminated <# block comment at offset ${i}`);
      blank(i, end + 2);
      i = end + 2;
      continue;
    }

    // Line comment
    if (c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // Here-strings: @' then a newline, ending with '@ at the start of a line.
    if (c === '@' && (source[i + 1] === "'" || source[i + 1] === '"')) {
      const quote = source[i + 1];
      const afterQuote = source[i + 2];
      if (afterQuote === '\r' || afterQuote === '\n') {
        const terminator = new RegExp(`\\r?\\n['"]@`, 'g');
        terminator.lastIndex = i;
        const m = terminator.exec(source);
        assert.ok(m, `${name}: unterminated here-string starting at offset ${i}`);
        const stop = m.index + m[0].length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    // Single-quoted string, '' is a literal quote
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= source.length) assert.fail(`${name}: unterminated single-quoted string at offset ${i}`);
        if (source[j] === "'") {
          if (source[j + 1] === "'") { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // Double-quoted string: backtick escapes, "" is a literal quote
    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= source.length) assert.fail(`${name}: unterminated double-quoted string at offset ${i}`);
        if (source[j] === '`') { j += 2; continue; }
        if (source[j] === '"') {
          if (source[j + 1] === '"') { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '{' || c === '(' || c === '[') { stack.push({ c, i }); i += 1; continue; }
    if (c === '}' || c === ')' || c === ']') {
      const open = stack.pop();
      assert.ok(open, `${name}: unexpected '${c}' at offset ${i}`);
      assert.equal(pairs[c], open.c, `${name}: '${c}' at offset ${i} closes '${open.c}' opened at ${open.i}`);
      i += 1;
      continue;
    }

    i += 1;
  }

  assert.equal(stack.length, 0, `${name}: unclosed '${stack.map((s) => s.c).join('')}'`);
  return code.join('');
}

const installPs1 = read('install.ps1');
const uninstallPs1 = read('uninstall.ps1');
const cliPs1 = read('bin/tg-secretary.ps1');
const cliCmd = read('bin/tg-secretary.cmd');
const cliSh = read('bin/tg-secretary');

const codeInstall = analysePowerShell(installPs1, 'install.ps1');
const codeUninstall = analysePowerShell(uninstallPs1, 'uninstall.ps1');
const codeCli = analysePowerShell(cliPs1, 'bin/tg-secretary.ps1');

// --- it is Windows-shaped, and honest about what it is ------------------------

test('the three Windows scripts exist and announce PowerShell 5.1', () => {
  for (const file of ['install.ps1', 'uninstall.ps1', 'bin/tg-secretary.ps1']) {
    const text = read(file);
    assert.match(text, /#Requires -Version 5\.1/, `${file} should state its minimum`);
  }
  assert.ok(fs.statSync(path.join(root, 'bin', 'tg-secretary.cmd')).isFile());
});

test('the installer takes the same decisions as install.sh', () => {
  for (const flag of ['-Dir', '-Token', '-Port', '-Listen', '-TimeZone', '-Model', '-Force', '-Yes']) {
    assert.ok(installPs1.includes(flag), `install.ps1 should accept ${flag}`);
  }
  assert.match(installPs1, /SupportsShouldProcess/, 'so -WhatIf works');
  // The four things that make the Linux version safe, in Windows spelling.
  assert.match(installPs1, /Register-ScheduledTask/);
  assert.match(installPs1, /RestartCount\s+999/, 'the task restarts, which is what lets /update hand over');
  assert.match(installPs1, /icacls/, 'the token file gets an ACL, not a mode');
  assert.match(installPs1, /\. \(\\$env:LOCALAPPDATA\)|LOCALAPPDATA/, 'per-user default location');
  assert.match(installPs1, /ProgramData/, 'machine-wide default location when elevated');
});

test('native tools are run through a helper that does not treat stderr as failure', () => {
  // The bug this exists for: "git.exe : From https://..." appeared on a real Windows
  // box and aborted the install. git writes progress to stderr; PowerShell 5.1 turns
  // redirected native stderr into an error record, and with $ErrorActionPreference
  // = 'Stop' that is a terminating NativeCommandError thrown before $LASTEXITCODE can
  // be read. The exit code is the verdict, so the helper relaxes the preference for
  // the duration of the call only.
  const start = installPs1.indexOf('function Invoke-Native {');
  assert.ok(start > 0, 'install.ps1 should have an Invoke-Native helper');
  let depth = 0;
  let end = start;
  for (let i = installPs1.indexOf('{', start); i < installPs1.length; i += 1) {
    if (installPs1[i] === '{') depth += 1;
    else if (installPs1[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = installPs1.slice(start, end);

  const relax = body.indexOf("$ErrorActionPreference = 'Continue'");
  const invoke = body.indexOf('& $File @Arguments');
  assert.ok(relax > 0, 'Invoke-Native must relax $ErrorActionPreference');
  assert.ok(invoke > relax, 'the preference has to be relaxed before the call, not after');
  assert.match(body, /\$LASTEXITCODE/, 'the exit code, not the stderr text, decides');

  // Nothing else may redirect a native tool's stderr into the error stream.
  const redirected = [...installPs1.matchAll(/^.*&\s+\S+[^\n]*2>&1.*$/gm)].map((m) => m[0].trim());
  assert.ok(redirected.length > 0, 'the helper itself should merge stderr');
  for (const line of redirected) {
    assert.match(line, /& \$File @Arguments 2>&1/, `stderr is merged outside Invoke-Native: ${line}`);
  }

  // git, icacls and "node -v" all went through it, because each of them talks on stderr.
  assert.ok(!/&\s+icacls\b/.test(installPs1), 'icacls should go through Invoke-Native');
  assert.ok(!/\(&\s+\$NodePath/.test(installPs1), 'node should go through Invoke-Native');
  assert.ok(!/&\s+git\b/.test(installPs1), 'git should go through Invoke-Native');
});

test('the token is never written into the checkout when installing for all users', () => {
  // Elevated installs put settings in ProgramData, next to nothing else, which is
  // the Windows counterpart of /etc/secretary-bot.env - and bot/env.mjs reads it.
  assert.match(installPs1, /Join-Path \$env:ProgramData 'tg-ai-secretary'/);
  const env = read('bot/env.mjs');
  assert.match(env, /tg-ai-secretary', 'bot\.env'/, 'bot/env.mjs must look where install.ps1 writes');
});

test('it measures the CPU instead of guessing on Windows', () => {
  assert.match(installPs1, /IsProcessorFeaturePresent/);
  // Bit 40 is AVX2; the ARM64 path must not pretend it applies.
  assert.match(installPs1, /40\s*=\s*'avx2'/);
  assert.match(installPs1, /ARM64/);
  // ...and the measurement has to reach the report, or it was pointless.
  assert.match(installPs1, /SECRETARY_CPU_FLAGS=/);
  const hw = read('bot/hardware.mjs');
  assert.match(hw, /SECRETARY_CPU_FLAGS/);
});

test('no PowerShell 7-only syntax, because the scripts promise 5.1', () => {
  // PS7 added &&, ||, ?? and ?. . A 5.1 user would get a parse error on line one.
  for (const [name, code] of [['install.ps1', codeInstall], ['uninstall.ps1', codeUninstall], ['tg-secretary.ps1', codeCli]]) {
    for (const [label, pattern] of [
      ['&&', /&&/],
      ['||', /\|\|/],
      ['??', /\?\?/],
      ['?.', /\?\./],
      ['ForEach-Object -Parallel', /-Parallel\b/],
    ]) {
      // `[ordered]@{` and help text are fine; this is pure code by now.
      assert.ok(!pattern.test(code), `${name} uses ${label}, which PowerShell 5.1 cannot parse`);
    }
  }
});

test('PowerShell automatic variables are not used as loop variables', () => {
  // $pid and $args are read-only/automatic. Assigning to $pid throws at runtime -
  // the kind of bug that only shows up on the machine of the person uninstalling.
  for (const [name, text] of [['uninstall.ps1', uninstallPs1], ['tg-secretary.ps1', cliPs1]]) {
    assert.ok(!/foreach\s*\(\s*\$pid\s+in/.test(text), `${name} must not loop over $pid`);
    assert.ok(!/\$args\s*=/.test(text), `${name} must not assign to $args`);
  }
});

test('every cmdlet the scripts restart or schedule actually exists', () => {
  // Restart-ScheduledTask does not exist; it was in an early draft.
  // Comments may name the non-existent cmdlet (they explain why it is not used);
  // only real code matters.
  for (const [name, code] of [['tg-secretary.ps1', codeCli], ['uninstall.ps1', codeUninstall], ['install.ps1', codeInstall]]) {
    assert.ok(!/\bRestart-ScheduledTask\b/.test(code), `${name} calls Restart-ScheduledTask, which is not a cmdlet`);
    assert.ok(!/\bRestart-Service\b/.test(code) || name === 'uninstall.ps1', `${name} should not assume a Windows service`);
  }
  // And the cmdlets that do exist are used for the jobs they are for.
  assert.match(codeCli, /Stop-ScheduledTask[\s\S]*Start-ScheduledTask/, 'restart is stop then start');
  assert.match(codeInstall, /Register-ScheduledTask/);
  assert.match(codeUninstall, /Unregister-ScheduledTask/);
});

// --- the two front ends stay in step ------------------------------------------

test('both front ends offer the same commands', () => {
  // Lines like "  status)     cmd_status ;;" and "  version|-v|--version) ...".
  const bashCommands = [...cliSh.matchAll(/^ {2}([a-z][a-z|-]*)\)\s/gm)]
    .flatMap((m) => m[1].split('|'))
    .filter((c) => /^[a-z][a-z-]*$/.test(c));

  const switchBlock = /switch\s*\(\$Command\.ToLower\(\)\)\s*\{([\s\S]*?)\n\}/.exec(cliPs1);
  assert.ok(switchBlock, 'the PowerShell front end should dispatch on a switch');
  const psCommands = [...switchBlock[1].matchAll(/^\s*'([a-z-]+)'/gm)].map((m) => m[1]);

  for (const shared of ['status', 'panel', 'token', 'start', 'stop', 'restart', 'logs', 'update', 'paths', 'version', 'uninstall']) {
    assert.ok(bashCommands.includes(shared), `bash front end should handle ${shared}`);
    assert.ok(psCommands.includes(shared), `PowerShell front end should handle ${shared}`);
  }
});

test('flags are parsed by the script, not by parameter binding', () => {
  // A [CmdletBinding()] param block binds before the script runs: "-n 50" is an
  // undeclared parameter, so PowerShell stops with "A parameter cannot be found"
  // and nothing in the script can help. The front end therefore hand-parses $args.
  // Comments may name the attribute (they explain why it is not used); only code counts.
  assert.ok(!/\[CmdletBinding\(\)\]/.test(codeCli), 'the front end must not use advanced binding');
  assert.match(cliPs1, /\$RawArgs\s*=\s*@\(\$args\)/);

  // Every flag the help text shows in brackets has to be recognised somewhere:
  // [-Foreground], [-f], [-n N], [-Purge], [-Yes], [-Dir PATH].
  const promised = [...cliPs1.matchAll(/\[(-{1,2}[A-Za-z][\w-]*)/g)].map((m) => m[1].replace(/^-+/, ''));
  assert.ok(promised.length >= 4, `the help text should mention flags, found ${promised.join(', ')}`);
  for (const flag of new Set(promised)) {
    // Either a literal in one of the flag lists, or an alternative in the
    // "-Dir/--dir=value" style regex.
    const literal = new RegExp(`'--?${flag}'|'--?${flag},`, 'i').test(cliPs1);
    const alternative = new RegExp(`\\((\\w+\\|)*${flag}(\\|\\w+)*\\)`, 'i').test(cliPs1);
    assert.ok(literal || alternative, `the help text offers -${flag} but the parser never mentions it`);
  }

  // And the two that take a value must consume it, or "logs -n 50" makes "50" a command.
  assert.match(cliPs1, /\(dir\|path\)/i);
  assert.match(cliPs1, /\(n\|lines\)/i);
});

test('the PowerShell front end finds its install the same way', () => {
  assert.match(cliPs1, /SECRETARY_HOME/);
  assert.match(cliPs1, /Join-Path \$env:LOCALAPPDATA 'Programs\\tg-ai-secretary'/);
  assert.match(cliPs1, /Join-Path \$env:ProgramData 'tg-ai-secretary'/);
  assert.match(cliPs1, /package\.json/, 'it identifies an install by its files, not by its name');
});

test('state set inside an Invoke-Step scriptblock is written with $script:', () => {
  // & { $x = 1 } runs in a child scope; without $script: the installer would
  // register the task, then behave as if it had not, and never check the panel.
  // Blocks are found by matching braces with PowerShell's string rules - a regex
  // for this matched the wrong block on the first attempt.
  const blocks = [];
  for (const match of installPs1.matchAll(/Invoke-Step\b[^\n{]*\{/g)) {
    const from = match.index + match[0].length;
    let i = from;
    let depth = 1;
    while (i < installPs1.length && depth > 0) {
      const c = installPs1[i];
      if (c === "'" || c === '"') {
        const quote = c;
        i += 1;
        while (i < installPs1.length) {
          if (installPs1[i] === quote) {
            if (installPs1[i + 1] === quote) { i += 2; continue; }
            break;
          }
          if (installPs1[i] === '`' && quote === '"') { i += 2; continue; }
          i += 1;
        }
      } else if (c === '{') { depth += 1; } else if (c === '}') { depth -= 1; }
      i += 1;
    }
    blocks.push({ body: installPs1.slice(from, i - 1), start: match.index, end: i });
  }

  assert.ok(blocks.length >= 5, `expected the writes to go through Invoke-Step, found ${blocks.length}`);

  // What matters is what happens *after* the block: a variable assigned only inside
  // it and read later has lost its value. Variables that are also assigned later
  // are separate, and locals never read again are fine.
  for (const block of blocks) {
    const after = blocks.reduce((text, b) => (b.start >= block.end ? text.replace(b.body, ' ') : text),
      installPs1.slice(block.end));

    for (const assignment of block.body.matchAll(/^\s*\$(?!script:)([A-Za-z_]\w*)\s*=/gm)) {
      const name = assignment[1];
      if (name === 'null') continue;                 // $null = ... discards output, by design
      const readAfter = new RegExp(`\\$${name}\\b`).test(after);
      const assignedAfter = new RegExp(`^\\s*\\$${name}\\s*=`, 'm').test(after);
      assert.ok(!(readAfter && !assignedAfter),
        `$${name} is assigned inside an Invoke-Step scriptblock and used after it - use $script:${name}`);
    }
  }
});

test('the .cmd wrapper is a wrapper and forwards everything', () => {
  assert.match(cliCmd, /tg-secretary\.ps1/);
  assert.match(cliCmd, /-NoProfile/);
  assert.match(cliCmd, /-ExecutionPolicy Bypass/);
  assert.match(cliCmd, /%\*/);
  assert.match(cliCmd, /exit \/b %errorlevel%/);
  // cmd.exe is happiest with CRLF, and this file is 3 lines - no excuse.
  assert.ok(cliCmd.includes('\r\n'), 'the .cmd file should use CRLF line endings');
});

// --- settings the two halves share --------------------------------------------

test('the settings install.ps1 writes are the settings the runtime reads', () => {
  // Some live in tgcloud/lib/config.js, some are read straight from the
  // environment by the runner; both are the bot's business, not the installer's.
  const readers = [
    read('tgcloud/lib/config.js'),
    read('bot/runner.mjs'),
  ].join('\n');

  for (const key of ['BOT_TOKEN', 'PANEL_PORT', 'PANEL_HOST', 'BOT_TIMEZONE', 'LLM_BASE_URL']) {
    assert.ok(installPs1.includes(key), `install.ps1 should write ${key}`);
    if (key !== 'BOT_TOKEN') {
      assert.ok(readers.includes(key), `${key} should be read by the runtime`);
    }
  }
  // BOT_TOKEN becomes the bot_token setting; the panel is where a pasted token
  // lands, and it is the same key everywhere.
  assert.ok(read('bot/panel/server.mjs').includes("'bot_token'"));
});

test('the installer writes plain UTF-8 without a BOM', () => {
  // A BOM would turn "BOT_TOKEN" into "\uFEFFBOT_TOKEN" for the .env reader.
  assert.match(installPs1, /UTF8Encoding\(\$false\)/);
  assert.ok(read('bot/env.mjs').includes('\\uFEFF'), 'and the reader strips one anyway');
});

// --- the settings-file half, which can be run for real ------------------------

test('bot/env.mjs reads the machine-wide ProgramData file, BOM or not', async () => {
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');

  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'env-win-'));
  const programData = pathMod.join(dir, 'ProgramData');
  const settings = pathMod.join(programData, 'tg-ai-secretary');
  fsMod.mkdirSync(settings, { recursive: true });

  // What Windows PowerShell 5.1 writes if you edit the file: UTF-8 with a BOM and
  // CRLF line endings.
  fsMod.writeFileSync(pathMod.join(settings, 'bot.env'),
    '\uFEFFBOT_TOKEN=123456789:AAtoken\r\nPANEL_PORT=9123\r\nBOT_TIMEZONE=Europe/London\r\n');

  const cwd = process.cwd();
  const savedEnv = { ...process.env };
  try {
    process.env.ProgramData = programData;
    delete process.env.BOT_TOKEN;
    delete process.env.PANEL_PORT;
    process.chdir(dir);                       // no bot/.env here, so the fallback is used
    const { loadEnv, candidatePaths } = await import('../bot/env.mjs');

    assert.ok(candidatePaths().some((p) => p.includes('tg-ai-secretary')), 'ProgramData is a candidate');
    loadEnv();

    assert.equal(process.env.BOT_TOKEN, '123456789:AAtoken', 'a BOM must not become part of the key name');
    assert.equal(process.env.PANEL_PORT, '9123');
    assert.equal(process.env.BOT_TIMEZONE, 'Europe/London');
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});
