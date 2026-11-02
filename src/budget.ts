/**
 * Root-scope register planning for flattened bundles.
 *
 * Luau gives every function 200 registers, and a flattened bundle is one
 * function. Scoping each module into its own function moves module locals out
 * of that budget, but the bindings modules share still have to live somewhere
 * the whole chunk can see. Those are the ones this file plans: the hottest stay
 * root locals, the rest move into a table that costs one register no matter how
 * many bindings it holds.
 *
 * Nothing here touches Lua text. It works on binding metadata so the flattener
 * can stay a line-rewrite pass.
 */

/** Registers Luau allows in a function. */
export const LUAU_REGISTER_LIMIT = 200;

/** Root locals the flattener aims for, leaving room for temporaries. */
export const DEFAULT_REGISTER_BUDGET = 150;

/** Registers kept spare for expression temporaries in the root chunk. */
export const TEMP_RESERVE = 12;

/** Name of the table that holds cold bindings. */
export const COLD_TABLE = "____cold";

/** A binding that another module imports and that therefore has to be shared. */
export interface BindingCandidate {
  key: string;
  /** The name the defining module uses for it. */
  name: string;
  /** How many times the name is referenced, used to rank hot against cold. */
  refs: number;
  /**
   * Whether the defining module can turn its declaration into an assignment to
   * the root local. False when the module keeps a shadowing local of its own or
   * declares the name more than once, which forces the publish form instead.
   */
  canAssign: boolean;
}

/** Where a shared binding lives once the plan is made. */
export interface BindingSlot {
  key: string;
  /** Root local name, or `____cold.bN` for a cold binding. */
  name: string;
  /** `assign`: definition assigns the root local. `publish`/`cold`: copy at the end of the module. */
  form: "assign" | "publish" | "cold";
}

export interface SlotPlan {
  slots: Map<string, BindingSlot>;
  /** Root locals to declare, in order. */
  hot: string[];
  /** The cold table's name when anything was packed into it. */
  table: string | null;
  cold: number;
}

export interface RegisterUsage {
  modules: number;
  /** Shared bindings that had to be hoisted at all. */
  hoisted: number;
  hot: number;
  cold: number;
  /** Root locals the flattened chunk declares. */
  rootLocals: number;
  budget: number | false;
  limit: number | false;
  /** The module with the most locals inside its own wrapper. */
  worst: { name: string; locals: number } | null;
  /** Configured `rootGlobals` names the bundle declares or assigns. */
  rootGlobals: string[];
  /** Configured `rootGlobals` names the bundle never mentions. */
  missingRootGlobals: string[];
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes comments and string contents so identifier counting is not fooled. */
export function stripLuaStringsAndComments(code: string): string {
  return code
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\[(=*)\[[\s\S]*?\]\1\]/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

export function countReferences(code: string, name: string): number {
  const matches = code.match(new RegExp(`\\b${escapeName(name)}\\b`, "g"));

  return matches === null ? 0 : matches.length;
}

/**
 * Splits shared bindings into root locals and cold table entries.
 *
 * Ranking is by reference count, so the names that appear most keep the cheap
 * direct form. Everything that does not fit the budget goes into one table,
 * which is a single root local regardless of how many bindings it holds.
 */
export function planSlots(candidates: BindingCandidate[], budget: number | false): SlotPlan {
  const slots = new Map<string, BindingSlot>();

  let hotCount = candidates.length;

  if (budget !== false) {
    hotCount = Math.min(candidates.length, Math.max(0, budget - TEMP_RESERVE - 1));
  }

  const coldKeys = new Set<string>();

  if (hotCount < candidates.length) {
    const ranked = [...candidates].sort((left, right) => right.refs - left.refs);

    for (const candidate of ranked.slice(hotCount)) coldKeys.add(candidate.key);
  }

  const used = new Set<string>();
  const hot: string[] = [];

  let renamed = 0;
  let cold = 0;

  // Assign names in definition order rather than rank order, so output stays
  // stable when two bindings happen to have the same reference count.
  for (const candidate of candidates) {
    if (coldKeys.has(candidate.key)) {
      cold += 1;
      slots.set(candidate.key, { key: candidate.key, name: `${COLD_TABLE}.b${cold}`, form: "cold" });

      continue;
    }

    if (candidate.canAssign && !used.has(candidate.name)) {
      used.add(candidate.name);
      hot.push(candidate.name);
      slots.set(candidate.key, { key: candidate.key, name: candidate.name, form: "assign" });

      continue;
    }

    // The defining module keeps a local with the binding's name, so the root
    // slot needs a name of its own and the module publishes into it.
    let name = `____export_${renamed + 1}`;

    while (used.has(name)) {
      renamed += 1;
      name = `____export_${renamed + 1}`;
    }

    renamed += 1;
    used.add(name);
    hot.push(name);
    slots.set(candidate.key, { key: candidate.key, name, form: "publish" });
  }

  return { slots, hot, table: cold > 0 ? COLD_TABLE : null, cold };
}

/** The warning text for a bundle that may not fit Luau's register budget. */
export function formatRegisterReport(usage: RegisterUsage): string | null {
  if (usage.missingRootGlobals.length > 0) {
    return (
      `tstl-bundle-flatten: rootGlobals lists ${usage.missingRootGlobals.map((name) => `"${name}"`).join(", ")}, ` +
      "but the bundle never declares or assigns them. Check the spelling, or declare the name in TypeScript."
    );
  }

  if (usage.limit === false) return null;

  if (usage.rootLocals > usage.limit) {
    return (
      `tstl-bundle-flatten: ${usage.rootLocals} root locals in the flattened bundle, ` +
      `Luau's limit is ${usage.limit}. Expect "Out of local registers" on load. ` +
      `Lower registerBudget (currently ${usage.budget}) to pack more shared bindings into a table.`
    );
  }

  if (usage.worst !== null && usage.worst.locals > usage.limit) {
    return (
      `tstl-bundle-flatten: module "${usage.worst.name}" declares ${usage.worst.locals} locals ` +
      `in one function, Luau's limit is ${usage.limit}. Split that module's top level.`
    );
  }

  return null;
}
