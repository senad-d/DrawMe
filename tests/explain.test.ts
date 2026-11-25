import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { marked } from "marked";
import { describe, it, expect } from "vitest";
import { explainFile, explainXml } from "../src/explain";

const GRAPH_MODEL = `<mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="tier" value="Backend" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="300" as="geometry"/></mxCell>
  <mxCell id="api" value="API" vertex="1" parent="tier"><mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="db" value="Database" vertex="1" parent="tier" style="shape=cylinder"><mxGeometry x="10" y="120" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="e1" value="reads" edge="1" parent="1" source="api" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
const CONTAINERED = `<mxfile><diagram name="Page-1">${GRAPH_MODEL}</diagram></mxfile>`;

function renderMarkdown(markdown: string) {
  const html = marked.parse(markdown, { async: false });
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
}

describe("explainXml", () => {
  it("describes the same graph as a bare model and a wrapped page", () => {
    expect(explainXml(GRAPH_MODEL)).toBe(explainXml(CONTAINERED));
  });

  it("keeps title, page, component, group and verb text literal in parsed Markdown", () => {
    const xml = `<mxfile>
      <diagram name="[Stage](/stage)"><mxGraphModel><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="group" value="![Tier](/tier.svg)" vertex="1" parent="1"/>
        <mxCell id="api" value="# API" vertex="1" parent="group"/>
        <mxCell id="db" value="Database" vertex="1" parent="group"/>
        <mxCell id="e" value="[reads](/read)" edge="1" parent="1" source="api" target="db"/>
      </root></mxGraphModel></diagram>
      <diagram>compressed-data</diagram>
    </mxfile>`;
    const markdown = explainXml(xml, "Orders\n\n# Notes");
    const structure: string[] = [];
    marked.walkTokens(marked.lexer(markdown), (token) => {
      if (token.type === "heading") structure.push(`h${token.depth}`);
      else if (["link", "image", "html"].includes(token.type)) structure.push(token.type);
    });
    expect.soft(structure).toEqual(["h1", "h2", "h3", "h3", "h2"]);
    const visible = renderMarkdown(markdown).documentElement?.textContent?.replace(/\s+/g, " ") ?? "";
    for (const literal of ["Orders # Notes", "[Stage](/stage)", "![Tier](/tier.svg)", "# API", "[reads](/read)"]) {
      expect(visible).toContain(literal);
    }
  });

  it("keeps autolink-like text and Markdown punctuation in an unlabeled vertex ID literal", () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="https://example.com" vertex="1"/>
      <mxCell id="api" value="API &lt; limit &gt; 0 at www.example.com or ops@example.com" vertex="1"/>
      <mxCell id="e" edge="1" source="api" target="https://example.com"/>
    </root></mxGraphModel>`;
    const html = renderMarkdown(explainXml(xml));
    expect(html.getElementsByTagName("a")).toHaveLength(0);
    expect(Array.from(html.getElementsByTagName("li"), (li) => li.textContent)).toContain(
      "API < limit > 0 at www.example.com or ops@example.com → (unlabeled https://example.com)",
    );
  });

  it("does not interpret a component label as a nested ordered list", () => {
    const xml = '<mxGraphModel><root><mxCell id="a" value="1) Start" vertex="1"/></root></mxGraphModel>';
    const html = renderMarkdown(explainXml(xml));
    expect(html.getElementsByTagName("ol")).toHaveLength(0);
    expect(html.getElementsByTagName("li")[0]?.textContent).toBe("1) Start");
  });

  it("describes wrapped and child edge labels and existing unlabeled endpoints", () => {
    const xml = `<diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="api" value="API" vertex="1" parent="1"/>
      <mxCell id="db" value="Database" vertex="1" parent="1"/>
      <mxCell id="cache" vertex="1" parent="1"/>
      <UserObject id="e1" label="reads"><mxCell edge="1" parent="1" source="api" target="db"/></UserObject>
      <mxCell id="e2" edge="1" parent="1" source="api" target="db"/>
      <mxCell id="label" style="edgeLabel;" value="updates" vertex="1" parent="e2"><mxGeometry relative="1" as="geometry"/></mxCell>
      <mxCell id="e3" edge="1" parent="1" source="api" target="cache"/>
      <mxCell id="e4" edge="1" parent="1" source="api" target="missing"/>
    </root></mxGraphModel></diagram>`;
    const items = Array.from(renderMarkdown(explainXml(xml)).getElementsByTagName("li"), (li) => li.textContent);
    expect(items.filter((text) => text?.includes("→"))).toEqual([
      "API —reads→ Database",
      "API —updates→ Database",
      "API → (unlabeled cache)",
    ]);
  });

  it("includes distinct edge labels in document order and falls back to an inner cell value", () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="a" value="A" vertex="1"/><mxCell id="b" value="B" vertex="1"/>
      <mxCell id="first" value="reads" vertex="1" parent="e"/>
      <object id="e"><mxCell value="writes" edge="1" source="a" target="b"/></object>
      <mxCell id="duplicate" value="reads" style="edgeLabel;" vertex="1" parent="e"/>
      <object id="last" label="commits"><mxCell vertex="1" parent="e"/></object>
    </root></mxGraphModel>`;
    const items = Array.from(renderMarkdown(explainXml(xml)).getElementsByTagName("li"), (li) => li.textContent);
    expect(items).toEqual(["A", "B", "A —reads; writes; commits→ B"]);
  });

  it("replaces invalid numeric references without losing the rest of the explanation", () => {
    const xml = `<diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" value="Before &amp;#x110000; &amp;#55296; after" vertex="1" parent="1"/>
      <mxCell id="b" value="Database" vertex="1" parent="1"/>
    </root></mxGraphModel></diagram>`;
    const visible = renderMarkdown(explainXml(xml)).documentElement?.textContent;
    expect(visible).toContain("Before \uFFFD \uFFFD after");
    expect(visible).toContain("Database");
  });

  it("preserves valid XML references when replacing raw out-of-range references", () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="a" value="&#99999999999; &#x1F600; &#34;quoted&#34;" vertex="1"/>
    </root></mxGraphModel>`;
    const visible = renderMarkdown(explainXml(xml)).documentElement?.textContent;
    expect(visible).toContain('� 😀 "quoted"');
  });

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

  it("distinguishes missing graph data from compressed pages", () => {
    expect(explainXml("<diagram/>")).toContain("missing graph model");
    expect(explainXml("<mxGraphModel/>")).toContain("missing graph root");
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

describe("explainFile", () => {
  it("rejects non-regular input through bounded XML intake", async () => {
    await expect(explainFile(fileURLToPath(new URL(".", import.meta.url)))).rejects.toThrow("not a regular file");
  });
});
