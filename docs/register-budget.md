# Register budget for flattened bundles

Implemented. See "Status" at the end for what differs from the plan.

## Problem

Luau gives every function 200 registers. A flattened bundle is a single top-level
function, so every module-level `local` competes for that one budget, and locals stay
live for the whole chunk because nothing closes their scope.

Flattening deletes the per-module closure TSTL emitted, and that closure was exactly
what kept register pressure local. So the limit is self-inflicted by flatten.

Measured on DoomBrawl (`DEBUG=true`, the build that fails):

| metric                                 | value |
| -------------------------------------- | ----- |
| modules in bundle                      | 30    |
| module-level `local` declarations      | 503   |
| distinct root names after flatten      | 209   |
| root `local` lines in flattened output | 191   |
| cross-module binding names             | 144   |
| names exported by 2+ modules           | 3     |

Release build (`DEBUG=false`, shake on) is already fine: 40 distinct root names.
The failure is the debug build, and any future build that keeps whole subsystems.

`cw` in the error is a darklua `rename_variables` name, not a project identifier.
The error is raised when the optimized file is compiled on the server, so the plugin
must be validated by static counting locally, not by running Luau.

## Design

Three layers. Layer 1 fixes today's failure. Layer 2 guarantees headroom as the
project grows. Layer 3 makes the state visible before the server finds out.

### Layer 1 — module-scoped emission (default on)

Wrap each module body in its own function and call it in module order:

```lua
local A, B, C -- hoisted: imported by some other module

do
local function ____module_3()
-- untouched module body, no re-indentation
B = function() ... end
end
____module_3()
end
```

- A module's own locals live in its wrapper function, so they no longer consume root
  registers. Root drops from ~191 to `hoisted + table + temps`.
- The wrapper name itself is scoped in a `do` block, so it costs zero permanent root
  registers.
- Bodies are not re-indented. Indentation is cosmetic to Lua and re-indenting would
  shift every source-map column.
- Only bindings another module imports get hoisted. Everything else stays private.
- Bodies are emitted verbatim otherwise, so the existing `stripExports`, `stripImports`,
  `stripReturn`, `stripEmptyScopes` pipeline is unchanged.

Hoisted definition sites: `local X = expr` becomes `X = expr` inside the wrapper,
`local function X()` becomes `function X()`. Both assign to the outer local.
Recursion still works.

Duplicate export names (3 today): a name exported by two modules cannot share one root
slot. Those get a unique slot (`____export_12`) and consumers get a wrapper-local alias
(`local X = ____export_12`), which is cheap because it is inside the wrapper's register
budget. Non-colliding names keep their plain name, so the common path needs no aliasing.

Projection for the failing build: 144 hoisted names, 0 wrapper slots, ~10 temps.

### Layer 2 — cold-binding tables (auto, when over budget)

Keep the most referenced hoisted bindings as direct root locals, move the rest into one
table:

```lua
local ____cold = {}

do
local function ____module_7()
local Foo = ____cold.b12 -- import alias, wrapper scope
...
____cold.b12 = function() ... end -- definition, then aliases point at it
end
____module_7()
end
```

Ranking: total references of the binding across the chunk, hottest first.

Why this shape:

- No identifier rewriting. Import aliases are local to the consumer wrapper, so plain
  `Foo` references keep working. Definition sites keep a wrapper-local name and publish
  a copy. That means no Lua lexer, no scope analysis, no shadowing bugs.
- Root cost becomes `hot names + 1 table + temps`, which is bounded by the budget no
  matter how large the import graph grows.
- Runtime cost is one table read per import per module load, at init only.

### Layer 3 — reporting

- Compute root `local` count from the emitted chunk (no Luau needed).
- `registerReport: "warn" | "off"` (default `"warn"`), using `registerLimit`
  (default 200).
- Include a small dev script that prints the counts for a built bundle, so a regression
  is visible before upload. Not done: the warning fires during emit instead.

## Config

| option           | default  | meaning                                                         |
| ---------------- | -------- | --------------------------------------------------------------- |
| `scopeModules`   | `true`   | Layer 1. Off restores today's flat emission.                    |
| `registerBudget` | `150`    | Layer 2 target for root locals. `false` disables packing.       |
| `registerLimit`  | `200`    | Layer 3 threshold for the warning.                              |
| `registerReport` | `"warn"` | Layer 3 behaviour: `"warn"` or `"off"`.                         |
| `rootGlobals`    | `[]`     | Names host Lua reaches as globals (see "Host-visible globals"). |

`scopeModules: false` is the immediate escape hatch: it restores the old flat emission,
which in practice means leaving the module runtime/flattening decision to TSTL. It has no
register planning, and the report then counts every module local as a root local.

## Implementation steps

1. `src/flatten.ts`
   - Split `flattenLines` into: normalize bodies (existing pipeline), build a symbol
     table (per module: exported name -> declaration line, imports -> target binding),
     emit (hoist declaration, wrappers, calls).
   - Binding identity is `(module, export)`, not the bare name, so collisions are
     detectable before emission.
   - Emit only `Line` values, using `inserted()` for synthetic lines so `lineMap` stays
     correct.
2. `src/budget.ts` (new)
   - Reference counting per binding, hot/cold split, root-count projection, budget
     arithmetic, report text. Kept separate so it is unit-testable without emit.
3. `src/index.ts`
   - Resolve the new options, pass budget to flattener, run the report after emit.
4. Tests
   - `src/flatten-equivalence.test.ts`: scoped output still produces identical runtime
     behaviour for the existing fixtures; import aliases, default exports, re-export
     blocks, `skipModules`, duplicate export names.
   - `src/concat.test.ts` / `src/sourcemap.test.ts`: wrapper lines are `src: -1`, bodies
     keep their line origins.
   - New `src/budget.test.ts`: ranking, budget edges, hot/cold split, collisions.
   - New `src/register-count.test.ts`: assert a synthetic 500-binding bundle stays under
     budget after emission.
5. Validation
   - Build DoomBrawl with `DEBUG=true` and `DEBUG=false`, count root locals and peak
     wrapper locals statically, compare against 200.
   - Confirm darklua's `rename_variables` still accepts the output (wrapper locals are
     ordinary locals).
   - Upload once to the server to confirm load.

## Risks

- Upvalues: a wrapper that imports many bindings turns them into upvalues. Luau caps
  upvalues too; the per-module import count is the same number that today sits in root,
  so this does not make anything worse, but the report should cover it.
- Stack traces gain one frame per module load (init only, not steady state).
- Output grows ~4 lines per module; darklua's `remove_spaces` keeps it flat.
- A single module with more than 200 top-level locals still fails. That is a source
  layout problem no bundler can fix; the report should name such modules.
- Darklua's `remove_empty_do` must not eat the wrapper blocks. They are never empty, so
  it will not, but a test should pin it.

## Open questions

1. `registerBudget` default of 150, or a tighter 130?
2. Wrapper as `do local function ____m() ... end ____m() end` (0 root slots, 4 lines) or
   a plain `local function` (1 root slot, 2 lines)?
3. `registerReport` default `"warn"` or `"throw"`?
4. Ship `flatten: false` stopgap together with Layer 1?

## Status

Decisions taken: `registerBudget` 150, 0-root-slot wrappers, `registerReport: "warn"`.

- `src/budget.ts`: `planSlots` ranks by reference count, reserves `TEMP_RESERVE` (12)
  registers for expression temporaries, and emits one `____cold` table for everything
  that does not fit. `stripLuaStringsAndComments` keeps counting from seeing names
  inside strings and comments.
- `src/flatten.ts`: scoped emission, re-export forwarding (including the `do`-wrapped
  renaming re-export TSTL emits), duplicate-name slots, and the old flat path kept as
  `flattenFlat` behind `scopeModules: false`.
- `src/index.ts`: new options resolved from both the factory config and the inline
  `luaPlugins` entry; `afterEmit` warns once per bundled file.
- Tests: `src/budget.test.ts` (ranking, split, report text) and `src/scope.test.ts`
  (private vs shared locals, aliases, duplicate names, cold packing, 500-binding bundle,
  flat parity, `onUsage`).

Deviations from the plan:

- `registerLimit` was added so the warning threshold is configurable; it defaults to
  Luau's 200.
- `flatten: false` was dropped in favour of the existing `scopeModules: false`. Turning
  flattening off entirely is what `luaBundle`/TSTL config already decides; this plugin
  does not need a second switch, and `skipModules` already covers the per-module case.
- No standalone dev script. `afterEmit` reports the same numbers at build time, and
  `flattenWithUsage` exposes them to tests.
- The output does not re-indent wrapper bodies. Kept that way deliberately: source-map
  columns for module lines stay as TSTL wrote them.

## Host-visible globals (follow-up)

Scoping introduced a second problem: a name the host calls (`tick`) must not be
trapped in a wrapper local. `rootGlobals` lists those names.

- A top-level `local NAME` declaration in any module is emitted without `local`, so the
  value lands in the global table. `local function NAME` becomes `function NAME`; both
  statements are identical in global form.
- A listed name that is also a shared binding keeps its slot. After the last wrapper the
  flattener copies it to the global table (`NAME = NAME`, or `NAME = ____cold.bN`), so
  the register plan is unaffected.
- A listed name that never appears in the bundle is reported through
  `formatRegisterReport`, which catches typos.
- This is separate from `globals`, which substitutes compile-time values. Because the
  result is a real global, darklua's `rename_variables` keeps it only when the name is
  in `detect_globals` (DoomBrawl already lists `tick`).

The `tick` failure itself was not caused by scoping: shaking removed
`____exports.default = Global` because `export default Global` aliases the variable
symbol rather than declaring a new one, so marking `Global` live never reached the
export line. Consumers then bound `local Global = default`. The shaker now records
identifier-style default exports by symbol and keeps the export line when an import
reaches it. The flattener also no longer invents `<name> = default` for a module whose
default export is missing.
