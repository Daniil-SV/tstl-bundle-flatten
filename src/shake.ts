import * as ts from "typescript";

/**
 * TypeScript-AST tree shaking.
 *
 * TSTL emits straight from the program's source files, so removing code here
 * means the Lua is generated already stripped: no second parser, no edits to
 * emitted text.
 *
 * The pass builds one program-wide liveness graph. Declarations are graph
 * nodes; references are edges. Everything that runs unconditionally is a root
 * (top-level statements and side-effectful initializers). A declaration is kept
 * when it is reachable from a root, so a function only used by an already-dead
 * function disappears too.
 *
 * Removal is conservative: a declaration with a side-effectful initializer is
 * kept (or converted to an expression statement by the local pass), and a class
 * with a static initializer is kept even if nothing references it.
 */

export interface ShakeOptions {
  /** Also remove unused class methods and accessors. */
  shakeClassFunctions?: boolean;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

type ClassLike = ts.ClassDeclaration | ts.ClassExpression;

interface Unit {
  /** Declaration node the unit removes when it is dead. */
  node: ts.Node;
  /** Class that has to survive whenever a member unit survives. */
  owner?: ClassLike;
  /** Accessors share a name, so they live and die together. */
  siblings?: ts.Node[];
}

interface Context {
  checker: ts.TypeChecker;
  units: Map<ts.Node, Unit>;
  /** Units keyed by the parse-tree node they were originally created from. */
  origins: Map<ts.Node, Unit>;
  /** Import bindings referenced from live code, used to prune dead imports. */
  usedSymbols: Set<ts.Symbol>;
  /**
   * `export default name` is an alias to the symbol `name`, not a declaration
   * of its own, so marking the symbol live does not reach the export line. This
   * maps the aliased symbol back to the export assignments that publish it.
   */
  defaultExports: Map<ts.Symbol, ts.Node[]>;
  live: Set<ts.Node>;
  queue: ts.Node[];
  shakeClassFunctions: boolean;
}

/** Entry point used by the plugin's `beforeTransform` hook. */
export function shakeProgram(program: ts.Program, options: ShakeOptions = {}): void {
  const context: Context = {
    checker: program.getTypeChecker(),
    units: new Map(),
    origins: new Map(),
    usedSymbols: new Set(),
    defaultExports: new Map(),
    live: new Set(),
    queue: [],
    shakeClassFunctions: options.shakeClassFunctions === true,
  };

  const sourceFiles = program.getSourceFiles().filter((file) => !file.isDeclarationFile);

  for (const file of sourceFiles) collectFile(file, context);

  for (const file of sourceFiles) {
    for (const statement of file.statements) visitCode(statement, context, false);
  }

  drain(context);

  for (const file of sourceFiles) rewriteNode(file, context);
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function collectFile(file: ts.SourceFile, context: Context): void {
  file.forEachChild((node) => collectNode(node, context));
}

function collectNode(node: ts.Node, context: Context): void {
  // Namespaces are kept whole: their bodies are emitted as statements and
  // TSTL has no simple way to remove individual declarations from them.
  if (ts.isModuleDeclaration(node)) return;

  if (isAmbient(node)) return;

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      addUnit(declaration, context);
    }
  } else if (ts.isFunctionDeclaration(node)) {
    addUnit(node, context);
  } else if (ts.isClassDeclaration(node)) {
    addUnit(node, context);
    collectClassMembers(node, context);
  } else if (ts.isEnumDeclaration(node)) {
    addUnit(node, context);
  } else if (ts.isExportAssignment(node)) {
    addUnit(node, context);
    recordDefaultExport(node, context);
  }

  node.forEachChild((child) => collectNode(child, context));
}

/**
 * Remembers which symbol an identifier-style `export default name` publishes.
 * The checker resolves the default export to `name` itself, so only the import
 * side knows the export line has to survive as well.
 */
function recordDefaultExport(node: ts.ExportAssignment, context: Context): void {
  if (!ts.isIdentifier(node.expression)) return;

  const symbol = context.checker.getSymbolAtLocation(node.expression);
  if (!symbol) return;

  const resolved = resolveSymbol(symbol, context) ?? symbol;
  const exports = context.defaultExports.get(resolved) ?? [];

  exports.push(node);
  context.defaultExports.set(resolved, exports);
}

function collectClassMembers(node: ts.ClassDeclaration, context: Context): void {
  if (!context.shakeClassFunctions) return;

  const accessors = new Map<string, ts.Node[]>();

  for (const member of node.members) {
    if (!isClassFunction(member)) continue;

    // Members with computed property names (e.g. [Symbol.iterator]) cannot be
    // statically resolved — they may be called implicitly through language
    // protocols (iteration, coercion, etc.) — so never track them for removal.
    if (ts.isComputedPropertyName(member.name)) continue;

    const unit = addUnit(member, context);
    unit.owner = node;

    if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
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
    if (group.length < 2) continue;

    for (const member of group) {
      const unit = unitOf(member, context);
      if (unit) unit.siblings = group.filter((other) => other !== member);
    }
  }
}

function addUnit(node: ts.Node, context: Context): Unit {
  const existing = unitOf(node, context);
  if (existing) return existing;

  const unit: Unit = { node };
  context.units.set(node, unit);
  context.origins.set(ts.getOriginalNode(node), unit);
  return unit;
}

/**
 * Folding rebuilds declarations through the factory, so the checker still
 * reports the parse-tree node for a symbol. Resolve through the original-node
 * chain to find the unit that was registered for the rebuilt declaration.
 */
function unitOf(node: ts.Node, context: Context): Unit | undefined {
  return context.units.get(node) ?? context.origins.get(ts.getOriginalNode(node));
}

function isClassFunction(node: ts.ClassElement): node is ts.MethodDeclaration | ts.AccessorDeclaration {
  return (
    (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
    !ts.isConstructorDeclaration(node)
  );
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

function markLive(node: ts.Node | undefined, context: Context): void {
  if (!node) return;

  const unit = unitOf(node, context);
  if (!unit || context.live.has(unit.node)) return;

  context.live.add(unit.node);
  context.queue.push(unit.node);

  if (unit.owner) markLive(unit.owner, context);
  for (const sibling of unit.siblings ?? []) markLive(sibling, context);
}

function drain(context: Context): void {
  while (context.queue.length > 0) {
    const node = context.queue.pop() as ts.Node;
    const unit = unitOf(node, context);
    if (!unit) continue;

    if (ts.isVariableDeclaration(node)) {
      visitBindingName(node.name, context);
      if (node.initializer) visitCode(node.initializer, context, false);
    } else if (ts.isFunctionDeclaration(node)) {
      visitFunctionLike(node, context);
    } else if (ts.isClassDeclaration(node)) {
      visitClass(node, context);
    } else if (ts.isEnumDeclaration(node)) {
      visitEnum(node, context);
    } else if (ts.isExportAssignment(node)) {
      visitCode(node.expression, context, false);
    } else if (isClassFunction(node as ts.ClassElement)) {
      visitFunctionLike(node as FunctionLike, context);
    }
  }
}

function resolveSymbol(symbol: ts.Symbol | undefined, context: Context): ts.Symbol | undefined {
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;

  try {
    return context.checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function markSymbol(node: ts.Node, context: Context): void {
  const symbol = context.checker.getSymbolAtLocation(node);
  if (!symbol) return;

  context.usedSymbols.add(symbol);

  const resolved = resolveSymbol(symbol, context);
  if (!resolved) return;

  // A default export that aliases a local (`export default Global`) has to be
  // kept when an import reaches the local, or consumers import nothing.
  if (isImportAlias(symbol)) {
    for (const exportNode of context.defaultExports.get(resolved) ?? []) markLive(exportNode, context);
  }

  for (const declaration of resolved.declarations ?? []) markLive(declaration, context);
}

function isImportAlias(symbol: ts.Symbol): boolean {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return false;

  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportEqualsDeclaration(declaration),
  );
}

function markProperty(node: ts.Node, context: Context): void {
  const symbol = resolveSymbol(context.checker.getSymbolAtLocation(node), context);
  if (!symbol) return;

  for (const declaration of symbol.declarations ?? []) markLive(declaration, context);
}

/**
 * Walks code that will actually run. Declarations are not entered unless they
 * are live (or `all` is set, for namespace bodies which are never pruned).
 */
function visitCode(node: ts.Node, context: Context, all: boolean): void {
  if (ts.isIdentifier(node)) {
    markSymbol(node, context);
    return;
  }

  if (ts.isPrivateIdentifier(node)) {
    markProperty(node, context);
    return;
  }

  if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return;

  if (ts.isPropertyAccessExpression(node)) {
    visitCode(node.expression, context, all);
    markProperty(node.name, context);
    return;
  }

  if (ts.isPropertyAssignment(node)) {
    visitPropertyName(node.name, context);
    visitCode(node.initializer, context, all);
    return;
  }

  if (ts.isShorthandPropertyAssignment(node)) {
    markSymbol(node.name, context);
    if (node.objectAssignmentInitializer) visitCode(node.objectAssignmentInitializer, context, all);
    return;
  }

  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    visitPropertyName(node.name, context);
    visitFunctionLike(node, context);
    return;
  }

  if (ts.isVariableStatement(node)) {
    visitVariableStatement(node, context, all);
    return;
  }

  if (ts.isFunctionDeclaration(node)) {
    if (all) visitFunctionLike(node, context);
    return;
  }

  if (ts.isClassDeclaration(node)) {
    if (all) {
      visitClassLikeAll(node, context);
    } else if (classHasSideEffects(node, context)) {
      markLive(node, context);
    }
    return;
  }

  if (ts.isClassExpression(node)) {
    visitClassLikeAll(node, context);
    return;
  }

  if (ts.isEnumDeclaration(node)) {
    if (all) {
      visitEnum(node, context);
    } else if (enumHasSideEffects(node, context)) {
      markLive(node, context);
    }
    return;
  }

  if (ts.isModuleDeclaration(node)) {
    visitModule(node, context);
    return;
  }

  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;

  if (ts.isExportAssignment(node)) {
    // A default export is only code when something imports it. If the
    // expression itself has side effects it still has to run.
    if (all || expressionHasSideEffects(node.expression, context)) {
      visitCode(node.expression, context, all);
    }
    return;
  }

  if (ts.isModuleBlock(node)) {
    for (const statement of node.statements) visitCode(statement, context, true);
    return;
  }

  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
    return;
  }

  if (ts.isParameter(node)) {
    visitParameter(node, context);
    return;
  }

  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isConstructorDeclaration(node)) {
    visitFunctionLike(node, context);
    return;
  }

  if (ts.isClassStaticBlockDeclaration(node)) {
    visitCode(node.body, context, all);
    return;
  }

  if (ts.isSourceFile(node) || ts.isBlock(node)) {
    for (const statement of node.statements) visitCode(statement, context, all);
    return;
  }

  if (ts.isCaseBlock(node)) {
    for (const clause of node.clauses) visitCode(clause, context, all);
    return;
  }

  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    for (const statement of node.statements) visitCode(statement, context, all);
    return;
  }

  node.forEachChild((child) => visitCode(child, context, all));
}

function visitVariableStatement(node: ts.VariableStatement, context: Context, all: boolean): void {
  for (const declaration of node.declarationList.declarations) {
    if (all) {
      visitBindingName(declaration.name, context);
      if (declaration.initializer) visitCode(declaration.initializer, context, true);
      continue;
    }

    // Destructuring defaults and computed keys run even when every binding is
    // unused, so keep the declaration instead of dropping those effects.
    if (bindingHasSideEffects(declaration.name, context)) markLive(declaration, context);

    if (declaration.initializer && expressionHasSideEffects(declaration.initializer, context)) {
      visitCode(declaration.initializer, context, false);
    }
  }
}

function visitBindingName(name: ts.BindingName, context: Context): void {
  if (ts.isIdentifier(name)) return;

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;

    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
      visitCode(element.propertyName.expression, context, false);
    }

    visitBindingName(element.name, context);
    if (element.initializer) visitCode(element.initializer, context, false);
  }
}

function visitFunctionLike(node: FunctionLike, context: Context): void {
  for (const modifier of modifierNodes(node)) visitDecorator(modifier, context);

  for (const parameter of node.parameters) visitParameter(parameter, context);

  if (node.body) visitCode(node.body, context, false);
}

function visitParameter(node: ts.ParameterDeclaration, context: Context): void {
  for (const modifier of modifierNodes(node)) visitDecorator(modifier, context);

  visitBindingName(node.name, context);
  if (node.initializer) visitCode(node.initializer, context, false);
}

function visitPropertyName(name: ts.PropertyName, context: Context): void {
  if (ts.isComputedPropertyName(name)) visitCode(name.expression, context, false);
}

function visitClass(node: ts.ClassDeclaration, context: Context): void {
  visitClassLikeAll(node, context, true);
}

function visitClassLikeAll(node: ClassLike, context: Context, onlyLiveMembers = false): void {
  for (const modifier of modifierNodes(node)) visitDecorator(modifier, context);

  for (const clause of node.heritageClauses ?? []) {
    for (const type of clause.types) visitCode(type.expression, context, false);
  }

  for (const member of node.members) {
    for (const modifier of modifierNodes(member)) visitDecorator(modifier, context);

    if (ts.isConstructorDeclaration(member)) {
      visitFunctionLike(member, context);
      continue;
    }

    if (isClassFunction(member)) {
      visitPropertyName(member.name, context);

      if (!onlyLiveMembers || !context.shakeClassFunctions || ts.isComputedPropertyName(member.name)) {
        visitFunctionLike(member, context);
      } else if (hasDecorators(member)) {
        markLive(member, context);
      }
      continue;
    }

    if (ts.isPropertyDeclaration(member)) {
      visitPropertyName(member.name, context);
      if (member.initializer) visitCode(member.initializer, context, false);
      continue;
    }

    if (ts.isClassStaticBlockDeclaration(member)) {
      visitCode(member.body, context, false);
      continue;
    }

    if (ts.isIndexSignatureDeclaration(member)) continue;
  }
}

function visitEnum(node: ts.EnumDeclaration, context: Context): void {
  for (const modifier of modifierNodes(node)) visitDecorator(modifier, context);

  for (const member of node.members) {
    visitPropertyName(member.name, context);
    if (member.initializer) visitCode(member.initializer, context, false);
  }
}

function visitModule(node: ts.ModuleDeclaration, context: Context): void {
  if (node.body) visitCode(node.body, context, true);
}

function visitDecorator(modifier: ts.ModifierLike, context: Context): void {
  if (ts.isDecorator(modifier)) visitCode(modifier.expression, context, false);
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

function expressionHasSideEffects(
  expression: ts.Expression | undefined,
  context: Context,
  seen: Set<ts.Node> = new Set(),
): boolean {
  if (!expression) return false;

  switch (expression.kind) {
    case ts.SyntaxKind.NewExpression:
      return newExpressionHasSideEffects(expression as ts.NewExpression, context, seen);

    case ts.SyntaxKind.CallExpression:
    case ts.SyntaxKind.TaggedTemplateExpression:
    case ts.SyntaxKind.AwaitExpression:
    case ts.SyntaxKind.YieldExpression:
    case ts.SyntaxKind.DeleteExpression:
    case ts.SyntaxKind.PostfixUnaryExpression:
      return true;

    case ts.SyntaxKind.PrefixUnaryExpression: {
      const node = expression as ts.PrefixUnaryExpression;
      return (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken ||
        expressionHasSideEffects(node.operand, context, seen)
      );
    }

    case ts.SyntaxKind.BinaryExpression: {
      const node = expression as ts.BinaryExpression;
      const operator = node.operatorToken.kind;

      // Assignments are effects even when both operands are plain reads.
      if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
        return true;
      }

      return expressionHasSideEffects(node.left, context, seen) || expressionHasSideEffects(node.right, context, seen);
    }

    case ts.SyntaxKind.ConditionalExpression: {
      const node = expression as ts.ConditionalExpression;
      return (
        expressionHasSideEffects(node.condition, context, seen) ||
        expressionHasSideEffects(node.whenTrue, context, seen) ||
        expressionHasSideEffects(node.whenFalse, context, seen)
      );
    }

    case ts.SyntaxKind.PropertyAccessExpression:
      return expressionHasSideEffects((expression as ts.PropertyAccessExpression).expression, context, seen);

    case ts.SyntaxKind.ElementAccessExpression: {
      const node = expression as ts.ElementAccessExpression;
      return (
        expressionHasSideEffects(node.expression, context, seen) ||
        expressionHasSideEffects(node.argumentExpression, context, seen)
      );
    }

    case ts.SyntaxKind.ParenthesizedExpression:
      return expressionHasSideEffects((expression as ts.ParenthesizedExpression).expression, context, seen);

    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.SatisfiesExpression:
    case ts.SyntaxKind.NonNullExpression:
    case ts.SyntaxKind.TypeAssertionExpression:
      return expressionHasSideEffects((expression as ts.AssertionExpression).expression, context, seen);

    case ts.SyntaxKind.ArrayLiteralExpression:
      return (expression as ts.ArrayLiteralExpression).elements.some((element) =>
        expressionHasSideEffects(ts.isSpreadElement(element) ? element.expression : element, context, seen),
      );

    case ts.SyntaxKind.ObjectLiteralExpression:
      return (expression as ts.ObjectLiteralExpression).properties.some((member) =>
        objectMemberHasSideEffects(member, context, seen),
      );

    case ts.SyntaxKind.TemplateExpression:
      return (expression as ts.TemplateExpression).templateSpans.some((span) =>
        expressionHasSideEffects(span.expression, context, seen),
      );

    case ts.SyntaxKind.SpreadElement:
      return expressionHasSideEffects((expression as ts.SpreadElement).expression, context, seen);

    case ts.SyntaxKind.VoidExpression:
    case ts.SyntaxKind.TypeOfExpression:
      return expressionHasSideEffects((expression as ts.VoidExpression).expression, context, seen);

    case ts.SyntaxKind.ClassExpression:
      return classHasSideEffects(expression as ts.ClassExpression, context, seen);

    case ts.SyntaxKind.CommaListExpression:
      return (expression as ts.CommaListExpression).elements.some((element) =>
        expressionHasSideEffects(element, context, seen),
      );

    default:
      return false;
  }
}

/**
 * `new C()` has no effect when `C` is a class in this program whose
 * construction only assigns fields. That lets the shaker drop module-level
 * helpers like `const defaultParser = new Parser()` when they are unused,
 * instead of keeping the whole class alive for an allocation nobody observes.
 */
function newExpressionHasSideEffects(node: ts.NewExpression, context: Context, seen: Set<ts.Node>): boolean {
  if (expressionHasSideEffects(node.expression, context, seen)) return true;

  for (const argument of node.arguments ?? []) {
    if (expressionHasSideEffects(ts.isSpreadElement(argument) ? argument.expression : argument, context, seen)) {
      return true;
    }
  }

  const declaration = resolveClassDeclaration(node.expression, context);

  return declaration === undefined || !isPureClassConstruction(declaration, context, seen);
}

function resolveClassDeclaration(expression: ts.Expression, context: Context): ts.ClassDeclaration | undefined {
  if (!ts.isIdentifier(expression)) return undefined;

  const symbol = resolveSymbol(context.checker.getSymbolAtLocation(expression), context);
  if (!symbol) return undefined;

  return (symbol.declarations ?? []).find(ts.isClassDeclaration);
}

function isPureClassConstruction(node: ts.ClassDeclaration, context: Context, seen: Set<ts.Node>): boolean {
  if (seen.has(node)) return false;
  if (hasDecorators(node)) return false;

  // A base class constructor may do anything.
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) return false;
  }

  seen.add(node);

  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) {
      if (hasDecorators(member) || !constructorIsPure(member, context, seen)) return false;
      continue;
    }

    // Assigning these fields could hit a setter with side effects.
    if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) return false;

    if (ts.isPropertyDeclaration(member)) {
      if (ts.isComputedPropertyName(member.name)) return false;
      if (member.initializer && expressionHasSideEffects(member.initializer, context, seen)) return false;
      continue;
    }

    if (ts.isClassStaticBlockDeclaration(member)) return false;
    if (ts.isMethodDeclaration(member) || ts.isIndexSignatureDeclaration(member)) continue;

    return false;
  }

  return true;
}

function constructorIsPure(node: ts.ConstructorDeclaration, context: Context, seen: Set<ts.Node>): boolean {
  for (const parameter of node.parameters) {
    if (parameter.initializer && expressionHasSideEffects(parameter.initializer, context, seen)) {
      return false;
    }
  }

  if (!node.body) return true;

  for (const statement of node.body.statements) {
    if (!ts.isExpressionStatement(statement)) return false;

    const expression = statement.expression;

    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(expression.left) ||
      expression.left.expression.kind !== ts.SyntaxKind.ThisKeyword
    ) {
      return false;
    }

    if (expressionHasSideEffects(expression.right, context, seen)) return false;
  }

  return true;
}

function objectMemberHasSideEffects(
  member: ts.ObjectLiteralElementLike,
  context: Context,
  seen: Set<ts.Node>,
): boolean {
  if (ts.isPropertyAssignment(member)) {
    return (
      (ts.isComputedPropertyName(member.name) && expressionHasSideEffects(member.name.expression, context, seen)) ||
      expressionHasSideEffects(member.initializer, context, seen)
    );
  }

  if (ts.isShorthandPropertyAssignment(member)) return false;
  if (ts.isSpreadAssignment(member)) return expressionHasSideEffects(member.expression, context, seen);

  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return ts.isComputedPropertyName(member.name) && expressionHasSideEffects(member.name.expression, context, seen);
  }

  // Methods and accessors are just function objects; creating one has no effect.
  return false;
}

function bindingHasSideEffects(name: ts.BindingName, context: Context): boolean {
  if (ts.isIdentifier(name)) return false;

  return name.elements.some((element) => {
    if (ts.isOmittedExpression(element)) return false;

    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
      if (expressionHasSideEffects(element.propertyName.expression, context)) return true;
    }

    return (
      bindingHasSideEffects(element.name, context) ||
      (element.initializer ? expressionHasSideEffects(element.initializer, context) : false)
    );
  });
}

function classHasSideEffects(node: ClassLike, context: Context, seen: Set<ts.Node> = new Set()): boolean {
  if (hasDecorators(node)) return true;

  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      if (expressionHasSideEffects(type.expression, context, seen)) return true;
    }
  }

  for (const member of node.members) {
    if (hasDecorators(member)) return true;
    if (ts.isClassStaticBlockDeclaration(member)) return true;

    if (ts.isPropertyDeclaration(member) && member.initializer) {
      const isStatic = modifierNodes(member).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (isStatic && expressionHasSideEffects(member.initializer, context, seen)) return true;
    }

    if (
      "name" in member &&
      member.name !== undefined &&
      ts.isComputedPropertyName(member.name) &&
      expressionHasSideEffects(member.name.expression, context, seen)
    ) {
      return true;
    }
  }

  return false;
}

function enumHasSideEffects(node: ts.EnumDeclaration, context: Context): boolean {
  return node.members.some((member) => expressionHasSideEffects(member.initializer, context));
}

function hasDecorators(node: ts.Node): boolean {
  return modifierNodes(node).some(ts.isDecorator);
}

function modifierNodes(node: ts.Node): readonly ts.ModifierLike[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

function rewriteNode(node: ts.Node, context: Context): void {
  // Namespace bodies are left exactly as written.
  if (ts.isModuleDeclaration(node)) return;

  if (ts.isSourceFile(node) || ts.isBlock(node)) {
    rewriteStatementList(node, context);
    return;
  }

  if (ts.isCaseBlock(node)) {
    for (const clause of node.clauses) rewriteNode(clause, context);
    return;
  }

  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    for (const statement of node.statements) rewriteNode(statement, context);
    rewriteStatementList(node, context);
    return;
  }

  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    for (const member of node.members) rewriteNode(member, context);
    if (ts.isClassDeclaration(node)) pruneClassMembers(node, context);
    return;
  }

  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (node.body) rewriteNode(node.body, context);
    return;
  }

  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    if (node.body) rewriteNode(node.body, context);
    return;
  }

  if (ts.isConstructorDeclaration(node)) {
    if (node.body) rewriteNode(node.body, context);
    return;
  }

  if (ts.isClassStaticBlockDeclaration(node)) {
    rewriteNode(node.body, context);
    return;
  }

  node.forEachChild((child) => rewriteNode(child, context));
}

function rewriteStatementList(
  node: ts.SourceFile | ts.Block | ts.CaseClause | ts.DefaultClause,
  context: Context,
): void {
  for (const statement of node.statements) rewriteNode(statement, context);

  const kept: ts.Statement[] = [];

  for (const statement of node.statements) {
    if (isDeadDeclaration(statement, context)) continue;

    if (ts.isVariableStatement(statement)) {
      kept.push(...rewriteVariableStatement(statement, context));
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      const pruned = pruneImportDeclaration(statement, context);
      if (pruned) kept.push(pruned);
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const unit = unitOf(statement, context);

      if (unit && !context.live.has(unit.node)) {
        // The export itself is unused, but evaluating the expression may not be.
        if (expressionHasSideEffects(statement.expression, context)) {
          kept.push(ts.factory.createExpressionStatement(statement.expression));
        }
        continue;
      }

      kept.push(statement);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const pruned = pruneExportDeclaration(statement, context);
      if (pruned) kept.push(pruned);
      continue;
    }

    kept.push(statement);
  }

  const unchanged =
    kept.length === node.statements.length && kept.every((statement, index) => statement === node.statements[index]);

  if (!unchanged) setStatements(node, kept);
}

function isDeadDeclaration(statement: ts.Statement, context: Context): boolean {
  if (!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement) && !ts.isEnumDeclaration(statement)) {
    return false;
  }

  const unit = unitOf(statement, context);
  if (!unit) return false;
  return !context.live.has(unit.node);
}

function rewriteVariableStatement(node: ts.VariableStatement, context: Context): ts.Statement[] {
  if (isAmbient(node)) return [node];

  const declarations = node.declarationList.declarations;

  if (declarations.every((declaration) => !isDeadVariable(declaration, context))) {
    return [node];
  }

  const kept: ts.Statement[] = [];
  let pending: ts.VariableDeclaration[] = [];
  let modifiersPlaced = false;

  const flush = () => {
    if (pending.length === 0) return;

    const useModifiers = !modifiersPlaced && node.modifiers !== undefined;
    if (useModifiers) modifiersPlaced = true;

    kept.push(
      ts.factory.createVariableStatement(
        useModifiers ? node.modifiers : undefined,
        ts.factory.createVariableDeclarationList(pending, node.declarationList.flags),
      ),
    );
    pending = [];
  };

  for (const declaration of declarations) {
    if (!isDeadVariable(declaration, context)) {
      pending.push(declaration);
      continue;
    }

    // The binding is gone, but its initializer still has to run.
    if (declaration.initializer && expressionHasSideEffects(declaration.initializer, context)) {
      flush();
      kept.push(ts.factory.createExpressionStatement(declaration.initializer));
    }
  }

  flush();

  return kept;
}

function isDeadVariable(node: ts.VariableDeclaration, context: Context): boolean {
  const unit = unitOf(node, context);
  if (!unit) return false;
  return !context.live.has(unit.node);
}

function pruneClassMembers(node: ts.ClassDeclaration, context: Context): void {
  if (!context.shakeClassFunctions) return;

  const kept = node.members.filter((member) => {
    if (!isClassFunction(member)) return true;

    const unit = unitOf(member, context);
    if (!unit) return true;

    if (context.live.has(unit.node)) return true;
    return (unit.siblings ?? []).some((sibling) => context.live.has(sibling));
  });

  if (kept.length !== node.members.length) {
    (node as { members: ts.NodeArray<ts.ClassElement> }).members = ts.factory.createNodeArray(kept);
  }
}

function pruneImportDeclaration(node: ts.ImportDeclaration, context: Context): ts.ImportDeclaration | undefined {
  const clause = node.importClause;

  // `import "module"` exists purely for its side effect.
  if (!clause) return node;

  // Type-only imports never emit Lua.
  if (clause.isTypeOnly) return undefined;

  const used = (name: ts.Identifier): boolean => {
    const symbol = context.checker.getSymbolAtLocation(name);
    return symbol !== undefined && context.usedSymbols.has(symbol);
  };

  // Mutate in place so the import keeps the parent/position information TSTL
  // expects while emitting.
  const mutableClause = clause as {
    name?: ts.Identifier;
    namedBindings?: ts.NamedImportBindings;
  };

  if (mutableClause.name && !used(mutableClause.name)) mutableClause.name = undefined;

  if (mutableClause.namedBindings) {
    if (ts.isNamespaceImport(mutableClause.namedBindings)) {
      if (!used(mutableClause.namedBindings.name)) mutableClause.namedBindings = undefined;
    } else {
      const bindings = mutableClause.namedBindings;
      const elements = bindings.elements.filter((specifier) => !specifier.isTypeOnly && used(specifier.name));

      if (elements.length === 0) {
        mutableClause.namedBindings = undefined;
      } else if (elements.length !== bindings.elements.length) {
        (bindings as { elements: ts.NodeArray<ts.ImportSpecifier> }).elements = ts.factory.createNodeArray(elements);
      }
    }
  }

  if (mutableClause.name === undefined && mutableClause.namedBindings === undefined) {
    // Keep the module load even when no binding survived.
    (node as { importClause?: ts.ImportClause }).importClause = undefined;
  }

  return node;
}

function pruneExportDeclaration(
  node: ts.ExportDeclaration,
  context: Context,
): ts.ExportDeclaration | ts.ImportDeclaration | undefined {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return node;

  const kept = node.exportClause.elements.filter((specifier) => {
    if (specifier.isTypeOnly) return true;

    const symbol = resolveSymbol(
      context.checker.getSymbolAtLocation(specifier.propertyName ?? specifier.name),
      context,
    );
    if (!symbol) return true;

    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) return true;

    const units = declarations.map((declaration) => unitOf(declaration, context)).filter(isUnit);
    if (units.length === 0) return true;

    return units.some((unit) => context.live.has(unit.node));
  });

  if (kept.length === node.exportClause.elements.length) return node;

  if (kept.length === 0) {
    const typeOnly = node.isTypeOnly || node.exportClause.elements.every((specifier) => specifier.isTypeOnly);

    // A value re-export still loads its module. Keep that side effect as a
    // plain import rather than silently dropping the module from the bundle.
    if (node.moduleSpecifier && !typeOnly) {
      return ts.factory.createImportDeclaration(undefined, undefined, node.moduleSpecifier, node.attributes);
    }

    return undefined;
  }

  return ts.factory.updateExportDeclaration(
    node,
    node.modifiers,
    node.isTypeOnly,
    ts.factory.updateNamedExports(node.exportClause, kept),
    node.moduleSpecifier,
    node.attributes,
  );
}

function isUnit(unit: Unit | undefined): unit is Unit {
  return unit !== undefined;
}

function setStatements(
  node: ts.SourceFile | ts.Block | ts.CaseClause | ts.DefaultClause,
  statements: ts.Statement[],
): void {
  (node as { statements: ts.NodeArray<ts.Statement> }).statements = ts.factory.createNodeArray(statements);
}

function isAmbient(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}
