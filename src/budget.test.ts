import { describe, expect, test } from "bun:test";
import {
  COLD_TABLE,
  DEFAULT_REGISTER_BUDGET,
  LUAU_REGISTER_LIMIT,
  TEMP_RESERVE,
  type BindingCandidate,
  type RegisterUsage,
  countReferences,
  formatRegisterReport,
  planSlots,
  stripLuaStringsAndComments,
} from "./budget";

function candidate(key: string, refs: number, canAssign = true): BindingCandidate {
  return { key, name: key, refs, canAssign };
}

describe("stripLuaStringsAndComments", () => {
  test("removes line and block comments", () => {
    expect(stripLuaStringsAndComments("local x = 1 -- x\n--[[ x ]] print(x)")).not.toMatch(/--/);
  });

  test("removes string contents from every string form", () => {
    expect(stripLuaStringsAndComments(`print("x", 'x', [[x]])`)).not.toContain("x");
  });

  test("does not treat an escaped quote as the end of a string", () => {
    expect(stripLuaStringsAndComments(`print("a\\"x\\"b")`)).toBe(`print("")`);
  });
});

describe("countReferences", () => {
  test("counts whole identifiers only", () => {
    expect(countReferences("local value = 1\nprint(value, value2)", "value")).toBe(2);
  });

  test("ignores text inside strings and comments", () => {
    const code = `local value = 1 -- value\nprint("value")`;

    expect(countReferences(stripLuaStringsAndComments(code), "value")).toBe(1);
  });

  test("returns zero for a name that never appears", () => {
    expect(countReferences("print(1)", "value")).toBe(0);
  });
});

describe("planSlots", () => {
  test("keeps every binding direct when the budget is disabled", () => {
    const plan = planSlots([candidate("a", 1), candidate("b", 2)], false);

    expect(plan.hot).toEqual(["a", "b"]);
    expect(plan.cold).toBe(0);
    expect(plan.table).toBeNull();
    expect(plan.slots.get("a")).toEqual({ key: "a", name: "a", form: "assign" });
  });

  test("moves the least referenced bindings into the cold table", () => {
    const plan = planSlots([candidate("hot", 9), candidate("cold", 1), candidate("warm", 4)], LUAU_REGISTER_LIMIT);

    // The default limit leaves room for every binding.
    expect(plan.cold).toBe(0);

    const tight = planSlots([candidate("hot", 9), candidate("cold", 1), candidate("warm", 4)], TEMP_RESERVE + 3);

    expect(tight.hot).toEqual(["hot", "warm"]);
    expect(tight.slots.get("cold")).toEqual({ key: "cold", name: `${COLD_TABLE}.b1`, form: "cold" });
    expect(tight.table).toBe(COLD_TABLE);
  });

  test("keeps definition order when reference counts tie", () => {
    // The first of three equally hot bindings keeps the direct slot; the rest
    // move to the table. A stable sort is what makes that deterministic.
    const plan = planSlots([candidate("a", 5), candidate("b", 5), candidate("c", 5)], TEMP_RESERVE + 2);

    expect(plan.hot).toEqual(["a"]);
    expect(plan.cold).toBe(2);

    expect(planSlots([candidate("second", 5), candidate("first", 5)], false).hot).toEqual(["second", "first"]);
  });

  test("gives a binding that cannot assign a renamed slot and publishes it", () => {
    const plan = planSlots([candidate("value", 3, false)], LUAU_REGISTER_LIMIT);

    expect(plan.hot).toEqual(["____export_1"]);
    expect(plan.slots.get("value")).toEqual({ key: "value", name: "____export_1", form: "publish" });
  });

  test("renames around a direct slot that already took the name", () => {
    const plan = planSlots(
      [candidate("value", 3), { key: "other", name: "value", refs: 2, canAssign: false }],
      LUAU_REGISTER_LIMIT,
    );

    expect(plan.hot).toEqual(["value", "____export_1"]);
    expect(plan.slots.get("other")?.form).toBe("publish");
  });
});

describe("formatRegisterReport", () => {
  const usage = (overrides: Partial<RegisterUsage>): RegisterUsage => ({
    modules: 1,
    hoisted: 1,
    hot: 1,
    cold: 0,
    rootLocals: 1,
    budget: DEFAULT_REGISTER_BUDGET,
    limit: LUAU_REGISTER_LIMIT,
    worst: { name: "src/main", locals: 1 },
    rootGlobals: [],
    missingRootGlobals: [],
    ...overrides,
  });

  test("stays quiet when the bundle fits", () => {
    expect(formatRegisterReport(usage({}))).toBeNull();
  });

  test("names the count, the limit and the setting that fixes it", () => {
    const message = formatRegisterReport(usage({ rootLocals: 220 }));

    expect(message).toContain("220 root locals");
    expect(message).toContain("Luau's limit is 200");
    expect(message).toContain("registerBudget");
  });

  test("names the module whose own locals overflow", () => {
    const message = formatRegisterReport(usage({ worst: { name: "src/big", locals: 240 } }));

    expect(message).toContain(`module "src/big" declares 240 locals`);
  });

  test("reports nothing when the limit is disabled", () => {
    expect(formatRegisterReport(usage({ rootLocals: 500, limit: false }))).toBeNull();
  });

  test("names root-global entries the bundle never declares", () => {
    const message = formatRegisterReport(usage({ missingRootGlobals: ["tick", "spawn"] }));

    expect(message).toContain(`"tick", "spawn"`);
    expect(message).toContain("rootGlobals");
  });
});
