var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/index.ts
var exports_src = {};
__export(exports_src, {
  createPlugin: () => createPlugin,
  default: () => src_default,
  shakeProgram: () => shakeProgram,
  transformLines: () => transformLines
});
module.exports = __toCommonJS(exports_src);

// src/fold.ts
var ts = __toESM(require("typescript"));
function foldProgram(program, options) {
  const globals = resolveGlobals(options.globals);
  if (globals.size === 0 && !options.computeExpressions)
    return;
  const checker = program.getTypeChecker();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile)
      continue;
    const result = ts.transform(sourceFile, [
      (context) => {
        const visitor = (node) => {
          if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node))
            return node;
          if (ts.isIdentifier(node) && globals.has(node.text) && isGlobalReference(node, checker)) {
            const literal = literalFor(globals.get(node.text));
            if (literal !== undefined)
              return ts.setOriginalNode(literal, node);
          }
          const visited = ts.visitEachChild(node, visitor, context);
          if (!options.computeExpressions)
            return visited;
          if (ts.isIfStatement(visited))
            return simplifyIf(visited);
          if (ts.isWhileStatement(visited))
            return simplifyWhile(visited);
          if (ts.isDoStatement(visited))
            return simplifyDo(visited);
          if (ts.isExpressionStatement(visited))
            return simplifyExpressionStatement(visited);
          if (ts.isExpression(visited))
            return simplifyExpression(visited);
          return visited;
        };
        return (node) => ts.visitNode(node, visitor) ?? node;
      }
    ]);
    const transformed = result.transformed[0];
    const statements = transformed.statements.map((statement) => graft(statement));
    sourceFile.statements = ts.factory.createNodeArray(statements);
    for (const statement of statements)
      setParent(statement, sourceFile);
    result.dispose();
  }
}
var GRAFT_SKIP = new Set([
  "parent",
  "original",
  "symbol",
  "locals",
  "emitNode",
  "transformFlags",
  "modifierFlagsCache",
  "flags",
  "kind",
  "pos",
  "end",
  "id",
  "jsDoc",
  "flowNode",
  "nextContainer"
]);
function graft(updated) {
  const original = ts.getOriginalNode(updated);
  if (original === updated || original.kind !== updated.kind)
    return updated;
  const target = original;
  for (const key of Object.keys(updated)) {
    if (GRAFT_SKIP.has(key))
      continue;
    const value = updated[key];
    if (isNodeLike(value)) {
      target[key] = graft(value);
    } else if (Array.isArray(value) && value.every(isNodeLike)) {
      target[key] = ts.factory.createNodeArray(value.map((child) => graft(child)));
    }
  }
  return original;
}
function isNodeLike(value) {
  return typeof value === "object" && value !== null && typeof value.kind === "number" && typeof value.flags === "number";
}
function setParent(node, parent) {
  if (node.parent === undefined) {
    node.parent = parent;
  }
  ts.forEachChild(node, (child) => setParent(child, node));
}
function resolveGlobals(specs) {
  const globals = new Map;
  for (const spec of specs) {
    const value = resolveGlobalValue(spec);
    if (!isStaticValue(value)) {
      throw new Error(`tstl-bundle-flatten: global "${spec.identifier}" must be a boolean, number, string, bigint, null, or undefined`);
    }
    globals.set(spec.identifier, value);
  }
  return globals;
}
function resolveGlobalValue(spec) {
  if (hasOwn(spec, "value"))
    return spec.value;
  if (spec.envJson !== undefined) {
    const raw = process.env[spec.envJson];
    if (raw === undefined)
      return spec.defaultValue;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`tstl-bundle-flatten: environment variable "${spec.envJson}" for global "${spec.identifier}" is not valid JSON`);
    }
  }
  if (spec.env !== undefined) {
    const raw = process.env[spec.env];
    return raw === undefined ? spec.defaultValue : parseEnvironmentValue(raw);
  }
  return spec.defaultValue;
}
function parseEnvironmentValue(raw) {
  if (raw === "true")
    return true;
  if (raw === "false")
    return false;
  if (raw === "null")
    return null;
  if (raw === "undefined")
    return;
  if (raw.trim() !== "" && !Number.isNaN(Number(raw)))
    return Number(raw);
  return raw;
}
function isStaticValue(value) {
  return value === null || value === undefined || typeof value === "boolean" || typeof value === "number" || typeof value === "string" || typeof value === "bigint";
}
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
function isGlobalReference(node, checker) {
  const parent = node.parent;
  if (parent !== undefined && isNonReferenceName(node, parent))
    return false;
  let symbol;
  try {
    symbol = checker.getSymbolAtLocation(node);
  } catch {
    return true;
  }
  if (symbol === undefined)
    return true;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return true;
    }
  }
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0)
    return true;
  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}
function isNonReferenceName(node, parent) {
  if (ts.isPropertyAccessExpression(parent) && parent.name === node)
    return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
    return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node)
    return true;
  if (ts.isLabeledStatement(parent) && parent.label === node)
    return true;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)
    return true;
  if ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && (parent.name === node || parent.propertyName === node)) {
    return true;
  }
  if (ts.isImportClause(parent) && parent.name === node)
    return true;
  return false;
}
function simplifyIf(node) {
  const condition = evaluateStatic(node.expression);
  if (condition === undefined)
    return node;
  return truthy(condition.value) ? node.thenStatement : node.elseStatement;
}
function simplifyWhile(node) {
  const condition = evaluateStatic(node.expression);
  if (condition !== undefined && !truthy(condition.value))
    return;
  return node;
}
function simplifyDo(node) {
  const condition = evaluateStatic(node.expression);
  if (condition !== undefined && !truthy(condition.value))
    return node.statement;
  return node;
}
function simplifyExpressionStatement(node) {
  if (ts.isStringLiteralLike(node.expression))
    return node;
  if (evaluateStatic(node.expression) !== undefined)
    return;
  return node;
}
function simplifyExpression(expression) {
  if (isLiteralExpression(expression))
    return expression;
  const staticResult = evaluateStatic(expression);
  if (staticResult !== undefined)
    return replaceWithLiteral(staticResult.value, expression);
  if (ts.isConditionalExpression(expression)) {
    const condition = evaluateStatic(expression.condition);
    if (condition !== undefined)
      return condition.value ? expression.whenTrue : expression.whenFalse;
  }
  if (ts.isBinaryExpression(expression)) {
    const left = evaluateStatic(expression.left);
    if (left !== undefined) {
      switch (expression.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
          return truthy(left.value) ? expression.right : replaceWithLiteral(left.value, expression);
        case ts.SyntaxKind.BarBarToken:
          return truthy(left.value) ? replaceWithLiteral(left.value, expression) : expression.right;
        case ts.SyntaxKind.QuestionQuestionToken:
          return left.value === null || left.value === undefined ? expression.right : replaceWithLiteral(left.value, expression);
      }
    }
  }
  return expression;
}
function replaceWithLiteral(value, original) {
  const literal = literalFor(value);
  return literal === undefined ? original : ts.setOriginalNode(literal, original);
}
function isLiteralExpression(expression) {
  switch (expression.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    default:
      return false;
  }
}
function literalFor(value) {
  if (value === undefined)
    return ts.factory.createVoidZero();
  if (value === null)
    return ts.factory.createNull();
  if (typeof value === "boolean")
    return value ? ts.factory.createTrue() : ts.factory.createFalse();
  if (typeof value === "string")
    return ts.factory.createStringLiteral(value);
  if (typeof value === "bigint")
    return ts.factory.createBigIntLiteral(`${value}n`);
  if (!Number.isFinite(value))
    return;
  if (value < 0 || Object.is(value, -0)) {
    return ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(Math.abs(value)));
  }
  return ts.factory.createNumericLiteral(value);
}
function evaluateStatic(expression) {
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { value: expression.text };
  }
  if (ts.isNumericLiteral(expression))
    return { value: Number(expression.text) };
  if (ts.isBigIntLiteral(expression))
    return { value: BigInt(expression.text.slice(0, -1)) };
  switch (expression.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return { value: true };
    case ts.SyntaxKind.FalseKeyword:
      return { value: false };
    case ts.SyntaxKind.NullKeyword:
      return { value: null };
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return evaluateStatic(expression.expression);
  }
  if (ts.isPrefixUnaryExpression(expression))
    return evaluatePrefix(expression);
  if (ts.isTypeOfExpression(expression))
    return evaluateTypeOf(expression);
  if (ts.isVoidExpression(expression))
    return evaluateVoid(expression);
  if (ts.isBinaryExpression(expression))
    return evaluateBinary(expression);
  if (ts.isConditionalExpression(expression))
    return evaluateConditional(expression);
  return;
}
function evaluatePrefix(node) {
  const operand = evaluateStatic(node.operand);
  if (operand === undefined)
    return;
  switch (node.operator) {
    case ts.SyntaxKind.ExclamationToken:
      return { value: !truthy(operand.value) };
    case ts.SyntaxKind.PlusToken:
      return typeof operand.value === "number" ? { value: +operand.value } : undefined;
    case ts.SyntaxKind.MinusToken:
      if (typeof operand.value === "number")
        return { value: -operand.value };
      if (typeof operand.value === "bigint")
        return { value: -operand.value };
      return;
    case ts.SyntaxKind.TildeToken:
      return typeof operand.value === "number" ? { value: ~operand.value } : undefined;
    default:
      return;
  }
}
function evaluateTypeOf(node) {
  const operand = evaluateStatic(node.expression);
  return operand === undefined ? undefined : { value: typeof operand.value };
}
function evaluateVoid(node) {
  return evaluateStatic(node.expression) === undefined ? undefined : { value: undefined };
}
function evaluateConditional(node) {
  const condition = evaluateStatic(node.condition);
  if (condition === undefined)
    return;
  return evaluateStatic(truthy(condition.value) ? node.whenTrue : node.whenFalse);
}
function evaluateBinary(node) {
  const operator = node.operatorToken.kind;
  const left = evaluateStatic(node.left);
  if (left === undefined)
    return;
  switch (operator) {
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return truthy(left.value) ? evaluateStatic(node.right) : left;
    case ts.SyntaxKind.BarBarToken:
      return truthy(left.value) ? left : evaluateStatic(node.right);
    case ts.SyntaxKind.QuestionQuestionToken:
      return left.value === null || left.value === undefined ? evaluateStatic(node.right) : left;
  }
  const right = evaluateStatic(node.right);
  if (right === undefined)
    return;
  return evaluateBinaryValues(operator, left.value, right.value);
}
function evaluateBinaryValues(operator, left, right) {
  switch (operator) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return { value: left === right };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return { value: left !== right };
    case ts.SyntaxKind.LessThanToken:
      return compare(left, right, (a, b) => a < b);
    case ts.SyntaxKind.LessThanEqualsToken:
      return compare(left, right, (a, b) => a <= b);
    case ts.SyntaxKind.GreaterThanToken:
      return compare(left, right, (a, b) => a > b);
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return compare(left, right, (a, b) => a >= b);
    case ts.SyntaxKind.PlusToken:
      if (typeof left === "number" && typeof right === "number")
        return { value: left + right };
      if (typeof left === "string" && typeof right === "string")
        return { value: left + right };
      return;
  }
  if (typeof left !== "number" || typeof right !== "number")
    return;
  switch (operator) {
    case ts.SyntaxKind.MinusToken:
      return { value: left - right };
    case ts.SyntaxKind.AsteriskToken:
      return { value: left * right };
    case ts.SyntaxKind.SlashToken:
      return { value: left / right };
    case ts.SyntaxKind.PercentToken:
      return { value: left % right };
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return { value: left ** right };
    case ts.SyntaxKind.LessThanLessThanToken:
      return { value: left << right };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return { value: left >> right };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return { value: left >>> right };
    case ts.SyntaxKind.AmpersandToken:
      return { value: left & right };
    case ts.SyntaxKind.BarToken:
      return { value: left | right };
    case ts.SyntaxKind.CaretToken:
      return { value: left ^ right };
    default:
      return;
  }
}
function compare(left, right, comparator) {
  if (typeof left === "number" && typeof right === "number")
    return { value: comparator(left, right) };
  if (typeof left === "string" && typeof right === "string")
    return { value: comparator(left, right) };
  return;
}
function truthy(value) {
  return Boolean(value);
}

// src/budget.ts
var LUAU_REGISTER_LIMIT = 200;
var DEFAULT_REGISTER_BUDGET = 150;
var TEMP_RESERVE = 12;
var COLD_TABLE = "____cold";
function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripLuaStringsAndComments(code) {
  return code.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, " ").replace(/--[^\n]*/g, " ").replace(/\[(=*)\[[\s\S]*?\]\1\]/g, " ").replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}
function countReferences(code, name) {
  const matches = code.match(new RegExp(`\\b${escapeName(name)}\\b`, "g"));
  return matches === null ? 0 : matches.length;
}
function planSlots(candidates, budget) {
  const slots = new Map;
  let hotCount = candidates.length;
  if (budget !== false) {
    hotCount = Math.min(candidates.length, Math.max(0, budget - TEMP_RESERVE - 1));
  }
  const coldKeys = new Set;
  if (hotCount < candidates.length) {
    const ranked = [...candidates].sort((left, right) => right.refs - left.refs);
    for (const candidate of ranked.slice(hotCount))
      coldKeys.add(candidate.key);
  }
  const used = new Set;
  const hot = [];
  let renamed = 0;
  let cold = 0;
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
function formatRegisterReport(usage) {
  if (usage.missingRootGlobals.length > 0) {
    return `tstl-bundle-flatten: rootGlobals lists ${usage.missingRootGlobals.map((name) => `"${name}"`).join(", ")}, ` + "but the bundle never declares or assigns them. Check the spelling, or declare the name in TypeScript.";
  }
  if (usage.limit === false)
    return null;
  if (usage.rootLocals > usage.limit) {
    return `tstl-bundle-flatten: ${usage.rootLocals} root locals in the flattened bundle, ` + `Luau's limit is ${usage.limit}. Expect "Out of local registers" on load. ` + `Lower registerBudget (currently ${usage.budget}) to pack more shared bindings into a table.`;
  }
  if (usage.worst !== null && usage.worst.locals > usage.limit) {
    return `tstl-bundle-flatten: module "${usage.worst.name}" declares ${usage.worst.locals} locals ` + `in one function, Luau's limit is ${usage.limit}. Split that module's top level.`;
  }
  return null;
}

// src/lines.ts
function splitLines(code) {
  return code.split(`
`).map((text, src) => ({ text, src }));
}
function render(lines) {
  return lines.map((line) => line.text).join(`
`);
}
function lineMap(lines) {
  return lines.map((line) => line.src);
}
function inserted(text) {
  return { text, src: -1 };
}
function isBlank(text) {
  return text.trim() === "";
}

// src/flatten.ts
var MODULE = /\["([^"]+)"\] = function\([^)]*\)\s*\n([\s\S]*?)\n end,/dg;
var EXPORTS_TABLE = "local ____exports = {}";
var REQUIRE_LINE = /^([ \t]*)local (____\w+) = require\("([^"]+)"\)$/;
var ANY_REQUIRE = /^[ \t]*(?:local ____\w+ = )?require\("[^"]+"\)$/;
var IMPORT_LINE = /^([ \t]*)local (\w+) = (____\w+)(?:\.(\w+)|\["([^"]+)"\])$/;
var NAMESPACE_REQUIRE = /^[ \t]*local \w+ = require\("([^"]+)"\)$/;
var RETURN_EXPORTS = /(?:^|\n)return (?:____exports|\{[^}]*\})$/;
var EXPORT_FUNCTION = /^function ____exports(?:\.(\w+)|\["([^"]+)"\])\s*\(/;
var EXPORT_VALUE = /^([ \t]*)____exports(?:\.(\w+)|\["([^"]+)"\])\s*=\s*(.*)$/;
function declaredLocals(text) {
  const match = /^local[ \t]+(function[ \t]+)?(.+)$/.exec(text);
  if (match === null)
    return null;
  if (match[1] !== undefined) {
    const name = /^([A-Za-z_]\w*)\s*\(/.exec(match[2]);
    return name === null ? null : [name[1]];
  }
  const names = match[2].split("=")[0].split(",").map((part) => part.trim());
  return names.every((name) => /^[A-Za-z_]\w*$/.test(name)) ? names : null;
}
var LUA_KEYWORDS = new Set([
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
  "while"
]);
var BINDING_SEPARATOR = "\x00";
function bindingKey(modulePath, exportName) {
  return `${modulePath}${BINDING_SEPARATOR}${exportName}`;
}
function sanitizeModuleName(name) {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
function isLuaIdentifier(name) {
  return /^[A-Za-z_]\w*$/.test(name) && !LUA_KEYWORDS.has(name);
}
function localNameFor(exportName) {
  return isLuaIdentifier(exportName) ? exportName : `____${sanitizeModuleName(exportName)}`;
}
function topLevelName(text) {
  const declaration = /^local (?:function )?([A-Za-z_]\w*)\s*[=(]/.exec(text);
  if (declaration !== null)
    return declaration[1];
  const assignment = /^([A-Za-z_]\w*)\s*=/.exec(text);
  if (assignment !== null)
    return assignment[1];
  const fn = /^function ([A-Za-z_]\w*)\s*\(/.exec(text);
  return fn === null ? null : fn[1];
}
function globalizeDeclaration(line, names) {
  if (!line.text.startsWith("local "))
    return line;
  const name = topLevelName(line.text);
  if (name === null || !names.has(name))
    return line;
  return { ...line, text: line.text.slice("local ".length) };
}
function matchedExportName(match) {
  return match[2] ?? match[3] ?? "";
}
var EXPORT_TABLE_ENTRY = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*,?\s*$/;
var EXPORT_TABLE_RETURN = /^return \{/;
var EXPORT_TABLE_END = /^\}/;
function exportTableNames(raw) {
  const start = raw.findIndex((line) => EXPORT_TABLE_RETURN.test(line.text));
  if (start === -1)
    return [];
  const end = raw.findIndex((line, index) => index > start && EXPORT_TABLE_END.test(line.text));
  if (end === -1)
    return [];
  const names = [];
  for (const line of raw.slice(start + 1, end)) {
    const entry = EXPORT_TABLE_ENTRY.exec(line.text);
    if (entry !== null)
      names.push({ name: entry[1], localName: entry[2] });
  }
  return names;
}
function normalizeOptions(options) {
  return Array.isArray(options) ? { skipModules: options } : options;
}
function stripExports(lines, defaultAlias) {
  const rewritten = lines.map((line) => {
    let text = line.text;
    if (defaultAlias !== null) {
      text = text.replace(/function ____exports\.default(\s*\()/g, `local function ${defaultAlias}$1`);
      text = text.replace(/____exports\.default\s*=\s*([^\n]*)/g, (_m, rhs) => `local ${defaultAlias} = ${rhs}`);
      text = text.replace(/____exports\.default\b/g, defaultAlias);
    }
    text = text.replace(/function ____exports\.(\w+)\s*\(/g, "local function $1(").replace(/function ____exports\["([^"]+)"\]\s*\(/g, (_m, name) => `local function ${localNameFor(name)}(`).replace(/____exports\.(\w+)\s*=/g, "local $1 =").replace(/____exports\["([^"]+)"\]\s*=/g, (_m, name) => `local ${localNameFor(name)} =`).replace(/____exports\["([^"]+)"\]/g, (_m, name) => localNameFor(name)).replace(/____exports\./g, "");
    return { ...line, text };
  });
  const index = rewritten.findIndex((line) => line.text.endsWith(EXPORTS_TABLE));
  if (index === -1)
    return rewritten;
  const prefix = rewritten[index].text.slice(0, -EXPORTS_TABLE.length);
  const rest = rewritten.slice(index + 1);
  if (prefix !== "" && rest.length > 0) {
    rest[0] = { ...rest[0], text: prefix + rest[0].text };
  }
  return [...rewritten.slice(0, index), ...rest];
}
function stripReturn(lines) {
  const body = render(lines);
  const stripped = body.replace(RETURN_EXPORTS, "");
  if (stripped === body)
    return lines;
  return lines.slice(0, stripped === "" ? 0 : stripped.split(`
`).length);
}
function stripEmptyScopes(lines) {
  const result = [];
  for (let index = 0;index < lines.length; index++) {
    if (lines[index].text !== "do") {
      result.push(lines[index]);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && isBlank(lines[end].text))
      end++;
    if (end < lines.length && lines[end].text.trimStart() === "end") {
      index = end;
      continue;
    }
    result.push(lines[index]);
  }
  return result;
}
function trimLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start].text))
    start++;
  while (end > start && isBlank(lines[end - 1].text))
    end--;
  if (start >= end)
    return [];
  const trimmed = lines.slice(start, end);
  trimmed[0] = { ...trimmed[0], text: trimmed[0].text.trimStart() };
  trimmed[trimmed.length - 1] = {
    ...trimmed[trimmed.length - 1],
    text: trimmed[trimmed.length - 1].text.trimEnd()
  };
  return trimmed;
}
function computeDefaultAlias(moduleName, lines) {
  const text = render(lines);
  if (!/____exports\.default\b/.test(text))
    return null;
  return `____default_${sanitizeModuleName(moduleName)}`;
}
function analyzeModule(name, raw, defaultAlias) {
  const requires = new Map;
  const importLocals = new Map;
  const imports = [];
  const forwards = new Map;
  const exports2 = [];
  const topLocalCounts = new Map;
  const topLocalLines = new Map;
  const addLocal = (localName, text) => {
    topLocalCounts.set(localName, (topLocalCounts.get(localName) ?? 0) + 1);
    const lines = topLocalLines.get(localName) ?? [];
    lines.push(text);
    topLocalLines.set(localName, lines);
  };
  for (const line of raw) {
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
      for (const local of declared)
        addLocal(local, line.text);
    }
    const fn = EXPORT_FUNCTION.exec(line.text);
    if (fn !== null) {
      const exportName = fn[1] ?? fn[2] ?? "";
      const localName = exportName === "default" && defaultAlias !== null ? defaultAlias : localNameFor(exportName);
      if (localName !== "default")
        exports2.push({ name: exportName, localName, canAssign: true });
      continue;
    }
    const value = EXPORT_VALUE.exec(line.text);
    if (value === null)
      continue;
    const [, indent, , , expression] = value;
    const exportName = matchedExportName(value);
    const localName = exportName === "default" && defaultAlias !== null ? defaultAlias : localNameFor(exportName);
    const target = expression.trim();
    if (/^[A-Za-z_]\w*$/.test(target) && importLocals.has(target)) {
      forwards.set(exportName, importLocals.get(target));
      continue;
    }
    const property = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(target) ?? /^([A-Za-z_]\w*)\["([^"]+)"\]$/.exec(target);
    const required = property === null ? undefined : requires.get(property[1]);
    if (property !== null && required !== undefined) {
      forwards.set(exportName, bindingKey(required, property[2]));
      continue;
    }
    if (indent !== "" || localName === "default")
      continue;
    exports2.push({ name: exportName, localName, canAssign: true });
  }
  const tableExports = exportTableNames(raw);
  for (const entry of tableExports) {
    if (exports2.some((exported) => exported.name === entry.name))
      continue;
    exports2.push({ name: entry.name, localName: entry.localName, canAssign: true });
  }
  for (const exported of exports2) {
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
  return { name, raw, defaultAlias, imports, importLocals, forwards, exports: exports2, topLocalCounts, topLocalLines };
}
function resolveBinding(key, forwardTargets) {
  let current = key;
  for (let hops = 0;hops < 32; hops++) {
    const next = forwardTargets.get(current);
    if (next === undefined)
      return current;
    current = next;
  }
  return current;
}
function extractModules(lines, skipModules) {
  const code = render(lines);
  const runtimeStart = code.indexOf(`
local ____modules = {}
`);
  if (runtimeStart < 0)
    return null;
  const header = code.slice(0, runtimeStart + 1);
  const headerLineCount = header.split(`
`).length - 1;
  const modules = [];
  MODULE.lastIndex = 0;
  let match;
  while ((match = MODULE.exec(code)) !== null) {
    if (skipModules.includes(match[1]))
      continue;
    const bodyStart = match.indices[2][0];
    const firstLine = code.slice(0, bodyStart).split(`
`).length - 1;
    modules.push({ name: match[1], raw: lines.slice(firstLine, firstLine + match[2].split(`
`).length) });
  }
  return { headerLineCount, modules };
}
function resolveImports(analysis, resolve, bundled, defaultAliases) {
  const result = [];
  const rewritten = new Set;
  const byName = new Map(analysis.imports.map((entry) => [entry.localName, entry]));
  for (const line of analysis.raw) {
    if (REQUIRE_LINE.test(line.text))
      continue;
    if (ANY_REQUIRE.test(line.text))
      continue;
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
    if (slot !== undefined) {
      if (slot.name === localName)
        continue;
      const replacement = { ...line, text: `${indent}local ${localName} = ${slot.name}` };
      rewritten.add(replacement);
      result.push(replacement);
      continue;
    }
    if (!bundled.has(entry.modulePath)) {
      const target = localNameFor(entry.exportName);
      if (localName !== target) {
        const replacement = { ...line, text: `${indent}local ${localName} = ${target}` };
        rewritten.add(replacement);
        result.push(replacement);
      }
      continue;
    }
    const alias = entry.exportName === "default" ? defaultAliases.get(entry.modulePath) : undefined;
    if (alias !== undefined && alias !== null) {
      if (alias === localName)
        continue;
      const replacement = { ...line, text: `${indent}local ${localName} = ${alias}` };
      rewritten.add(replacement);
      result.push(replacement);
    }
  }
  return { lines: result, rewritten };
}
function isForwardedExport(analysis, line) {
  const value = EXPORT_VALUE.exec(line.text);
  return value !== null && analysis.forwards.has(matchedExportName(value));
}
function isAssignableDeclaration(line, names) {
  if (!/^local (?:function )?[A-Za-z_]\w*[ \t]*[=(]/.test(line.text))
    return false;
  const match = /^local (?:function )?([A-Za-z_]\w*)/.exec(line.text);
  return match !== null && names.has(match[1]);
}
function buildModuleBody(analysis, assignable, resolve, bundled, defaultAliases, rootGlobals) {
  const kept = analysis.raw.filter((line) => !isForwardedExport(analysis, line));
  const { lines: imported, rewritten } = resolveImports({ ...analysis, raw: kept }, resolve, bundled, defaultAliases);
  const stripped = stripExports(imported, analysis.defaultAlias);
  const converted = stripped.map((line) => {
    if (rewritten.has(line) || !isAssignableDeclaration(line, assignable))
      return line;
    return { ...line, text: line.text.slice("local ".length) };
  });
  const globalized = converted.map((line) => rewritten.has(line) ? line : globalizeDeclaration(line, rootGlobals));
  return trimLines(stripEmptyScopes(stripReturn(globalized)));
}
function wrapperLines(name, body, publish) {
  return [
    inserted("do"),
    inserted(`local function ${name}()`),
    ...body,
    ...publish,
    inserted("end"),
    inserted(`${name}()`),
    inserted("end")
  ];
}
function buildPlan(analyses, budget) {
  const forwardTargets = new Map;
  for (const analysis of analyses) {
    for (const [exportName, target] of analysis.forwards) {
      forwardTargets.set(bindingKey(analysis.name, exportName), target);
    }
  }
  const cleanText = new Map;
  for (const analysis of analyses)
    cleanText.set(analysis.name, stripLuaStringsAndComments(render(analysis.raw)));
  const imported = new Map;
  for (const analysis of analyses) {
    for (const entry of analysis.imports) {
      const key = resolveBinding(bindingKey(entry.modulePath, entry.exportName), forwardTargets);
      const readers = imported.get(key) ?? [];
      readers.push({ localName: entry.localName, from: analysis.name });
      imported.set(key, readers);
    }
  }
  const candidates = [];
  for (const analysis of analyses) {
    for (const exported of analysis.exports) {
      const key = bindingKey(analysis.name, exported.name);
      const readers = imported.get(key);
      if (readers === undefined)
        continue;
      let refs = countReferences(cleanText.get(analysis.name) ?? "", exported.localName);
      for (const reader of readers) {
        refs += countReferences(cleanText.get(reader.from) ?? "", reader.localName);
      }
      candidates.push({ key, name: exported.localName, refs, canAssign: exported.canAssign });
    }
  }
  return { plan: planSlots(candidates, budget), forwardTargets };
}
function flattenScoped(lines, extracted, budget, limit, rootGlobals) {
  const analyses = extracted.modules.map((module2) => analyzeModule(module2.name, module2.raw, computeDefaultAlias(module2.name, module2.raw)));
  const { plan, forwardTargets } = buildPlan(analyses, budget);
  const rootGlobalNames = new Set(rootGlobals);
  const bundled = new Set(analyses.map((analysis) => analysis.name));
  const defaultAliases = new Map(analyses.map((analysis) => [analysis.name, analysis.defaultAlias]));
  const resolve = (modulePath, exportName) => {
    const key = resolveBinding(bindingKey(modulePath, exportName), forwardTargets);
    return plan.slots.get(key);
  };
  const assignable = new Map;
  const publishes = new Map;
  for (const analysis of analyses) {
    const names = new Set;
    const publish = [];
    for (const exported of analysis.exports) {
      const slot = plan.slots.get(bindingKey(analysis.name, exported.name));
      if (slot === undefined)
        continue;
      if (slot.form === "assign") {
        names.add(exported.localName);
      } else {
        publish.push(inserted(`${slot.name} = ${exported.localName}`));
      }
    }
    assignable.set(analysis.name, names);
    publishes.set(analysis.name, publish);
  }
  const bodies = analyses.map((analysis) => buildModuleBody(analysis, assignable.get(analysis.name) ?? new Set, resolve, bundled, defaultAliases, rootGlobalNames));
  const result = lines.slice(0, extracted.headerLineCount);
  if (plan.hot.length > 0)
    result.push(inserted(`local ${plan.hot.join(", ")}`));
  if (plan.table !== null)
    result.push(inserted(`local ${plan.table} = {}`));
  for (const [index, body] of bodies.entries()) {
    if (index > 0)
      result.push(inserted(""));
    if (body.length === 0) {
      result.push(inserted(""));
      continue;
    }
    result.push(...wrapperLines(`____module_${index}`, body, publishes.get(analyses[index].name) ?? []));
  }
  const published = new Map;
  for (const analysis of analyses) {
    for (const exported of analysis.exports) {
      if (!rootGlobalNames.has(exported.localName))
        continue;
      const slot = plan.slots.get(bindingKey(analysis.name, exported.name));
      if (slot !== undefined)
        published.set(exported.localName, slot.name);
    }
  }
  for (const [name, slot] of published)
    result.push(inserted(`${name} = ${slot}`));
  const seen = new Set(published.keys());
  for (const body of bodies) {
    for (const line of body) {
      const name = topLevelName(line.text);
      if (name !== null && rootGlobalNames.has(name))
        seen.add(name);
    }
  }
  for (const line of result) {
    const namespace = NAMESPACE_REQUIRE.exec(line.text);
    if (namespace !== null) {
      throw new Error(`tstl-bundle-flatten: cannot flatten a namespace import of "${namespace[1]}". ` + "Import the names themselves.");
    }
  }
  let worst = null;
  for (const [index, body] of bodies.entries()) {
    const locals = body.filter((line) => /^local (?:function )?[A-Za-z_]\w*/.test(line.text)).length;
    if (worst === null || locals > worst.locals)
      worst = { name: analyses[index].name, locals };
  }
  const usage = {
    modules: analyses.length,
    hoisted: plan.slots.size,
    hot: plan.hot.length,
    cold: plan.cold,
    rootLocals: plan.hot.length + (plan.table === null ? 0 : 1),
    budget,
    limit,
    worst,
    rootGlobals: rootGlobals.filter((name) => seen.has(name)),
    missingRootGlobals: rootGlobals.filter((name) => !seen.has(name))
  };
  return { lines: result, usage };
}
function flattenFlat(lines, skipModules, budget, limit, rootGlobals) {
  const extracted = extractModules(lines, skipModules);
  if (extracted === null)
    return { lines, usage: null };
  const moduleEntries = extracted.modules;
  const defaultAliases = new Map;
  const rootGlobalNames = new Set(rootGlobals);
  for (const entry of moduleEntries) {
    defaultAliases.set(entry.name, computeDefaultAlias(entry.name, entry.raw));
  }
  const bodies = [];
  for (const entry of moduleEntries) {
    const alias = defaultAliases.get(entry.name) ?? null;
    const body = trimLines(stripEmptyScopes(stripImports(stripReturn(stripExports(entry.raw, alias)), defaultAliases).map((line) => globalizeDeclaration(line, rootGlobalNames))));
    bodies.push(body.length > 0 ? body : [inserted("")]);
  }
  const result = lines.slice(0, extracted.headerLineCount);
  if (bodies.length === 0)
    result.push(inserted(""));
  for (const [index, body] of bodies.entries()) {
    if (index > 0)
      result.push(inserted(""));
    result.push(...body);
  }
  for (const line of result) {
    const namespace = NAMESPACE_REQUIRE.exec(line.text);
    if (namespace !== null) {
      throw new Error(`tstl-bundle-flatten: cannot flatten a namespace import of "${namespace[1]}". ` + "Import the names themselves.");
    }
  }
  let worst = null;
  for (const [index, body] of bodies.entries()) {
    const locals = body.filter((line) => /^local (?:function )?[A-Za-z_]\w*/.test(line.text)).length;
    if (worst === null || locals > worst.locals)
      worst = { name: moduleEntries[index].name, locals };
  }
  const seen = new Set;
  for (const body of bodies) {
    for (const line of body) {
      const name = topLevelName(line.text);
      if (name !== null && rootGlobalNames.has(name))
        seen.add(name);
    }
  }
  return {
    lines: result,
    usage: {
      modules: moduleEntries.length,
      hoisted: 0,
      hot: 0,
      cold: 0,
      rootLocals: bodies.reduce((total, body) => total + body.filter((line) => /^local (?:function )?[A-Za-z_]\w*/.test(line.text)).length, 0),
      budget,
      limit,
      worst,
      rootGlobals: rootGlobals.filter((name) => seen.has(name)),
      missingRootGlobals: rootGlobals.filter((name) => !seen.has(name))
    }
  };
}
function stripImports(lines, defaultAliases) {
  const result = [];
  const requireMap = new Map;
  for (let index = 0;index < lines.length; index++) {
    const line = lines[index];
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
    if (ANY_REQUIRE.test(line.text))
      continue;
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
      if (modulePath !== undefined && alias === null)
        continue;
      if (alias) {
        if (localName === alias)
          continue;
        result.push({ ...line, text: `${indent}local ${localName} = ${alias}` });
        continue;
      }
    }
    const exportLocal = localNameFor(exportName);
    if (localName === exportLocal)
      continue;
    result.push({ ...line, text: `${indent}local ${localName} = ${exportLocal}` });
  }
  return result;
}
function flattenWithUsage(lines, options = {}) {
  const resolved = normalizeOptions(options);
  const skipModules = resolved.skipModules ?? [];
  const budget = resolved.registerBudget === undefined ? DEFAULT_REGISTER_BUDGET : resolved.registerBudget;
  const limit = resolved.registerLimit === undefined ? LUAU_REGISTER_LIMIT : resolved.registerLimit;
  const rootGlobals = resolved.rootGlobals ?? [];
  if (resolved.scopeModules === false)
    return flattenFlat(lines, skipModules, budget, limit, rootGlobals);
  const extracted = extractModules(lines, skipModules);
  if (extracted === null)
    return { lines, usage: null };
  return flattenScoped(lines, extracted, budget, limit, rootGlobals);
}

// src/format.ts
var RE_COMMENT = /^\s*--/;
var RE_DOC_COMMENT = /^\s*---/;
var RE_BLANK = /^\s*$/;
var RE_LOCAL = /^\s*local\b/;
var RE_END = /^\s*end\b/;
var RE_BLOCK_OPENER = /(?:then|do|else|repeat)$/;
var RE_FUNCTION_HEAD = /\bfunction\b.*\)\s*$/;
var CONTINUES_END = /^(?:end\b|else\b|elseif\b|\)|[}\]]|,)/;
function afterWhitespace({ lines, at }, pattern) {
  for (let index = at;index < lines.length; index++) {
    const { text } = lines[index];
    if (isBlank(text))
      continue;
    return pattern.test(text.trimStart());
  }
  return false;
}
var RULES = [
  {
    matches: (pair) => /^[ \t]*end$/.test(pair.previous) && (pair.atEof || pair.next !== "") && !afterWhitespace(pair, CONTINUES_END),
    consumesNext: false
  },
  {
    matches: ({ previous, next, atEof }) => /^[)}]$/.test(previous) && (atEof || next !== "") && !/^[)}]/.test(next),
    consumesNext: false
  },
  {
    matches: ({ previous, next }) => /^[ \t]*local (?!function\b)\w/.test(previous) && /^[^\S\n]*(?!local\b|--)\S/.test(next),
    guard: ({ previous }) => !RE_FUNCTION_HEAD.test(previous.trimEnd()),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*local (?!function\b)\w/.test(next),
    guard: ({ previous }) => !RE_LOCAL.test(previous) && !RE_COMMENT.test(previous) && !RE_BLANK.test(previous) && !RE_BLOCK_OPENER.test(previous.trimEnd()) && !RE_FUNCTION_HEAD.test(previous.trimEnd()),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*\w[\w.:]*\([^)]*$/.test(next),
    guard: ({ previous }) => !RE_COMMENT.test(previous) && !RE_BLANK.test(previous) && !RE_END.test(previous) && !RE_BLOCK_OPENER.test(previous.trimEnd()) && !RE_FUNCTION_HEAD.test(previous.trimEnd()),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*(?:if|for|while|repeat|return)\b/.test(next),
    guard: ({ previous }) => !RE_BLOCK_OPENER.test(previous.trimEnd()) && !RE_FUNCTION_HEAD.test(previous.trimEnd()) && !RE_END.test(previous) && !RE_DOC_COMMENT.test(previous) && !RE_BLANK.test(previous),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*---/.test(next),
    guard: ({ previous }) => !RE_COMMENT.test(previous) && !RE_BLANK.test(previous),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*(?:local )?function\b/.test(next),
    guard: ({ previous }) => !RE_COMMENT.test(previous) && !RE_BLANK.test(previous),
    consumesNext: true
  }
];
function applyRule(lines, rule) {
  const result = [];
  for (let index = 0;index < lines.length; index++) {
    result.push(lines[index]);
    const next = lines[index + 1];
    if (next === undefined)
      continue;
    const pair = {
      previous: lines[index].text,
      next: next.text,
      atEof: index + 2 === lines.length && next.text === "",
      lines,
      at: index + 1
    };
    if (!rule.matches(pair))
      continue;
    if (rule.guard === undefined || rule.guard(pair)) {
      result.push(inserted(""));
    }
    if (rule.consumesNext) {
      result.push(next);
      index++;
    }
  }
  return result;
}
function formatLines(lines) {
  return RULES.reduce(applyRule, lines);
}

// src/shake.ts
var ts2 = __toESM(require("typescript"));
function shakeProgram(program, options = {}) {
  const context = {
    checker: program.getTypeChecker(),
    units: new Map,
    origins: new Map,
    usedSymbols: new Set,
    defaultExports: new Map,
    live: new Set,
    queue: [],
    shakeClassFunctions: options.shakeClassFunctions === true
  };
  const sourceFiles = program.getSourceFiles().filter((file) => !file.isDeclarationFile);
  for (const file of sourceFiles)
    collectFile(file, context);
  for (const file of sourceFiles) {
    for (const statement of file.statements)
      visitCode(statement, context, false);
  }
  drain(context);
  for (const file of sourceFiles)
    rewriteNode(file, context);
}
function collectFile(file, context) {
  file.forEachChild((node) => collectNode(node, context));
}
function collectNode(node, context) {
  if (ts2.isModuleDeclaration(node))
    return;
  if (isAmbient(node))
    return;
  if (ts2.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      addUnit(declaration, context);
    }
  } else if (ts2.isFunctionDeclaration(node)) {
    addUnit(node, context);
  } else if (ts2.isClassDeclaration(node)) {
    addUnit(node, context);
    collectClassMembers(node, context);
  } else if (ts2.isEnumDeclaration(node)) {
    addUnit(node, context);
  } else if (ts2.isExportAssignment(node)) {
    addUnit(node, context);
    recordDefaultExport(node, context);
  }
  node.forEachChild((child) => collectNode(child, context));
}
function recordDefaultExport(node, context) {
  if (!ts2.isIdentifier(node.expression))
    return;
  const symbol = context.checker.getSymbolAtLocation(node.expression);
  if (!symbol)
    return;
  const resolved = resolveSymbol(symbol, context) ?? symbol;
  const exports2 = context.defaultExports.get(resolved) ?? [];
  exports2.push(node);
  context.defaultExports.set(resolved, exports2);
}
function collectClassMembers(node, context) {
  if (!context.shakeClassFunctions)
    return;
  const accessors = new Map;
  for (const member of node.members) {
    if (!isClassFunction(member))
      continue;
    if (ts2.isComputedPropertyName(member.name))
      continue;
    const unit = addUnit(member, context);
    unit.owner = node;
    if (ts2.isGetAccessorDeclaration(member) || ts2.isSetAccessorDeclaration(member)) {
      const key = member.name.getText();
      const group = accessors.get(key);
      if (group) {
        group.push(member);
      } else {
        accessors.set(key, [member]);
      }
    }
  }
  for (const group of accessors.values()) {
    if (group.length < 2)
      continue;
    for (const member of group) {
      const unit = unitOf(member, context);
      if (unit)
        unit.siblings = group.filter((other) => other !== member);
    }
  }
}
function addUnit(node, context) {
  const existing = unitOf(node, context);
  if (existing)
    return existing;
  const unit = { node };
  context.units.set(node, unit);
  context.origins.set(ts2.getOriginalNode(node), unit);
  return unit;
}
function unitOf(node, context) {
  return context.units.get(node) ?? context.origins.get(ts2.getOriginalNode(node));
}
function isClassFunction(node) {
  return (ts2.isMethodDeclaration(node) || ts2.isGetAccessorDeclaration(node) || ts2.isSetAccessorDeclaration(node)) && !ts2.isConstructorDeclaration(node);
}
function markLive(node, context) {
  if (!node)
    return;
  const unit = unitOf(node, context);
  if (!unit || context.live.has(unit.node))
    return;
  context.live.add(unit.node);
  context.queue.push(unit.node);
  if (unit.owner)
    markLive(unit.owner, context);
  for (const sibling of unit.siblings ?? [])
    markLive(sibling, context);
}
function drain(context) {
  while (context.queue.length > 0) {
    const node = context.queue.pop();
    const unit = unitOf(node, context);
    if (!unit)
      continue;
    if (ts2.isVariableDeclaration(node)) {
      visitBindingName(node.name, context);
      if (node.initializer)
        visitCode(node.initializer, context, false);
    } else if (ts2.isFunctionDeclaration(node)) {
      visitFunctionLike(node, context);
    } else if (ts2.isClassDeclaration(node)) {
      visitClass(node, context);
    } else if (ts2.isEnumDeclaration(node)) {
      visitEnum(node, context);
    } else if (ts2.isExportAssignment(node)) {
      visitCode(node.expression, context, false);
    } else if (isClassFunction(node)) {
      visitFunctionLike(node, context);
    }
  }
}
function resolveSymbol(symbol, context) {
  if (!symbol)
    return;
  if ((symbol.flags & ts2.SymbolFlags.Alias) === 0)
    return symbol;
  try {
    return context.checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}
function markSymbol(node, context) {
  const symbol = context.checker.getSymbolAtLocation(node);
  if (!symbol)
    return;
  context.usedSymbols.add(symbol);
  const resolved = resolveSymbol(symbol, context);
  if (!resolved)
    return;
  if (isImportAlias(symbol)) {
    for (const exportNode of context.defaultExports.get(resolved) ?? [])
      markLive(exportNode, context);
  }
  for (const declaration of resolved.declarations ?? [])
    markLive(declaration, context);
}
function isImportAlias(symbol) {
  if ((symbol.flags & ts2.SymbolFlags.Alias) === 0)
    return false;
  return (symbol.declarations ?? []).some((declaration) => ts2.isImportSpecifier(declaration) || ts2.isImportClause(declaration) || ts2.isNamespaceImport(declaration) || ts2.isImportEqualsDeclaration(declaration));
}
function markProperty(node, context) {
  const symbol = resolveSymbol(context.checker.getSymbolAtLocation(node), context);
  if (!symbol)
    return;
  for (const declaration of symbol.declarations ?? [])
    markLive(declaration, context);
}
function visitCode(node, context, all) {
  if (ts2.isIdentifier(node)) {
    markSymbol(node, context);
    return;
  }
  if (ts2.isPrivateIdentifier(node)) {
    markProperty(node, context);
    return;
  }
  if (ts2.isTypeNode(node) || ts2.isTypeParameterDeclaration(node))
    return;
  if (ts2.isPropertyAccessExpression(node)) {
    visitCode(node.expression, context, all);
    markProperty(node.name, context);
    return;
  }
  if (ts2.isPropertyAssignment(node)) {
    visitPropertyName(node.name, context);
    visitCode(node.initializer, context, all);
    return;
  }
  if (ts2.isShorthandPropertyAssignment(node)) {
    markSymbol(node.name, context);
    if (node.objectAssignmentInitializer)
      visitCode(node.objectAssignmentInitializer, context, all);
    return;
  }
  if (ts2.isMethodDeclaration(node) || ts2.isGetAccessorDeclaration(node) || ts2.isSetAccessorDeclaration(node)) {
    visitPropertyName(node.name, context);
    visitFunctionLike(node, context);
    return;
  }
  if (ts2.isVariableStatement(node)) {
    visitVariableStatement(node, context, all);
    return;
  }
  if (ts2.isFunctionDeclaration(node)) {
    if (all)
      visitFunctionLike(node, context);
    return;
  }
  if (ts2.isClassDeclaration(node)) {
    if (all) {
      visitClassLikeAll(node, context);
    } else if (classHasSideEffects(node, context)) {
      markLive(node, context);
    }
    return;
  }
  if (ts2.isClassExpression(node)) {
    visitClassLikeAll(node, context);
    return;
  }
  if (ts2.isEnumDeclaration(node)) {
    if (all) {
      visitEnum(node, context);
    } else if (enumHasSideEffects(node, context)) {
      markLive(node, context);
    }
    return;
  }
  if (ts2.isModuleDeclaration(node)) {
    visitModule(node, context);
    return;
  }
  if (ts2.isImportDeclaration(node) || ts2.isExportDeclaration(node))
    return;
  if (ts2.isExportAssignment(node)) {
    if (all || expressionHasSideEffects(node.expression, context)) {
      visitCode(node.expression, context, all);
    }
    return;
  }
  if (ts2.isModuleBlock(node)) {
    for (const statement of node.statements)
      visitCode(statement, context, true);
    return;
  }
  if (ts2.isInterfaceDeclaration(node) || ts2.isTypeAliasDeclaration(node) || ts2.isImportEqualsDeclaration(node)) {
    return;
  }
  if (ts2.isParameter(node)) {
    visitParameter(node, context);
    return;
  }
  if (ts2.isFunctionExpression(node) || ts2.isArrowFunction(node) || ts2.isConstructorDeclaration(node)) {
    visitFunctionLike(node, context);
    return;
  }
  if (ts2.isClassStaticBlockDeclaration(node)) {
    visitCode(node.body, context, all);
    return;
  }
  if (ts2.isSourceFile(node) || ts2.isBlock(node)) {
    for (const statement of node.statements)
      visitCode(statement, context, all);
    return;
  }
  if (ts2.isCaseBlock(node)) {
    for (const clause of node.clauses)
      visitCode(clause, context, all);
    return;
  }
  if (ts2.isCaseClause(node) || ts2.isDefaultClause(node)) {
    for (const statement of node.statements)
      visitCode(statement, context, all);
    return;
  }
  node.forEachChild((child) => visitCode(child, context, all));
}
function visitVariableStatement(node, context, all) {
  for (const declaration of node.declarationList.declarations) {
    if (all) {
      visitBindingName(declaration.name, context);
      if (declaration.initializer)
        visitCode(declaration.initializer, context, true);
      continue;
    }
    if (bindingHasSideEffects(declaration.name, context))
      markLive(declaration, context);
    if (declaration.initializer && expressionHasSideEffects(declaration.initializer, context)) {
      visitCode(declaration.initializer, context, false);
    }
  }
}
function visitBindingName(name, context) {
  if (ts2.isIdentifier(name))
    return;
  for (const element of name.elements) {
    if (ts2.isOmittedExpression(element))
      continue;
    if (element.propertyName && ts2.isComputedPropertyName(element.propertyName)) {
      visitCode(element.propertyName.expression, context, false);
    }
    visitBindingName(element.name, context);
    if (element.initializer)
      visitCode(element.initializer, context, false);
  }
}
function visitFunctionLike(node, context) {
  for (const modifier of modifierNodes(node))
    visitDecorator(modifier, context);
  for (const parameter of node.parameters)
    visitParameter(parameter, context);
  if (node.body)
    visitCode(node.body, context, false);
}
function visitParameter(node, context) {
  for (const modifier of modifierNodes(node))
    visitDecorator(modifier, context);
  visitBindingName(node.name, context);
  if (node.initializer)
    visitCode(node.initializer, context, false);
}
function visitPropertyName(name, context) {
  if (ts2.isComputedPropertyName(name))
    visitCode(name.expression, context, false);
}
function visitClass(node, context) {
  visitClassLikeAll(node, context, true);
}
function visitClassLikeAll(node, context, onlyLiveMembers = false) {
  for (const modifier of modifierNodes(node))
    visitDecorator(modifier, context);
  for (const clause of node.heritageClauses ?? []) {
    for (const type of clause.types)
      visitCode(type.expression, context, false);
  }
  for (const member of node.members) {
    for (const modifier of modifierNodes(member))
      visitDecorator(modifier, context);
    if (ts2.isConstructorDeclaration(member)) {
      visitFunctionLike(member, context);
      continue;
    }
    if (isClassFunction(member)) {
      visitPropertyName(member.name, context);
      if (!onlyLiveMembers || !context.shakeClassFunctions || ts2.isComputedPropertyName(member.name)) {
        visitFunctionLike(member, context);
      } else if (hasDecorators(member)) {
        markLive(member, context);
      }
      continue;
    }
    if (ts2.isPropertyDeclaration(member)) {
      visitPropertyName(member.name, context);
      if (member.initializer)
        visitCode(member.initializer, context, false);
      continue;
    }
    if (ts2.isClassStaticBlockDeclaration(member)) {
      visitCode(member.body, context, false);
      continue;
    }
    if (ts2.isIndexSignatureDeclaration(member))
      continue;
  }
}
function visitEnum(node, context) {
  for (const modifier of modifierNodes(node))
    visitDecorator(modifier, context);
  for (const member of node.members) {
    visitPropertyName(member.name, context);
    if (member.initializer)
      visitCode(member.initializer, context, false);
  }
}
function visitModule(node, context) {
  if (node.body)
    visitCode(node.body, context, true);
}
function visitDecorator(modifier, context) {
  if (ts2.isDecorator(modifier))
    visitCode(modifier.expression, context, false);
}
function expressionHasSideEffects(expression, context, seen = new Set) {
  if (!expression)
    return false;
  switch (expression.kind) {
    case ts2.SyntaxKind.NewExpression:
      return newExpressionHasSideEffects(expression, context, seen);
    case ts2.SyntaxKind.CallExpression:
    case ts2.SyntaxKind.TaggedTemplateExpression:
    case ts2.SyntaxKind.AwaitExpression:
    case ts2.SyntaxKind.YieldExpression:
    case ts2.SyntaxKind.DeleteExpression:
    case ts2.SyntaxKind.PostfixUnaryExpression:
      return true;
    case ts2.SyntaxKind.PrefixUnaryExpression: {
      const node = expression;
      return node.operator === ts2.SyntaxKind.PlusPlusToken || node.operator === ts2.SyntaxKind.MinusMinusToken || expressionHasSideEffects(node.operand, context, seen);
    }
    case ts2.SyntaxKind.BinaryExpression: {
      const node = expression;
      const operator = node.operatorToken.kind;
      if (operator >= ts2.SyntaxKind.FirstAssignment && operator <= ts2.SyntaxKind.LastAssignment) {
        return true;
      }
      return expressionHasSideEffects(node.left, context, seen) || expressionHasSideEffects(node.right, context, seen);
    }
    case ts2.SyntaxKind.ConditionalExpression: {
      const node = expression;
      return expressionHasSideEffects(node.condition, context, seen) || expressionHasSideEffects(node.whenTrue, context, seen) || expressionHasSideEffects(node.whenFalse, context, seen);
    }
    case ts2.SyntaxKind.PropertyAccessExpression:
      return expressionHasSideEffects(expression.expression, context, seen);
    case ts2.SyntaxKind.ElementAccessExpression: {
      const node = expression;
      return expressionHasSideEffects(node.expression, context, seen) || expressionHasSideEffects(node.argumentExpression, context, seen);
    }
    case ts2.SyntaxKind.ParenthesizedExpression:
      return expressionHasSideEffects(expression.expression, context, seen);
    case ts2.SyntaxKind.AsExpression:
    case ts2.SyntaxKind.SatisfiesExpression:
    case ts2.SyntaxKind.NonNullExpression:
    case ts2.SyntaxKind.TypeAssertionExpression:
      return expressionHasSideEffects(expression.expression, context, seen);
    case ts2.SyntaxKind.ArrayLiteralExpression:
      return expression.elements.some((element) => expressionHasSideEffects(ts2.isSpreadElement(element) ? element.expression : element, context, seen));
    case ts2.SyntaxKind.ObjectLiteralExpression:
      return expression.properties.some((member) => objectMemberHasSideEffects(member, context, seen));
    case ts2.SyntaxKind.TemplateExpression:
      return expression.templateSpans.some((span) => expressionHasSideEffects(span.expression, context, seen));
    case ts2.SyntaxKind.SpreadElement:
      return expressionHasSideEffects(expression.expression, context, seen);
    case ts2.SyntaxKind.VoidExpression:
    case ts2.SyntaxKind.TypeOfExpression:
      return expressionHasSideEffects(expression.expression, context, seen);
    case ts2.SyntaxKind.ClassExpression:
      return classHasSideEffects(expression, context, seen);
    case ts2.SyntaxKind.CommaListExpression:
      return expression.elements.some((element) => expressionHasSideEffects(element, context, seen));
    default:
      return false;
  }
}
function newExpressionHasSideEffects(node, context, seen) {
  if (expressionHasSideEffects(node.expression, context, seen))
    return true;
  for (const argument of node.arguments ?? []) {
    if (expressionHasSideEffects(ts2.isSpreadElement(argument) ? argument.expression : argument, context, seen)) {
      return true;
    }
  }
  const declaration = resolveClassDeclaration(node.expression, context);
  return declaration === undefined || !isPureClassConstruction(declaration, context, seen);
}
function resolveClassDeclaration(expression, context) {
  if (!ts2.isIdentifier(expression))
    return;
  const symbol = resolveSymbol(context.checker.getSymbolAtLocation(expression), context);
  if (!symbol)
    return;
  return (symbol.declarations ?? []).find(ts2.isClassDeclaration);
}
function isPureClassConstruction(node, context, seen) {
  if (seen.has(node))
    return false;
  if (hasDecorators(node))
    return false;
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts2.SyntaxKind.ExtendsKeyword)
      return false;
  }
  seen.add(node);
  for (const member of node.members) {
    if (ts2.isConstructorDeclaration(member)) {
      if (hasDecorators(member) || !constructorIsPure(member, context, seen))
        return false;
      continue;
    }
    if (ts2.isGetAccessorDeclaration(member) || ts2.isSetAccessorDeclaration(member))
      return false;
    if (ts2.isPropertyDeclaration(member)) {
      if (ts2.isComputedPropertyName(member.name))
        return false;
      if (member.initializer && expressionHasSideEffects(member.initializer, context, seen))
        return false;
      continue;
    }
    if (ts2.isClassStaticBlockDeclaration(member))
      return false;
    if (ts2.isMethodDeclaration(member) || ts2.isIndexSignatureDeclaration(member))
      continue;
    return false;
  }
  return true;
}
function constructorIsPure(node, context, seen) {
  for (const parameter of node.parameters) {
    if (parameter.initializer && expressionHasSideEffects(parameter.initializer, context, seen)) {
      return false;
    }
  }
  if (!node.body)
    return true;
  for (const statement of node.body.statements) {
    if (!ts2.isExpressionStatement(statement))
      return false;
    const expression = statement.expression;
    if (!ts2.isBinaryExpression(expression) || expression.operatorToken.kind !== ts2.SyntaxKind.EqualsToken || !ts2.isPropertyAccessExpression(expression.left) || expression.left.expression.kind !== ts2.SyntaxKind.ThisKeyword) {
      return false;
    }
    if (expressionHasSideEffects(expression.right, context, seen))
      return false;
  }
  return true;
}
function objectMemberHasSideEffects(member, context, seen) {
  if (ts2.isPropertyAssignment(member)) {
    return ts2.isComputedPropertyName(member.name) && expressionHasSideEffects(member.name.expression, context, seen) || expressionHasSideEffects(member.initializer, context, seen);
  }
  if (ts2.isShorthandPropertyAssignment(member))
    return false;
  if (ts2.isSpreadAssignment(member))
    return expressionHasSideEffects(member.expression, context, seen);
  if (ts2.isMethodDeclaration(member) || ts2.isGetAccessorDeclaration(member) || ts2.isSetAccessorDeclaration(member)) {
    return ts2.isComputedPropertyName(member.name) && expressionHasSideEffects(member.name.expression, context, seen);
  }
  return false;
}
function bindingHasSideEffects(name, context) {
  if (ts2.isIdentifier(name))
    return false;
  return name.elements.some((element) => {
    if (ts2.isOmittedExpression(element))
      return false;
    if (element.propertyName && ts2.isComputedPropertyName(element.propertyName)) {
      if (expressionHasSideEffects(element.propertyName.expression, context))
        return true;
    }
    return bindingHasSideEffects(element.name, context) || (element.initializer ? expressionHasSideEffects(element.initializer, context) : false);
  });
}
function classHasSideEffects(node, context, seen = new Set) {
  if (hasDecorators(node))
    return true;
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts2.SyntaxKind.ExtendsKeyword)
      continue;
    for (const type of clause.types) {
      if (expressionHasSideEffects(type.expression, context, seen))
        return true;
    }
  }
  for (const member of node.members) {
    if (hasDecorators(member))
      return true;
    if (ts2.isClassStaticBlockDeclaration(member))
      return true;
    if (ts2.isPropertyDeclaration(member) && member.initializer) {
      const isStatic = modifierNodes(member).some((modifier) => modifier.kind === ts2.SyntaxKind.StaticKeyword);
      if (isStatic && expressionHasSideEffects(member.initializer, context, seen))
        return true;
    }
    if ("name" in member && member.name !== undefined && ts2.isComputedPropertyName(member.name) && expressionHasSideEffects(member.name.expression, context, seen)) {
      return true;
    }
  }
  return false;
}
function enumHasSideEffects(node, context) {
  return node.members.some((member) => expressionHasSideEffects(member.initializer, context));
}
function hasDecorators(node) {
  return modifierNodes(node).some(ts2.isDecorator);
}
function modifierNodes(node) {
  return ts2.canHaveModifiers(node) ? ts2.getModifiers(node) ?? [] : [];
}
function rewriteNode(node, context) {
  if (ts2.isModuleDeclaration(node))
    return;
  if (ts2.isSourceFile(node) || ts2.isBlock(node)) {
    rewriteStatementList(node, context);
    return;
  }
  if (ts2.isCaseBlock(node)) {
    for (const clause of node.clauses)
      rewriteNode(clause, context);
    return;
  }
  if (ts2.isCaseClause(node) || ts2.isDefaultClause(node)) {
    for (const statement of node.statements)
      rewriteNode(statement, context);
    rewriteStatementList(node, context);
    return;
  }
  if (ts2.isClassDeclaration(node) || ts2.isClassExpression(node)) {
    for (const member of node.members)
      rewriteNode(member, context);
    if (ts2.isClassDeclaration(node))
      pruneClassMembers(node, context);
    return;
  }
  if (ts2.isFunctionDeclaration(node) || ts2.isFunctionExpression(node) || ts2.isArrowFunction(node)) {
    if (node.body)
      rewriteNode(node.body, context);
    return;
  }
  if (ts2.isMethodDeclaration(node) || ts2.isGetAccessorDeclaration(node) || ts2.isSetAccessorDeclaration(node)) {
    if (node.body)
      rewriteNode(node.body, context);
    return;
  }
  if (ts2.isConstructorDeclaration(node)) {
    if (node.body)
      rewriteNode(node.body, context);
    return;
  }
  if (ts2.isClassStaticBlockDeclaration(node)) {
    rewriteNode(node.body, context);
    return;
  }
  node.forEachChild((child) => rewriteNode(child, context));
}
function rewriteStatementList(node, context) {
  for (const statement of node.statements)
    rewriteNode(statement, context);
  const kept = [];
  for (const statement of node.statements) {
    if (isDeadDeclaration(statement, context))
      continue;
    if (ts2.isVariableStatement(statement)) {
      kept.push(...rewriteVariableStatement(statement, context));
      continue;
    }
    if (ts2.isImportDeclaration(statement)) {
      const pruned = pruneImportDeclaration(statement, context);
      if (pruned)
        kept.push(pruned);
      continue;
    }
    if (ts2.isExportAssignment(statement)) {
      const unit = unitOf(statement, context);
      if (unit && !context.live.has(unit.node)) {
        if (expressionHasSideEffects(statement.expression, context)) {
          kept.push(ts2.factory.createExpressionStatement(statement.expression));
        }
        continue;
      }
      kept.push(statement);
      continue;
    }
    if (ts2.isExportDeclaration(statement)) {
      const pruned = pruneExportDeclaration(statement, context);
      if (pruned)
        kept.push(pruned);
      continue;
    }
    kept.push(statement);
  }
  const unchanged = kept.length === node.statements.length && kept.every((statement, index) => statement === node.statements[index]);
  if (!unchanged)
    setStatements(node, kept);
}
function isDeadDeclaration(statement, context) {
  if (!ts2.isFunctionDeclaration(statement) && !ts2.isClassDeclaration(statement) && !ts2.isEnumDeclaration(statement)) {
    return false;
  }
  const unit = unitOf(statement, context);
  if (!unit)
    return false;
  return !context.live.has(unit.node);
}
function rewriteVariableStatement(node, context) {
  if (isAmbient(node))
    return [node];
  const declarations = node.declarationList.declarations;
  if (declarations.every((declaration) => !isDeadVariable(declaration, context))) {
    return [node];
  }
  const kept = [];
  let pending = [];
  let modifiersPlaced = false;
  const flush = () => {
    if (pending.length === 0)
      return;
    const useModifiers = !modifiersPlaced && node.modifiers !== undefined;
    if (useModifiers)
      modifiersPlaced = true;
    kept.push(ts2.factory.createVariableStatement(useModifiers ? node.modifiers : undefined, ts2.factory.createVariableDeclarationList(pending, node.declarationList.flags)));
    pending = [];
  };
  for (const declaration of declarations) {
    if (!isDeadVariable(declaration, context)) {
      pending.push(declaration);
      continue;
    }
    if (declaration.initializer && expressionHasSideEffects(declaration.initializer, context)) {
      flush();
      kept.push(ts2.factory.createExpressionStatement(declaration.initializer));
    }
  }
  flush();
  return kept;
}
function isDeadVariable(node, context) {
  const unit = unitOf(node, context);
  if (!unit)
    return false;
  return !context.live.has(unit.node);
}
function pruneClassMembers(node, context) {
  if (!context.shakeClassFunctions)
    return;
  const kept = node.members.filter((member) => {
    if (!isClassFunction(member))
      return true;
    const unit = unitOf(member, context);
    if (!unit)
      return true;
    if (context.live.has(unit.node))
      return true;
    return (unit.siblings ?? []).some((sibling) => context.live.has(sibling));
  });
  if (kept.length !== node.members.length) {
    node.members = ts2.factory.createNodeArray(kept);
  }
}
function pruneImportDeclaration(node, context) {
  const clause = node.importClause;
  if (!clause)
    return node;
  if (clause.isTypeOnly)
    return;
  const used = (name) => {
    const symbol = context.checker.getSymbolAtLocation(name);
    return symbol !== undefined && context.usedSymbols.has(symbol);
  };
  const mutableClause = clause;
  if (mutableClause.name && !used(mutableClause.name))
    mutableClause.name = undefined;
  if (mutableClause.namedBindings) {
    if (ts2.isNamespaceImport(mutableClause.namedBindings)) {
      if (!used(mutableClause.namedBindings.name))
        mutableClause.namedBindings = undefined;
    } else {
      const bindings = mutableClause.namedBindings;
      const elements = bindings.elements.filter((specifier) => !specifier.isTypeOnly && used(specifier.name));
      if (elements.length === 0) {
        mutableClause.namedBindings = undefined;
      } else if (elements.length !== bindings.elements.length) {
        bindings.elements = ts2.factory.createNodeArray(elements);
      }
    }
  }
  if (mutableClause.name === undefined && mutableClause.namedBindings === undefined) {
    node.importClause = undefined;
  }
  return node;
}
function pruneExportDeclaration(node, context) {
  if (!node.exportClause || !ts2.isNamedExports(node.exportClause))
    return node;
  const kept = node.exportClause.elements.filter((specifier) => {
    if (specifier.isTypeOnly)
      return true;
    const symbol = resolveSymbol(context.checker.getSymbolAtLocation(specifier.propertyName ?? specifier.name), context);
    if (!symbol)
      return true;
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0)
      return true;
    const units = declarations.map((declaration) => unitOf(declaration, context)).filter(isUnit);
    if (units.length === 0)
      return true;
    return units.some((unit) => context.live.has(unit.node));
  });
  if (kept.length === node.exportClause.elements.length)
    return node;
  if (kept.length === 0) {
    const typeOnly = node.isTypeOnly || node.exportClause.elements.every((specifier) => specifier.isTypeOnly);
    if (node.moduleSpecifier && !typeOnly) {
      return ts2.factory.createImportDeclaration(undefined, undefined, node.moduleSpecifier, node.attributes);
    }
    return;
  }
  return ts2.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, ts2.factory.updateNamedExports(node.exportClause, kept), node.moduleSpecifier, node.attributes);
}
function isUnit(unit) {
  return unit !== undefined;
}
function setStatements(node, statements) {
  node.statements = ts2.factory.createNodeArray(statements);
}
function isAmbient(node) {
  const modifiers = ts2.canHaveModifiers(node) ? ts2.getModifiers(node) : undefined;
  return (modifiers ?? []).some((modifier) => modifier.kind === ts2.SyntaxKind.DeclareKeyword);
}

// src/sourcemap.ts
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var CHAR_TO_INT = new Map([...BASE64].map((char, index) => [char, index]));
function decodeVlq(text) {
  const values = [];
  let shift = 0;
  let value = 0;
  for (const char of text) {
    const digit = CHAR_TO_INT.get(char);
    if (digit === undefined)
      return values;
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value >>= 1;
    values.push(negative ? -value : value);
    shift = 0;
    value = 0;
  }
  return values;
}
function encodeVlq(value) {
  let encoded = "";
  let remaining = value < 0 ? -value << 1 | 1 : value << 1;
  do {
    let digit = remaining & 31;
    remaining >>>= 5;
    if (remaining > 0)
      digit |= 32;
    encoded += BASE64[digit];
  } while (remaining > 0);
  return encoded;
}
function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  for (const group of mappings.split(";")) {
    const segments = [];
    let generatedColumn = 0;
    for (const raw of group.split(",")) {
      if (raw === "")
        continue;
      const values = decodeVlq(raw);
      if (values.length === 0)
        continue;
      generatedColumn += values[0];
      const segment = { generatedColumn };
      if (values.length >= 4) {
        source += values[1];
        sourceLine += values[2];
        sourceColumn += values[3];
        segment.source = source;
        segment.sourceLine = sourceLine;
        segment.sourceColumn = sourceColumn;
      }
      if (values.length >= 5) {
        name += values[4];
        segment.name = name;
      }
      segments.push(segment);
    }
    lines.push(segments);
  }
  return lines;
}
function encodeMappings(lines) {
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  return lines.map((segments) => {
    let generatedColumn = 0;
    return segments.map((segment) => {
      let encoded = encodeVlq(segment.generatedColumn - generatedColumn);
      generatedColumn = segment.generatedColumn;
      if (segment.source === undefined)
        return encoded;
      encoded += encodeVlq(segment.source - source);
      encoded += encodeVlq(segment.sourceLine - sourceLine);
      encoded += encodeVlq(segment.sourceColumn - sourceColumn);
      source = segment.source;
      sourceLine = segment.sourceLine;
      sourceColumn = segment.sourceColumn;
      if (segment.name === undefined)
        return encoded;
      encoded += encodeVlq(segment.name - name);
      name = segment.name;
      return encoded;
    }).join(",");
  }).join(";");
}
function remapSourceMap(sourceMap, lineMap) {
  let parsed;
  try {
    parsed = JSON.parse(sourceMap);
  } catch {
    return sourceMap;
  }
  if (typeof parsed.mappings !== "string")
    return sourceMap;
  const original = decodeMappings(parsed.mappings);
  const remapped = lineMap.map((line) => line === -1 ? [] : original[line] ?? []);
  return JSON.stringify({ ...parsed, mappings: encodeMappings(remapped) });
}

// src/index.ts
var PLUGIN_NAME = "@gwigz/tstl-bundle-flatten";
function resolveGlobals2(config) {
  const globals = [];
  const values = { ...config.globals, ...config.injectGlobals };
  for (const [identifier, value] of Object.entries(values)) {
    globals.push(isGlobalValueConfig(value) ? { identifier, ...globalFields(value) } : { identifier, value });
  }
  for (const spec of config.injectGlobalValues ?? []) {
    globals.push({ identifier: spec.identifier, ...globalFields(spec) });
  }
  return globals;
}
function isGlobalValueConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  return "value" in value || "env" in value || "envJson" in value || "env_json" in value || "defaultValue" in value || "default_value" in value;
}
function globalFields(spec) {
  const envJson = spec.envJson ?? spec.env_json;
  const defaultValue = spec.defaultValue ?? spec.default_value;
  return {
    ...spec.value === undefined ? {} : { value: spec.value },
    ...spec.env === undefined ? {} : { env: spec.env },
    ...envJson === undefined ? {} : { envJson },
    ...defaultValue === undefined ? {} : { defaultValue }
  };
}
function resolveConfig(config) {
  const classFunctions = config.shakeClassFunctions ?? config.shakeClasses ?? config.classFunctions ?? config.removeClassFunctions ?? config.shakeClassMembers ?? false;
  const shake = config.shake ?? false;
  const globals = resolveGlobals2(config);
  const computeExpressions = config.computeExpressions ?? config.computeExpression ?? (shake || globals.length > 0);
  return {
    skipModules: config.skipModules ?? [],
    format: config.format ?? true,
    shake,
    shakeClassFunctions: classFunctions === true,
    computeExpressions: computeExpressions === true,
    globals,
    scopeModules: config.scopeModules ?? true,
    registerBudget: config.registerBudget ?? DEFAULT_REGISTER_BUDGET,
    registerLimit: config.registerLimit ?? LUAU_REGISTER_LIMIT,
    registerReport: config.registerReport ?? "warn",
    rootGlobals: config.rootGlobals ?? []
  };
}
function transformLines(code, {
  skipModules = [],
  format = true,
  scopeModules,
  registerBudget,
  registerLimit,
  rootGlobals,
  onUsage
} = {}) {
  const original = splitLines(code);
  const { lines: flattened, usage } = flattenWithUsage(original, {
    skipModules,
    scopeModules,
    registerBudget,
    registerLimit,
    rootGlobals
  });
  let lines = flattened === original ? original : [...flattened, inserted("")];
  if (format) {
    lines = formatLines(lines);
  }
  if (usage !== null && onUsage !== undefined)
    onUsage(usage);
  return lines;
}
function createPlugin(config = {}) {
  const resolved = resolveConfig(config);
  return {
    beforeTransform(program) {
      if (resolved.computeExpressions || resolved.globals.length > 0) {
        foldProgram(program, {
          globals: resolved.globals,
          computeExpressions: resolved.computeExpressions
        });
      }
      if (!resolved.shake)
        return;
      shakeProgram(program, { shakeClassFunctions: resolved.shakeClassFunctions });
    },
    afterEmit(_program, options, emitHost, result) {
      const pluginConfig = options.luaPlugins?.find((plugin) => ("name" in plugin) && plugin.name === PLUGIN_NAME);
      const transform = pluginConfig ? {
        skipModules: pluginConfig.skipModules ?? resolved.skipModules,
        format: pluginConfig.format ?? resolved.format,
        scopeModules: pluginConfig.scopeModules ?? resolved.scopeModules,
        registerBudget: pluginConfig.registerBudget ?? resolved.registerBudget,
        registerLimit: pluginConfig.registerLimit ?? resolved.registerLimit,
        registerReport: pluginConfig.registerReport ?? resolved.registerReport,
        rootGlobals: pluginConfig.rootGlobals ?? resolved.rootGlobals
      } : resolved;
      for (const file of result) {
        const lines = transformLines(file.code, {
          ...transform,
          onUsage: (usage) => {
            if (transform.registerReport === "off")
              return;
            const message = formatRegisterReport(usage);
            if (message !== null)
              console.warn(message);
          }
        });
        file.code = render(lines);
        emitHost.writeFile(file.outputPath, file.code, false);
        if (options.sourceMap && file.sourceMap !== undefined) {
          file.sourceMap = remapSourceMap(file.sourceMap, lineMap(lines));
          emitHost.writeFile(`${file.outputPath}.map`, file.sourceMap, false);
        }
      }
    }
  };
}
var plugin = Object.assign(createPlugin, { afterEmit: createPlugin().afterEmit });
var src_default = plugin;
