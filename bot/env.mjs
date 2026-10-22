import fs from 'node:fs';
import path from 'node:path';

// A 30-line .env reader, because the target machine is a PS4 and every dependency
// is another thing that can fail to build there.
//
// Looked up in this order (first value wins, real environment variables always win):
//   bot/.env  ->  ./.env  ->  /etc/secretary-bot.env
export function loadEnv() {
  const candidates = [
    path.join(process.cwd(), 'bot', '.env'),
    path.join(process.cwd(), '.env'),
    '/etc/secretary-bot.env',
  ];
  const loaded = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
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
