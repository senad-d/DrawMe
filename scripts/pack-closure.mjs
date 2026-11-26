import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

function relativeRuntimeImports(source) {
  const imports = new Set();
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      specifier = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
               ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    // With verbatimModuleSyntax, inline type specifiers can leave import/export {}.
    // Only declarations explicitly marked `import type`/`export type` disappear entirely.
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const name = specifier.text;
      if (name === "." || name === ".." || name.startsWith("./") || name.startsWith("../")) {
        imports.add(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

export function checkRuntimeClosure(root, entries, packedFiles) {
  // Match the project's bundler resolution (including .js-to-.ts substitution and index files),
  // but don't mistake declarations for implementations or let them hide an adjacent JS file.
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
  };
  const host = {
    ...ts.sys,
    fileExists: (file) => !/\.d\.[cm]?ts$/i.test(file) && ts.sys.fileExists(file),
  };
  const issues = [];
  const pending = [];
  const visited = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry || isAbsolute(entry)) {
      issues.push("package.json pi.extensions entries must be relative file paths");
    } else {
      pending.push(resolve(root, entry));
    }
  }

  while (pending.length > 0) {
    const absolutePath = pending.pop();
    const path = relative(root, absolutePath).split(sep).join("/");
    if (visited.has(path)) continue;
    visited.add(path);
    if (!path || isAbsolute(path) || path === ".." || path.startsWith("../")) {
      issues.push(`runtime module must be inside the package: ${path || "."}`);
      continue;
    }
    if (!packedFiles.has(path)) issues.push(`runtime package file is missing: ${path}`);

    const text = host.fileExists(absolutePath) && host.readFile(absolutePath);
    if (typeof text !== "string") {
      issues.push(`cannot read runtime package file: ${path}`);
      continue;
    }
    if (path.endsWith(".json")) continue;
    const source = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true);
    for (const specifier of relativeRuntimeImports(source)) {
      const { resolvedModule } = ts.resolveModuleName(specifier, absolutePath, options, host);
      if (resolvedModule) {
        pending.push(resolve(resolvedModule.resolvedFileName));
      } else {
        issues.push(`cannot resolve runtime import ${JSON.stringify(specifier)} from ${path}`);
      }
    }
  }
  return issues;
}
