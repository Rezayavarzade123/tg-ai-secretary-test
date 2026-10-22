// What this machine can actually do.
//
// There is no console-specific code path anywhere in this project: a jailbroken
// PS4 running Linux is an ordinary x86-64 Linux box, and this file reads it the
// same way it reads a laptop, a mini-PC or a Raspberry Pi — from /proc and from
// the CPU flags. Nothing below looks at the model name to decide anything; the
// model name is only printed, because it is the one thing a person recognises.
//
// What actually differs between machines is (a) which vector instructions the
// CPU has, which decides how llama.cpp has to be built, and (b) how many cores
// and how much memory there are, which decides which model fits and how many
// threads to use. Both are measurable, so both are measured.
//
//   npm run hw              report + recommendation
//   npm run hw -- --json    same, machine-readable
//   npm run hw -- --bench   also time a real model server (needs one running)
//
// The rule from the rest of the project applies here too: no invented numbers.
// If a speed has not been measured, it is reported as not measured.
//
// That includes the CPU flags. On Linux they come from /proc/cpuinfo. Windows has
// no /proc, and os.cpus() carries no flags at all, so on Windows the installer
// measures them with IsProcessorFeaturePresent and passes them in:
//
//   SECRETARY_CPU_FLAGS="sse4_2 avx avx2"     (space or comma separated)
//   SECRETARY_CPU_FLAGS_SOURCE=kernel32
//
// Without either source this file says "could not be measured" rather than
// claiming the CPU has no AVX2 — the two are different, and the second one is the
// difference between a working install and an hour of debugging.

import fs from 'node:fs';
import os from 'node:os';

// --- /proc parsers (pure, so tests can feed them real sample files) ----------

export function parseCpuInfo(text) {
  const blocks = String(text || '').split(/\n\s*\n/).filter((b) => b.trim());
  const first = blocks[0] || '';
  const field = (src, name) => {
    const m = src.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im'));
    return m ? m[1].trim() : '';
  };

  const modelName =
    field(first, 'model name') ||
    field(first, 'Processor') ||
    field(first, 'Hardware') ||
    field(first, 'cpu model') ||
    'unknown CPU';

  // x86 exposes "flags", arm64 exposes "Features".
  const flagLine = field(first, 'flags') || field(first, 'Features') || '';
  const flags = flagLine.toLowerCase().split(/\s+/).filter(Boolean);

  const sockets = new Set();
  let perSocket = 0;
  let logical = 0;
  for (const b of blocks) {
    if (!/^processor\s*:/im.test(b)) continue;
    logical += 1;
    const id = field(b, 'physical id');
    if (id) sockets.add(id);
    perSocket = Math.max(perSocket, Number(field(b, 'cpu cores')) || 0);
  }
  const physical = perSocket && sockets.size ? perSocket * sockets.size : logical;

  return { modelName, flags, logical, physical, sockets: sockets.size || 1 };
}

export function parseMemInfo(text) {
  const kb = (name) => {
    const m = String(text || '').match(new RegExp(`^${name}:\\s*(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  return { totalMb: Math.round(kb('MemTotal') / 1024), availableMb: Math.round(kb('MemAvailable') / 1024), swapMb: Math.round(kb('SwapTotal') / 1024) };
}

// --- the decision ------------------------------------------------------------
// Everything here is a rule about the CPU and memory we just measured, not about
// the shape of the box.

export function recommend({
  arch, flags = [], logical = 1, physical = 1, memMb = 0, swapMb = 0, cpuModel = '',
  // `flagsKnown: false` means "nothing told us", which is not the same as "the CPU
  // has nothing". Defaults to whether we were given any flags at all.
  flagsKnown = flags.length > 0,
  flagsSource = '',
}) {
  const has = (f) => flags.includes(f);
  const cores = Math.max(1, physical || logical || 1);

  const vec = {
    sse42: has('sse4_2'),
    avx: has('avx'),
    avx2: has('avx2'),
    fma: has('fma'),
    // AVX-512 exists on some x86 CPUs; nothing in this project requires it.
    avx512: has('avx512f'),
    neon: has('asimd') || has('neon'),
    // Whether the line above means anything. False = nobody measured.
    detected: Boolean(flagsKnown),
  };

  const warnings = [];
  if (arch !== 'x64' && arch !== 'arm64') {
    warnings.push(`${arch} is not a supported architecture: llama.cpp builds for x86-64 or ARM64.`);
  }
  if (arch === 'x64' && !vec.detected) {
    // The important case: an unmeasured CPU must not be reported as a CPU without
    // AVX2. Say what is unknown, and how to find out.
    warnings.push(
      'SIMD capabilities could not be measured here: no /proc/cpuinfo and no SECRETARY_CPU_FLAGS. ' +
      'Prebuilt llama.cpp downloads assume AVX2, so this report is not proof either way — ' +
      'on Windows run the installer (it measures them), elsewhere check with: ' +
      "grep -o 'avx2' /proc/cpuinfo | head -1"
    );
  }
  if (arch === 'x64' && vec.detected && !vec.avx2) {
    warnings.push(
      'No AVX2 on this CPU. Prebuilt llama.cpp downloads — and Ollama\u2019s default CPU build — assume AVX2 ' +
      'and will crash or refuse to start. Build llama.cpp on this machine instead ' +
      '(-DGGML_NATIVE=ON); that compiles for exactly these instructions.'
    );
  }
  if (arch === 'x64' && vec.detected && !vec.avx) {
    warnings.push('No AVX at all: expect roughly half the throughput of an AVX CPU and use a 0.6B model.');
  }
  if (vec.detected && !vec.fma && vec.avx2) {
    // kernel32 has no FMA feature bit, so a Windows report must not trigger this.
    if (flagsSource !== 'kernel32') {
      warnings.push('AVX2 without FMA is unusual; some BLAS paths will be slower than the flags suggest.');
    }
  }
  if (memMb && memMb < 2048) {
    warnings.push(`Only ${memMb} MB of RAM: no ≤2B model fits here with room to run. Use a 0.6B model, or another machine.`);
  }
  if (memMb && memMb < 3500) {
    warnings.push(`${memMb} MB of RAM: a 1.7B Q4 model needs ~1.1 GB of weights plus ~0.5–1 GB of KV cache and the OS. Expect swapping — use -c 2048 and a 0.6B model if it stutters.`);
  }
  if (memMb && memMb < 7000 && !swapMb) {
    warnings.push('No swap configured, and this machine has less than 7 GB of RAM. A model load spike can be killed by the OOM reaper: add a 2–4 GB swapfile.');
  }
  if (cores <= 2) {
    warnings.push(`${cores} core(s): prompt processing will be the bottleneck, so keep the prompt short (a low HISTORY_LIMIT) before blaming the model.`);
  }

  // Which model actually fits. Weights at Q4_K_M are ~0.4 GB (0.6B) and
  // ~1.1 GB (1.7B); the rest of the budget is KV cache + the OS.
  let pick;
  if (!memMb || memMb >= 5500) {
    pick = {
      name: 'Qwen3-1.7B-Instruct', quant: 'Q4_K_M', sizeMb: 1100, ctx: 4096,
      note: 'the strongest model under 2B for this job; ~1.1 GB of weights',
    };
  } else if (memMb >= 2600) {
    pick = {
      name: 'Qwen3-1.7B-Instruct', quant: 'Q4_K_M', sizeMb: 1100, ctx: 2048,
      note: 'fits, but the smaller context leaves less room for history',
    };
  } else {
    pick = {
      name: 'Qwen3-0.6B-Instruct', quant: 'Q4_K_M', sizeMb: 400, ctx: 2048,
      note: 'the model that still runs when nothing bigger does; weaker at languages and tool use',
    };
  }

  // One thread per physical core: two threads on one core only time-slices it.
  // (On ARM and on most consoles physical === logical anyway.)
  const threads = physical >= 2 ? physical : Math.max(1, logical);
  const build = arch === 'arm64'
    ? { cmake: '-DGGML_NATIVE=ON', note: 'native build; ARM needs no special flags' }
    : !vec.detected
      ? { cmake: '-DGGML_NATIVE=ON', note: 'build here if you cannot confirm AVX2: prebuilt binaries assume it' }
      : vec.avx2
        ? { cmake: '-DGGML_NATIVE=ON', note: 'native build; prebuilt binaries would also work here' }
        : { cmake: '-DGGML_NATIVE=ON', note: 'must be built here: prebuilt binaries assume AVX2' };

  const llamaArgs = [
    `-m ${pick.name}-${pick.quant}.gguf`,
    `-c ${pick.ctx}`,
    '-np 1',
    `-t ${threads}`,
    '--jinja',
    '--host 127.0.0.1',
    '--port 8080',
  ];

  return {
    cpu: { modelName: cpuModel, cores, logical, arch, flagsSource: flagsSource || (flagsKnown ? 'provided' : '') },
    vec, memMb, swapMb, threads, build, model: pick, llamaArgs, warnings,
  };
}

// --- reading the live machine ------------------------------------------------

function readIfExists(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// "sse4_2 avx avx2" / "sse4_2,avx,avx2" / mixed case -> ['sse4_2','avx','avx2'].
// Also accepts the aliases a Windows caller is likely to produce (sse4.2,
// avx512f, asimd) so the same vocabulary reaches recommend().
export function parseFlagString(text) {
  const ALIASES = { 'sse4.2': 'sse4_2', 'sse4.1': 'sse4_1', sse42: 'sse4_2', asimd: 'asimd' };
  return String(text || '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => ALIASES[f] ?? f);
}

export function inspect(env = {}) {
  const cpuText = env.cpuInfo ?? readIfExists('/proc/cpuinfo');
  const memText = env.memInfo ?? readIfExists('/proc/meminfo');
  const cpu = parseCpuInfo(cpuText);

  // Second source: whoever launched us. On Windows that is install.ps1, which
  // measures with kernel32; anywhere else it is a manual override for a container
  // that hides /proc. /proc wins when it has an answer.
  const externalRaw = env.cpuFlags ?? process.env.SECRETARY_CPU_FLAGS ?? '';
  const external = parseFlagString(externalRaw);
  const flags = cpu.flags.length ? cpu.flags : external;
  const flagsSource = cpu.flags.length
    ? 'proc'
    : external.length
      ? (env.cpuFlagsSource ?? process.env.SECRETARY_CPU_FLAGS_SOURCE) || 'env'
      : '';

  const mem = memText ? parseMemInfo(memText) : { totalMb: Math.round(os.totalmem() / 1048576), availableMb: Math.round(os.freemem() / 1048576), swapMb: 0 };

  // /proc is the truth where it exists; os.cpus() is the fallback (macOS, Windows,
  // and containers that hide /proc) — it counts cores, but carries no flags.
  const cores = cpu.logical || os.cpus().length || 1;
  return {
    ...recommend({
      arch: process.arch,
      flags,
      flagsKnown: flags.length > 0,
      flagsSource,
      logical: cores,
      physical: cpu.physical || cores,
      memMb: mem.totalMb,
      swapMb: mem.swapMb,
      cpuModel: cpu.modelName,
    }),
    kernel: `${os.type()} ${os.release()}`,
    node: process.version,
    availableMb: mem.availableMb,
  };
}

// --- optional: measure a running server --------------------------------------
// Roughly what a real reply costs: a short system prompt, a short message, and
// room for a chat-length answer. Timings come from the server, never from a
// stopwatch around the process unless the server reports nothing.

const BENCH_PROMPT = 'You are a secretary. Reply to this in two short sentences: "Are we still on for Thursday?"';

export async function benchmark({ baseUrl = 'http://127.0.0.1:8080', model, rounds = 3, timeoutMs = 180000, fetchImpl = fetch } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages: [{ role: 'user', content: BENCH_PROMPT }],
    max_tokens: 80,
    temperature: 0,
    stream: false,
  };

  const one = async () => {
    const started = Date.now();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`model server returned ${res.status}: ${raw.slice(0, 200)}`);
    const data = JSON.parse(raw);
    const t = data?.timings ?? {};
    const usage = data?.usage ?? {};
    return {
      wallMs: Date.now() - started,
      promptTokens: Number(usage.prompt_tokens ?? t.prompt_n ?? 0),
      completionTokens: Number(usage.completion_tokens ?? t.predicted_n ?? 0),
      promptMs: Number(t.prompt_ms ?? 0),
      decodeMs: Number(t.predicted_ms ?? 0),
      timed: Boolean(t.prompt_ms || t.predicted_ms),
    };
  };

  await one(); // warm the page cache and any lazy buffers; discarded
  const runs = [];
  for (let i = 0; i < rounds; i += 1) runs.push(await one());

  const timed = runs.filter((r) => r.timed);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const src = timed.length ? timed : runs;
  const prefillTps = timed.length ? avg(timed.map((r) => r.promptTokens / (r.promptMs / 1000))) : 0;
  const decodeTps = timed.length ? avg(timed.map((r) => r.completionTokens / (r.decodeMs / 1000))) : 0;

  return {
    rounds: runs.length,
    timedRounds: timed.length,
    wallMs: Math.round(avg(src.map((r) => r.wallMs))),
    promptTokens: Math.round(avg(src.map((r) => r.promptTokens))),
    completionTokens: Math.round(avg(src.map((r) => r.completionTokens))),
    prefillTps: Number(prefillTps.toFixed(1)),
    decodeTps: Number(decodeTps.toFixed(1)),
    measured: timed.length > 0,
  };
}

// --- printing ----------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);

export function formatReport(r) {
  const lines = [];
  const vecNames = Object.entries(r.vec)
    .filter(([k, on]) => on && k !== 'detected')
    .map(([k]) => k.toUpperCase());
  lines.push('machine');
  lines.push(`  cpu        ${r.cpu.modelName || 'unknown'}`);
  lines.push(`             ${r.cpu.cores} physical core(s), ${r.cpu.logical} threads, ${r.cpu.arch}, ${r.kernel}`);
  if (!r.vec.detected) {
    lines.push('  simd       not measured (no /proc/cpuinfo and no SECRETARY_CPU_FLAGS)');
  } else {
    const src = r.cpu.flagsSource && !['proc', 'provided'].includes(r.cpu.flagsSource) ? ` (from ${r.cpu.flagsSource})` : '';
    lines.push(`  simd       ${vecNames.length ? vecNames.join(' ') : 'none detected'}${src}`);
  }
  lines.push(`  memory     ${r.memMb} MB total, ${r.availableMb} MB available, ${r.swapMb ? `${r.swapMb} MB swap` : 'no swap'}`);
  lines.push('');
  lines.push('what to run');
  lines.push(`  threads    ${r.threads}  (-t ${r.threads}${r.cpu.logical > r.threads ? `, one per physical core; ${r.cpu.logical} logical` : ''})`);
  lines.push(`  build      ${r.build.cmake}   ${r.build.note}`);
  lines.push(`  model      ${r.model.name} ${r.model.quant} (~${r.model.sizeMb} MB) — ${r.model.note}`);
  lines.push(`  llama.cpp  llama-server ${r.llamaArgs.join(' ')}`);
  if (r.bench) {
    lines.push('');
    lines.push('measured, just now');
    if (r.bench.measured) {
      lines.push(`  prefill    ${r.bench.prefillTps} tok/s over ${r.bench.promptTokens} tokens`);
      lines.push(`  decode     ${r.bench.decodeTps} tok/s over ${r.bench.completionTokens} tokens`);
      lines.push(`  per reply  ~${r.bench.wallMs} ms end to end`);
    } else {
      lines.push(`  wall clock ${r.bench.wallMs} ms per reply — the server reported no timings, so prefill/decode split is unknown`);
    }
  } else {
    lines.push('');
    lines.push('measured');
    lines.push('  not yet — start the model server, then: npm run hw -- --bench');
  }
  if (r.warnings.length) {
    lines.push('');
    lines.push('watch out');
    for (const w of r.warnings) lines.push(`  • ${w}`);
  }
  return lines.join('\n');
}

// --- CLI ---------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const report = inspect();
  if (args.includes('--bench')) {
    const baseUrl = process.env.LOCAL_LLM_URL || process.env.LLM_BASE_URL || 'http://127.0.0.1:8080';
    const model = process.env.LLM_MODEL || process.env.MODEL || '';
    try {
      report.bench = await benchmark({ baseUrl, model: model || undefined });
    } catch (e) {
      console.error(`\n✖ could not reach a model server at ${baseUrl}: ${e.message}`);
      console.error('  start it first, e.g. sudo systemctl start llama-server\n');
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('\nSecretary — machine report');
    console.log('─'.repeat(64));
    console.log(formatReport(report));
    console.log('─'.repeat(64));
    console.log(pad('', 0) + 'Nothing here is estimated: unmeasured numbers say so.\n');
  }
  process.exitCode = report.warnings.some((w) => /not a supported architecture|no ≤2B model fits/.test(w)) ? 1 : 0;
}
