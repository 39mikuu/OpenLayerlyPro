import ts from "typescript";

export const BODY_METHODS = new Set(["json", "text", "formData", "arrayBuffer", "blob"]);
export const HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

export function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function routeHandlerName(node) {
  if (ts.isFunctionDeclaration(node) && node.name && HTTP_METHODS.has(node.name.text)) {
    return node.name.text;
  }

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name) &&
    HTTP_METHODS.has(node.parent.name.text)
  ) {
    return node.parent.name.text;
  }

  return null;
}

export function collectRouteHandlers(sourceFile) {
  const handlers = [];

  function visit(node) {
    const name = routeHandlerName(node);
    if (name) handlers.push({ name, node });
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return handlers;
}

export function isAliasExpression(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) && aliases.has(unwrapped.text);
}

export function isRequestCloneExpression(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return false;
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "clone") return false;
  const target = unwrapExpression(callee.expression);
  return ts.isIdentifier(target) && aliases.has(target.text);
}

export function isRequestBodyExpression(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === "body") {
    const target = unwrapExpression(unwrapped.expression);
    return ts.isIdentifier(target) && aliases.has(target.text);
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const target = unwrapExpression(unwrapped.expression);
    const argument = unwrapped.argumentExpression && unwrapExpression(unwrapped.argumentExpression);
    return (
      ts.isIdentifier(target) &&
      aliases.has(target.text) &&
      Boolean(argument && ts.isStringLiteralLike(argument) && argument.text === "body")
    );
  }
  return false;
}

function isRequestAliasLikeExpression(expression, aliases) {
  return isAliasExpression(expression, aliases) || isRequestCloneExpression(expression, aliases);
}

export function collectRequestAliases(handler) {
  const firstParameter = handler.parameters[0];
  if (!firstParameter || !ts.isIdentifier(firstParameter.name)) return new Set();

  const aliases = new Set([firstParameter.name.text]);
  let changed = true;

  while (changed) {
    changed = false;

    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isRequestAliasLikeExpression(node.initializer, aliases) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isRequestAliasLikeExpression(node.right, aliases) &&
        !aliases.has(node.left.text)
      ) {
        aliases.add(node.left.text);
        changed = true;
      }

      ts.forEachChild(node, visit);
    }

    if (handler.body) visit(handler.body);
  }

  return aliases;
}

export function collectRequestBodyStreamAliases(
  handler,
  requestAliases = collectRequestAliases(handler),
) {
  const aliases = new Set();
  let changed = true;

  while (changed) {
    changed = false;

    function isBodyStreamAliasExpression(expression) {
      const unwrapped = unwrapExpression(expression);
      return (
        isRequestBodyExpression(unwrapped, requestAliases) ||
        (ts.isIdentifier(unwrapped) && aliases.has(unwrapped.text))
      );
    }

    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isBodyStreamAliasExpression(node.initializer) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isBodyStreamAliasExpression(node.right) &&
        !aliases.has(node.left.text)
      ) {
        aliases.add(node.left.text);
        changed = true;
      }

      ts.forEachChild(node, visit);
    }

    if (handler.body) visit(handler.body);
  }

  return aliases;
}
