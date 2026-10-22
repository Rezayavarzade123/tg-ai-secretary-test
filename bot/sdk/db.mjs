import { tableData, save } from './store.mjs';

// The subset of `sdk/db` that the bot actually uses:
//
//   const rows = await db.select().from(notes).orderBy(asc(notes.id)).all();
//   const row  = await db.select().from(x).where(eq(x.id, 1)).get();
//   await db.insert(t).values({...}).returning().run();
//   await db.insert(t).values({...}).onConflictDoUpdate({ target: t.id, set: {...} }).run();
//   await db.delete(t).where(eq(t.id, 1)).run();
//
// Rows are plain objects keyed by the column KEY (e.g. `chatId`, `created`), which
// is what the platform returns and what tgcloud/schema.js declares.

export const COL = Symbol('column');

function column(name) {
  return {
    name,
    key: null,
    isColumn: true,
    primaryKey() { this.pk = true; return this; },
    notNull() { this.notnull = true; return this; },
    default(v) { this.def = v; this.hasDef = true; return this; },
    unique() { return this; },
  };
}

export const integer = (name) => column(name);
export const text = (name) => column(name);
export const boolean = (name) => column(name);

// Indexes and raw SQL are accepted and ignored: the JSON store has no indexes.
export const index = () => ({ on() { return this; } });
export const sql = () => ({});

const registry = new Map();

export function table(name, cols) {
  const t = { __name: name, __cols: {} };
  for (const [key, col] of Object.entries(cols)) {
    col.key = key;
    col.table = name;
    t[key] = col;
    t.__cols[key] = col;
  }
  registry.set(name, t);
  return t;
}

export function getTable(name) {
  return registry.get(name) ?? null;
}

// --- predicates ---------------------------------------------------------------
export const eq = (c, v) => (row) => row[c.key] === v;
export const ne = (c, v) => (row) => row[c.key] !== v;
export const lte = (c, v) => (row) => row[c.key] <= v;
export const gte = (c, v) => (row) => row[c.key] >= v;
export const and = (...fns) => (row) => fns.every((f) => f(row));
export const or = (...fns) => (row) => fns.some((f) => f(row));
export const desc = (c) => ({ c, dir: -1 });
export const asc = (c) => ({ c, dir: 1 });

// --- helpers ------------------------------------------------------------------
function nextId(t, rows) {
  const idCol = t.__cols.id;
  if (!idCol) return undefined;
  let max = 0;
  for (const r of rows) if (Number.isFinite(r.id) && r.id > max) max = r.id;
  return max + 1;
}

function withDefaults(t, values) {
  const row = { ...values };
  for (const [key, col] of Object.entries(t.__cols)) {
    if (key in row) continue;
    if (col.hasDef && (typeof col.def !== 'object' || col.def === null)) row[key] = col.def;
  }
  return row;
}

function sortRows(rows, order) {
  if (!order) return rows;
  const orders = Array.isArray(order) ? order : [order];
  return [...rows].sort((a, b) => {
    for (const o of orders) {
      const av = a[o.c.key];
      const bv = b[o.c.key];
      if (av === bv) continue;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      return (av < bv ? -1 : 1) * o.dir;
    }
    return 0;
  });
}

function project(row, projection) {
  if (!projection) return { ...row };
  const out = {};
  for (const [alias, col] of Object.entries(projection)) out[alias] = row[col.key];
  return out;
}

// --- the query builder --------------------------------------------------------
export const db = {
  select(projection) {
    return {
      from(t) {
        const q = {
          _where: null, _order: null, _limit: Infinity, _offset: 0,
          where(pred) { q._where = pred; return q; },
          orderBy(o) { q._order = o; return q; },
          limit(n) { q._limit = n; return q; },
          offset(n) { q._offset = n; return q; },
          async all() {
            let rows = tableData(t.__name);
            if (q._where) rows = rows.filter(q._where);
            rows = sortRows(rows, q._order);
            rows = rows.slice(q._offset, q._offset + q._limit);
            return rows.map((r) => project(r, projection));
          },
          async get() {
            return (await q.all())[0] ?? null;
          },
        };
        return q;
      },
    };
  },

  insert(t) {
    return {
      values(input) {
        const list = Array.isArray(input) ? input : [input];
        const state = { returning: false, conflict: null };
        const builder = {
          returning() { state.returning = true; return builder; },
          onConflictDoUpdate({ target, set }) { state.conflict = { key: target.key, set }; return builder; },
          async run() {
            const rows = tableData(t.__name);
            const out = [];
            for (const raw of list) {
              if (state.conflict) {
                const existing = rows.find((r) => r[state.conflict.key] === raw[state.conflict.key]);
                if (existing) {
                  Object.assign(existing, state.conflict.set);
                  out.push({ ...existing });
                  continue;
                }
              }
              const row = withDefaults(t, raw);
              if (row.id === undefined) row.id = nextId(t, rows);
              rows.push(row);
              out.push({ ...row });
            }
            save();
            return state.returning ? out : { rowsAffected: out.length };
          },
        };
        return builder;
      },
    };
  },

  delete(t) {
    return {
      where(pred) {
        return {
          async run() {
            const rows = tableData(t.__name);
            const keep = rows.filter((r) => !pred(r));
            const removed = rows.length - keep.length;
            rows.length = 0;
            rows.push(...keep);
            save();
            return { rowsAffected: removed };
          },
        };
      },
    };
  },
};
