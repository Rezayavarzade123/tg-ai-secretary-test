import fs from 'node:fs';
import path from 'node:path';

// A 30-line .env reader. The target is a machine with a few gigabytes to spare, so
// every dependency is another thing that can fail to build there.
//
// Looked up in this order (first value wins, real environment variables always win):
//   bot/.env  ->  ./.env  ->  /etc/secretary-bot.env  ->  %ProgramData%\tg-ai-secretary\bot.env
//
// The last two are the same idea on different platforms: a settings file outside
// the checkout, so the code can be read-only and the token is not in the repo.
// install.sh writes the /etc one; install.ps1 writes the ProgramData one when it
// installs for all users on Windows.
export function candidatePaths() {
  const list = [
    path.join(process.cwd(), 'bot', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  if (process.env.ProgramData) {
    list.push('/etc/secretary-bot.env');
    list.push(path.join(process.env.ProgramData, 'tg-ai-secretary', 'bot.env'));
  } else {
    list.push('/etc/secretary-bot.env');
  }
  return list;
}

export function loadEnv() {
  const candidates = candidatePaths();
  const loaded = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    // Strip a UTF-8 BOM: PowerShell 5.1 and Notepad both like to add one, and a
    // BOM would turn the first key into "\uFEFFBOT_TOKEN", which is not a key.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}
