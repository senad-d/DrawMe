import { describe, it, expect } from "vitest";
import { explainXml } from "../src/explain";

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
      <diagram name="Two"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="y" value="Y" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      </root></mxGraphModel></diagram>
    </mxfile>`;
    const md = explainXml(xml);
    expect(md).toContain("## Page 1: One");
    expect(md).toContain("## Page 2: Two");
  });
});
