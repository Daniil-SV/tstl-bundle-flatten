import { afterEach, describe, expect, test } from "bun:test";
import * as ts from "typescript";
import * as tstl from "typescript-to-lua";

import { createPlugin, type PluginConfig } from "./index";

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

const envNames: string[] = [];

function setEnv(name: string, value: string): void {
  envNames.push(name);
  process.env[name] = value;
}

afterEach(() => {
  for (const name of envNames.splice(0)) delete process.env[name];
});

describe("global injection", () => {
  test("injects a false value and removes the dead branch", () => {
    const source = `
function deadFn() { return "dead"; }
if (DEBUG) {
  print(deadFn());
}
print("alive");
`;
    const lua = luaOf(transpile({ "main.ts": source }, { globals: { DEBUG: false }, shake: true }));

    expect(lua).toContain("alive");
    expect(lua).not.toContain("deadFn");
    expect(lua).not.toContain("DEBUG");
  });

  test("injects a true value and keeps the live branch", () => {
    const source = `
if (DEBUG) {
  print("debug");
} else {
  print("release");
}
`;
    const lua = luaOf(transpile({ "main.ts": source }, { globals: { DEBUG: true } }));

    expect(lua).toContain("debug");
    expect(lua).not.toContain("release");
  });

  test("accepts a darklua-style list of globals", () => {
    const source = `
if (DEBUG) {
  print("debug");
}
print("always");
`;
    const lua = luaOf(
      transpile({ "main.ts": source }, { injectGlobalValues: [{ identifier: "DEBUG", value: false }] }),
    );

    expect(lua).toContain("always");
    expect(lua).not.toContain("debug");
  });

  test("accepts darklua snake_case keys", () => {
    setEnv("TSTL_TEST_DEBUG_SNAKE", "false");

    const source = `
if (DEBUG) {
  print("debug");
}
print("always");
`;
    const lua = luaOf(
      transpile(
        { "main.ts": source },
        {
          injectGlobalValues: [{ identifier: "DEBUG", env_json: undefined, default_value: false }],
        },
      ),
    );

    expect(lua).toContain("always");
    expect(lua).not.toContain("debug");
  });

  test("reads values from the environment", () => {
    setEnv("TSTL_TEST_DEBUG", "false");

    const source = `
if (DEBUG) {
  print("debug");
}
print("always");
`;
    const lua = luaOf(
      transpile(
        { "main.ts": source },
        {
          injectGlobalValues: [{ identifier: "DEBUG", env: "TSTL_TEST_DEBUG", defaultValue: true }],
        },
      ),
    );

    expect(lua).toContain("always");
    expect(lua).not.toContain("debug");
  });

  test("uses the default value when the environment variable is missing", () => {
    const source = `
if (DEBUG) {
  print("debug");
} else {
  print("release");
}
`;
    const lua = luaOf(
      transpile(
        { "main.ts": source },
        {
          injectGlobalValues: [{ identifier: "DEBUG", env: "TSTL_TEST_MISSING", defaultValue: true }],
        },
      ),
    );

    expect(lua).toContain("debug");
    expect(lua).not.toContain("release");
  });

  test("parses JSON from the environment", () => {
    setEnv("TSTL_TEST_LIMIT", "42");

    const source = `
if (LIMIT > 40) {
  print("high");
}
print("always");
`;
    const lua = luaOf(
      transpile({ "main.ts": source }, { injectGlobalValues: [{ identifier: "LIMIT", envJson: "TSTL_TEST_LIMIT" }] }),
    );

    expect(lua).toContain("high");
  });

  test("accepts the injectGlobals alias", () => {
    const source = `
if (DEBUG) {
  print("debug");
}
print("always");
`;
    const lua = luaOf(transpile({ "main.ts": source }, { injectGlobals: { DEBUG: false } }));

    expect(lua).toContain("always");
    expect(lua).not.toContain("debug");
  });

  test("leaves shadowing locals alone", () => {
    const source = `
function pick() {
  const DEBUG = true;
  if (DEBUG) return "local";
  return "outer";
}
print(pick());
`;
    const lua = luaOf(transpile({ "main.ts": source }, { globals: { DEBUG: false } }));

    expect(lua).toContain("local");
  });

  test("leaves matching property names alone", () => {
    const source = `
const options = { DEBUG: "field" };
print(options.DEBUG);
`;
    const lua = luaOf(transpile({ "main.ts": source }, { globals: { DEBUG: false } }));

    expect(lua).toContain("DEBUG");
    expect(lua).not.toContain("options.false");
  });
});

describe("expression folding", () => {
  test("folds static conditions before shaking", () => {
    const source = `
function used() { return "math"; }
function unused() { return "nope"; }
if (1 + 1 === 2) {
  print(used());
} else {
  print(unused());
}
`;
    const lua = luaOf(transpile({ "main.ts": source }, { shake: true }));

    expect(lua).toContain("math");
    expect(lua).not.toContain("nope");
  });

  test("removes loops with a statically false condition", () => {
    const source = `
while (false) {
  print("never");
}
do {
  print("once");
} while (false);
`;
    const lua = luaOf(transpile({ "main.ts": source }, { computeExpressions: true }));

    expect(lua).not.toContain("never");
    expect(lua).toContain("once");
  });

  test("removes side-effect-free expression statements", () => {
    const source = `
1 + 2;
print("kept");
`;
    const lua = luaOf(transpile({ "main.ts": source }, { computeExpressions: true }));

    expect(lua).toContain("kept");
    expect(lua).not.toContain("3");
  });

  test("keeps everything when compute expressions is disabled", () => {
    const source = `
if (DEBUG) {
  print("debug");
} else {
  print("release");
}
`;
    const lua = luaOf(transpile({ "main.ts": source }, { globals: { DEBUG: false }, computeExpressions: false }));

    expect(lua).toContain("debug");
    expect(lua).toContain("release");
    expect(lua).not.toContain("DEBUG");
  });
});

describe("dead code with globals", () => {
  test("removes a class only referenced from a stripped branch", () => {
    const source = `
class UIDebugMenu {
  update() { print("debug update"); }
}
class UISystem {
  debug?: UIDebugMenu;
  constructor() {
    if (DEBUG) this.debug = new UIDebugMenu();
  }
  update() {
    if (DEBUG) this.debug?.update();
    print("ui update");
  }
}
new UISystem().update();
`;
    const lua = luaOf(transpile({ "main.ts": source }, { globals: { DEBUG: false }, shake: true }));

    expect(lua).toContain("ui update");
    expect(lua).not.toContain("UIDebugMenu");
    expect(lua).not.toContain("debug update");
  });

  test("keeps the class when the branch is live", () => {
    const source = `
class UIDebugMenu {
  update() { print("debug update"); }
}
class UISystem {
  debug?: UIDebugMenu;
  constructor() {
    if (DEBUG) this.debug = new UIDebugMenu();
  }
  update() {
    if (DEBUG) this.debug?.update();
    print("ui update");
  }
}
new UISystem().update();
`;
    const lua = luaOf(transpile({ "main.ts": source }, { globals: { DEBUG: true }, shake: true }));

    expect(lua).toContain("UIDebugMenu");
    expect(lua).toContain("debug update");
  });
});
