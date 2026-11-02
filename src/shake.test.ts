import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import * as tstl from "typescript-to-lua";

import { createPlugin, default as defaultPlugin, type PluginConfig } from "./index";

// createVirtualProgram is exported for TSTL's own tests but marked @internal in
// the declarations, so reach for it through the runtime namespace.
const createVirtualProgram = (
  tstl as unknown as {
    createVirtualProgram(files: Record<string, string>, options?: ts.CompilerOptions): ts.Program;
  }
).createVirtualProgram;

interface EmitResult {
  files: Record<string, string>;
  diagnostics: readonly ts.Diagnostic[];
}

function transpile(files: Record<string, string>, config: Partial<PluginConfig> = {}): EmitResult {
  const program = createVirtualProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.esnext.d.ts"],
    types: [],
    noHeader: true,
    luaTarget: tstl.LuaTarget.Lua54,
  });

  const output: Record<string, string> = {};
  const result = new tstl.Transpiler({
    emitHost: { ...ts.sys, writeFile: () => undefined },
  }).emit({
    program,
    plugins: [createPlugin(config)],
    writeFile: (fileName, data) => {
      output[fileName] = data;
    },
  });

  return { files: output, diagnostics: result.diagnostics };
}

function luaOf(result: EmitResult, name = "main.lua"): string {
  const file = result.files[name];

  if (file === undefined) {
    throw new Error(`expected ${name}, got ${Object.keys(result.files).join(", ")}`);
  }

  return file;
}

describe("tree shaking", () => {
  test("leaves code alone unless shake is enabled", () => {
    const source = `
function liveFn() { return "live"; }
function deadFn() { return "dead"; }
print(liveFn());
`;
    const { files, diagnostics } = transpile({ "main.ts": source });
    const lua = luaOf({ files, diagnostics });

    expect(diagnostics).toEqual([]);
    expect(lua).toContain("liveFn");
    expect(lua).toContain("deadFn");
  });

  test("removes functions reachable only from other dead functions", () => {
    const source = `
function liveFn() { return "live"; }
function deadFn() { return "dead"; }
function deadCaller() { return deadFn(); }
print(liveFn());
`;
    const { files, diagnostics } = transpile({ "main.ts": source }, { shake: true });
    const lua = luaOf({ files, diagnostics });

    expect(diagnostics).toEqual([]);
    expect(lua).toContain("liveFn");
    expect(lua).not.toContain("deadFn");
    expect(lua).not.toContain("deadCaller");
  });

  test("removes unused locals and keeps used ones", () => {
    const source = `
function makeValue() { return 1; }
function run() {
  const kept = makeValue();
  const dropped = 123;
  const alsoDropped = "text";
  return kept;
}
print(run());
`;
    const { files, diagnostics } = transpile({ "main.ts": source }, { shake: true });
    const lua = luaOf({ files, diagnostics });

    expect(diagnostics).toEqual([]);
    expect(lua).toContain("kept");
    expect(lua).not.toContain("dropped");
    expect(lua).not.toContain("alsoDropped");
  });

  test("preserves side effects from an unused initializer", () => {
    const source = `
declare function listen(): number;
function run() {
  const handle = listen();
}
run();
`;
    const { files, diagnostics } = transpile({ "main.ts": source }, { shake: true });
    const lua = luaOf({ files, diagnostics });

    expect(diagnostics).toEqual([]);
    expect(lua).toContain("listen(");
    expect(lua).not.toContain("handle");
  });

  test("removes local functions only reachable from dead local functions", () => {
    const source = `
function run() {
  function live() { return 1; }
  function deadFn() { return 2; }
  function deadCaller() { return deadFn(); }
  return live();
}
print(run());
`;
    const { files, diagnostics } = transpile({ "main.ts": source }, { shake: true });
    const lua = luaOf({ files, diagnostics });

    expect(diagnostics).toEqual([]);
    expect(lua).toContain("live");
    expect(lua).not.toContain("deadFn");
    expect(lua).not.toContain("deadCaller");
  });

  test("keeps declarations imported by another module", () => {
    const { files, diagnostics } = transpile(
      {
        "lib.ts": `
export function wanted() { return 1; }
export function unwanted() { return 2; }
`,
        "main.ts": `
import { wanted } from "./lib";
print(wanted());
`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics }, "lib.lua")).toContain("wanted");
    expect(luaOf({ files, diagnostics }, "lib.lua")).not.toContain("unwanted");
  });

  test("follows re-export chains", () => {
    const { files, diagnostics } = transpile(
      {
        "impl.ts": `export function viaReExport() { return 1; }`,
        "barrel.ts": `export { viaReExport } from "./impl";`,
        "main.ts": `
import { viaReExport } from "./barrel";
print(viaReExport());
`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics }, "impl.lua")).toContain("viaReExport");
  });

  test("drops export specifiers for removed declarations", () => {
    const { files, diagnostics } = transpile(
      {
        "lib.ts": `
function helper() { return 1; }
export { helper };
`,
        "main.ts": `print("entry");`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics }, "lib.lua")).not.toContain("helper");
  });

  test("keeps top-level side effects", () => {
    const source = `
declare function register(): void;
const handle = register();
print("ready");
`;
    const { files, diagnostics } = transpile({ "main.ts": source }, { shake: true });
    const lua = luaOf({ files, diagnostics });

    expect(diagnostics).toEqual([]);
    expect(lua).toContain("register(");
    expect(lua).not.toContain("handle");
  });

  test("removes unused classes but keeps instantiated ones", () => {
    const source = `
class Dead {
  value() { return 1; }
}
class Live {
  value() { return 2; }
}
print(new Live().value());
`;
    const { files, diagnostics } = transpile({ "main.ts": source }, { shake: true });
    const lua = luaOf({ files, diagnostics });

    expect(diagnostics).toEqual([]);
    expect(lua).toContain("Live");
    expect(lua).not.toContain("Dead");
  });

  test("keeps class methods unless class shaking is enabled", () => {
    const source = `
class Widget {
  constructor(public value: number) {}
  used() { return this.value; }
  unused() { return 42; }
}
const widget = new Widget(1);
print(widget.used());
`;
    const withoutClassShake = luaOf(transpile({ "main.ts": source }, { shake: true }));
    expect(withoutClassShake).toContain("unused");

    const withClassShake = luaOf(transpile({ "main.ts": source }, { shake: true, shakeClassFunctions: true }));
    expect(withClassShake).toContain("used");
    expect(withClassShake).not.toContain("unused");
  });

  test("keeps class methods referenced from live methods", () => {
    const source = `
class Widget {
  used() { return this.helper(); }
  helper() { return 1; }
  unused() { return 2; }
}
print(new Widget().used());
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true, shakeClassFunctions: true }));

    expect(lua).toContain("helper");
    expect(lua).not.toContain("unused");
  });

  test("accepts the class shaking aliases", () => {
    const source = `
class Widget {
  used() { return 1; }
  unused() { return 2; }
}
print(new Widget().used());
`;

    for (const alias of ["shakeClasses", "classFunctions", "removeClassFunctions", "shakeClassMembers"] as const) {
      const lua = luaOf(transpile({ "main.ts": source }, { shake: true, [alias]: true }));
      expect(lua).not.toContain("unused");
    }
  });

  test("keeps side-effectful declarators in their original order", () => {
    const source = `
declare function firstCall(): number;
declare function secondCall(): number;
function deadHelper() { return 1; }
function run() {
  const a = firstCall(), b = 42, c = secondCall();
  return 0;
}
run();
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true }));
    const first = lua.indexOf("firstCall");
    const second = lua.indexOf("secondCall");

    expect(lua).not.toContain("local a");
    expect(lua).not.toContain("local b");
    expect(lua).not.toContain("local c");
    expect(lua).not.toContain("deadHelper");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  test("keeps a class with a static side effect even when unused", () => {
    const source = `
declare function setup(): void;
class DeadButSideEffectful {
  static ready = setup();
  unusedMethod() { return 1; }
}
print("entry");
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true, shakeClassFunctions: true }));

    expect(lua).toContain("DeadButSideEffectful");
    expect(lua).toContain("setup(");
    expect(lua).not.toContain("unusedMethod");
  });

  test("removes unused local classes", () => {
    const source = `
function run() {
  class Dead {
    value() { return 1; }
  }
  class Live {
    value() { return 2; }
  }
  return new Live().value();
}
print(run());
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true }));

    expect(lua).toContain("Live");
    expect(lua).not.toContain("Dead");
  });

  test("keeps a default export that another module imports", () => {
    const { files, diagnostics } = transpile(
      {
        "lib.ts": `export default function defaultEntry() { return 1; }`,
        "main.ts": `
import defaultEntry from "./lib";
print(defaultEntry());
`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics }, "lib.lua")).toContain("____exports.default");
  });

  test("keeps a default export that aliases a local declaration", () => {
    const { files, diagnostics } = transpile(
      {
        "lib.ts": `
class Store { value: number; constructor() { this.value = 1; } }
const store = new Store();
export default store;
`,
        "main.ts": `
import store from "./lib";
print(store.value);
`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics }, "lib.lua")).toContain("____exports.default");
  });

  test("keeps class methods called by the constructor", () => {
    const source = `
class Widget {
  constructor() { this.helper(); }
  helper() { return 1; }
  unused() { return 2; }
}
print(new Widget());
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true, shakeClassFunctions: true }));

    expect(lua).toContain("helper");
    expect(lua).not.toContain("unused");
  });

  test("keeps assignment effects in removed locals", () => {
    const source = `
function run() {
  let control = 0;
  const unused = (control = 1);
  return control;
}
print(run());
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true }));

    expect(lua).not.toContain("unused");
    expect(lua).toContain("control = 1");
  });

  test("keeps computed object method names in removed locals", () => {
    const source = `
declare function key(): string;
const unused = { [key()]() { return 1; } };
print("entry");
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true }));

    expect(lua).not.toContain("unused");
    expect(lua).toContain("key(");
  });

  test("keeps getter and setter pairs together", () => {
    const source = `
class Widget {
  get used() { return 1; }
  set used(value: number) {}
  get unused() { return 2; }
  set unused(value: number) {}
}
const widget = new Widget();
print(widget.used);
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true, shakeClassFunctions: true }));

    expect(lua).toContain("used");
    expect(lua).not.toContain("unused");
  });

  test("keeps methods with computed property names", () => {
    const source = `
const key = "compute";
class Widget {
  used() { return 1; }
  [key]() { return 2; }
  unused() { return 3; }
}
const w = new Widget();
print(w.used());
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true, shakeClassFunctions: true }));

    expect(lua).toContain("used");
    // The [key]() method should be preserved — computed names can't be
    // statically resolved, so it's never safe to remove them.
    expect(lua).toContain("compute");
    expect(lua).not.toContain("unused");
  });

  test("keeps [Symbol.iterator] on a class used via for-of", () => {
    const source = `
class NumberRange {
  constructor(private start: number, private end: number) {}
  *[Symbol.iterator]() {
    for (let i = this.start; i < this.end; i++) yield i;
  }
  unused() { return 42; }
}
const range = new NumberRange(0, 5);
for (const n of range) print(n);
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true, shakeClassFunctions: true }));

    expect(lua).toContain("NumberRange");
    expect(lua).not.toContain("unused");
  });

  test("reads options through TSTL's plugin factory", () => {
    const files = {
      "main.ts": `
function liveFn() { return 1; }
function deadFn() { return 2; }
print(liveFn());
`,
    };
    const program = createVirtualProgram(files, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      lib: ["lib.esnext.d.ts"],
      types: [],
      noHeader: true,
      luaTarget: tstl.LuaTarget.Lua54,
      luaPlugins: [{ plugin: defaultPlugin, shake: true }],
    } as tstl.CompilerOptions);

    const output: Record<string, string> = {};
    new tstl.Transpiler({
      emitHost: { ...ts.sys, writeFile: () => undefined },
    }).emit({
      program,
      writeFile: (fileName, data) => {
        output[fileName] = data;
      },
    });

    expect(output["main.lua"]).toContain("liveFn");
    expect(output["main.lua"]).not.toContain("deadFn");
  });

  test("shakes and flattens a bundle in one emit", () => {
    const program = createVirtualProgram(
      {
        "lib.ts": `
export function usedFn() { return 1; }
export function deadFn() { return 2; }
`,
        "main.ts": `
import { usedFn } from "./lib";
print(usedFn());
`,
      },
      {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        lib: ["lib.esnext.d.ts"],
        types: [],
        noHeader: true,
        luaTarget: tstl.LuaTarget.Lua54,
        luaBundle: "bundle.lua",
        luaBundleEntry: "main.ts",
        luaPlugins: [{ plugin: defaultPlugin, shake: true }],
      } as tstl.CompilerOptions,
    );

    const output: Record<string, string> = {};
    new tstl.Transpiler({
      // afterEmit rewrites the file through the emit host, so capture there.
      emitHost: {
        ...ts.sys,
        writeFile: (fileName, data) => {
          output[fileName] = data;
        },
      },
    }).emit({ program });

    const bundlePath = Object.keys(output).find((fileName) => fileName.endsWith("bundle.lua"));
    const bundle = bundlePath === undefined ? undefined : output[bundlePath];
    expect(bundle).toBeDefined();
    expect(bundle).toContain("usedFn");
    expect(bundle).not.toContain("deadFn");
    expect(bundle).not.toContain("____modules");
    expect(bundle).not.toContain('require("lib")');
  });
});

describe("dead modules", () => {
  test("prunes unused import bindings", () => {
    const { files, diagnostics } = transpile(
      {
        "lib.ts": `
export function used() { return "used"; }
export function unused() { return "unused"; }
`,
        "main.ts": `
import { used, unused } from "./lib";
print(used());
`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics })).not.toContain("unused");
    expect(luaOf({ files, diagnostics }, "lib.lua")).not.toContain("unused");
  });

  test("removes a default export nobody imports", () => {
    const { files, diagnostics } = transpile(
      {
        "lib.ts": `
const secret = "secret";
export default { secret };
`,
        "main.ts": `print("entry");`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics }, "lib.lua")).not.toContain("secret");
  });

  test("keeps a default export that is imported", () => {
    const { files, diagnostics } = transpile(
      {
        "lib.ts": `
function helper() { return "helper"; }
export default { helper };
`,
        "main.ts": `
import api from "./lib";
print(api.helper());
`,
      },
      { shake: true },
    );

    expect(diagnostics).toEqual([]);
    expect(luaOf({ files, diagnostics }, "lib.lua")).toContain("helper");
  });

  test("strips a module kept alive only by an unobserved allocation", () => {
    const { files, diagnostics } = transpile(
      {
        "parser.ts": `
export class Parser {
  options: { strict: boolean } = { strict: false };
  constructor(public optionsOverride: { strict: boolean } = { strict: true }) {
    this.options = optionsOverride;
  }
  parse() { return "parsed"; }
}
const defaultParser = new Parser();
`,
        "index.ts": `
import { Parser } from "./parser";
export default { Parser };
`,
        "debug.ts": `
import { Parser } from "./index";
export class DebugMenu {
  run() { return new Parser().parse(); }
}
`,
        "main.ts": `
import { DebugMenu } from "./debug";
if (DEBUG) new DebugMenu();
print("entry");
`,
      },
      { globals: { DEBUG: false }, shake: true },
    );

    expect(diagnostics).toEqual([]);

    const lua = Object.values(files).join("\n");

    expect(lua).toContain("entry");
    expect(lua).not.toContain("Parser");
  });

  test("keeps an allocation whose constructor has side effects", () => {
    const source = `
declare function register(): void;
class Widget {
  constructor() { register(); }
}
const instance = new Widget();
print("entry");
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true }));

    expect(lua).toContain("entry");
    expect(lua).toContain("register(");
  });

  test("keeps an allocation when a setter could run", () => {
    const source = `
class Widget {
  set value(next: number) {}
  constructor() { this.value = 1; }
}
const instance = new Widget();
print("entry");
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true }));

    expect(lua).toContain("entry");
    expect(lua).toContain("Widget");
  });
});
