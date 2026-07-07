import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import {
  BODY_METHODS,
  collectRequestAliases,
  collectRequestBodyStreamAliases,
  collectRouteHandlers,
  HTTP_METHODS,
  isRequestBodyExpression,
  isRequestCloneExpression,
  isRequestConstructionExpression,
  unwrapExpression,
} from "./lib/route-ast.mjs";

const ROUTE_FILE_PATTERN = /^route\.(?:[cm]?[jt]sx?)$/;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_MODULE = "@/modules/auth/session";
const REQUEST_BODY_MODULE = "@/lib/request-body";
const FILE_MODULE = "@/modules/file";
const API_MODULE = "@/lib/api";
const RATE_LIMIT_MODULE = "@/lib/rate-limit";
const AUTH_CALLS = new Set(["requireUser", "requireAdmin", "requireAdminSession"]);
const CATEGORY_A_CALLS = new Set([
  "readJsonWithLimit",
  "readJsonWithLimitOrDefault",
  "readTextWithLimit",
  "readFormDataWithLimit",
  "readBoundedRawBody",
]);
const DIRECT_BODY_METHODS = BODY_METHODS;
const CATEGORY_B_CALLS = new Set(["assertContentLengthWithinLimit"]);
const CATEGORY_C_CALLS = new Set(["parseFormDataBody", "saveUploadedFile", "saveStreamedFile"]);
const SAFE_CALLS = new Set(["getClientIp", "getUserAgent"]);
const RATE_LIMIT_CALLS = new Set(["rateLimit", "isRateLimited"]);
const VERIFIED_TRANSPARENT_WRAPPERS = [];

const ALLOWLIST = [
  {
    file: "src/app/api/auth/admin/login/route.ts",
    method: "POST",
    kind: "public-body",
    reason:
      "Public admin login endpoint must read credentials before establishing an authenticated session.",
  },
  {
    file: "src/app/api/auth/request-code/route.ts",
    method: "POST",
    kind: "public-body",
    reason:
      "Public login-code request endpoint must read unauthenticated email and challenge fields.",
  },
  {
    file: "src/app/api/auth/verify-code/route.ts",
    method: "POST",
    kind: "public-body",
    reason:
      "Public login-code verification endpoint must read unauthenticated email and code fields.",
  },
  {
    file: "src/app/api/admin/setup/route.ts",
    method: "POST",
    kind: "public-body",
    reason:
      "This is an intentionally unauthenticated first-time initialization entry point; its risk and the semantics of 'first admin creation' are owned by the existing setup design itself, not by this PR's definition of a 'protected write route'.",
  },
  {
    file: "src/app/api/payments/webhook/stripe/route.ts",
    method: "POST",
    kind: "public-body",
    reason: "Stripe signature verification requires the untouched raw request body.",
  },
  {
    file: "src/app/api/auth/logout/route.ts",
    method: "POST",
    kind: "public-bodyless",
    reason:
      "Logout is intentionally callable without proving a current user and performs no request body read.",
  },
];

async function collectRouteFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectRouteFiles(absolute)));
    else if (entry.isFile() && ROUTE_FILE_PATTERN.test(entry.name)) files.push(absolute);
  }
  return files;
}

function createSourceFile(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  );
}

function nodeLineColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function statementLineColumn(sourceFile, statement) {
  return nodeLineColumn(sourceFile, statement);
}

function relativePath(file) {
  const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
  if (relative && !relative.startsWith("../") && relative !== "..") return relative;

  const normalized = path.resolve(file).split(path.sep).join("/");
  const sourceAppIndex = normalized.lastIndexOf("/src/app/");
  if (sourceAppIndex >= 0) return normalized.slice(sourceAppIndex + 1);
  return relative || file;
}

function normalizeModuleSpecifier(specifier) {
  return specifier;
}

function buildImportMap(sourceFile) {
  const named = new Map();
  const namespaces = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = normalizeModuleSpecifier(statement.moduleSpecifier.text);
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;

    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        named.set(element.name.text, { moduleSpecifier, importedName });
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, { moduleSpecifier });
    }
  }

  return { named, namespaces };
}

function bindingNameContainsIdentifier(name, text) {
  if (ts.isIdentifier(name)) return name.text === text;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.some((element) => {
      if (ts.isOmittedExpression(element)) return false;
      return bindingNameContainsIdentifier(element.name, text);
    });
  }
  return false;
}

function declaresName(node, text) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name
  ) {
    return bindingNameContainsIdentifier(node.name, text);
  }
  if (ts.isParameter(node)) return bindingNameContainsIdentifier(node.name, text);
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node))
    return false;
  return false;
}

function nodeContainsIdentifier(node, identifier) {
  let found = false;
  function visit(current) {
    if (current === identifier) return;
    if (declaresName(current, identifier.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isBlockScope(node) {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseBlock(node);
}

function isShadowed(identifier, handler) {
  let scope = identifier.parent;
  while (scope && scope !== handler) {
    if (isBlockScope(scope) && nodeContainsIdentifier(scope, identifier)) return true;
    scope = scope.parent;
  }

  let current = identifier.parent;
  while (current && current !== handler) {
    if (declaresName(current, identifier.text)) return true;
    current = current.parent;
  }
  return false;
}

function isBodyMethodCallTarget(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return aliases.has(unwrapped.text) ? unwrapped.text : null;
  }
  if (isRequestCloneExpression(unwrapped, aliases)) {
    const callee = unwrapExpression(unwrapped.expression);
    const target = unwrapExpression(callee.expression);
    return ts.isIdentifier(target) ? `${target.text}.clone()` : "request.clone()";
  }
  if (isRequestConstructionExpression(unwrapped, aliases)) {
    return "new Request";
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      isBodyMethodCallTarget(unwrapped.whenTrue, aliases) ??
      isBodyMethodCallTarget(unwrapped.whenFalse, aliases)
    );
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    (unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      isBodyMethodCallTarget(unwrapped.left, aliases) ??
      isBodyMethodCallTarget(unwrapped.right, aliases)
    );
  }
  return null;
}

function resolveCallee(call, importMap, handler) {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    if (isShadowed(callee, handler)) return null;
    return importMap.named.get(callee.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const namespace = callee.expression;
    if (isShadowed(namespace, handler)) return null;
    const namespaceImport = importMap.namespaces.get(namespace.text);
    if (!namespaceImport) return null;
    return { moduleSpecifier: namespaceImport.moduleSpecifier, importedName: callee.name.text };
  }
  return null;
}

function isResolvedCall(call, importMap, handler, moduleSpecifier, importedNames) {
  const resolved = resolveCallee(call, importMap, handler);
  return resolved?.moduleSpecifier === moduleSpecifier && importedNames.has(resolved.importedName);
}

function directBodyRead(call, aliases) {
  const callee = unwrapExpression(call.expression);
  let target;
  let method;

  if (ts.isPropertyAccessExpression(callee)) {
    target = unwrapExpression(callee.expression);
    method = callee.name.text;
  } else if (ts.isElementAccessExpression(callee)) {
    target = unwrapExpression(callee.expression);
    const argument = callee.argumentExpression && unwrapExpression(callee.argumentExpression);
    if (argument && ts.isStringLiteralLike(argument)) method = argument.text;
  }

  const targetName = target && isBodyMethodCallTarget(target, aliases);
  if (!method || !DIRECT_BODY_METHODS.has(method) || !targetName) return null;
  return { category: "A", name: `${targetName}.${method}`, node: call };
}

function computedBodyMethodReview(call, aliases) {
  const callee = unwrapExpression(call.expression);
  if (!ts.isElementAccessExpression(callee)) return null;
  const target = unwrapExpression(callee.expression);
  const targetName = isBodyMethodCallTarget(target, aliases);
  if (!targetName) return null;
  const argument = callee.argumentExpression && unwrapExpression(callee.argumentExpression);
  if (argument && ts.isStringLiteralLike(argument)) return null;
  return {
    name: `${targetName}[computed]() requires manual review before auth`,
    node: call,
  };
}

function streamReaderRead(call, aliases, bodyStreamAliases) {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "getReader") return null;
  const target = unwrapExpression(callee.expression);
  if (ts.isIdentifier(target) && bodyStreamAliases.has(target.text)) {
    return { category: "A", name: `${target.text}.getReader`, node: call };
  }
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== "body") return null;
  const request = unwrapExpression(target.expression);
  if (!ts.isIdentifier(request) || !aliases.has(request.text)) return null;
  return { category: "A", name: `${request.text}.body.getReader`, node: call };
}

function readableFromWebRead(call, aliases) {
  const callee = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "fromWeb" ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Readable"
  ) {
    return null;
  }
  const firstArgument = call.arguments[0] && unwrapExpression(call.arguments[0]);
  let bodyAccess = firstArgument;
  if (bodyAccess && ts.isAsExpression(bodyAccess))
    bodyAccess = unwrapExpression(bodyAccess.expression);
  if (
    !bodyAccess ||
    !ts.isPropertyAccessExpression(bodyAccess) ||
    bodyAccess.name.text !== "body"
  ) {
    return null;
  }
  const request = unwrapExpression(bodyAccess.expression);
  if (!ts.isIdentifier(request) || !aliases.has(request.text)) return null;
  return { category: "A", name: "Readable.fromWeb", node: call };
}

function manualContentLengthCheck(node, aliases) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "get") return null;
  const target = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== "headers") return null;
  const request = unwrapExpression(target.expression);
  if (!ts.isIdentifier(request) || !aliases.has(request.text)) return null;
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || unwrapExpression(parent.expression) !== node) return null;
  const firstArgument = parent.arguments[0] && unwrapExpression(parent.arguments[0]);
  if (!firstArgument || !ts.isStringLiteralLike(firstArgument)) return null;
  if (firstArgument.text.toLowerCase() !== "content-length") return null;
  return { category: "B", name: "content-length", node: parent };
}

function callCategory(call, importMap, handler, aliases, bodyStreamAliases) {
  const direct = directBodyRead(call, aliases);
  if (direct) return direct;
  const reader = streamReaderRead(call, aliases, bodyStreamAliases);
  if (reader) return reader;
  const fromWeb = readableFromWebRead(call, aliases);
  if (fromWeb) return fromWeb;

  if (isResolvedCall(call, importMap, handler, REQUEST_BODY_MODULE, CATEGORY_A_CALLS)) {
    const resolved = resolveCallee(call, importMap, handler);
    return { category: "A", name: resolved.importedName, node: call };
  }
  if (isResolvedCall(call, importMap, handler, REQUEST_BODY_MODULE, CATEGORY_B_CALLS)) {
    const resolved = resolveCallee(call, importMap, handler);
    return { category: "B", name: resolved.importedName, node: call };
  }
  if (isResolvedCall(call, importMap, handler, REQUEST_BODY_MODULE, CATEGORY_C_CALLS)) {
    const resolved = resolveCallee(call, importMap, handler);
    return { category: "C", name: resolved.importedName, node: call };
  }
  if (isResolvedCall(call, importMap, handler, FILE_MODULE, CATEGORY_C_CALLS)) {
    const resolved = resolveCallee(call, importMap, handler);
    return { category: "C", name: resolved.importedName, node: call };
  }
  return null;
}

function isSafeCall(call, importMap, handler) {
  return (
    isResolvedCall(call, importMap, handler, API_MODULE, SAFE_CALLS) ||
    isResolvedCall(call, importMap, handler, RATE_LIMIT_MODULE, RATE_LIMIT_CALLS)
  );
}

function isRateLimiterCall(call, importMap, handler) {
  return isResolvedCall(call, importMap, handler, RATE_LIMIT_MODULE, RATE_LIMIT_CALLS);
}

function isAuthCallExpression(expression, importMap, handler) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isAwaitExpression(unwrapped)) {
    return isAuthCallExpression(unwrapped.expression, importMap, handler);
  }
  if (!ts.isCallExpression(unwrapped)) return null;
  if (!isResolvedCall(unwrapped, importMap, handler, AUTH_MODULE, AUTH_CALLS)) return null;
  const resolved = resolveCallee(unwrapped, importMap, handler);
  return resolved ? { ...resolved, node: unwrapped } : null;
}

function authStatementInfo(statement, importMap, handler, sourceFile) {
  if (ts.isExpressionStatement(statement)) {
    const expression = unwrapExpression(statement.expression);
    if (!ts.isAwaitExpression(expression)) return null;
    const resolved = isAuthCallExpression(expression, importMap, handler);
    if (!resolved) return null;
    return {
      statement,
      node: resolved.node,
      name: resolved.importedName,
      ...statementLineColumn(sourceFile, statement),
    };
  }

  if (!ts.isVariableStatement(statement)) return null;
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) && !ts.isObjectBindingPattern(declaration.name)) {
      continue;
    }
    if (!declaration.initializer) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (!ts.isAwaitExpression(initializer)) continue;
    const resolved = isAuthCallExpression(initializer, importMap, handler);
    if (!resolved) continue;
    return {
      statement,
      node: resolved.node,
      name: resolved.importedName,
      ...statementLineColumn(sourceFile, statement),
    };
  }
  return null;
}

function topLevelStatements(handler) {
  if (!handler.body || !ts.isBlock(handler.body)) return [];
  const statements = Array.from(handler.body.statements);
  if (statements.length === 1 && ts.isTryStatement(statements[0])) {
    return Array.from(statements[0].tryBlock.statements);
  }
  return statements;
}

function findTopLevelAuth(handler, importMap, sourceFile) {
  for (const statement of topLevelStatements(handler)) {
    const info = authStatementInfo(statement, importMap, handler, sourceFile);
    if (info) return info;
  }
  return null;
}

function enclosingTopLevelStatement(node, handler) {
  const statements = topLevelStatements(handler);
  let current = node;
  while (current && current !== handler.body) {
    if (statements.includes(current)) return current;
    current = current.parent;
  }
  return null;
}

function isInsideNestedFunction(node, handler) {
  let current = node.parent;
  while (current && current !== handler) {
    if (isFunctionLike(current)) return true;
    current = current.parent;
  }
  return false;
}

function expressionContainsRequestAlias(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  if (isBodyMethodCallTarget(unwrapped, aliases)) return true;
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === "body") {
    return Boolean(isBodyMethodCallTarget(unwrapped.expression, aliases));
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return expressionContainsRequestAlias(property.initializer, aliases);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return expressionContainsRequestAlias(property.name, aliases);
      }
      if (ts.isSpreadAssignment(property)) {
        return expressionContainsRequestAlias(property.expression, aliases);
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.some((element) => {
      if (ts.isSpreadElement(element)) {
        return expressionContainsRequestAlias(element.expression, aliases);
      }
      return expressionContainsRequestAlias(element, aliases);
    });
  }
  return false;
}

function requestEscape(call, importMap, handler, aliases) {
  if (isSafeCall(call, importMap, handler)) return null;
  for (const argument of call.arguments) {
    if (expressionContainsRequestAlias(argument, aliases)) {
      return { name: "request passed to non-safe-list call", node: call };
    }
  }
  return null;
}

function requestConstructionEscape(node, aliases) {
  if (!ts.isNewExpression(node)) return null;
  const callee = unwrapExpression(node.expression);
  if (ts.isIdentifier(callee) && callee.text === "Request") return null;
  for (const argument of node.arguments ?? []) {
    if (expressionContainsRequestAlias(argument, aliases)) {
      return { name: "request passed to non-safe-list constructor", node };
    }
  }
  return null;
}

function requestContainerReview(node, aliases) {
  if (!ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node)) return null;
  if (!expressionContainsRequestAlias(node, aliases)) return null;
  return { name: "request stored in a container before auth", node };
}

function cloneOrBodyExtractionReview(node, aliases) {
  if (isRequestCloneExpression(node, aliases)) {
    return { name: "request.clone() requires manual review before auth", node };
  }
  if (isRequestConstructionExpression(node, aliases)) {
    return { name: "new Request(request) requires manual review before auth", node };
  }
  if (isRequestBodyExpression(node, aliases)) {
    return { name: "request.body extraction requires manual review before auth", node };
  }
  return null;
}

function collectOperations(handler, importMap, sourceFile) {
  const aliases = collectRequestAliases(handler);
  const bodyStreamAliases = collectRequestBodyStreamAliases(handler, aliases);
  const operations = [];
  const requestEscapes = [];
  const nestedAuthCalls = [];
  let hasRateLimiterCall = false;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (isRateLimiterCall(node, importMap, handler)) hasRateLimiterCall = true;
      if (isResolvedCall(node, importMap, handler, AUTH_MODULE, AUTH_CALLS)) {
        const topLevelStatement = enclosingTopLevelStatement(node, handler);
        if (
          isInsideNestedFunction(node, handler) ||
          !topLevelStatement ||
          (!authStatementInfo(topLevelStatement, importMap, handler, sourceFile) &&
            !ts.isExpressionStatement(topLevelStatement) &&
            !ts.isVariableStatement(topLevelStatement))
        ) {
          nestedAuthCalls.push({
            name: resolveCallee(node, importMap, handler)?.importedName ?? "auth",
            topLevelStatement,
            nested: isInsideNestedFunction(node, handler),
            ...nodeLineColumn(sourceFile, node),
          });
        }
      }
      const operation = callCategory(node, importMap, handler, aliases, bodyStreamAliases);
      if (operation) {
        operations.push({
          ...operation,
          topLevelStatement: enclosingTopLevelStatement(node, handler),
          nested: isInsideNestedFunction(node, handler),
          ...nodeLineColumn(sourceFile, node),
        });
      } else {
        const escape =
          computedBodyMethodReview(node, aliases) ??
          requestEscape(node, importMap, handler, aliases);
        if (escape) {
          requestEscapes.push({
            ...escape,
            topLevelStatement: enclosingTopLevelStatement(node, handler),
            nested: isInsideNestedFunction(node, handler),
            ...nodeLineColumn(sourceFile, node),
          });
        }
      }
    }

    const constructorEscape = requestConstructionEscape(node, aliases);
    if (constructorEscape) {
      requestEscapes.push({
        ...constructorEscape,
        topLevelStatement: enclosingTopLevelStatement(constructorEscape.node, handler),
        nested: isInsideNestedFunction(constructorEscape.node, handler),
        ...nodeLineColumn(sourceFile, constructorEscape.node),
      });
    }

    const containerReview = requestContainerReview(node, aliases);
    if (containerReview) {
      requestEscapes.push({
        ...containerReview,
        topLevelStatement: enclosingTopLevelStatement(containerReview.node, handler),
        nested: isInsideNestedFunction(containerReview.node, handler),
        ...nodeLineColumn(sourceFile, containerReview.node),
      });
    }

    const cloneOrBodyExtraction = cloneOrBodyExtractionReview(node, aliases);
    if (cloneOrBodyExtraction) {
      requestEscapes.push({
        ...cloneOrBodyExtraction,
        topLevelStatement: enclosingTopLevelStatement(cloneOrBodyExtraction.node, handler),
        nested: isInsideNestedFunction(cloneOrBodyExtraction.node, handler),
        ...nodeLineColumn(sourceFile, cloneOrBodyExtraction.node),
      });
    }

    const manualContentLength = manualContentLengthCheck(node, aliases);
    if (manualContentLength) {
      operations.push({
        ...manualContentLength,
        topLevelStatement: enclosingTopLevelStatement(manualContentLength.node, handler),
        nested: isInsideNestedFunction(manualContentLength.node, handler),
        ...nodeLineColumn(sourceFile, manualContentLength.node),
      });
    }

    ts.forEachChild(node, visit);
  }

  if (handler.body) visit(handler.body);
  return { operations, requestEscapes, nestedAuthCalls, hasRateLimiterCall };
}

function declarationMap(sourceFile) {
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      }
    }
  }
  return declarations;
}

function isVerifiedTransparentWrapper(call, importMap, handler) {
  const resolved = resolveCallee(call, importMap, handler);
  if (!resolved) return false;
  return VERIFIED_TRANSPARENT_WRAPPERS.some(
    (wrapper) =>
      wrapper.moduleSpecifier === resolved.moduleSpecifier &&
      wrapper.importedName === resolved.importedName,
  );
}

function unwrapWrappedHandler(initializer, importMap, handler) {
  const expression = unwrapExpression(initializer);
  if (isFunctionLike(expression)) return { node: expression, pattern: "exported variable handler" };
  if (!ts.isCallExpression(expression)) return null;

  const functionArguments = expression.arguments.filter((argument) =>
    isFunctionLike(unwrapExpression(argument)),
  );
  if (expression.arguments.length === 1 && functionArguments.length === 1) {
    if (!isVerifiedTransparentWrapper(expression, importMap, handler)) {
      return {
        manual: true,
        pattern: "wrapped handler",
        reason: "wrapper function is not on the verified-transparent allowlist",
      };
    }
    return { node: unwrapExpression(functionArguments[0]), pattern: "wrapped handler" };
  }
  return { manual: true, pattern: "wrapped handler" };
}

function exportedHandlers(sourceFile, importMap) {
  const declarations = declarationMap(sourceFile);
  const handlers = [];

  for (const { name, node } of collectRouteHandlers(sourceFile)) {
    if (!hasExportModifier(node)) continue;
    handlers.push({ method: name, node, pattern: "exported function declaration" });
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !HTTP_METHODS.has(declaration.name.text)) continue;
      if (!declaration.initializer) {
        handlers.push({
          method: declaration.name.text,
          node: null,
          pattern: "exported variable handler",
          manualReason: "exported handler has no initializer",
          anchor: declaration,
        });
        continue;
      }
      const unwrapped = unwrapWrappedHandler(declaration.initializer, importMap, declaration);
      if (unwrapped?.node) {
        handlers.push({
          method: declaration.name.text,
          node: unwrapped.node,
          pattern: unwrapped.pattern,
        });
      } else {
        handlers.push({
          method: declaration.name.text,
          node: null,
          pattern: unwrapped?.pattern ?? "exported variable handler",
          manualReason:
            unwrapped?.reason ?? "unable to statically extract exported handler function",
          anchor: declaration,
        });
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      const method = element.name.text;
      if (!HTTP_METHODS.has(method)) continue;
      const localName = element.propertyName?.text ?? element.name.text;
      const declaration = declarations.get(localName);
      if (!declaration) {
        handlers.push({
          method,
          node: null,
          pattern: "export re-export",
          manualReason: "unable to resolve re-exported handler",
          anchor: element,
        });
        continue;
      }
      if (ts.isFunctionDeclaration(declaration)) {
        handlers.push({ method, node: declaration, pattern: "export re-export" });
      } else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const unwrapped = unwrapWrappedHandler(declaration.initializer, importMap, declaration);
        if (unwrapped?.node) {
          handlers.push({ method, node: unwrapped.node, pattern: "export re-export" });
        } else {
          handlers.push({
            method,
            node: null,
            pattern: "export re-export",
            manualReason:
              unwrapped?.reason ?? "unable to statically extract re-exported handler function",
            anchor: declaration,
          });
        }
      }
    }
  }

  return handlers;
}

function isAllowed(file, method) {
  const relative = relativePath(file);
  return ALLOWLIST.find((entry) => entry.file === relative && entry.method === method) ?? null;
}

function categoriesSummary(operations) {
  return {
    A: [...new Set(operations.filter((op) => op.category === "A").map((op) => op.name))],
    B: [...new Set(operations.filter((op) => op.category === "B").map((op) => op.name))],
    C: [...new Set(operations.filter((op) => op.category === "C").map((op) => op.name))],
  };
}

function occursBeforeOperation(operation, auth) {
  if (!operation.topLevelStatement) return false;
  if (operation.topLevelStatement === auth.statement) {
    return operation.node.pos < auth.node.pos;
  }
  return operation.topLevelStatement.pos < auth.statement.pos;
}

function classifyHandler(
  { file, method, node, pattern, manualReason, anchor },
  sourceFile,
  importMap,
) {
  if (!node) {
    const position = anchor ? nodeLineColumn(sourceFile, anchor) : { line: 1, column: 1 };
    return {
      file: relativePath(file),
      method,
      pattern,
      categories: { A: [], B: [], C: [] },
      hasRateLimiterCall: false,
      auth: null,
      verdict: "needs-manual-review",
      reasons: [manualReason ?? "unable to statically classify handler"],
      line: position.line,
      column: position.column,
    };
  }

  const auth = findTopLevelAuth(node, importMap, sourceFile);
  const { operations, requestEscapes, nestedAuthCalls, hasRateLimiterCall } = collectOperations(
    node,
    importMap,
    sourceFile,
  );
  const allowlistEntry = isAllowed(file, method);
  const hasCategoryA = operations.some((op) => op.category === "A");
  const firstParameter = node.parameters[0];
  const hasNonIdentifierFirstParameter = Boolean(
    firstParameter && !ts.isIdentifier(firstParameter.name),
  );

  const base = {
    file: relativePath(file),
    method,
    pattern,
    categories: categoriesSummary(operations),
    hasRateLimiterCall,
    auth: auth ? { name: auth.name, line: auth.line, column: auth.column } : null,
    verdict: "no-body-bodyless",
    reasons: [],
  };

  if (allowlistEntry) {
    return {
      ...base,
      verdict: "allowlisted",
      allowlistKind: allowlistEntry.kind,
      allowlistReason: allowlistEntry.reason,
    };
  }

  if (hasNonIdentifierFirstParameter) {
    return {
      ...base,
      verdict: "needs-manual-review",
      reasons: [
        "handler's request parameter uses a non-identifier binding pattern; static body-read tracking cannot be verified",
      ],
      ...nodeLineColumn(sourceFile, firstParameter.name),
    };
  }

  if (operations.some((op) => op.nested || !op.topLevelStatement)) {
    const op = operations.find((candidate) => candidate.nested || !candidate.topLevelStatement);
    return {
      ...base,
      verdict: "needs-manual-review",
      reasons: [`${op.name} is not enclosed by a direct top-level handler statement`],
      line: op.line,
      column: op.column,
    };
  }

  if (!auth) {
    if (nestedAuthCalls.length > 0) {
      const authCall = nestedAuthCalls[0];
      return {
        ...base,
        verdict: "needs-manual-review",
        reasons: [`${authCall.name} is not an unconditional top-level awaited auth statement`],
        line: authCall.line,
        column: authCall.column,
      };
    }
    if (operations.length > 0) {
      const op = operations[0];
      return {
        ...base,
        verdict: "violation",
        reasons: [
          `${op.category} operation ${op.name} occurs without a top-level awaited auth statement`,
        ],
        line: op.line,
        column: op.column,
      };
    }
    if (requestEscapes.length > 0) {
      const escape = requestEscapes[0];
      return {
        ...base,
        verdict: "needs-manual-review",
        reasons: [escape.name],
        line: escape.line,
        column: escape.column,
      };
    }
    return {
      ...base,
      verdict: WRITE_METHODS.has(method) ? "unclassified" : "no-body-bodyless",
      reasons: WRITE_METHODS.has(method)
        ? ["write handler has no resolved auth call and no classified body operation"]
        : [],
    };
  }

  for (const op of operations) {
    if (occursBeforeOperation(op, auth)) {
      return {
        ...base,
        verdict: "violation",
        reasons: [`${op.category} operation ${op.name} occurs before ${auth.name}`],
        line: op.line,
        column: op.column,
      };
    }
  }

  for (const escape of requestEscapes) {
    if (escape.nested || !escape.topLevelStatement || occursBeforeOperation(escape, auth)) {
      return {
        ...base,
        verdict: "needs-manual-review",
        reasons: [escape.name],
        line: escape.line,
        column: escape.column,
      };
    }
  }

  if (operations.length === 0) {
    return {
      ...base,
      verdict: "no-body-bodyless",
    };
  }

  return {
    ...base,
    verdict: hasCategoryA ? "compliant" : "already-compliant-no-change-needed",
  };
}

function shouldValidateAllowlist(root) {
  const normalized = path.resolve(root).split(path.sep).join("/");
  const cwd = process.cwd().split(path.sep).join("/");
  return normalized === cwd || normalized.endsWith("/src/app");
}

async function checkAllowlist(root, handlersByKey) {
  if (!shouldValidateAllowlist(root)) return [];

  const failures = [];
  for (const entry of ALLOWLIST) {
    if (/[*?[\]{}]/.test(entry.file)) {
      failures.push(`${entry.file}: allowlist entries must be exact file paths, not globs`);
      continue;
    }
    const absolute = path.resolve(entry.file);
    if (!absolute.startsWith(path.resolve(root)) && root !== ".") {
      // Test fixtures may intentionally include only the allowlisted relative path.
    }
    const key = `${entry.file}#${entry.method}`;
    const handler = handlersByKey.get(key);
    if (!handler) {
      failures.push(
        `${entry.file} ${entry.method}: allowlist entry does not match an exported handler`,
      );
      continue;
    }
    if (entry.kind === "public-body" && !handler.categories.A.length) {
      failures.push(
        `${entry.file} ${entry.method}: stale allowlist entry no longer has an A-category body read`,
      );
    }
    if (entry.kind === "public-bodyless" && handler.categories.A.length) {
      failures.push(
        `${entry.file} ${entry.method}: stale bodyless allowlist entry now has an A-category body read`,
      );
    }
    if (
      entry.kind === "public-bodyless" &&
      (handler.categories.B.length || handler.categories.C.length)
    ) {
      failures.push(
        `${entry.file} ${entry.method}: stale bodyless allowlist entry now has B/C body-adjacent operations`,
      );
    }
    if (handler.auth) {
      failures.push(
        `${entry.file} ${entry.method}: stale allowlist entry now has resolved auth call ${handler.auth.name}`,
      );
    }
  }
  return failures;
}

function isWriteHandler(result) {
  return (
    WRITE_METHODS.has(result.method) ||
    result.categories.A.length ||
    result.categories.B.length ||
    result.categories.C.length
  );
}

async function analyzeRouteTree(root) {
  const absoluteRoot = path.resolve(root);
  const routeFiles = await collectRouteFiles(absoluteRoot);
  const results = [];

  for (const file of routeFiles.sort()) {
    const source = await readFile(file, "utf8");
    const sourceFile = createSourceFile(source, file);
    const importMap = buildImportMap(sourceFile);
    for (const handler of exportedHandlers(sourceFile, importMap)) {
      results.push(classifyHandler({ file, ...handler }, sourceFile, importMap));
    }
  }

  const handlersByKey = new Map(
    results.map((result) => [`${result.file}#${result.method}`, result]),
  );
  const allowlistFailures = await checkAllowlist(root, handlersByKey);
  return { routeFiles, results, allowlistFailures };
}

function summary(routeFiles, results) {
  const writeHandlers = results.filter(isWriteHandler);
  const protectedHandlers = writeHandlers.filter((result) => result.auth);
  const protectedBodyReadingHandlers = protectedHandlers.filter(
    (result) => result.categories.A.length,
  );
  const protectedBodylessHandlers = protectedHandlers.filter(
    (result) => !result.categories.A.length,
  );
  const publicAllowlistedBodyHandlers = writeHandlers.filter(
    (result) => result.verdict === "allowlisted" && result.allowlistKind === "public-body",
  );
  const compliantProtectedHandlers = protectedHandlers.filter((result) =>
    ["compliant", "already-compliant-no-change-needed", "no-body-bodyless"].includes(
      result.verdict,
    ),
  );
  const violations = writeHandlers.filter((result) => result.verdict === "violation");
  const manual = writeHandlers.filter((result) => result.verdict === "needs-manual-review");
  const unclassified = writeHandlers.filter(
    (result) => !result.auth && result.verdict !== "allowlisted",
  );

  return {
    "route files scanned": routeFiles.length,
    "write handlers discovered": writeHandlers.length,
    "protected body-reading handlers": protectedBodyReadingHandlers.length,
    "protected bodyless handlers": protectedBodylessHandlers.length,
    "public allowlisted body handlers": publicAllowlistedBodyHandlers.length,
    "currently compliant protected handlers": compliantProtectedHandlers.length,
    "unclassified write handlers": unclassified.length,
    violations: violations.length,
    "needs-manual-review": manual.length,
  };
}

function printSummary(summaryObject) {
  const lines = [];
  for (const key of [
    "route files scanned",
    "write handlers discovered",
    "protected body-reading handlers",
    "protected bodyless handlers",
    "public allowlisted body handlers",
    "currently compliant protected handlers",
    "unclassified write handlers",
    "violations",
    "needs-manual-review",
  ]) {
    lines.push(`${key}: ${summaryObject[key]}`);
  }
  return lines;
}

function printDefaultReport(results, allowlistFailures) {
  const stdout = [];
  const stderr = [];
  for (const result of results.filter((candidate) => candidate.verdict === "allowlisted")) {
    stdout.push(`allowlisted: ${result.method} ${result.file} (${result.allowlistReason})`);
  }

  if (allowlistFailures.length > 0) {
    stderr.push("Auth-before-body allowlist failures:");
    for (const failure of allowlistFailures) stderr.push(failure);
  }

  const findings = results.filter((result) =>
    ["violation", "needs-manual-review", "unclassified"].includes(result.verdict),
  );
  if (findings.length > 0) {
    stderr.push("Protected Route Handlers must authenticate before body reads:");
    for (const finding of findings) {
      stderr.push(
        `${finding.file}:${finding.line ?? 1}:${finding.column ?? 1}: ${finding.verdict}: ${finding.reasons.join("; ")}`,
      );
    }
  }

  return { stdout, stderr };
}

export async function checkAuthBeforeBody(root = "src/app", options = {}) {
  const analysis = await analyzeRouteTree(root);
  const summaryObject = summary(analysis.routeFiles, analysis.results);
  let stdout = [];
  let stderr = [];
  if (options.audit) {
    for (const result of analysis.results.filter(isWriteHandler)) {
      stdout.push(JSON.stringify(result));
    }
    stdout.push(...printSummary(summaryObject));
  } else {
    ({ stdout, stderr } = printDefaultReport(analysis.results, analysis.allowlistFailures));
  }

  return {
    ...analysis,
    summary: summaryObject,
    failed:
      analysis.allowlistFailures.length > 0 ||
      analysis.results.some((result) =>
        ["violation", "needs-manual-review", "unclassified"].includes(result.verdict),
      ),
    stdout,
    stderr,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const audit = args.includes("--audit");
  const roots = args.filter((arg) => arg !== "--audit");
  const root = roots[0] ?? "src/app";
  const result = await checkAuthBeforeBody(root, { audit });
  if (result.stdout.length > 0) {
    await new Promise((resolve) => process.stdout.write(`${result.stdout.join("\n")}\n`, resolve));
  }
  if (result.stderr.length > 0) {
    await new Promise((resolve) => process.stderr.write(`${result.stderr.join("\n")}\n`, resolve));
  }
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
