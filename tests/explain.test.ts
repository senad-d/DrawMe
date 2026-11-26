import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { marked } from "marked";
import { describe, it, expect } from "vitest";
import { DEFAULT_VALIDATION_LIMITS } from "../src/diagram-files";
import { explainFile, explainXml } from "../src/explain";

function visibleText(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  return new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").documentElement?.textContent ?? "";
}

const CONTAINERED = `<mxfile><diagram name="Page-1"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="tier" value="Backend" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="300" as="geometry"/></mxCell>
  <mxCell id="api" value="API" vertex="1" parent="tier"><mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="db" value="Database" vertex="1" parent="tier" style="shape=cylinder"><mxGeometry x="10" y="120" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="e1" value="reads" edge="1" parent="1" source="api" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

describe("explainXml", () => {
  it("lists components grouped by container and annotates shape types", () => {
    const md = explainXml(CONTAINERED, "svc");
    expect(md).toContain("# svc");
    expect(md).toContain("### Components (2)");
    expect(md).toContain("- **Backend**");
    expect(md).toContain("  - API");
    expect(md).toContain("Database _data store_"); // cylinder -> data store
  });

  it("renders relations with the edge label as the verb", () => {
    const md = explainXml(CONTAINERED, "svc");
    expect(md).toContain("### Relations (1)");
    expect(md).toContain("- API —reads→ Database");
  });

  it("strips HTML formatting from labels", () => {
    const xml = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="api" value="&lt;b&gt;API&lt;/b&gt;&lt;br&gt;Gateway" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="80" height="40" as="geometry"/>
      </mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    expect(explainXml(xml)).toContain("- API Gateway");
  });

  it("decodes doubly encoded numeric entities and preserves empty delimiters", () => {
    const xml = `<diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="encoded" value="&amp;#x41;&amp;#80;&amp;nbsp;&lt;&gt;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="80" height="40" as="geometry"/>
      </mxCell>
    </root></mxGraphModel></diagram>`;
    expect(explainXml(xml)).toContain("- AP <>");
  });

  it("unwraps UserObject and object cells", () => {
    const xml = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <UserObject id="user" label="User wrapper"><mxCell vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></UserObject>
      <object id="object" value="Object wrapper"><mxCell vertex="1" parent="1"><mxGeometry x="100" y="0" width="80" height="40" as="geometry"/></mxCell></object>
    </root></mxGraphModel></diagram></mxfile>`;
    const md = explainXml(xml);
    expect(md).toContain("- User wrapper");
    expect(md).toContain("- Object wrapper");
  });

  it("describes unlabeled and id-less vertices", () => {
    const xml = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="mystery" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      <mxCell vertex="1"><mxGeometry x="100" y="0" width="80" height="40" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const md = explainXml(xml);
    expect(md).toContain("- (unlabeled mystery)");
    expect(md).toContain("- (unlabeled null)");
  });

  it("describes compressed pages without throwing", () => {
    const md = explainXml(`<mxfile><diagram name="Packed">compressed-data</diagram></mxfile>`);
    expect(md).toContain("_(compressed page — cannot describe)_");
  });

  it("skips edges with a dangling endpoint", () => {
    const xml = `<mxfile><diagram name="P"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="e" edge="1" parent="1" source="a" target="ghost"><mxGeometry relative="1" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const md = explainXml(xml);
    expect(md).toContain("### Relations (0)");
    expect(md).toContain("_(none)_");
  });

  it("describes a bare graph the same way as its wrapped page", () => {
    const model = `<mxGraphModel><root><mxCell id="a" value="API" vertex="1"/></root></mxGraphModel>`;
    expect(explainXml(model)).toBe(explainXml(`<mxfile><diagram>${model}</diagram></mxfile>`));
  });

  it("keeps source text literal in the title, page, group, node, fallback ID and verb", () => {
    const xml = `<mxfile><diagram name="![Page](page.png)"><mxGraphModel><root>
      <mxCell id="group" value="[Group](group.md)" vertex="1"/>
      <mxCell id="a" value="**Node**" vertex="1" parent="group"/>
      <mxCell id="[id](id.md)" vertex="1" parent="group"/>
      <mxCell id="b" value="Other" vertex="1" parent="group"/>
      <mxCell id="e" value="[calls](verb.md)" edge="1" source="a" target="b"/>
    </root></mxGraphModel></diagram><diagram>compressed</diagram></mxfile>`;
    const markdown = explainXml(xml, "<mark>Title</mark>\n## Extra heading");
    const structure: string[] = [];
    marked.walkTokens(marked.lexer(markdown), (token) => {
      if (token.type === "heading") structure.push(`h${token.depth}`);
      if (["html", "link", "image", "strong"].includes(token.type)) structure.push(token.type);
    });
    expect(structure).toEqual(["h1", "h2", "h3", "strong", "h3", "h2"]);
    const text = visibleText(markdown);
    for (const literal of [
      "<mark>Title</mark>", "## Extra heading", "![Page](page.png)", "[Group](group.md)",
      "**Node**", "[id](id.md)", "[calls](verb.md)",
    ]) expect(text).toContain(literal);
  });

  it("keeps explicit and bare autolinks as visible literal text", () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="a" vertex="1" value="&lt;https://example.org&gt;"/>
      <mxCell id="b" vertex="1" value="ops@example.org"/>
    </root></mxGraphModel>`;
    const markdown = explainXml(xml, "www.example.org");
    const links: string[] = [];
    marked.walkTokens(marked.lexer(markdown), (token) => {
      if (token.type === "link") links.push(token.href);
    });
    expect(links).toEqual([]);
    const text = visibleText(markdown);
    for (const literal of ["www.example.org", "<https://example.org>", "ops@example.org"]) expect(text).toContain(literal);
  });

  it("uses wrapped and child edge labels and names existing unlabeled endpoints", () => {
    const xml = `<diagram><mxGraphModel><root>
      <mxCell id="a" value="A" vertex="1"/>
      <mxCell id="b" value="B" vertex="1"/>
      <mxCell id="c" vertex="1"/>
      <object id="wrapped" label="wraps"><mxCell edge="1" source="a" target="b"/></object>
      <mxCell id="edge" edge="1" source="b" target="a"/>
      <mxCell id="caption" value="labels" vertex="1" parent="edge" style="edgeLabel;"/>
      <mxCell id="unlabeled" edge="1" source="a" target="c"/>
      <mxCell id="dangling" edge="1" source="a" target="missing"/>
    </root></mxGraphModel></diagram>`;
    const text = visibleText(explainXml(xml));
    expect.soft(text).toContain("A —wraps→ B");
    expect.soft(text).toContain("B —labels→ A");
    expect.soft(text).toContain("A → (unlabeled c)");
    expect(text).toContain("Relations (3)");
  });

  it("keeps multiple child labels in document order without listing them as components", () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="a" value="A" vertex="1"/>
      <mxCell id="b" value="B" vertex="1"/>
      <mxCell id="e" value="calls" edge="1" source="a" target="b"/>
      <mxCell id="z" value="on success" vertex="1" parent="e"><mxGeometry relative="1"/></mxCell>
      <UserObject id="c" value="with retries"><mxCell vertex="1" parent="e" style="edgeLabel;"/></UserObject>
    </root></mxGraphModel>`;
    const text = visibleText(explainXml(xml));
    expect.soft(text).toContain("Components (2)");
    expect(text).toContain("A —calls; on success; with retries→ B");
  });

  it("still explains later relations after encountering an out-of-range numeric reference", () => {
    const xml = CONTAINERED.replace('value="API"', 'value="API &amp;#x110000;"');
    expect(visibleText(explainXml(xml))).toContain("—reads→ Database");
  });

  it("adds page headings for a multi-page file", () => {
    const xml = `<mxfile>
      <diagram name="One"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="x" value="X" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      </root></mxGraphModel></diagram>
      <diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="y" value="Y" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      </root></mxGraphModel></diagram>
    </mxfile>`;
    const md = explainXml(xml);
    expect(md).toContain("## Page 1: One");
    expect(md).toContain("## Page 2\n");
  });
});

it("rejects a diagram file larger than the shared byte ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawme-explain-"));
  try {
    const path = join(dir, "oversized.drawio");
    await writeFile(path, CONTAINERED + " ".repeat(DEFAULT_VALIDATION_LIMITS.maxBytes));
    await expect(explainFile(path)).rejects.toThrow(/byte limit/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
