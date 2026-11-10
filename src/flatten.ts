import {
  DEFAULT_REGISTER_BUDGET,
  LUAU_REGISTER_LIMIT,
  type BindingCandidate,
  type BindingSlot,
  type RegisterUsage,
  type SlotPlan,
  countReferences,
  planSlots,
  stripLuaStringsAndComments,
} from "./budget";
import { type Line, inserted, isBlank, render, splitLines } from "./lines";

/**
 * Flattens a TSTL bundle by eliminating the module system entirely.
 *
 * TSTL's luaBundle wraps each module in a closure with a require() runtime.
 * This rewrites the bundle to emit all module code in dependency order, removing
 * the ____modules table, ____moduleCache, require() function, module closures,
 * and import/export boilerplate.
 *
 * Every surviving module body is emitted inside its own function. A flattened
 * bundle is a single top-level function, and Luau only allows 200 registers in
 * one, so a module's private locals have to leave that scope. Only bindings
 * another module imports are hoisted to the root, and when there are more of
 * those than the register budget allows, the coldest move into a table.
 *
 * Everything happens over `Line[]` rather than raw text so each surviving line
 * remembers where it came from, which is what lets the source map survive.
 */

// `d` gives us the body's exact offset, which is how we find its first line.
const MODULE = /\["([^"]+)"\] = function\([^)]*\)\s*\n([\s\S]*?)\n end,/dg;

const EXPORTS_TABLE = "local ____exports = {}";
const REQUIRE_LINE = /^([ \t]*)local (____\w+) = require\("([^"]+)"\)$/;
const ANY_REQUIRE = /^[ \t]*(?:local ____\w+ = )?require\("[^"]+"\)$/;
const IMPORT_LINE = /^([ \t]*)local (\w+) = (____\w+)(?:\.(\w+)|\["([^"]+)"\])$/;
const NAMESPACE_REQUIRE = /^[ \t]*local \w+ = require\("([^"]+)"\)$/;
const RETURN_EXPORTS = /(?:^|\n)return (?:____exports|\{[^}]*\})$/;

// TSTL writes `____exports.name` when the name is a Lua identifier and
// `____exports["name"]` when it is not (keywords like `not`, or anything else
// that cannot be a field without brackets).
const EXPORT_FUNCTION = /^function ____exports(?:\.(\w+)|\["([^"]+)"\])\s*\(/;
const EXPORT_VALUE = /^([ \t]*)____exports(?:\.(\w+)|\["([^"]+)"\])\s*=\s*(.*)$/;

/**
 * The names a top-level `local` statement declares.
 *
 * TSTL writes `local Error, RangeError, ...` for a group of bindings that share
 * one scope, and no single name can be turned into a root assignment: stripping
 * `local` would assign every name on the line, and the declaration still
 * shadows the slot while it runs.
 */
function declaredLocals(text: string): string[] | null {
  const match = /^local[ \t]+(function[ \t]+)?(.+)$/.exec(text);

  if (match === null) return null;

  if (match[1] !== undefined) {
    const name = /^([A-Za-z_]\w*)\s*\(/.exec(match[2]);

    return name === null ? null : [name[1]];
  }

  const names = match[2]
    .split("=")[0]
    .split(",")
    .map((part) => part.trim());

  return names.every((name) => /^[A-Za-z_]\w*$/.test(name)) ? names : null;
}

const LUA_KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

/** Separates the module path from the export name in a binding key. */
const BINDING_SEPARATOR = "\u0000";

export interface FlattenOptions {
  skipModules?: string[];
  /** Wrap each module in its own function so its locals leave the root scope. */
  scopeModules?: boolean;
  /** Root locals the plan aims for; false keeps every shared binding direct. */
  registerBudget?: number | false;
  /** Root locals that count as a failure, for reporting. */
  registerLimit?: number | false;
  /**
   * Names that must be reachable from host Lua as globals. A module-level
   * `local` declaration of one of these names is emitted without `local`, and a
   * listed name that is shared between modules is published to the global table
   * once every module has run.
   */
  rootGlobals?: string[];
}

export interface FlattenResult {
  lines: Line[];
  usage: RegisterUsage | null;
}

interface ImportRef {
  localName: string;
  modulePath: string;
  exportName: string;
}

interface ExportedName {
  name: string;
  localName: string;
  canAssign: boolean;
}

interface Analysis {
  name: string;
  raw: Line[];
  defaultAlias: string | null;
  imports: ImportRef[];
  /** Modules this one requires, in the order the requires appear. */
  dependencies: string[];
  /** Binding keys this module imports, by the name it binds them to. */
  importLocals: Map<string, string>;
  /** Export name -> binding key it simply re-exports. */
  forwards: Map<string, string>;
  exports: ExportedName[];
  /** The module ends with a bare `return <value>` instead of `return ____exports`. */
  rawReturn: boolean;
  topLocalCounts: Map<string, number>;
  topLocalLines: Map<string, string[]>;
}

function bindingKey(modulePath: string, exportName: string): string {
  return `${modulePath}${BINDING_SEPARATOR}${exportName}`;
}

function sanitizeModuleName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function isLuaIdentifier(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name) && !LUA_KEYWORDS.has(name);
}

/**
 * The module-local name for an export.
 *
 * A name that cannot be a Lua local (`not`, `a-b`) still has to be bound
 * somewhere the module can read, so it takes the `____` prefix TSTL already uses
 * for the same reason.
 */
function localNameFor(exportName: string): string {
  return isLuaIdentifier(exportName) ? exportName : `____${sanitizeModuleName(exportName)}`;
}

/**
 * The name a top-level statement declares or assigns. Only the first name of a
 * declaration is read, so a multi-name `local a, b = ...` is left alone rather
 * than turned into a broken assignment.
 */
function topLevelName(text: string): string | null {
  const declaration = /^local (?:function )?([A-Za-z_]\w*)\s*[=(]/.exec(text);

  if (declaration !== null) return declaration[1];

  const assignment = /^([A-Za-z_]\w*)\s*=/.exec(text);

  if (assignment !== null) return assignment[1];

  const fn = /^function ([A-Za-z_]\w*)\s*\(/.exec(text);

  return fn === null ? null : fn[1];
}

/**
 * Drops `local` from a declaration of a name that has to be reachable from the
 * host, so the value is assigned to the global table instead of a wrapper local.
 * `local function foo` becomes `function foo`, which is the same statement in
 * global form.
 */
function globalizeDeclaration(line: Line, names: Set<string>): Line {
  if (!line.text.startsWith("local ")) return line;

  const name = topLevelName(line.text);

  if (name === null || !names.has(name)) return line;

  return { ...line, text: line.text.slice("local ".length) };
}

/** Reads the export name out of an `EXPORT_VALUE` match, dot or bracket form. */
function matchedExportName(match: RegExpExecArray): string {
  return match[2] ?? match[3] ?? "";
}

// TSTL's lualib module does not publish through `____exports`; it ends with a
// table literal mapping every helper name to the local that holds it. Without
// reading that table the helpers stay trapped in the module wrapper and every
// `local __TS__X = ____lualib.__TS__X` import resolves to nothing.
const EXPORT_TABLE_ENTRY = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*,?\s*$/;
const EXPORT_TABLE_RETURN = /^return \{/;
const EXPORT_TABLE_END = /^\}/;

/** Reads the `return { name = localName, ... }` table a module can end with. */
function exportTableNames(raw: Line[]): { name: string; localName: string }[] {
  const start = raw.findIndex((line) => EXPORT_TABLE_RETURN.test(line.text));

  if (start === -1) return [];

  const end = raw.findIndex((line, index) => index > start && EXPORT_TABLE_END.test(line.text));

  if (end === -1) return [];

  const names: { name: string; localName: string }[] = [];

  for (const line of raw.slice(start + 1, end)) {
    const entry = EXPORT_TABLE_ENTRY.exec(line.text);

    if (entry !== null && isLuaIdentifier(entry[2])) names.push({ name: entry[1], localName: entry[2] });
  }

  return names;
}

function normalizeOptions(options: FlattenOptions | string[]): FlattenOptions {
  return Array.isArray(options) ? { skipModules: options } : options;
}

/** Rewrites the ____exports table away, one line at a time. */
function stripExports(lines: Line[], defaultAlias: string | null): Line[] {
  const rewritten = lines.map((line) => {
    let text = line.text;

    if (defaultAlias !== null) {
      text = text.replace(/function ____exports\.default(\s*\()/g, `local function ${defaultAlias}$1`);
      text = text.replace(/____exports\.default\s*=\s*([^\n]*)/g, (_m, rhs) => `local ${defaultAlias} = ${rhs}`);
      text = text.replace(/____exports\.default\b/g, defaultAlias);
    }

    text = text
      .replace(/function ____exports\.(\w+)\s*\(/g, "local function $1(")
      .replace(/function ____exports\["([^"]+)"\]\s*\(/g, (_m, name: string) => `local function ${localNameFor(name)}(`)
      .replace(/____exports\.(\w+)\s*=/g, "local $1 =")
      .replace(/____exports\["([^"]+)"\]\s*=/g, (_m, name: string) => `local ${localNameFor(name)} =`)
      .replace(/____exports\["([^"]+)"\]/g, (_m, name: string) => localNameFor(name))
      .replace(/____exports\./g, "");

    return { ...line, text };
  });

  // Only the first declaration goes, matching the original single replace.
  const index = rewritten.findIndex((line) => line.text.endsWith(EXPORTS_TABLE));

  if (index === -1) return rewritten;

  const prefix = rewritten[index].text.slice(0, -EXPORTS_TABLE.length);
  const rest = rewritten.slice(index + 1);

  // An indented declaration leaves its indent behind on the following line.
  if (prefix !== "" && rest.length > 0) {
    rest[0] = { ...rest[0], text: prefix + rest[0].text };
  }

  return [...rewritten.slice(0, index), ...rest];
}

/** Drops a trailing `return ____exports` or `return { ... }`. */
function stripReturn(lines: Line[]): Line[] {
  const body = render(lines);
  const stripped = body.replace(RETURN_EXPORTS, "");

  if (stripped === body) return lines;

  // The match is always a suffix, so the difference is whole trailing lines.
  // An empty result is zero lines, not the one that splitting "" would give.
  return lines.slice(0, stripped === "" ? 0 : stripped.split("\n").length);
}

/**
 * Drops `do ... end` scopes left empty once their requires disappeared.
 *
 * TSTL wraps side-effect imports and some hoisted references in a `do` block;
 * with every statement gone the block is just dead whitespace.
 */
function stripEmptyScopes(lines: Line[]): Line[] {
  const result: Line[] = [];

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].text !== "do") {
      result.push(lines[index]);

      continue;
    }

    let end = index + 1;

    while (end < lines.length && isBlank(lines[end].text)) end++;

    if (end < lines.length && lines[end].text.trimStart() === "end") {
      index = end;

      continue;
    }

    result.push(lines[index]);
  }

  return result;
}

/** The line-array equivalent of `String.prototype.trim` on the body. */
function trimLines(lines: Line[]): Line[] {
  let start = 0;
  let end = lines.length;

  while (start < end && isBlank(lines[start].text)) start++;
  while (end > start && isBlank(lines[end - 1].text)) end--;

  if (start >= end) return [];

  const trimmed = lines.slice(start, end);

  trimmed[0] = { ...trimmed[0], text: trimmed[0].text.trimStart() };
  trimmed[trimmed.length - 1] = {
    ...trimmed[trimmed.length - 1],
    text: trimmed[trimmed.length - 1].text.trimEnd(),
  };

  return trimmed;
}

/** The last top-level `return` statement in a module body, if there is one. */
function moduleReturnIndex(lines: Line[]): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^return[ \t]/.test(lines[index].text)) return index;
  }

  return -1;
}

/**
 * Whether a module's value comes from a bare `return`, which is how TSTL emits
 * JSON modules. Those modules never declare `____exports`, so the return value
 * is the module's default export.
 *
 * A `return { name = local, ... }` table (TSTL's lualib) is also a bare return
 * but publishes named exports instead, so it is not a default export.
 */
function hasRawReturn(lines: Line[], exportNames: { name: string }[]): boolean {
  const index = moduleReturnIndex(lines);

  if (index === -1) return false;

  // A module that touches `____exports` publishes through the exports table,
  // even when its final statement is a table constructor mentioning it.
  if (/\b____exports\b/.test(render(lines))) return false;

  // `return { name = local }` is the lualib shape: named exports, not a default.
  return exportNames.length === 0;
}

function computeDefaultAlias(moduleName: string, lines: Line[]): string | null {
  const text = render(lines);

  if (!/____exports\.default\b/.test(text) && !hasRawReturn(lines, exportTableNames(lines))) {
    return null;
  }

  return `____default_${sanitizeModuleName(moduleName)}`;
}

/** Reads a module's imports, re-exports and top-level declarations. */
function analyzeModule(name: string, raw: Line[], defaultAlias: string | null): Analysis {
  const requires = new Map<string, string>();
  const dependencies: string[] = [];
  const importLocals = new Map<string, string>();
  const imports: ImportRef[] = [];
  const forwards = new Map<string, string>();
  const exports: ExportedName[] = [];
  const topLocalCounts = new Map<string, number>();
  const topLocalLines = new Map<string, string[]>();

  const addLocal = (localName: string, text: string) => {
    topLocalCounts.set(localName, (topLocalCounts.get(localName) ?? 0) + 1);

    const lines = topLocalLines.get(localName) ?? [];
    lines.push(text);
    topLocalLines.set(localName, lines);
  };

  for (const line of raw) {
    // Every require is an execution-order dependency: TSTL runs the required
    // module before the code after the statement, even when nothing is bound.
    const requiredModule = /require\("([^"]+)"\)/.exec(line.text);

    if (requiredModule !== null) dependencies.push(requiredModule[1]);

    const requirement = REQUIRE_LINE.exec(line.text);

    if (requirement !== null) {
      requires.set(requirement[2], requirement[3]);
      continue;
    }

    const imported = IMPORT_LINE.exec(line.text);

    if (imported !== null) {
      const [, , localName, alias, dotName, bracketName] = imported;
      const exportName = dotName ?? bracketName ?? "";
      const modulePath = requires.get(alias);

      if (modulePath !== undefined) {
        const key = bindingKey(modulePath, exportName);
        importLocals.set(localName, key);
        imports.push({ localName, modulePath, exportName });
      }

      addLocal(localName, line.text);
      continue;
    }

    const declared = declaredLocals(line.text);

    if (declared !== null) {
      for (const local of declared) addLocal(local, line.text);
    }

    const fn = EXPORT_FUNCTION.exec(line.text);

    if (fn !== null) {
      const exportName = fn[1] ?? fn[2] ?? "";
      const localName = exportName === "default" && defaultAlias !== null ? defaultAlias : localNameFor(exportName);

      if (localName !== "default") exports.push({ name: exportName, localName, canAssign: true });
      continue;
    }

    const value = EXPORT_VALUE.exec(line.text);

    if (value === null) continue;

    const [, indent, , , expression] = value;
    const exportName = matchedExportName(value);
    const localName = exportName === "default" && defaultAlias !== null ? defaultAlias : localNameFor(exportName);
    const target = expression.trim();

    // A re-export of an import is not a binding of its own: point consumers at
    // the module the name actually comes from. TSTL wraps a renaming re-export
    // in a `do` block, so this also has to read indented export lines.
    if (/^[A-Za-z_]\w*$/.test(target) && importLocals.has(target)) {
      forwards.set(exportName, importLocals.get(target)!);
      continue;
    }

    const property = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(target) ?? /^([A-Za-z_]\w*)\["([^"]+)"\]$/.exec(target);
    const required = property === null ? undefined : requires.get(property[1]);

    if (property !== null && required !== undefined) {
      forwards.set(exportName, bindingKey(required, property[2]));
      continue;
    }

    // Only a declaration at the module's own top level can be given a root
    // slot; one buried in a `do` block goes out of scope before the module does.
    if (indent !== "" || localName === "default") continue;

    exports.push({ name: exportName, localName, canAssign: true });
  }

  // A module can also publish its exports as a `return { ... }` table, which is
  // how TSTL's lualib module exposes every `__TS__*` helper.
  const tableExports = exportTableNames(raw);

  for (const entry of tableExports) {
    if (exports.some((exported) => exported.name === entry.name)) continue;

    exports.push({ name: entry.name, localName: entry.localName, canAssign: true });
  }

  // A JSON module has no `____exports`; its whole return value is the default
  // export. The importer still reads `.default`, so bind the return value under
  // the module's default alias.
  const rawReturn = defaultAlias !== null && hasRawReturn(raw, tableExports);

  if (rawReturn && !exports.some((exported) => exported.name === "default")) {
    exports.push({ name: "default", localName: defaultAlias, canAssign: true });
  }

  // A name the module declares more than once cannot become an assignment to the
  // root local: the later declaration would still shadow it.
  for (const exported of exports) {
    const count = topLocalCounts.get(exported.localName) ?? 0;

    if (count > 1) {
      exported.canAssign = false;
      continue;
    }

    if (count === 1) {
      const text = topLocalLines.get(exported.localName)?.[0] ?? "";

      exported.canAssign = /^local (?:function )?[A-Za-z_]\w*[ \t]*[=(]/.test(text);
    }
  }

  return {
    name,
    raw,
    defaultAlias,
    imports,
    dependencies,
    importLocals,
    forwards,
    exports,
    rawReturn,
    topLocalCounts,
    topLocalLines,
  };
}

/** Follows re-export chains to the binding that actually defines the value. */
function resolveBinding(key: string, forwardTargets: Map<string, string>): string {
  let current = key;

  for (let hops = 0; hops < 32; hops++) {
    const next = forwardTargets.get(current);

    if (next === undefined) return current;

    current = next;
  }

  return current;
}

/** Pulls the module sources out of a bundle, leaving the header in place. */
function extractModules(
  lines: Line[],
  skipModules: string[],
): { headerLineCount: number; modules: { name: string; raw: Line[] }[] } | null {
  const code = render(lines);
  const runtimeStart = code.indexOf("\nlocal ____modules = {}\n");

  if (runtimeStart < 0) return null;

  // Everything before the module table is kept verbatim.
  const header = code.slice(0, runtimeStart + 1);
  const headerLineCount = header.split("\n").length - 1;
  const modules: { name: string; raw: Line[] }[] = [];

  MODULE.lastIndex = 0;

  let match: RegExpExecArray | null;

  while ((match = MODULE.exec(code)) !== null) {
    if (skipModules.includes(match[1])) continue;

    const bodyStart = match.indices![2]![0];
    const firstLine = code.slice(0, bodyStart).split("\n").length - 1;

    modules.push({ name: match[1], raw: lines.slice(firstLine, firstLine + match[2].split("\n").length) });
  }

  return { headerLineCount, modules };
}

/** Rewrites `local X = ____mod.Y` into a reference to the shared binding. */
function resolveImports(
  analysis: Analysis,
  resolve: (modulePath: string, exportName: string) => BindingSlot | undefined,
  bundled: Set<string>,
  defaultAliases: Map<string, string | null>,
  lateAliases: Map<string, LateAlias>,
): { lines: Line[]; rewritten: Set<Line> } {
  const result: Line[] = [];
  const rewritten = new Set<Line>();
  const byName = new Map(analysis.imports.map((entry) => [entry.localName, entry]));

  for (const line of analysis.raw) {
    if (REQUIRE_LINE.test(line.text)) continue;

    // A side-effect import leaves a bare `require("...")` with no runtime left
    // to answer it once the module system is gone.
    if (ANY_REQUIRE.test(line.text)) continue;

    const imported = IMPORT_LINE.exec(line.text);

    if (imported === null) {
      result.push(line);
      continue;
    }

    const [, indent, localName] = imported;
    const entry = byName.get(localName);

    if (entry === undefined) {
      result.push(line);
      continue;
    }

    const slot = resolve(entry.modulePath, entry.exportName);

    // A cyclic dependency cannot be ordered so its provider runs first. Its
    // alias lives at root scope instead, and the provider fills it when it
    // runs; dropping the per-module copy keeps later reads looking at the
    // final value rather than a nil captured at module entry. Only drop the
    // import when it resolves to the same binding the alias stands for: another
    // module may use the same local name for an unrelated export.
    if (slot !== undefined && lateAliases.get(localName)?.slot === slot) continue;

    if (slot !== undefined) {
      if (slot.name === localName) continue;

      const replacement = { ...line, text: `${indent}local ${localName} = ${slot.name}` };
      rewritten.add(replacement);
      result.push(replacement);

      continue;
    }

    // Imported from a module that is not in this bundle (or was skipped, so the
    // host provides it): keep the old shape, which reads the bare name.
    if (!bundled.has(entry.modulePath)) {
      const target = localNameFor(entry.exportName);

      if (localName !== target) {
        const replacement = { ...line, text: `${indent}local ${localName} = ${target}` };
        rewritten.add(replacement);
        result.push(replacement);
      }

      continue;
    }

    // The module is here but publishing nothing under that name: the export was
    // shaken away, so there is no value to bind. A default can still exist as
    // the module's unique alias when the plan did not need a slot for it.
    const alias = entry.exportName === "default" ? defaultAliases.get(entry.modulePath) : undefined;

    if (alias !== undefined && alias !== null) {
      if (alias === localName) continue;

      const replacement = { ...line, text: `${indent}local ${localName} = ${alias}` };
      rewritten.add(replacement);
      result.push(replacement);
    }
  }

  return { lines: result, rewritten };
}

/** A re-export line that was forwarded and no longer declares anything. */
function isForwardedExport(analysis: Analysis, line: Line): boolean {
  const value = EXPORT_VALUE.exec(line.text);

  return value !== null && analysis.forwards.has(matchedExportName(value));
}

/** Whether a line declares a binding the plan wants to assign directly. */
function isAssignableDeclaration(line: Line, names: Set<string>): boolean {
  if (!/^local (?:function )?[A-Za-z_]\w*[ \t]*[=(]/.test(line.text)) return false;

  const match = /^local (?:function )?([A-Za-z_]\w*)/.exec(line.text);

  return match !== null && names.has(match[1]);
}

/** Turns a raw module `return value` into the declaration of its default alias. */
function assignRawReturn(lines: Line[], alias: string | null): Line[] {
  if (alias === null) return lines;

  const index = moduleReturnIndex(lines);

  if (index === -1 || !/^return[ \t]+/.test(lines[index].text)) return lines;

  return lines.map((line, at) =>
    at === index ? { ...line, text: line.text.replace(/^return[ \t]+/, `local ${alias} = `) } : line,
  );
}

function buildModuleBody(
  analysis: Analysis,
  assignable: Set<string>,
  resolve: (modulePath: string, exportName: string) => BindingSlot | undefined,
  bundled: Set<string>,
  defaultAliases: Map<string, string | null>,
  rootGlobals: Set<string>,
  lateAliases: Map<string, LateAlias>,
): Line[] {
  const kept = analysis.raw.filter((line) => !isForwardedExport(analysis, line));
  const { lines: imported, rewritten } = resolveImports(
    { ...analysis, raw: kept },
    resolve,
    bundled,
    defaultAliases,
    lateAliases,
  );

  const stripped = stripExports(imported, analysis.defaultAlias);
  const withDefault = analysis.rawReturn ? assignRawReturn(stripped, analysis.defaultAlias) : stripped;

  // `local X = ...` becomes `X = ...`, which assigns the root local instead of
  // introducing a module-local that would shadow it.
  const converted = withDefault.map((line) => {
    if (rewritten.has(line) || !isAssignableDeclaration(line, assignable)) return line;

    return { ...line, text: line.text.slice("local ".length) };
  });

  // Listed root globals cannot stay `local` or they would be trapped in the
  // wrapper. Rewritten import aliases are left alone: they are reads.
  const globalized = converted.map((line) => (rewritten.has(line) ? line : globalizeDeclaration(line, rootGlobals)));

  return trimLines(stripEmptyScopes(stripReturn(globalized)));
}

function wrapperLines(name: string, body: Line[], publish: Line[]): Line[] {
  return [
    inserted("do"),
    inserted(`local function ${name}()`),
    ...body,
    ...publish,
    inserted("end"),
    inserted(`${name}()`),
    inserted("end"),
  ];
}

function buildPlan(
  analyses: Analysis[],
  budget: number | false,
): { plan: SlotPlan; forwardTargets: Map<string, string> } {
  const forwardTargets = new Map<string, string>();

  for (const analysis of analyses) {
    for (const [exportName, target] of analysis.forwards) {
      forwardTargets.set(bindingKey(analysis.name, exportName), target);
    }
  }

  const cleanText = new Map<string, string>();

  for (const analysis of analyses) cleanText.set(analysis.name, stripLuaStringsAndComments(render(analysis.raw)));

  // Which bindings are actually read from another module.
  const imported = new Map<string, { localName: string; from: string }[]>();

  for (const analysis of analyses) {
    for (const entry of analysis.imports) {
      const key = resolveBinding(bindingKey(entry.modulePath, entry.exportName), forwardTargets);

      const readers = imported.get(key) ?? [];
      readers.push({ localName: entry.localName, from: analysis.name });
      imported.set(key, readers);
    }
  }

  const candidates: BindingCandidate[] = [];

  for (const analysis of analyses) {
    for (const exported of analysis.exports) {
      const key = bindingKey(analysis.name, exported.name);
      const readers = imported.get(key);

      if (readers === undefined) continue;

      let refs = countReferences(cleanText.get(analysis.name) ?? "", exported.localName);

      for (const reader of readers) {
        refs += countReferences(cleanText.get(reader.from) ?? "", reader.localName);
      }

      candidates.push({ key, name: exported.localName, refs, canAssign: exported.canAssign });
    }
  }

  return { plan: planSlots(candidates, budget), forwardTargets };
}

/** The module part of a binding key. */
function bindingOwner(key: string): string {
  const separator = key.indexOf(BINDING_SEPARATOR);

  return separator === -1 ? key : key.slice(0, separator);
}

/**
 * Orders modules so a dependency's body runs before the bodies that read it.
 *
 * TSTL emits modules in source order and relies on `require` at the top of each
 * module to run dependencies lazily, so bundle order says nothing about
 * execution order. Once the runtime is gone, a module that runs before the one
 * defining its imports captures nil.
 *
 * Tarjan's algorithm emits a component only after every component it depends on,
 * so the result is dependency-first. Modules in a cycle keep their bundle order;
 * the imports that cross the cycle are late-bound instead.
 */
function orderAnalyses(analyses: Analysis[]): { ordered: Analysis[]; componentOf: Map<string, number> } {
  const byName = new Map(analyses.map((analysis) => [analysis.name, analysis]));
  const bundleOrder = new Map(analyses.map((analysis, index) => [analysis.name, index]));
  const edges = new Map(
    analyses.map((analysis) => [analysis.name, analysis.dependencies.filter((dependency) => byName.has(dependency))]),
  );

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  let next = 0;

  const connect = (name: string) => {
    index.set(name, next);
    low.set(name, next);
    next += 1;
    stack.push(name);
    onStack.add(name);

    for (const dependency of edges.get(name) ?? []) {
      if (!index.has(dependency)) {
        connect(dependency);
        low.set(name, Math.min(low.get(name)!, low.get(dependency)!));
      } else if (onStack.has(dependency)) {
        low.set(name, Math.min(low.get(name)!, index.get(dependency)!));
      }
    }

    if (low.get(name) !== index.get(name)) return;

    const component: string[] = [];
    let member: string;

    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== name);

    components.push(component);
  };

  for (const analysis of analyses) {
    if (!index.has(analysis.name)) connect(analysis.name);
  }

  const componentOf = new Map<string, number>();

  for (const [position, component] of components.entries()) {
    for (const name of component) componentOf.set(name, position);
  }

  const ordered = components.flatMap((component) =>
    [...component]
      .sort((left, right) => bundleOrder.get(left)! - bundleOrder.get(right)!)
      .map((name) => byName.get(name)!),
  );

  return { ordered, componentOf };
}

interface LateAlias {
  key: string;
  owner: string;
  slot: BindingSlot;
}

/**
 * Import aliases that have to live at root scope because their binding is in
 * the importer's dependency cycle. The provider assigns them when its body runs,
 * so a consumer that only reads them later sees the final value.
 */
function planLateAliases(
  analyses: Analysis[],
  plan: SlotPlan,
  forwardTargets: Map<string, string>,
  componentOf: Map<string, number>,
  reserved: Set<string>,
): Map<string, LateAlias> {
  const byAlias = new Map<string, LateAlias[]>();

  for (const analysis of analyses) {
    for (const entry of analysis.imports) {
      const key = resolveBinding(bindingKey(entry.modulePath, entry.exportName), forwardTargets);
      const slot = plan.slots.get(key);

      // Same-name hot bindings already refer to the root local at every use,
      // so there is nothing to defer.
      if (slot === undefined || slot.name === entry.localName) continue;

      const owner = bindingOwner(key);

      if (componentOf.get(owner) === undefined || componentOf.get(owner) !== componentOf.get(analysis.name)) continue;

      if (!isLuaIdentifier(entry.localName)) continue;

      const aliases = byAlias.get(entry.localName) ?? [];
      aliases.push({ key, owner, slot });
      byAlias.set(entry.localName, aliases);
    }
  }

  const late = new Map<string, LateAlias>();

  for (const [alias, aliases] of byAlias) {
    // One root local cannot stand for two different bindings, and it must not
    // shadow an existing root binding.
    if (new Set(aliases.map((candidate) => candidate.key)).size !== 1) continue;
    if (reserved.has(alias)) continue;

    late.set(alias, aliases[0]);
  }

  return late;
}

/** Wraps every module in its own function, hoisting only what is shared. */
function flattenScoped(
  lines: Line[],
  extracted: { headerLineCount: number; modules: { name: string; raw: Line[] }[] },
  budget: number | false,
  limit: number | false,
  rootGlobals: string[],
): FlattenResult {
  const analyzed = extracted.modules.map((module) =>
    analyzeModule(module.name, module.raw, computeDefaultAlias(module.name, module.raw)),
  );
  const { ordered: analyses, componentOf } = orderAnalyses(analyzed);

  const { plan, forwardTargets } = buildPlan(analyses, budget);

  const rootGlobalNames = new Set(rootGlobals);
  const bundled = new Set(analyses.map((analysis) => analysis.name));
  const defaultAliases = new Map(analyses.map((analysis) => [analysis.name, analysis.defaultAlias]));

  const reserved = new Set(plan.hot);

  if (plan.table !== null) reserved.add(plan.table);

  for (const name of rootGlobalNames) reserved.add(name);

  const lateAliases = planLateAliases(analyses, plan, forwardTargets, componentOf, reserved);
  const lateNames = new Set(lateAliases.keys());
  const lateAssignments = new Map<string, { alias: string; source: string }[]>();

  for (const [alias, late] of lateAliases) {
    const assignments = lateAssignments.get(late.owner) ?? [];
    assignments.push({ alias, source: late.slot.name });
    lateAssignments.set(late.owner, assignments);
  }

  const resolve = (modulePath: string, exportName: string): BindingSlot | undefined => {
    const key = resolveBinding(bindingKey(modulePath, exportName), forwardTargets);

    return plan.slots.get(key);
  };

  const assignable = new Map<string, Set<string>>();
  const publishes = new Map<string, Line[]>();

  for (const analysis of analyses) {
    const names = new Set<string>();
    const publish: Line[] = [];

    for (const exported of analysis.exports) {
      const slot = plan.slots.get(bindingKey(analysis.name, exported.name));

      if (slot === undefined) continue;

      if (slot.form === "assign") {
        names.add(exported.localName);
      } else {
        publish.push(inserted(`${slot.name} = ${exported.localName}`));
      }
    }

    assignable.set(analysis.name, names);
    publishes.set(analysis.name, publish);
  }

  const bodies = analyses.map((analysis) =>
    buildModuleBody(
      analysis,
      assignable.get(analysis.name) ?? new Set(),
      resolve,
      bundled,
      defaultAliases,
      rootGlobalNames,
      lateAliases,
    ),
  );

  const result = lines.slice(0, extracted.headerLineCount);

  if (plan.hot.length > 0) result.push(inserted(`local ${plan.hot.join(", ")}`));
  if (plan.table !== null) result.push(inserted(`local ${plan.table} = {}`));

  const lateNamesInOrder = [...lateNames];

  if (lateNamesInOrder.length > 0) result.push(inserted(`local ${lateNamesInOrder.join(", ")}`));

  for (const [index, body] of bodies.entries()) {
    const name = analyses[index].name;

    // Bodies are separated by a blank line, which nothing in the bundle owns.
    if (index > 0) result.push(inserted(""));

    if (body.length === 0) {
      result.push(inserted(""));

      continue;
    }

    result.push(...wrapperLines(`____module_${index}`, body, publishes.get(name) ?? []));

    // Fill aliases bound to this module's exports now that its body has run.
    for (const assignment of lateAssignments.get(name) ?? []) {
      result.push(inserted(`${assignment.alias} = ${assignment.source}`));
    }
  }

  // A listed name that is also a shared binding lives in a root local (or the
  // cold table); copy it to the global table so host Lua can reach it.
  const published = new Map<string, string>();

  for (const analysis of analyses) {
    for (const exported of analysis.exports) {
      if (!rootGlobalNames.has(exported.localName)) continue;

      const slot = plan.slots.get(bindingKey(analysis.name, exported.name));

      if (slot !== undefined) published.set(exported.localName, slot.name);
    }
  }

  for (const [name, slot] of published) result.push(inserted(`${name} = ${slot}`));

  const seen = new Set(published.keys());

  for (const body of bodies) {
    for (const line of body) {
      const name = topLevelName(line.text);

      if (name !== null && rootGlobalNames.has(name)) seen.add(name);
    }
  }

  // A namespace import binds a module under a name of its own choosing rather than the `____`
  // prefix TSTL gives an import it destructures, and it is the one import that asks for the module
  // as an object. Flattening spends that object to make top-level locals, so the require would
  // survive into output with no runtime left to answer it and fail on load instead of here.
  for (const line of result) {
    const namespace = NAMESPACE_REQUIRE.exec(line.text);

    if (namespace !== null) {
      throw new Error(
        `tstl-bundle-flatten: cannot flatten a namespace import of "${namespace[1]}". ` +
          "Import the names themselves.",
      );
    }
  }

  let worst: { name: string; locals: number } | null = null;

  for (const [index, body] of bodies.entries()) {
    const locals = body.filter((line) => /^local (?:function )?[A-Za-z_]\w*/.test(line.text)).length;

    if (worst === null || locals > worst.locals) worst = { name: analyses[index].name, locals };
  }

  const usage: RegisterUsage = {
    modules: analyses.length,
    hoisted: plan.slots.size,
    hot: plan.hot.length,
    cold: plan.cold,
    rootLocals: plan.hot.length + (plan.table === null ? 0 : 1) + lateNames.size,
    budget,
    limit,
    worst,
    rootGlobals: rootGlobals.filter((name) => seen.has(name)),
    missingRootGlobals: rootGlobals.filter((name) => !seen.has(name)),
  };

  return { lines: result, usage };
}

/** The pre-scoping emission: every module body lands in the root scope. */
function flattenFlat(
  lines: Line[],
  skipModules: string[],
  budget: number | false,
  limit: number | false,
  rootGlobals: string[],
): FlattenResult {
  const extracted = extractModules(lines, skipModules);

  if (extracted === null) return { lines, usage: null };

  const moduleEntries = extracted.modules;
  const defaultAliases = new Map<string, string | null>();
  const rootGlobalNames = new Set(rootGlobals);

  for (const entry of moduleEntries) {
    defaultAliases.set(entry.name, computeDefaultAlias(entry.name, entry.raw));
  }

  const bodies: Line[][] = [];

  for (const entry of moduleEntries) {
    const alias = defaultAliases.get(entry.name) ?? null;

    const body = trimLines(
      stripEmptyScopes(
        stripImports(stripReturn(stripExports(entry.raw, alias)), defaultAliases).map((line) =>
          globalizeDeclaration(line, rootGlobalNames),
        ),
      ),
    );

    // An emptied-out module still contributes its separator, as it did when
    // this worked on strings and pushed "" into the joined list.
    bodies.push(body.length > 0 ? body : [inserted("")]);
  }

  const result = lines.slice(0, extracted.headerLineCount);

  // With every module skipped the output is just the header plus a blank
  // line, which is what joining an empty list of bodies used to produce.
  if (bodies.length === 0) result.push(inserted(""));

  for (const [index, body] of bodies.entries()) {
    // Bodies are separated by a blank line, which nothing in the bundle owns.
    if (index > 0) result.push(inserted(""));

    result.push(...body);
  }

  for (const line of result) {
    const namespace = NAMESPACE_REQUIRE.exec(line.text);

    if (namespace !== null) {
      throw new Error(
        `tstl-bundle-flatten: cannot flatten a namespace import of "${namespace[1]}". ` +
          "Import the names themselves.",
      );
    }
  }

  let worst: { name: string; locals: number } | null = null;

  for (const [index, body] of bodies.entries()) {
    const locals = body.filter((line) => /^local (?:function )?[A-Za-z_]\w*/.test(line.text)).length;

    if (worst === null || locals > worst.locals) worst = { name: moduleEntries[index].name, locals };
  }

  const seen = new Set<string>();

  for (const body of bodies) {
    for (const line of body) {
      const name = topLevelName(line.text);

      if (name !== null && rootGlobalNames.has(name)) seen.add(name);
    }
  }

  return {
    lines: result,
    usage: {
      modules: moduleEntries.length,
      hoisted: 0,
      hot: 0,
      cold: 0,
      rootLocals: bodies.reduce(
        (total, body) => total + body.filter((line) => /^local (?:function )?[A-Za-z_]\w*/.test(line.text)).length,
        0,
      ),
      budget,
      limit,
      worst,
      rootGlobals: rootGlobals.filter((name) => seen.has(name)),
      missingRootGlobals: rootGlobals.filter((name) => !seen.has(name)),
    },
  };
}

/** The pre-scoping import strip, kept for `scopeModules: false`. */
function stripImports(lines: Line[], defaultAliases: Map<string, string | null>): Line[] {
  const result: Line[] = [];

  // Maps a `____foo` require alias to the module path it came from, so an
  // import of a default export can be pointed at that module's unique alias.
  const requireMap = new Map<string, string>();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    // A renaming re-export is scoped in a bare `do` block so its require is local to it. The
    // block now holds a top-level local instead, which nothing outside could see.
    if (line.text === "do") {
      const close = lines.findIndex((other, at) => at > index && other.text === "end");

      if (close !== -1 && lines.slice(index + 1, close).some((other) => ANY_REQUIRE.test(other.text))) {
        for (const unwrapped of stripImports(lines.slice(index + 1, close), defaultAliases)) {
          result.push({ ...unwrapped, text: unwrapped.text.replace(/^ {4}/, "") });
        }

        index = close;

        continue;
      }
    }

    const requireMatch = line.text.match(REQUIRE_LINE);
    if (requireMatch) {
      requireMap.set(requireMatch[2], requireMatch[3]);
      continue;
    }

    if (ANY_REQUIRE.test(line.text)) continue;

    const match = IMPORT_LINE.exec(line.text);

    if (!match) {
      result.push(line);

      continue;
    }

    const [, indent, localName, requireVar, dotName, bracketName] = match;
    const exportName = dotName ?? bracketName ?? "";

    if (exportName === "default") {
      const modulePath = requireMap.get(requireVar);
      const alias = modulePath !== undefined ? defaultAliases.get(modulePath) : undefined;

      // The default export was shaken away; there is nothing to bind.
      if (modulePath !== undefined && alias === null) continue;

      if (alias) {
        if (localName === alias) continue;

        result.push({ ...line, text: `${indent}local ${localName} = ${alias}` });

        continue;
      }
    }

    // Same name means the earlier module already put it in scope.
    const exportLocal = localNameFor(exportName);

    if (localName === exportLocal) continue;

    result.push({ ...line, text: `${indent}local ${localName} = ${exportLocal}` });
  }

  return result;
}

export function flattenWithUsage(lines: Line[], options: FlattenOptions | string[] = {}): FlattenResult {
  const resolved = normalizeOptions(options);
  const skipModules = resolved.skipModules ?? [];
  const budget = resolved.registerBudget === undefined ? DEFAULT_REGISTER_BUDGET : resolved.registerBudget;
  const limit = resolved.registerLimit === undefined ? LUAU_REGISTER_LIMIT : resolved.registerLimit;
  const rootGlobals = resolved.rootGlobals ?? [];

  if (resolved.scopeModules === false) return flattenFlat(lines, skipModules, budget, limit, rootGlobals);

  const extracted = extractModules(lines, skipModules);

  if (extracted === null) return { lines, usage: null };

  return flattenScoped(lines, extracted, budget, limit, rootGlobals);
}

export function flattenLines(lines: Line[], options: FlattenOptions | string[] = {}): Line[] {
  return flattenWithUsage(lines, options).lines;
}

export function flattenBundle(code: string, options: FlattenOptions | string[] = {}): string {
  const lines = splitLines(code);
  const { lines: flattened } = flattenWithUsage(lines, options);

  if (flattened === lines) return code;

  return `${render(flattened)}\n`;
}
