import * as ts from "typescript";

/** Value that can be injected into the program and folded at compile time. */
export type StaticValue = boolean | number | string | bigint | null | undefined;

/** Configuration for one compile-time global, matching darklua's rule shape. */
export interface InjectGlobalValue {
  identifier: string;
  value?: unknown;
  env?: string;
  envJson?: string;
  defaultValue?: unknown;
}

export interface FoldOptions {
  globals: InjectGlobalValue[];
  computeExpressions: boolean;
}

interface StaticEvaluation {
  value: StaticValue;
}

/**
 * Replaces configured globals and folds static expressions before TSTL emits.
 *
 * This is the TypeScript-side equivalent of darklua's `inject_global_value`
 * and `compute_expression` rules. Folding happens before tree shaking, so a
 * branch such as `if (DEBUG) new DebugMenu()` disappears before liveness is
 * calculated and the classes it used can be removed as well.
 */
export function foldProgram(program: ts.Program, options: FoldOptions): void {
  const globals = resolveGlobals(options.globals);

  if (globals.size === 0 && !options.computeExpressions) return;

  const checker = program.getTypeChecker();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    const result = ts.transform(sourceFile, [
      (context) => {
        const visitor: ts.Visitor = (node) => {
          // Type references are not runtime values. Never inject into them.
          if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return node;

          if (ts.isIdentifier(node) && globals.has(node.text) && isGlobalReference(node, checker)) {
            const literal = literalFor(globals.get(node.text));

            if (literal !== undefined) return ts.setOriginalNode(literal, node);
          }

          const visited = ts.visitEachChild(node, visitor, context);

          if (!options.computeExpressions) return visited;

          if (ts.isIfStatement(visited)) return simplifyIf(visited);
          if (ts.isWhileStatement(visited)) return simplifyWhile(visited);
          if (ts.isDoStatement(visited)) return simplifyDo(visited);
          if (ts.isExpressionStatement(visited)) return simplifyExpressionStatement(visited);

          if (ts.isExpression(visited)) return simplifyExpression(visited);

          return visited;
        };

        return (node: ts.SourceFile) => (ts.visitNode(node, visitor) as ts.SourceFile | undefined) ?? node;
      },
    ]);

    const transformed = result.transformed[0];

    // TSTL reads the program's source file and the type checker still has to
    // resolve symbols while emitting. Rebuilding declarations through the
    // factory would detach them from the binder, so graft the folded children
    // back onto the original nodes instead of replacing those nodes.
    const statements = transformed.statements.map((statement) => graft(statement) as ts.Statement);

    (sourceFile as { statements: ts.NodeArray<ts.Statement> }).statements = ts.factory.createNodeArray(statements);

    for (const statement of statements) setParent(statement, sourceFile);

    result.dispose();
  }
}

/** Node properties that are bookkeeping, not children. */
const GRAFT_SKIP = new Set([
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
  "nextContainer",
]);

/**
 * Applies the folded tree to the original nodes, keeping every node the binder
 * knows. Factory updates record their source node in `original`, so the updated
 * node supplies the new children while the original node keeps its identity.
 */
function graft(updated: ts.Node): ts.Node {
  const original = ts.getOriginalNode(updated);

  // A brand-new node, or a replacement of a different kind (for example an
  // identifier replaced by a literal), is used as-is.
  if (original === updated || original.kind !== updated.kind) return updated;

  const target = original as unknown as Record<string, unknown>;

  for (const key of Object.keys(updated)) {
    if (GRAFT_SKIP.has(key)) continue;

    const value = (updated as unknown as Record<string, unknown>)[key];

    if (isNodeLike(value)) {
      target[key] = graft(value);
    } else if (Array.isArray(value) && value.every(isNodeLike)) {
      target[key] = ts.factory.createNodeArray(value.map((child) => graft(child)));
    }
  }

  return original;
}

function isNodeLike(value: unknown): value is ts.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "number" &&
    typeof (value as { flags?: unknown }).flags === "number"
  );
}

/**
 * Restores the parent links that `ts.transform` drops on new nodes.
 *
 * Existing nodes keep their parse-tree parents: the type checker still resolves
 * symbols through them. Only nodes created by the factory need a new parent.
 */
function setParent(node: ts.Node, parent: ts.Node): void {
  if ((node as { parent?: ts.Node }).parent === undefined) {
    (node as { parent?: ts.Node }).parent = parent;
  }

  ts.forEachChild(node, (child) => setParent(child, node));
}

// ---------------------------------------------------------------------------
// Global values
// ---------------------------------------------------------------------------

function resolveGlobals(specs: InjectGlobalValue[]): Map<string, StaticValue> {
  const globals = new Map<string, StaticValue>();

  for (const spec of specs) {
    const value = resolveGlobalValue(spec);

    if (!isStaticValue(value)) {
      throw new Error(
        `tstl-bundle-flatten: global "${spec.identifier}" must be a boolean, number, string, bigint, null, or undefined`,
      );
    }

    globals.set(spec.identifier, value);
  }

  return globals;
}

function resolveGlobalValue(spec: InjectGlobalValue): unknown {
  if (hasOwn(spec, "value")) return spec.value;

  if (spec.envJson !== undefined) {
    const raw = process.env[spec.envJson];

    if (raw === undefined) return spec.defaultValue;

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(
        `tstl-bundle-flatten: environment variable "${spec.envJson}" for global "${spec.identifier}" is not valid JSON`,
      );
    }
  }

  if (spec.env !== undefined) {
    const raw = process.env[spec.env];

    return raw === undefined ? spec.defaultValue : parseEnvironmentValue(raw);
  }

  return spec.defaultValue;
}

/**
 * `env` keeps darklua's simple string form, but parses the common scalar
 * spellings so `DEBUG=false` can drive a boolean condition.
 */
function parseEnvironmentValue(raw: string): StaticValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw === "undefined") return undefined;

  if (raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);

  return raw;
}

function isStaticValue(value: unknown): value is StaticValue {
  return (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  );
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// ---------------------------------------------------------------------------
// Global resolution
// ---------------------------------------------------------------------------

function isGlobalReference(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent;

  if (parent !== undefined && isNonReferenceName(node, parent)) return false;

  let symbol: ts.Symbol | undefined;

  try {
    symbol = checker.getSymbolAtLocation(node);
  } catch {
    return true;
  }

  if (symbol === undefined) return true;

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return true;
    }
  }

  const declarations = symbol.declarations ?? [];

  if (declarations.length === 0) return true;

  // A global is declared in an ambient file. A local binding or module import
  // lives in a normal source file and must shadow the configured name.
  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function isNonReferenceName(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return true;

  if (
    (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) &&
    (parent.name === node || parent.propertyName === node)
  ) {
    return true;
  }

  if (ts.isImportClause(parent) && parent.name === node) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Statement and expression folding
// ---------------------------------------------------------------------------

function simplifyIf(node: ts.IfStatement): ts.VisitResult<ts.Statement | undefined> {
  const condition = evaluateStatic(node.expression);

  if (condition === undefined) return node;

  return truthy(condition.value) ? node.thenStatement : node.elseStatement;
}

function simplifyWhile(node: ts.WhileStatement): ts.VisitResult<ts.Statement | undefined> {
  const condition = evaluateStatic(node.expression);

  if (condition !== undefined && !truthy(condition.value)) return undefined;

  return node;
}

function simplifyDo(node: ts.DoStatement): ts.VisitResult<ts.Statement | undefined> {
  const condition = evaluateStatic(node.expression);

  if (condition !== undefined && !truthy(condition.value)) return node.statement;

  return node;
}

function simplifyExpressionStatement(node: ts.ExpressionStatement): ts.VisitResult<ts.Statement | undefined> {
  // Keep directives like "use strict".
  if (ts.isStringLiteralLike(node.expression)) return node;

  if (evaluateStatic(node.expression) !== undefined) return undefined;

  return node;
}

function simplifyExpression(expression: ts.Expression): ts.Expression {
  // Literals already are their own folded form; replacing them would rebuild
  // their parents and discard text ranges for no benefit.
  if (isLiteralExpression(expression)) return expression;

  const staticResult = evaluateStatic(expression);

  if (staticResult !== undefined) return replaceWithLiteral(staticResult.value, expression);

  if (ts.isConditionalExpression(expression)) {
    const condition = evaluateStatic(expression.condition);

    if (condition !== undefined) return condition.value ? expression.whenTrue : expression.whenFalse;
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
          return left.value === null || left.value === undefined
            ? expression.right
            : replaceWithLiteral(left.value, expression);
      }
    }
  }

  return expression;
}

function replaceWithLiteral(value: StaticValue, original: ts.Node): ts.Expression {
  const literal = literalFor(value);

  return literal === undefined ? (original as ts.Expression) : ts.setOriginalNode(literal, original);
}

/** True when the expression already is the literal form we would produce. */
function isLiteralExpression(expression: ts.Expression): boolean {
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

function literalFor(value: StaticValue): ts.Expression | undefined {
  if (value === undefined) return ts.factory.createVoidZero();
  if (value === null) return ts.factory.createNull();
  if (typeof value === "boolean") return value ? ts.factory.createTrue() : ts.factory.createFalse();
  if (typeof value === "string") return ts.factory.createStringLiteral(value);
  if (typeof value === "bigint") return ts.factory.createBigIntLiteral(`${value}n`);

  if (!Number.isFinite(value)) return undefined;

  if (value < 0 || Object.is(value, -0)) {
    return ts.factory.createPrefixUnaryExpression(
      ts.SyntaxKind.MinusToken,
      ts.factory.createNumericLiteral(Math.abs(value)),
    );
  }

  return ts.factory.createNumericLiteral(value);
}

function evaluateStatic(expression: ts.Expression): StaticEvaluation | undefined {
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { value: expression.text };
  }

  if (ts.isNumericLiteral(expression)) return { value: Number(expression.text) };
  if (ts.isBigIntLiteral(expression)) return { value: BigInt(expression.text.slice(0, -1)) };

  switch (expression.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return { value: true };
    case ts.SyntaxKind.FalseKeyword:
      return { value: false };
    case ts.SyntaxKind.NullKeyword:
      return { value: null };
  }

  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return evaluateStatic(expression.expression);
  }

  if (ts.isPrefixUnaryExpression(expression)) return evaluatePrefix(expression);
  if (ts.isTypeOfExpression(expression)) return evaluateTypeOf(expression);
  if (ts.isVoidExpression(expression)) return evaluateVoid(expression);
  if (ts.isBinaryExpression(expression)) return evaluateBinary(expression);
  if (ts.isConditionalExpression(expression)) return evaluateConditional(expression);

  return undefined;
}

function evaluatePrefix(node: ts.PrefixUnaryExpression): StaticEvaluation | undefined {
  const operand = evaluateStatic(node.operand);

  if (operand === undefined) return undefined;

  switch (node.operator) {
    case ts.SyntaxKind.ExclamationToken:
      return { value: !truthy(operand.value) };

    case ts.SyntaxKind.PlusToken:
      return typeof operand.value === "number" ? { value: +operand.value } : undefined;

    case ts.SyntaxKind.MinusToken:
      if (typeof operand.value === "number") return { value: -operand.value };
      if (typeof operand.value === "bigint") return { value: -operand.value };
      return undefined;

    case ts.SyntaxKind.TildeToken:
      return typeof operand.value === "number" ? { value: ~operand.value } : undefined;

    default:
      return undefined;
  }
}

function evaluateTypeOf(node: ts.TypeOfExpression): StaticEvaluation | undefined {
  const operand = evaluateStatic(node.expression);

  return operand === undefined ? undefined : { value: typeof operand.value };
}

function evaluateVoid(node: ts.VoidExpression): StaticEvaluation | undefined {
  return evaluateStatic(node.expression) === undefined ? undefined : { value: undefined };
}

function evaluateConditional(node: ts.ConditionalExpression): StaticEvaluation | undefined {
  const condition = evaluateStatic(node.condition);

  if (condition === undefined) return undefined;

  return evaluateStatic(truthy(condition.value) ? node.whenTrue : node.whenFalse);
}

function evaluateBinary(node: ts.BinaryExpression): StaticEvaluation | undefined {
  const operator = node.operatorToken.kind;
  const left = evaluateStatic(node.left);

  if (left === undefined) return undefined;

  switch (operator) {
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return truthy(left.value) ? evaluateStatic(node.right) : left;

    case ts.SyntaxKind.BarBarToken:
      return truthy(left.value) ? left : evaluateStatic(node.right);

    case ts.SyntaxKind.QuestionQuestionToken:
      return left.value === null || left.value === undefined ? evaluateStatic(node.right) : left;
  }

  const right = evaluateStatic(node.right);

  if (right === undefined) return undefined;

  return evaluateBinaryValues(operator, left.value, right.value);
}

function evaluateBinaryValues(
  operator: ts.SyntaxKind,
  left: StaticValue,
  right: StaticValue,
): StaticEvaluation | undefined {
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
      if (typeof left === "number" && typeof right === "number") return { value: left + right };
      if (typeof left === "string" && typeof right === "string") return { value: left + right };
      return undefined;
  }

  if (typeof left !== "number" || typeof right !== "number") return undefined;

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
      return undefined;
  }
}

function compare(
  left: StaticValue,
  right: StaticValue,
  comparator: (left: number | string, right: number | string) => boolean,
): StaticEvaluation | undefined {
  if (typeof left === "number" && typeof right === "number") return { value: comparator(left, right) };
  if (typeof left === "string" && typeof right === "string") return { value: comparator(left, right) };

  return undefined;
}

function truthy(value: StaticValue): boolean {
  return Boolean(value);
}
