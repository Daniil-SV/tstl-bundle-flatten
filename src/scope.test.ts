import { describe, expect, test } from "bun:test";
import { COLD_TABLE, DEFAULT_REGISTER_BUDGET, LUAU_REGISTER_LIMIT, TEMP_RESERVE, type RegisterUsage } from "./budget";
import { flattenBundle, flattenWithUsage } from "./flatten";
import { transformLines } from "./index";
import { splitLines } from "./lines";

function bundle(modules: [name: string, body: string][], entry: string) {
  const header = `--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]`;

  const runtime = `local ____modules = {}
local ____moduleCache = {}
local ____originalRequire = require
local function require(file, ...)
end`;

  const entries = modules.map(([name, body]) => `["${name}"] = function(...) \n${body}\n end,`).join("\n");

  return `${header}\n\n${runtime}\n____modules = {\n${entries}\n}\nlocal ____entry = require("${entry}", ...)\nreturn ____entry\n`;
}

/** A module body that exports the given top-level statements. */
function exports(body: string): string {
  return `local ____exports = {}\n${body}\nreturn ____exports`;
}

function usageOf(code: string, options: Parameters<typeof flattenWithUsage>[1] = {}): RegisterUsage {
  const { usage } = flattenWithUsage(splitLines(code), options);

  if (usage === null) throw new Error("expected a bundle");

  return usage;
}

/** The root-scope lines a scoped bundle emits before its first module wrapper. */
function rootLocals(output: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line === "do");

  return lines.slice(0, start === -1 ? lines.length : start).filter((line) => line.startsWith("local "));
}

describe("scoped flatten", () => {
  test("wraps a module in a function it calls at once, with no root locals of its own", () => {
    const code = bundle([["src/main", exports("local value = 42\nprint(value)")]], "src/main");
    const output = flattenBundle(code, []);

    expect(output).toContain("do\nlocal function ____module_0()\n");
    expect(output).toContain("\nend\n____module_0()\nend\n");
    expect(usageOf(code).rootLocals).toBe(0);
    expect(rootLocals(output)).toEqual([]);
  });

  test("keeps a private local inside the module that owns it", () => {
    const code = bundle(
      [
        [
          "src/a",
          exports(`local secret = 1
function ____exports.read()
    return secret
end`),
        ],
        [
          "src/b",
          `local ____a = require("src/a")
local read = ____a.read
print(read())`,
        ],
      ],
      "src/b",
    );

    const output = flattenBundle(code, []);

    // `read` is read from another module, `secret` is not.
    expect(rootLocals(output)).toEqual(["local read"]);
    expect(output).toContain("\nlocal secret = 1\n");
  });

  test("assigns a hoisted binding instead of declaring it again in the module", () => {
    const code = bundle(
      [
        ["src/a", exports("____exports.value = 1")],
        ["src/b", `local ____a = require("src/a")\nlocal a_value = ____a.value\nprint(a_value)`],
      ],
      "src/b",
    );
    const output = flattenBundle(code, []);

    expect(output).toContain("local value\n");
    expect(output).toContain("\nvalue = 1\n");
    expect(output).not.toContain("local value = 1");
  });

  test("hoists helpers a module publishes through a return table", () => {
    // TSTL's lualib module ends with `return { name = local }` instead of filling
    // `____exports`, so its helpers have to be read from that table; otherwise
    // every `____lualib.__TS__X` import is dropped and resolves to a nil global.
    const code = bundle(
      [
        [
          "lualib_bundle",
          `local function __TS__Class(self)
    return {prototype = {}}
end
return {
    __TS__Class = __TS__Class
}`,
        ],
        [
          "src/main",
          `local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local Klass = __TS__Class()
print(Klass)`,
        ],
      ],
      "src/main",
    );

    const output = flattenBundle(code, []);

    expect(rootLocals(output)).toEqual(["local __TS__Class"]);
    expect(output).toContain("\nfunction __TS__Class(self)\n");
    expect(output).not.toContain("____lualib");
    expect(output).not.toContain("local __TS__Class =");
  });

  test("publishes a binding declared in a multi-name local", () => {
    // `local Error, RangeError, ...` shadows the root slot for every name on the
    // line, so those exports have to be copied out at the end of the module
    // instead of assigned into the slot while the wrapper runs.
    const code = bundle(
      [
        [
          "lualib_bundle",
          `local Error, RangeError

do
    local function make(name)
        return {name = name}
    end

    Error = make("Error")

    local function create(name)
        local class = {base = Error.name}
        return class
    end

    RangeError = create("RangeError")
end
return {
    Error = Error,
    RangeError = RangeError
}`,
        ],
        [
          "src/main",
          `local ____lualib = require("lualib_bundle")
local Error = ____lualib.Error
local RangeError = ____lualib.RangeError
print(Error.name, RangeError.name)`,
        ],
      ],
      "src/main",
    );

    const output = flattenBundle(code, []);

    expect(rootLocals(output)).toEqual(["local ____export_1, ____export_2"]);
    expect(output).toContain("\nlocal Error, RangeError\n");
    expect(output).toContain("\n____export_1 = Error\n____export_2 = RangeError\n");
    expect(output).toContain("local Error = ____export_1");
  });

  test("keeps a local alias for an import renamed by the consumer", () => {
    const code = bundle(
      [
        ["src/a", exports("____exports.value = 1")],
        [
          "src/b",
          `local ____a = require("src/a")
local alias = ____a.value
print(alias)`,
        ],
      ],
      "src/b",
    );

    const output = flattenBundle(code, []);

    expect(output).toContain("\nlocal alias = value\n");
    expect(output).toContain("print(alias)");
  });

  test("publishes through a renamed root slot when the module redeclares the name", () => {
    const code = bundle(
      [
        [
          "src/a",
          exports(`local value = 0
local value = 1
____exports.value = value`),
        ],
        ["src/b", `local ____a = require("src/a")\nlocal a_value = ____a.value\nprint(a_value)`],
      ],
      "src/b",
    );

    const output = flattenBundle(code, []);

    // The module's second `local value` shadows the root slot, so the export is
    // copied out at the end of the wrapper instead of assigned into it.
    expect(output).toMatch(/^local ____export_1$/m);
    expect(output).toContain("\n____export_1 = value\n");
    expect(output).toContain("local a_value = ____export_1");
  });

  test("hoists an export whose name is a Lua keyword", () => {
    // TSTL writes `not` with bracket syntax and names the importing local
    // `____not`. `not` cannot be a Lua local, so the root slot takes the prefix.
    const code = bundle(
      [
        [
          "src/a",
          exports(`____exports["not"] = function(a)
    return not a
end`),
        ],
        [
          "src/b",
          `local ____a = require("src/a")
local ____not = ____a["not"]
print(____not(true))`,
        ],
      ],
      "src/b",
    );

    const output = flattenBundle(code, []);

    expect(output).toMatch(/^local ____not$/m);
    expect(output).toContain("\n____not = function(a)\n");
    expect(output).toContain("\nprint(____not(true))\n");
    expect(output).not.toContain("____exports");
    expect(output).not.toContain("____a");
  });

  test("gives two modules exporting the same name separate slots", () => {
    const code = bundle(
      [
        ["src/a", exports("____exports.config = 1")],
        ["src/b", exports("____exports.config = 2")],
        [
          "src/c",
          `local ____a = require("src/a")
local ____b = require("src/b")
local a_config = ____a.config
local b_config = ____b.config
print(a_config, b_config)`,
        ],
      ],
      "src/c",
    );

    const output = flattenBundle(code, []);
    const usage = usageOf(code);

    expect(usage.rootLocals).toBe(2);
    expect(output).toMatch(/^local config, ____export_1$/m);
    expect(output).toContain("\nconfig = 1\n");
    expect(output).toContain("\n____export_1 = config\n");
  });

  test("packs the coldest bindings into one table when the budget is tight", () => {
    const code = sharedBundle(20);
    const usage = usageOf(code, { registerBudget: TEMP_RESERVE + 3 });
    const output = flattenBundle(code, { registerBudget: TEMP_RESERVE + 3 });

    expect(usage.hot).toBe(2);
    expect(usage.cold).toBe(18);
    expect(usage.rootLocals).toBe(3);
    expect(output).toContain(`local ${COLD_TABLE} = {}`);
    expect(rootLocals(output).filter((line) => line.startsWith("local "))).toHaveLength(2);
    expect(output).toContain(`\n${COLD_TABLE}.b1 = b3\n`);
    expect(output).toContain(`\nlocal b3 = ${COLD_TABLE}.b1\n`);
  });

  test("keeps a 500-binding bundle's root under the default budget", () => {
    const code = manyModuleBundle(500, 5);
    const usage = usageOf(code);

    expect(usage.hoisted).toBe(500);
    expect(usage.rootLocals).toBeLessThanOrEqual(DEFAULT_REGISTER_BUDGET);
    expect(usage.rootLocals).toBe(DEFAULT_REGISTER_BUDGET - TEMP_RESERVE - 1 + 1);
    expect(usage.cold).toBe(500 - usage.hot);

    // Every consumer's wrapper stays under Luau's per-function limit too.
    if (usage.worst !== null) expect(usage.worst.locals).toBeLessThan(LUAU_REGISTER_LIMIT);
  });

  test("hoists a default export under the module's unique alias", () => {
    const code = bundle(
      [
        [
          "src/lib",
          exports(`function ____exports.default()
    return 1
end`),
        ],
        [
          "src/main",
          `local ____lib = require("src/lib")
local entry = ____lib.default
print(entry())`,
        ],
      ],
      "src/main",
    );

    const output = flattenBundle(code, []);

    expect(output).toMatch(/^local ____default_src_lib$/m);
    expect(output).toContain("\nfunction ____default_src_lib()\n");
    expect(output).toContain("\nlocal entry = ____default_src_lib\n");
    expect(output).not.toContain("____exports");
  });

  test("leaves the flat emission available for configs that want it", () => {
    const code = bundle([["src/main", exports("local value = 1")]], "src/main");
    const flat = flattenBundle(code, { scopeModules: false });

    expect(flat).not.toContain("____module_");
    expect(flat).toContain("local value = 1");
    expect(usageOf(code, { scopeModules: false }).worst).toEqual({ name: "src/main", locals: 1 });
  });

  test("flattens a keyword export in the flat emission too", () => {
    const code = bundle(
      [
        [
          "src/a",
          exports(`____exports["not"] = function(a)
    return not a
end`),
        ],
        [
          "src/b",
          `local ____a = require("src/a")
local ____not = ____a["not"]
print(____not(true))`,
        ],
      ],
      "src/b",
    );

    const flat = flattenBundle(code, { scopeModules: false });

    expect(flat).toContain("\nlocal ____not = function(a)\n");
    expect(flat).toContain("\nprint(____not(true))\n");
    expect(flat).not.toContain("____exports");
    expect(flat).not.toContain("____a");
  });

  test("reports the plan through transformLines", () => {
    const code = bundle(
      [
        ["src/a", exports("____exports.value = 1")],
        ["src/b", `local ____a = require("src/a")\nlocal a_value = ____a.value\nprint(a_value)`],
      ],
      "src/b",
    );
    const usages: RegisterUsage[] = [];

    transformLines(code, { onUsage: (usage) => usages.push(usage) });

    expect(usages).toHaveLength(1);
    expect(usages[0].hoisted).toBe(1);
    expect(usages[0].rootLocals).toBe(1);
    expect(usages[0].budget).toBe(DEFAULT_REGISTER_BUDGET);
    expect(usages[0].limit).toBe(LUAU_REGISTER_LIMIT);
  });
});

describe("root globals", () => {
  test("emits a module-local function as a global when it is listed", () => {
    const code = bundle(
      [
        [
          "src/main",
          exports(`local function tick()
    print("tick")
end
tick()`),
        ],
      ],
      "src/main",
    );
    const output = flattenBundle(code, { rootGlobals: ["tick"] });
    const usage = usageOf(code, { rootGlobals: ["tick"] });

    expect(output).toContain("\nfunction tick()\n");
    expect(output).not.toContain("local function tick");
    expect(usage.rootGlobals).toEqual(["tick"]);
    expect(usage.missingRootGlobals).toEqual([]);
  });

  test("leaves an assignment to a global alone and still records it", () => {
    const code = bundle([["src/main", exports(`tick = function()\nend`) + "\ntick()"]], "src/main");
    const output = flattenBundle(code, { rootGlobals: ["tick"] });

    expect(output).toContain("\ntick = function()\n");
    expect(usageOf(code, { rootGlobals: ["tick"] }).rootGlobals).toEqual(["tick"]);
  });

  test("publishes a shared binding to the global table after the modules run", () => {
    const code = bundle(
      [
        ["src/a", exports("____exports.run = function()\nend")],
        ["src/b", `local ____a = require("src/a")\nlocal run = ____a.run\nprint(run)`],
      ],
      "src/b",
    );
    const output = flattenBundle(code, { rootGlobals: ["run"] });
    const lastWrapper = output.lastIndexOf("\n____module_");

    expect(output.slice(lastWrapper)).toContain("\nrun = run\n");
    expect(usageOf(code, { rootGlobals: ["run"] }).rootGlobals).toEqual(["run"]);
  });

  test("reports a listed name the bundle never mentions", () => {
    const code = bundle([["src/main", exports("print(1)")]], "src/main");

    expect(usageOf(code, { rootGlobals: ["tick"] }).missingRootGlobals).toEqual(["tick"]);
  });

  test("applies to the flat emission too", () => {
    const code = bundle([["src/main", exports(`local function tick()\n    print("tick")\nend\ntick()`)]], "src/main");
    const flat = flattenBundle(code, { scopeModules: false, rootGlobals: ["tick"] });

    expect(flat).toContain("\nfunction tick()\n");
    expect(flat).not.toContain("local function tick");
  });

  test("does not bind a default export the bundle does not define", () => {
    const code = bundle(
      [
        ["src/state", exports("local Global = 1")],
        ["src/main", `local ____state = require("src/state")\nlocal Global = ____state.default\nprint(Global)`],
      ],
      "src/main",
    );
    const output = flattenBundle(code, {});

    expect(output).not.toContain("local Global = default");
    expect(output).not.toContain("____state");
  });
});

/**
 * One producer exporting `count` values and consumers that each import a slice
 * of them, so no single wrapper holds every binding.
 */
function sharedBundle(count: number, consumers = 1): string {
  const producer = ["local ____exports = {}"];
  const consumerBodies = Array.from({ length: consumers }, () => [] as string[]);
  const prints = Array.from({ length: consumers }, () => [] as string[]);

  for (let index = 1; index <= count; index++) {
    const slice = (index - 1) % consumers;

    producer.push(`____exports.b${index} = ${index}`);
    consumerBodies[slice].push(`local b${index} = ____p.b${index}`);
    prints[slice].push(`b${index}`);
  }

  producer.push("return ____exports");

  const modules: [string, string][] = [["src/producer", producer.join("\n")]];

  for (let index = 0; index < consumers; index++) {
    modules.push([
      `src/consumer${index}`,
      `local ____p = require("src/producer")\n${consumerBodies[index].join("\n")}\nprint(${prints[index].join(", ")})`,
    ]);
  }

  return bundle(modules, "src/consumer0");
}

/**
 * One producer module per binding, so the test measures the root plan's budget
 * rather than a single module's own locals.
 */
function manyModuleBundle(count: number, consumers: number): string {
  const modules: [string, string][] = [];
  const consumerBodies = Array.from({ length: consumers }, () => [] as string[]);
  const prints = Array.from({ length: consumers }, () => [] as string[]);

  for (let index = 1; index <= count; index++) {
    const slice = (index - 1) % consumers;

    modules.push([`src/p${index}`, `local ____exports = {}\n____exports.b${index} = ${index}\nreturn ____exports`]);
    consumerBodies[slice].push(
      `local ____p${index} = require("src/p${index}")\nlocal b${index} = ____p${index}.b${index}`,
    );
    prints[slice].push(`b${index}`);
  }

  for (let index = 0; index < consumers; index++) {
    modules.push([`src/consumer${index}`, `${consumerBodies[index].join("\n")}\nprint(${prints[index].join(", ")})`]);
  }

  return bundle(modules, "src/consumer0");
}
