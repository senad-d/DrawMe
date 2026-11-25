import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { fitCanvasFile } from "../src/fitcanvas";
import { validateXml } from "../src/validate";

async function inTmp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "drawme-fit-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function wrap(model: string, name = "P1"): string {
  return `<mxfile><diagram name="${name}">${model}</diagram></mxfile>`;
}

const CRAMPED = wrap(`<mxGraphModel page="1" pageScale="1" pageWidth="400" pageHeight="300"><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="b" value="B" vertex="1" parent="1"><mxGeometry x="800" y="500" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="500" y="70"/></Array></mxGeometry></mxCell>
</root></mxGraphModel>`);

describe("fitCanvasFile", () => {
  it("grows a cramped page so boundary and margin warnings disappear", () =>
    inTmp(async (dir) => {
      const file = join(dir, "cramped.drawio");
      await writeFile(file, CRAMPED);
      expect(validateXml(CRAMPED).warnings.some((w) => w.includes("beyond right page boundary"))).toBe(true);

      const result = await fitCanvasFile({ input: file });
      expect(result.changed).toBe(true);
      expect(result.pages).toEqual([
        {
          page: "P1",
          status: "fitted",
          before: { width: 400, height: 300 },
          after: { width: 960, height: 600 },
          shift: { dx: 0, dy: 0 },
        },
      ]);

      const fitted = await readFile(file, "utf8");
      expect(fitted).toContain('pageWidth="960"');
      expect(fitted).toContain('pageHeight="600"');
      const after = validateXml(fitted);
      expect(after.warnings.filter((w) => w.includes("boundary") || w.includes("outer margin"))).toEqual([]);
    }));

  it("shifts negative content (and floating edge points) to the margin without touching container children", () =>
    inTmp(async (dir) => {
      const xml = wrap(`<mxGraphModel page="1"><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="c" vertex="1" parent="1" style="container=1"><mxGeometry x="-100" y="10" width="300" height="200" as="geometry"/></mxCell>
        <mxCell id="c1" vertex="1" parent="c"><mxGeometry x="20" y="30" width="80" height="40" as="geometry"/></mxCell>
        <mxCell id="f" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="100" as="sourcePoint"/><mxPoint x="150" y="100" as="targetPoint"/></mxGeometry></mxCell>
      </root></mxGraphModel>`);
      const file = join(dir, "shift.drawio");
      await writeFile(file, xml);

      const result = await fitCanvasFile({ input: file });
      expect(result.pages[0].status).toBe("fitted");
      expect(result.pages[0].shift).toEqual({ dx: 140, dy: 30 });

      const fitted = await readFile(file, "utf8");
      expect(fitted).toContain('x="40" y="40" width="300"'); // container shifted to the margin
      expect(fitted).toContain('x="20" y="30" width="80"'); // child keeps container-relative coords
      expect(fitted).toContain('x="140" y="130" as="sourcePoint"');
      expect(fitted).toContain('x="290" y="130" as="targetPoint"');
    }));

  it("fits an edge-only page around both floating terminals", () =>
    inTmp(async (dir) => {
      const file = join(dir, "edge-only.drawio");
      await writeFile(file, wrap(`<mxGraphModel page="1" pageWidth="500" pageHeight="400"><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="e" edge="1" parent="1"><mxGeometry relative="1" as="geometry">
          <mxPoint x="-80" y="10" as="sourcePoint"/><mxPoint x="120" y="70" as="targetPoint"/>
        </mxGeometry></mxCell>
      </root></mxGraphModel>`));

      const result = await fitCanvasFile({ input: file, margin: 20 });
      expect(result.pages[0].status).toBe("fitted");
      const fitted = new DOMParser().parseFromString(await readFile(file, "utf8"), "text/xml");
      const model = fitted.getElementsByTagName("mxGraphModel").item(0)!;
      const ends = Array.from(fitted.getElementsByTagName("mxPoint"));
      expect([model.getAttribute("pageWidth"), model.getAttribute("pageHeight")]).toEqual(["240", "100"]);
      expect(ends.map((end) => [end.getAttribute("x"), end.getAttribute("y")])).toEqual([["20", "20"], ["220", "80"]]);
    }));

  it("fits a parent-relative free end without counting hidden or stale attached points", () =>
    inTmp(async (dir) => {
      const file = join(dir, "nested-edge.drawio");
      await writeFile(file, wrap(`<mxGraphModel page="1"><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="hidden" parent="0" visible="0"/>
        <object id="c" label="Group"><mxCell vertex="1" parent="1">
          <mxGeometry x="100" y="80" width="80" height="60" as="geometry"/>
        </mxCell></object>
        <mxCell id="a" vertex="1" parent="c"><mxGeometry x="10" y="10" width="20" height="20" as="geometry"/></mxCell>
        <mxCell id="e" edge="1" parent="c" source="a"><mxGeometry relative="1" as="geometry">
          <mxPoint x="1000" y="1000" as="sourcePoint"/><mxPoint x="400" y="-30" as="targetPoint"/>
        </mxGeometry></mxCell>
        <mxCell id="draft" edge="1" parent="hidden"><mxGeometry relative="1" as="geometry">
          <mxPoint x="-900" y="900" as="sourcePoint"/><mxPoint x="-800" y="900" as="targetPoint"/>
        </mxGeometry></mxCell>
      </root></mxGraphModel>`));

      await fitCanvasFile({ input: file, margin: 20 });
      const fitted = new DOMParser().parseFromString(await readFile(file, "utf8"), "text/xml");
      const model = fitted.getElementsByTagName("mxGraphModel").item(0)!;
      const container = fitted.getElementById("c")!.getElementsByTagName("mxCell").item(0)!;
      const origin = container.getElementsByTagName("mxGeometry").item(0)!;
      const end = fitted.getElementById("e")!.getElementsByTagName("mxPoint").item(1)!;
      const coords = ["x", "y"].map((key) => Number(origin.getAttribute(key)) + Number(end.getAttribute(key)));
      expect(coords, "absolute free end should be at the right and top margin").toEqual([
        Number(model.getAttribute("pageWidth")) - 20,
        20,
      ]);
      expect([model.getAttribute("pageWidth"), model.getAttribute("pageHeight")]).toEqual(["440", "130"]);
      expect([end.getAttribute("x"), end.getAttribute("y")]).toEqual(["400", "-30"]);
      expect(container.hasAttribute("id")).toBe(false);
      expect(container.hasAttribute("value")).toBe(false);
    }));

  it("honours pageScale when computing page dimensions", () =>
    inTmp(async (dir) => {
      const xml = wrap(`<mxGraphModel page="1" pageScale="2"><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="a" vertex="1" parent="1"><mxGeometry x="40" y="40" width="800" height="400" as="geometry"/></mxCell>
      </root></mxGraphModel>`);
      const file = join(dir, "scaled.drawio");
      await writeFile(file, xml);
      const result = await fitCanvasFile({ input: file });
      expect(result.pages[0].after).toEqual({ width: 440, height: 240 }); // (content + 2*40) / 2
    }));

  it("is idempotent and reports unchanged on the second run", () =>
    inTmp(async (dir) => {
      const file = join(dir, "twice.drawio");
      await writeFile(file, CRAMPED);
      await fitCanvasFile({ input: file });
      const second = await fitCanvasFile({ input: file });
      expect(second.changed).toBe(false);
      expect(second.pages[0].status).toBe("unchanged");
    }));

  it("handles multi-page files: fits normal pages, skips compressed and infinite ones", () =>
    inTmp(async (dir) => {
      const xml = [
        "<mxfile>",
        `<diagram name="ok"><mxGraphModel page="1" pageWidth="100" pageHeight="100"><root>`,
        `<mxCell id="0"/><mxCell id="1" parent="0"/>`,
        `<mxCell id="a" vertex="1" parent="1"><mxGeometry x="10" y="10" width="200" height="100" as="geometry"/></mxCell>`,
        "</root></mxGraphModel></diagram>",
        `<diagram name="zip">jVPBcuIwDP0az0IPnUnTFsoRKC0F2u1ml3ZvxhaJB8fO2Ekh/fpVEgcCw+zsJbGfnp4lWWZ0nO4fLc+SpRGgWHgl9oyOWRgO6HXwj0DZAP1e0ACxlaIl9UAkv8GDVx4tpID8hFgYowqZnYLCaA2iOMG4tWZ3StsadXpqxmM4A6INV+foRooiadG7Qb/DZyDjxJ8c9EMflHJP9pnkCRe7Iyi9Z3RsjSmaVbofgzqp5aQwvyLNQlZ3RwSNPPihVa2/JzeVzZKJd8sVLIeXtvXtF1elT9YHW+xdU4Oi8ndkE6NNZTGCbHu8VaIU8x0FRhg3TXFDJGqZQz2rilKTMcHVU4NgcHwqKn0K1c3nfMHtBoqadHf3+Y6MyGh0PPmMFm/Ru3ldPk1XX2P9+7hMhpv1x2q6nsxHmM9m9dtOtqvN9uXnPPtDCcQFP0d/Nnr9GsRZOZ+8/JLTOJlM47nQGvNfLmYbjO2M2FL3iA6nSbYU6PZm06GJyHOsjM70XjIRPUlPUnCM6IjRVDpH+d0LFsp8W5pcugJVCcHiEuqOx9RhkzuUHYSFDxjOTgeoHiPFj+83VMEwB2r5Sy7bDkOs+lU3jFcDNjECqI7QzZlU5NAG0eLc42tCggnUdBhWjJqIS6UwWtBBSaOb+PhRC0k1UMKLySnb+eSXOYmxRq7T6WYysimGXk0DVjcicjkVgLKz18lyIRR6bsAvUXtdJTVGZ71OqumRWkE0i7HVUlz3+9RVSMFbz0GDdLZ4RavHKmVaBTgvBWjIeSWtLNprTFyKpH1yzeuvL1IRLb1FzXKgabo9GnYs/qk+SDcvkHnAedC8bYc/1eKkO/8A</diagram>`,
        `<diagram name="inf"><mxGraphModel page="0"><root>`,
        `<mxCell id="0"/><mxCell id="1" parent="0"/>`,
        `<mxCell id="z" vertex="1" parent="1"><mxGeometry x="5" y="5" width="50" height="50" as="geometry"/></mxCell>`,
        "</root></mxGraphModel></diagram>",
        "</mxfile>",
      ].join("");
      const file = join(dir, "multi.drawio");
      await writeFile(file, xml);
      const result = await fitCanvasFile({ input: file });
      expect(result.pages.map((p) => [p.page, p.status])).toEqual([
        ["ok", "fitted"],
        ["zip", "skipped"],
        ["inf", "skipped"],
      ]);
      expect(result.pages[1].reason).toContain("compressed");
      expect(result.pages[2].reason).toContain("infinite");
      const fitted = await readFile(file, "utf8");
      expect(fitted).toContain("jVPBcuIwDP0az0IPnUnTFsoRKC0F2u1ml3ZvxhaJB8fO2Ekh/fpVEgcCw+zsJbGfnp4lWWZ0nO4fLc+SpRGgWHgl9oyOWRgO6HXwj0DZAP1e0ACxlaIl9UAkv8GDVx4tpID8hFgYowqZnYLCaA2iOMG4tWZ3StsadXpqxmM4A6INV+foRooiadG7Qb/DZyDjxJ8c9EMflHJP9pnkCRe7Iyi9Z3RsjSmaVbofgzqp5aQwvyLNQlZ3RwSNPPihVa2/JzeVzZKJd8sVLIeXtvXtF1elT9YHW+xdU4Oi8ndkE6NNZTGCbHu8VaIU8x0FRhg3TXFDJGqZQz2rilKTMcHVU4NgcHwqKn0K1c3nfMHtBoqadHf3+Y6MyGh0PPmMFm/Ru3ldPk1XX2P9+7hMhpv1x2q6nsxHmM9m9dtOtqvN9uXnPPtDCcQFP0d/Nnr9GsRZOZ+8/JLTOJlM47nQGvNfLmYbjO2M2FL3iA6nSbYU6PZm06GJyHOsjM70XjIRPUlPUnCM6IjRVDpH+d0LFsp8W5pcugJVCcHiEuqOx9RhkzuUHYSFDxjOTgeoHiPFj+83VMEwB2r5Sy7bDkOs+lU3jFcDNjECqI7QzZlU5NAG0eLc42tCggnUdBhWjJqIS6UwWtBBSaOb+PhRC0k1UMKLySnb+eSXOYmxRq7T6WYysimGXk0DVjcicjkVgLKz18lyIRR6bsAvUXtdJTVGZ71OqumRWkE0i7HVUlz3+9RVSMFbz0GDdLZ4RavHKmVaBTgvBWjIeSWtLNprTFyKpH1yzeuvL1IRLb1FzXKgabo9GnYs/qk+SDcvkHnAedC8bYc/1eKkO/8A");
    }));

  it("writes to a separate output when asked and leaves the input untouched", () =>
    inTmp(async (dir) => {
      const input = join(dir, "in.drawio");
      const output = join(dir, "out.drawio");
      await writeFile(input, CRAMPED);
      const result = await fitCanvasFile({ input, output });
      expect(result.output).toBe(output);
      expect(existsSync(output)).toBe(true);
      expect(await readFile(input, "utf8")).toBe(CRAMPED);
      expect(await readFile(output, "utf8")).toContain('pageWidth="960"');
    }));

  it("preserves the XML declaration and trailing newline", () =>
    inTmp(async (dir) => {
      const file = join(dir, "decl.drawio");
      await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>\n${CRAMPED}\n`);
      await fitCanvasFile({ input: file });
      const fitted = await readFile(file, "utf8");
      expect(fitted.startsWith("<?xml")).toBe(true);
      expect(fitted.endsWith("\n")).toBe(true);
    }));

  it("skips a page without measurable content and rejects an invalid margin", () =>
    inTmp(async (dir) => {
      const empty = wrap(`<mxGraphModel page="1"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`);
      const file = join(dir, "empty.drawio");
      await writeFile(file, empty);
      const result = await fitCanvasFile({ input: file });
      expect(result.changed).toBe(false);
      expect(result.pages[0]).toMatchObject({ status: "skipped", reason: "no measurable content" });

      await expect(fitCanvasFile({ input: file, margin: -1 })).rejects.toThrow("invalid margin");
    }));
});
