// Minimal in-memory stand-in for the platform's `sdk` and `sdk/db`, just enough
// to run lib/pending.js locally. Not a faithful Drizzle clone.
export const store = {};
const seq = {};

const col = (name) => {
  const c = { name, primaryKey: () => c, notNull: () => c, default: () => c, unique: () => c };
  return c;
};
export const integer = (n) => col(n);
export const text = (n) => col(n);
export const boolean = (n) => col(n);
export const index = () => ({ on() { return this; } });
export const sql = () => ({});

export function table(name, cols) {
  const t = { __name: name };
  for (const [k, c] of Object.entries(cols)) t[k] = Object.assign(c, { key: k });
  store[name] ??= [];
  return t;
}

// Stubs so modules that import api/fetch can load; tests never call them.
export const api = {};
export const fetch = Object.assign(async () => { throw new Error('no network in tests'); }, { body: { json: (x) => x } });

export const eq = (c, v) => (r) => r[c.key] === v;
export const lte = (c, v) => (r) => r[c.key] <= v;
export const and = (...f) => (r) => f.every((x) => x(r));
export const desc = (c) => ({ c, dir: -1 });
export const asc = (c) => ({ c, dir: 1 });

export const db = {
  select(proj) {
    return {
      from(t) {
        let pred = () => true, ord = null, lim = Infinity, off = 0;
        const q = {
          where(p) { pred = p; return q; },
          orderBy(o) { ord = o; return q; },
          limit(n) { lim = n; return q; },
          offset(n) { off = n; return q; },
          async all() {
            let rows = store[t.__name].filter(pred);
            if (ord) rows = [...rows].sort((a, b) => (a[ord.c.key] - b[ord.c.key]) * ord.dir);
            rows = rows.slice(off, off + lim);
            return rows.map((r) => proj
              ? Object.fromEntries(Object.entries(proj).map(([k, c]) => [k, r[c.key]]))
              : { ...r });
          },
          async get() { return (await q.all())[0] ?? null; },
        };
        return q;
      },
    };
  },
  insert(t) {
    return {
      values(v) {
        let ret = false, conflict = null;
        const o = {
          returning() { ret = true; return o; },
          onConflictDoUpdate({ target, set }) { conflict = { key: target.key, set }; return o; },
          async run() {
            const out = (Array.isArray(v) ? v : [v]).map((x) => {
              if (conflict) {
                const existing = store[t.__name].find((r) => r[conflict.key] === x[conflict.key]);
                if (existing) { Object.assign(existing, conflict.set); return { ...existing }; }
              }
              const row = { ...x, id: (seq[t.__name] = (seq[t.__name] || 0) + 1) };
              store[t.__name].push(row);
              return { ...row };
            });
            return ret ? out : { rowsAffected: out.length };
          },
        };
        return o;
      },
    };
  },
  delete(t) {
    return {
      where(p) {
        return { async run() { store[t.__name] = store[t.__name].filter((r) => !p(r)); } };
      },
    };
  },
};
