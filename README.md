# `@gwigz/tstl-bundle-flatten`

A [TypeScriptToLua](https://github.com/TypeScriptToLua/TypeScriptToLua) plugin that flattens `luaBundle` output, eliminating the module system entirely.

TSTL's bundler wraps each module in a closure with a `require()` runtime. This plugin rewrites the bundle to emit all module code in dependency order, removing the `____modules` table, `____moduleCache`, `require()` function, module closures, and import/export boilerplate.

Each module body is emitted inside a function that runs immediately. That keeps private locals out of the chunk's root scope, which matters on Luau: a function gets 200 registers, and a flattened bundle is one function. Only bindings another module imports are hoisted to the root.

## When is this useful?

Some Lua runtimes don't support or benefit from a module system, or are have tight limitations. If you're targeting an environment like this and using `luaBundle`, the generated runtime adds unnecessary overhead. This plugin strips it out and gives you clean, top-level code.

## Install

```sh
bun add -D @gwigz/tstl-bundle-flatten
# or
npm install -D @gwigz/tstl-bundle-flatten
```

## Setup

Add the plugin to your `tsconfig.json`:

```diff
{
  "tstl": {
    "luaBundle": "bundle.lua",
    "luaBundleEntry": "src/index.ts",
    "luaPlugins": [
+     { "name": "@gwigz/tstl-bundle-flatten" }
    ]
  }
}
```

## Options

Options are passed inline in the plugin entry:

```jsonc
{
  "name": "@gwigz/tstl-bundle-flatten",
  // Modules to exclude from flattening (kept in the bundle runtime)
  "skipModules": ["constants"],
  // Insert blank lines at code boundaries for readability (default: true)
  "format": true,
  // Remove unused TypeScript declarations before TSTL emits Lua (default: false)
  "shake": false,
  // Also remove unused class methods and accessors (default: false)
  "shakeClassFunctions": false,
  // Fold constant expressions and remove statically dead branches.
  // Defaults to true when `shake` is enabled or any globals are configured.
  "computeExpressions": true,
  // Compile-time globals: a literal, or an object with value/env/envJson/defaultValue
  "globals": {
    "DEBUG": { "env": "DEBUG", "defaultValue": false },
    "BUILD_VERSION": "1.0.0",
  },
  // Wrap each module in a function so its locals leave the root scope (default: true)
  "scopeModules": true,
  // Root locals the plan aims for; the coldest bindings move into a table (default: 150)
  "registerBudget": 150,
  // Root locals that count as a failure when warning (default: 200)
  "registerLimit": 200,
  // Warn when the flattened bundle does not fit the register limit (default: "warn")
  "registerReport": "warn",
  // Names host Lua must reach as globals, e.g. a server-invoked `tick` (default: [])
  "rootGlobals": ["tick", "spawn"],
}
```

| Option                | Type                      | Default                        | Description                                                       |
| --------------------- | ------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `skipModules`         | `string[]`                | `[]`                           | Module names to leave untouched by the flattener                  |
| `format`              | `boolean`                 | `true`                         | Add whitespace between logical code blocks in the output          |
| `shake`               | `boolean`                 | `false`                        | Remove unused TypeScript declarations before TSTL emits Lua       |
| `shakeClassFunctions` | `boolean`                 | `false`                        | Also remove unused class methods and accessors (requires `shake`) |
| `computeExpressions`  | `boolean`                 | `true` with `shake` or globals | Fold constant expressions and remove statically dead branches     |
| `globals`             | `Record<string, unknown>` | `{}`                           | Compile-time globals to inject                                    |
| `injectGlobals`       | `Record<string, unknown>` | `{}`                           | Alias for `globals`                                               |
| `injectGlobalValues`  | `object[]`                | `[]`                           | darklua-style list of globals to inject                           |
| `scopeModules`        | `boolean`                 | `true`                         | Wrap each module in its own function to relieve root registers    |
| `registerBudget`      | `number \| false`         | `150`                          | Root locals to aim for; the rest pack into a table                |
| `registerLimit`       | `number \| false`         | `200`                          | Root locals that trigger the warning                              |
| `registerReport`      | `"warn" \| "off"`         | `"warn"`                       | Warn when the bundle exceeds `registerLimit`                      |
| `rootGlobals`         | `string[]`                | `[]`                           | Names host Lua must reach as globals (not compile-time values)    |

## Register pressure

Luau allows 200 registers in one function, and a flattened bundle is one function:
every module-level local used to compete for the same 200. With `scopeModules` on
(the default) each module body runs inside its own wrapper, so its private locals
stop counting against the root:

```lua
local greet -- hoisted: another module imports it

do
local function ____module_0()
function greet(name)
    print("Hello, " .. name)
end
end
____module_0()
end
```

The wrapper is declared inside a `do` block and called at once, so the wrapper name
itself costs no root register.

Bindings another module imports cannot stay private. The plugin counts how often each
one is referenced and keeps the hottest as direct root locals, up to `registerBudget`
minus a small reserve for expression temporaries. The rest go into one `____cold`
table (`____cold.b1`, `____cold.b2`, ...), which costs a single register no matter how
many bindings it holds. Consumers still get an ordinary `local` alias inside their own
wrapper, so module bodies are not rewritten.

Inside the wrapper, `local X = value` becomes `X = value` and `local function X()`
becomes `function X()`, assigning the hoisted root slot directly. A module that
declares the exported name more than once cannot do that, so it keeps its own local
and copies it to a renamed slot (`____export_1`) at the end.

Set `"registerBudget": false` to keep every hoisted binding direct, or
`"registerReport": "off"` to silence the warning. The warning fires when the root
scope, or a single module's wrapper, exceeds `registerLimit`; it names the module to
split when that is the problem.

`"scopeModules": false` restores the previous flat emission, where every module body
landed in the root scope. It is there for bundles that rely on that single-scope
behaviour; it has no register planning.

TSTL's own runtime is a module too. With `luaLibImport: "require-minimal"` (or
`"require"`) the bundle starts with a `lualib_bundle` module whose helpers are
published through a `return { name = name, ... }` table rather than `____exports`.
The flattener reads that table like any other export list, so
`local __TS__Class = ____lualib.__TS__Class` resolves to a root slot instead of a
nil global.

## Root globals

A host script often calls into the bundle directly, for example a server that runs
`tick()` every frame. Scoping keeps module locals inside their wrapper, so a name
declared with `local` is not reachable from outside. List those names in
`rootGlobals`:

```jsonc
{
  "rootGlobals": ["tick", "spawn"],
}
```

For each listed name:

- A module-level `local` declaration loses the keyword (`local function tick` becomes
  `function tick`). The value is assigned to the global table instead of a wrapper
  local, so host Lua sees it as soon as that module runs.
- A name that is already assigned without `local` is left alone; it is global
  already.
- A name that is also shared between modules keeps its register plan, and the
  flattened bundle copies it to the global table after the last module runs
  (`tick = tick`). This also covers bindings packed into `____cold`.
- A name the bundle never declares or assigns is reported by `registerReport`, which
  catches typos.

`rootGlobals` is unrelated to `globals`: `globals` are values substituted at compile
time, while `rootGlobals` only changes where existing bindings live. Names emitted
this way are real Lua globals, so darklua's `rename_variables` only keeps them if
they are in its `detect_globals` list (or `rename_variables` is off).

## Tree shaking

With `"shake": true`, the plugin runs TSTL's `beforeTransform` hook and removes
dead declarations from the TypeScript AST. TSTL then emits Lua that never
contained the removed code, so there is no post-processing pass and no second
Lua parser.

The pass follows references across modules and re-export chains. A function
that is only called by another dead function is removed too, while anything
reachable from top-level code stays. Side effects are preserved: an unused
`const handle = listen()` becomes the bare call `listen()`, and a class with a
static initializer is kept even if nothing references the class.

Class methods are kept by default because they can be reached dynamically.
Set `"shakeClassFunctions": true` to remove methods and accessors that are never
referenced. This relies on the type checker, so reflection-style access such as
`obj["method"]()` or passing an instance through `any` can hide a use. Leave it
off when a class is used that way.

Namespaces are left intact because their bodies are emitted as a whole.

## Compile-time globals

This is the TypeScript equivalent of darklua's `inject_global_value` and
`compute_expression` rules. Globals and constant conditions are resolved in the
TypeScript AST, before TSTL emits Lua and before tree shaking runs. A branch that
can never execute is removed, so declarations that were only referenced from
that branch become unreachable and are shaken too.

```jsonc
{
  "name": "@gwigz/tstl-bundle-flatten",
  "shake": true,
  "globals": {
    // Static value
    "BUILD_VERSION": "1.0.0",
    // String from the environment, parsed as a boolean/number when possible
    "DEBUG": { "env": "DEBUG", "defaultValue": false },
    // JSON value from the environment
    "LIMITS": { "envJson": "GAME_LIMITS", "defaultValue": 10 },
  },
}
```

The darklua-style list form is also accepted, including snake_case keys:

```jsonc
{
  "injectGlobalValues": [
    { "identifier": "DEBUG", "env": "DEBUG", "defaultValue": false },
    { "identifier": "LIMITS", "env_json": "GAME_LIMITS", "default_value": 10 },
    { "identifier": "BUILD_VERSION", "value": "1.0.0" },
  ],
}
```

For example, with `DEBUG` resolving to `false`:

```ts
class UIDebugMenu {
  update() {
    /* ... */
  }
}

class UISystem {
  debug?: UIDebugMenu;

  constructor() {
    if (DEBUG) this.debug = new UIDebugMenu();
  }

  update() {
    if (DEBUG) this.debug?.update();
  }
}
```

The `if (DEBUG)` branches are removed before shaking, so `UIDebugMenu` is no
longer referenced and disappears from the emitted Lua.

Notes:

- `env` keeps darklua's string form but parses `true`, `false`, `null`,
  `undefined` and numeric values, so `DEBUG=false` works as a condition.
- `envJson` is parsed with `JSON.parse`; invalid JSON is a build error.
- `defaultValue` is used when the environment variable is missing.
- Only primitives (`boolean`, `number`, `string`, `bigint`, `null`,
  `undefined`) can be injected.
- A local variable or import with the same name shadows the configured global.
- Folding also handles `if`, `while`/`do` conditions, conditional expressions,
  logical and comparison operators, arithmetic and bitwise operators, and
  removes side-effect-free expression statements.
- Set `"computeExpressions": false` to inject globals without removing branches.

## Source maps

With `"sourceMap": true` in your `compilerOptions`, the plugin rewrites the emitted
`.map` alongside the code, so generated lines still resolve back to the original
TypeScript after shaking, flattening and formatting.

Mapping is line accurate, not column accurate: the transforms rewrite line contents,
so only the line a statement ended up on is meaningful. That is enough to turn a
runtime or compiler error in the flattened output back into a file and line you
recognise.

TSTL writes the map before plugins run, so without this the `.map` on disk would
describe the unflattened bundle and point at the wrong lines.

`inlineSourceMap` is not supported: TSTL appends its comment after the bundle's
entry call, which flattening drops along with the rest of the module runtime.

## Example

Given a bundle with two modules:

```
src/
├── greet.ts → export function greet(name: string) { ... }
└── index.ts → import { greet } from "./greet"
```

TSTL's default `luaBundle` output wraps everything in a module runtime. After `tstl-bundle-flatten`, you get:

```lua
local greet
do
local function ____module_0()
function greet(name)
    print("Hello, " .. name)
end
end
____module_0()
end

do
local function ____module_1()
greet("world")
end
____module_1()
end
```

No `____modules`, no `require`, no module runtime. `greet` is hoisted because the
second module imports it; each module's remaining locals stay in its wrapper.
