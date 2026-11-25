import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const relativeSpecifier = /^\.{1,2}(?:\/|$)/;
const resolutionOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
};

function onlyTypeSpecifiers(elements) {
  // An empty import or re-export still loads the module for side effects.
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    if (clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && onlyTypeSpecifiers(bindings.elements))) {
      return;
    }
    return node.moduleSpecifier;
  }
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    if (node.isTypeOnly || (clause && ts.isNamedExports(clause) && onlyTypeSpecifiers(clause.elements))) {
      return;
    }
    return node.moduleSpecifier;
  }
  if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node.arguments[0];
  }
}

// Inspect the checkout without loading extension code; the pack list is checked separately.
export function runtimePackageClosure(root, extensions) {
  root = realpathSync(root);
  const paths = new Set();
  const issues = [];
  const pending = [];
  const packagePath = (file) => relative(root, file).split(sep).join("/");
  const withinRoot = (file) => {
    const path = packagePath(file);
    return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
  };
  const fileExists = (file) => withinRoot(file) && !ts.isDeclarationFileName(file) &&
    ts.sys.fileExists(file) && withinRoot(realpathSync(file));
  const host = {
    fileExists,
    readFile: (file) => fileExists(file) ? readFileSync(file, "utf8") : undefined,
  };

  function enqueue(file) {
    const path = packagePath(file);
    if (!paths.has(path)) {
      paths.add(path);
      pending.push(file);
    }
  }

  for (const entry of extensions) {
    if (typeof entry !== "string" || entry.length === 0 || isAbsolute(entry) || !withinRoot(resolve(root, entry))) {
      issues.push("package.json pi.extensions entries must be relative package file paths");
      continue;
    }
    const file = resolve(root, entry);
    if (fileExists(file)) enqueue(file);
    else issues.push(`runtime entry could not be resolved: ${packagePath(file) || "."}`);
  }

  while (pending.length > 0) {
    const file = pending.pop();
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
    function walk(node) {
      const specifier = moduleSpecifier(node);
      if (specifier && ts.isStringLiteralLike(specifier) && relativeSpecifier.test(specifier.text)) {
        const target = resolve(dirname(file), specifier.text);
        if (fileExists(target)) {
          enqueue(target);
        } else {
          const result = ts.resolveModuleName(specifier.text, file, resolutionOptions, host);
          if (result.resolvedModule) {
            enqueue(result.resolvedModule.resolvedFileName);
            for (const metadata of result.affectingLocations ?? []) paths.add(packagePath(metadata));
          } else {
            issues.push(`runtime module could not be resolved: ${packagePath(target) || "."} (imported by ${packagePath(file)})`);
          }
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }

  return { paths, issues };
}
