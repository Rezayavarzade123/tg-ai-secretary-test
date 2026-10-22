import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCpuInfo, parseMemInfo, recommend, benchmark, formatReport, inspect, parseFlagString } from '../bot/hardware.mjs';

// Real /proc/cpuinfo shapes, trimmed. The point of these tests is that the
// recommendation follows the *measured* flags and cores, never the name of the
// machine — a console, a laptop and a mini-PC with the same CPU get the same
// answer.

const JAGUAR = `processor\t: 0
vendor_id\t: AuthenticAMD
cpu family\t: 22
model\t\t: 48
model name\t: AMD AMD-Jaguar
cpu MHz\t\t: 1600.000
cpu cores\t: 4
physical id\t: 0
siblings\t: 4
flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx mmxext fxsr_opt pdpe1gb rdtscp lm constant_tsc rep_good nopl nonstop_tsc cpuid extd_apicid aperfmperf pni pclmulqdq monitor ssse3 cx16 sse4_1 sse4_2 popcnt aes xsave avx f16c lahf_lm cmp_legacy svm extapic cr8_legacy abm sse4a misalignsse 3dnowprefetch osvw ibs xsaveopt fma4

processor\t: 1
cpu cores\t: 4
physical id\t: 0
siblings\t: 4

processor\t: 4
cpu cores\t: 4
physical id\t: 1
siblings\t: 4

processor\t: 5
cpu cores\t: 4
physical id\t: 1
siblings\t: 4
`;

const MODERN_LAPTOP = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Core(TM) i7-1165G7 @ 2.80GHz
cpu cores\t: 4
physical id\t: 0
siblings\t: 8
flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe syscall nx pdpe1gb rdtscp lm constant_tsc art arch_perfmon pebs bts rep_good nopl xtopology nonstop_tsc cpuid aperfmperf tsc_known_freq pni pclmulqdq dtes64 monitor ds_cpl vmx est tm2 ssse3 sdbg fma cx16 xtpr pdcm pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand lahf_lm abm 3dnowprefetch cpuid_fault epb invpcid_single ssbd ibrs ibpb stibp tpr_shadow vnmi flexpriority ept vpid fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid mpx rdseed adx smap clflushopt intel_pt xsaveopt xsavec xgetbv1 xsaves dtherm ida arat pln pts hwp hwp_notify hwp_act_window hwp_epp md_clear flush_l1d arch_capabilities

processor\t: 1
cpu cores\t: 4
physical id\t: 0
`;

const ARM64 = `processor\t: 0
BogoMIPS\t: 108.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp
CPU implementer\t: 0x41
CPU architecture: 8
CPU variant\t: 0x0
CPU part\t: 0xd08
CPU revision\t: 3
`;

const MEM_8G = `MemTotal:        8192000 kB
MemFree:         1024000 kB
MemAvailable:    5900000 kB
Buffers:          120000 kB
Cached:          3100000 kB
SwapTotal:       2097152 kB
SwapFree:        2097152 kB
`;

const MEM_4G = `MemTotal:        3940000 kB
MemFree:          200000 kB
MemAvailable:    1800000 kB
SwapTotal:             0 kB
`;

// --- parsers -----------------------------------------------------------------

test('/proc/cpuinfo is read for model, flags and real core counts', () => {
  const cpu = parseCpuInfo(JAGUAR);
  assert.match(cpu.modelName, /Jaguar/);
  assert.equal(cpu.logical, 4);
  assert.equal(cpu.physical, 8, 'two 4-core packages');
  assert.ok(cpu.flags.includes('avx'));
  assert.ok(!cpu.flags.includes('avx2'), 'Jaguar has no AVX2');
});

test('ARM64 exposes Features instead of flags', () => {
  const cpu = parseCpuInfo(ARM64);
  assert.ok(cpu.flags.includes('asimd'));
  assert.equal(cpu.logical, 1);
});

test('/proc/meminfo is read in MB', () => {
  const mem = parseMemInfo(MEM_8G);
  assert.equal(mem.totalMb, 8000);
  assert.equal(mem.availableMb, 5762);
  assert.equal(mem.swapMb, 2048);
  assert.equal(parseMemInfo(MEM_4G).swapMb, 0);
});

// --- the decision ------------------------------------------------------------

test('an AVX-only CPU is told to build from source, not to download a binary', () => {
  const cpu = parseCpuInfo(JAGUAR);
  const r = recommend({ arch: 'x64', flags: cpu.flags, logical: cpu.logical, physical: cpu.physical, memMb: 8000, swapMb: 2048 });
  assert.equal(r.vec.avx2, false);
  assert.equal(r.build.cmake, '-DGGML_NATIVE=ON');
  assert.match(r.build.note, /must be built here/);
  assert.ok(r.warnings.some((w) => /No AVX2/.test(w) && /Ollama/.test(w)));
  assert.equal(r.model.ctx, 4096, '8 GB is enough for the full context');
  assert.equal(r.threads, 8);
  assert.ok(r.llamaArgs.includes('-t 8'), 'one flag per argument, ready to paste');
  assert.ok(r.llamaArgs.includes('--jinja'));
  assert.ok(r.llamaArgs.includes('-np 1'), 'one slot: a queue is cheaper than oversubscribing 8 cores');
});

test('an AVX2 machine gets the same advice, minus the build warning', () => {
  const cpu = parseCpuInfo(MODERN_LAPTOP);
  const r = recommend({ arch: 'x64', flags: cpu.flags, logical: 16, physical: cpu.physical, memMb: 16000, swapMb: 0 });
  assert.equal(r.vec.avx2, true);
  assert.ok(!r.warnings.some((w) => /No AVX2/.test(w)));
  assert.equal(r.threads, 4, 'one thread per physical core, not per hyperthread');
  assert.equal(r.build.note.includes('prebuilt'), true);
});

test('the recommendation depends on the CPU, never on its name', () => {
  const cpu = parseCpuInfo(JAGUAR);
  const a = recommend({ arch: 'x64', flags: cpu.flags, logical: 8, physical: 8, memMb: 8000, swapMb: 2048, cpuModel: 'AMD AMD-Jaguar' });
  const b = recommend({ arch: 'x64', flags: cpu.flags, logical: 8, physical: 8, memMb: 8000, swapMb: 2048, cpuModel: 'Some Laptop CPU' });
  assert.deepEqual({ ...a, cpu: { ...a.cpu, modelName: null } }, { ...b, cpu: { ...b.cpu, modelName: null } });
});

test('a small machine is steered to a smaller model rather than to hope', () => {
  const r = recommend({ arch: 'x64', flags: ['avx', 'avx2', 'fma'], logical: 4, physical: 4, memMb: 3900, swapMb: 0 });
  assert.equal(r.model.name, 'Qwen3-1.7B-Instruct');
  assert.equal(r.model.ctx, 2048);
  assert.ok(r.warnings.some((w) => /No swap/.test(w)));

  const tiny = recommend({ arch: 'x64', flags: ['avx'], logical: 2, physical: 2, memMb: 1500, swapMb: 0 });
  assert.equal(tiny.model.name, 'Qwen3-0.6B-Instruct');
  assert.ok(tiny.warnings.some((w) => /no ≤2B model fits/.test(w)));
});

test('ARM64 gets ARM advice and no x86 warnings', () => {
  const r = recommend({ arch: 'arm64', flags: ['asimd'], logical: 4, physical: 4, memMb: 8000, swapMb: 2048 });
  assert.equal(r.vec.neon, true);
  assert.ok(!r.warnings.some((w) => /AVX2/.test(w)));
  assert.match(r.build.note, /ARM/);
});

test('an unknown architecture is refused, out loud', () => {
  const r = recommend({ arch: 'mips', flags: [], logical: 1, physical: 1, memMb: 512, swapMb: 0 });
  assert.ok(r.warnings.some((w) => /not a supported architecture/.test(w)));
});

// --- measurement -------------------------------------------------------------

const fakeFetch = (payload) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

test('a benchmark reports the server numbers when the server reports them', async () => {
  const reply = { usage: { prompt_tokens: 400, completion_tokens: 60 }, timings: { prompt_ms: 20000, predicted_ms: 3000 } };
  const b = await benchmark({ fetchImpl: fakeFetch(reply), rounds: 3 });
  assert.equal(b.measured, true);
  assert.equal(b.prefillTps, 20);
  assert.equal(b.decodeTps, 20);
  assert.equal(b.rounds, 3);
  assert.equal(b.completionTokens, 60);
});

test('a benchmark without timings says so instead of inventing a split', async () => {
  const reply = { usage: { prompt_tokens: 400, completion_tokens: 60 } };
  const b = await benchmark({ fetchImpl: fakeFetch(reply), rounds: 2 });
  assert.equal(b.measured, false);
  assert.equal(b.prefillTps, 0);
  assert.equal(b.decodeTps, 0);
  assert.ok(b.wallMs >= 0);
});

test('a benchmark reports a server error as an error', async () => {
  const failing = async () => ({ ok: false, status: 503, text: async () => 'loading model' });
  await assert.rejects(() => benchmark({ fetchImpl: failing }), /503/);
});

// --- the report --------------------------------------------------------------

test('the printed report never shows a speed that was not measured', () => {
  const cpu = parseCpuInfo(JAGUAR);
  const r = {
    ...recommend({ arch: 'x64', flags: cpu.flags, logical: 8, physical: 8, memMb: 8000, swapMb: 2048, cpuModel: cpu.modelName }),
    kernel: 'Linux 5.15.0',
    node: 'v22.0.0',
    availableMb: 5900,
  };
  const text = formatReport(r);
  assert.match(text, /not yet — start the model server/);
  assert.ok(!/tok\/s/.test(text), 'no throughput figure may appear before it is measured');
  assert.match(text, /Jaguar/);
  assert.match(text, /simd\s+.*\bAVX\b/, 'the simd line lists what was detected');
  assert.ok(!/simd.*AVX2/.test(text), 'and does not list what was not');
});

test('a measured report shows both directions', () => {
  const cpu = parseCpuInfo(JAGUAR);
  const r = {
    ...recommend({ arch: 'x64', flags: cpu.flags, logical: 8, physical: 8, memMb: 8000, swapMb: 2048 }),
    kernel: 'Linux 5.15.0', node: 'v22.0.0', availableMb: 5900,
    bench: { measured: true, prefillTps: 12.5, decodeTps: 18.2, promptTokens: 400, completionTokens: 60, wallMs: 41000 },
  };
  const text = formatReport(r);
  assert.match(text, /prefill\s+12\.5 tok\/s/);
  assert.match(text, /decode\s+18\.2 tok\/s/);
  assert.match(text, /41000 ms/);
});

// --- machines without /proc: Windows, macOS, containers -----------------------
//
// Windows has no /proc/cpuinfo, and os.cpus() carries no flags, so the old code
// read "no flags" as "no AVX2" and warned confidently about a CPU it had never
// measured. install.ps1 measures with kernel32 and passes the answer in; without
// that, the report must say "not measured".

test('flags supplied by the Windows installer are used, and said to be', () => {
  const r = inspect({ cpuInfo: '', memInfo: '', cpuFlags: 'ssse3 sse4_1 sse4_2 avx avx2 avx512f', cpuFlagsSource: 'kernel32' });

  assert.equal(r.vec.detected, true);
  assert.equal(r.vec.avx2, true);
  assert.equal(r.cpu.flagsSource, 'kernel32');
  assert.ok(!r.warnings.some((w) => /No AVX2/.test(w)), 'a measured AVX2 machine must not be accused of lacking it');

  const text = formatReport(r);
  assert.match(text, /simd\s+.*AVX2/);
  assert.match(text, /from kernel32/);
});

test('without any source the report says unmeasured, not "no AVX2"', () => {
  const r = inspect({ cpuInfo: '', memInfo: '', cpuFlags: '' });

  assert.equal(r.vec.detected, false);
  assert.ok(!r.warnings.some((w) => /No AVX2/.test(w)), 'unknown is not absent');
  const warning = r.warnings.find((w) => /could not be measured/.test(w));
  assert.ok(warning, 'it should say the flags could not be measured');
  assert.match(warning, /SECRETARY_CPU_FLAGS/, 'and name the way to fix it');

  const text = formatReport(r);
  assert.match(text, /simd\s+not measured/);
  assert.match(text, /build here if you cannot confirm AVX2/);
});

test('kernel32 cannot report FMA, so its absence must not raise the FMA warning', () => {
  const windows = inspect({ cpuInfo: '', memInfo: '', cpuFlags: 'avx avx2', cpuFlagsSource: 'kernel32' });
  assert.equal(windows.vec.fma, false);
  assert.ok(!windows.warnings.some((w) => /FMA/.test(w)), 'not measured is not the same as not present');

  // ...but a real /proc report with AVX2 and no FMA is still worth mentioning.
  const linux = recommend({ arch: 'x64', flags: ['avx2', 'avx'], logical: 8, physical: 8, memMb: 8000 });
  assert.ok(linux.warnings.some((w) => /FMA/.test(w)));
});

test('flag strings are normalised, whatever a shell or API produces', () => {
  assert.deepEqual(parseFlagString('sse4_2 avx avx2'), ['sse4_2', 'avx', 'avx2']);
  assert.deepEqual(parseFlagString('SSE4.2, AVX2;avx'), ['sse4_2', 'avx2', 'avx']);
  assert.deepEqual(parseFlagString(''), []);
  assert.deepEqual(parseFlagString(null), []);
  // asimd is ARM's name for NEON; either spelling must work.
  assert.equal(recommend({ arch: 'arm64', flags: parseFlagString('asimd'), logical: 4, physical: 4, memMb: 8000 }).vec.neon, true);
});
