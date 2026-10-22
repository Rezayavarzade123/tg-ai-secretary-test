import fs from 'node:fs';
import path from 'node:path';

// A tiny persistent store: one JSON file, one array per table, written atomically.
//
// Why not a real database? The bot's data is a few hundred rows (settings, notes,
// the last messages, drafts). A JSON file needs no native module, so the same
// checkout runs on a PS4, a Raspberry Pi and a laptop; it is trivially backed up
// (one file) and you can read it with `cat` when something looks wrong. The query
// builder in ./db.mjs mirrors the subset of the platform's `sdk/db` the bot uses,
// so the handler code is identical to the serverless version.

const stateDir = process.env.BOT_STATE_DIR || path.join(process.cwd(), 'bot', 'state');
const stateFile = process.env.BOT_STATE_FILE || path.join(stateDir, 'bot.json');

let data = { version: 1, tables: {} };
let loaded = false;
let writeTimer = null;

export function getStateFile() {
  return stateFile;
}

export function load() {
  if (loaded) return data;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch (e) {
      // Never start from scratch silently: move the broken file aside so nothing is lost.
      const broken = `${stateFile}.broken-${Date.now()}`;
      fs.renameSync(stateFile, broken);
      console.error(`⚠️  ${stateFile} was unreadable (${e.message}). Moved it to ${broken} and started fresh.`);
    }
  }
  data.tables ??= {};
  data.version ??= 1;
  loaded = true;
  return data;
}

export function tableData(name) {
  const d = load();
  d.tables[name] ??= [];
  return d.tables[name];
}

// Writes are cheap at this size, and doing them synchronously means a crash or a
// power cut (the PS4's favourite trick) cannot lose a message that was answered.
export function save({ immediate = true } = {}) {
  if (!loaded) return;
  if (!immediate) {
    if (writeTimer) return;
    writeTimer = setTimeout(() => { writeTimer = null; save(); }, 250);
    if (typeof writeTimer.unref === 'function') writeTimer.unref();
    return;
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, stateFile);
}

// Keep the last N snapshots next to the state file.
export function backup(keep = 14) {
  try {
    if (!fs.existsSync(stateFile)) return null;
    const dir = path.join(path.dirname(stateFile), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `bot-${stamp}.json`);
    fs.copyFileSync(stateFile, target);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('bot-') && f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep))) {
      fs.rmSync(path.join(dir, old), { force: true });
    }
    return target;
  } catch (e) {
    console.warn('backup failed:', e.message);
    return null;
  }
}

export function stats() {
  const d = load();
  const counts = {};
  for (const [name, rows] of Object.entries(d.tables)) counts[name] = rows.length;
  let bytes = 0;
  try { bytes = fs.statSync(stateFile).size; } catch { /* not written yet */ }
  return { file: stateFile, bytes, counts };
}
