import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import ts from "typescript";
import { expect, it } from "vitest";
import { enhanceAnimatedSvg } from "../src/animation";
import type { DomEl } from "../src/dom";
import { compileMotion, injectMotion } from "../src/motion";
import { cssString, walkElements } from "../src/svg-helpers";

it("walks SVG elements in root-inclusive preorder, ignoring text and comments", () => {
  const root = new DOMParser().parseFromString("<svg>text<g><rect/><circle/></g><!--x--><defs><style/></defs></svg>", "image/svg+xml")
    .documentElement as unknown as DomEl;
  expect(walkElements(root).map((element) => element.tagName)).toEqual(["svg", "g", "rect", "circle", "defs", "style"]);
  expect(cssString('a"\\\tb\u007f')).toBe('"a\\"\\\\\\9 b\\7f "');
});

it("targets the same quoted, backslash and control-character cell ID in both animation dialects", async () => {
  const id = 'quoted"\\\tid';
  const escapedId = 'quoted&quot;\\&#9;id';
  const steps = JSON.stringify({ steps: [{ fadeIn: { cells: [id] } }] }).replaceAll('"', "&quot;");
  const source = `<mxGraphModel><root><mxCell id="0" animation="${steps}"/><mxCell id="${escapedId}" vertex="1"/></root></mxGraphModel>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g data-cell-id="${escapedId}"><rect width="1" height="1"/></g></svg>`;
  const selector = String.raw`g[data-cell-id="quoted\"\\\9 id"]`;
  const dir = await mkdtemp(join(tmpdir(), "drawme-quoted-id-"));
  try {
    const input = join(dir, "test.drawio");
    const output = join(dir, "test.svg");
    await writeFile(input, source);
    await writeFile(output, svg);
    expect(await enhanceAnimatedSvg(input, output)).toMatchObject({ sequenceCompiled: true });
    expect(await readFile(output, "utf8")).toContain(selector);
    const motion = compileMotion({ steps: [{ effect: "fadeIn", cells: [id] }] },
      new Map([[id, { kind: "vertex", style: "", parent: null }]])).compiled!;
    expect(injectMotion(svg, motion)).toContain(selector);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("shares one encoder and traversal and leaves wait scheduling outside the per-target switch", () => {
  for (const name of ["animation", "motion", "svgexport"]) {
    const path = new URL(`../src/${name}.ts`, import.meta.url);
    const file = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const imported = file.statements.find((node): node is ts.ImportDeclaration => ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./svg-helpers");
    const bindings = imported?.importClause?.namedBindings;
    const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name.text) : [];
    expect(names).toContain("walkElements");
    if (name !== "svgexport") expect(names).toContain("cssString");
    const visits = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node)) expect(["cssString", "walkElements", "walk"]).not.toContain(node.name?.text);
      if (name === "motion" && ts.isSwitchStatement(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "effect") {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) expect(clause.expression.text).not.toBe("wait");
        }
      }
      ts.forEachChild(node, visits);
    };
    visits(file);
  }
});
