# Style presets

Every diagram uses exactly one theme, and every output of it (preview PNG, final PNG/SVG/PDF/JPG, animated SVG, storyboard) shows that same theme.

| Theme | When to use |
|-------|-------------|
| **Light** | The default. Use it whenever the user does not explicitly ask for something else. |
| **Dark** | Only when the user explicitly asks for a dark theme, dark background, or dark mode. |
| **Multi-color** | Only when the user explicitly asks for multiple colors, color-coded roles, or a colorful diagram. It applies on Light, or on Dark when the user asks for both. |

Never switch themes on your own because a diagram type, a slide, or a README seems to suit one. A request for a "modern" or "clean" look is still Light. Diagram-type presets and the classic palette in the XML authoring reference contribute structural style keys only (`shape=`, `swimlane`, arrows, `dashed`); replace their colors with the active theme's colors unless the user asks for that notation's standard colors.

## Applying a theme

- **Set the page background** on the model, for example `<mxGraphModel background="#FFFFFF" ...>`. Every export, the animated SVG, and the storyboard read it. DrawMe pins exported SVGs to the authored colors, so a viewer in dark mode never inverts a Light diagram or brightens a Dark one.
- **One primary path.** Draw the main flow with the accent edge style (thicker, accent color) and every secondary connection with the neutral edge style. The reader should see the story before reading a label.
- **Accent with restraint.** In Light and Dark, the accent marks only the main path, numbered step badges, and the one or two nodes the diagram is about. Everything else is neutral.
- **Hierarchy through type.** Put a title (28px bold) and a one-line subtitle (16px, muted) top-left as `text` cells. Node labels use a bold name plus a muted detail line: `value="&lt;b&gt;API&lt;/b&gt;&lt;br&gt;&lt;font style=&quot;font-size:12px&quot; color=&quot;#64748B&quot;&gt;Process request&lt;/font&gt;"` (use the theme's muted color).
- **Shape language.** Rounded corners with a fixed radius (`absoluteArcSize=1;arcSize=12;`), 1.5px strokes, no `shadow=1` (draw.io's shadow is heavy and dated), generous inner padding (`spacing=12;`). Keep peer nodes the same size.
- **Containers recede.** Zones and groups use a near-background tint, a hairline stroke, and a small title at the top-left. They never compete with the nodes they hold.
- **Numbered steps.** For a sequence, put a 28×28 accent badge with the number beside each step instead of numbering inside the label.
- **Whitespace is part of the design.** Keep the spacing table from the XML authoring reference, align everything to a 10px grid, and run `drawio_fit_canvas`.
- **Edge labels** use the page background as `labelBackgroundColor` so they sit cleanly on lines.
- **Icons.** Prefer official vendor icons from `drawio_shapesearch` at a consistent size (48×48 inside or beside a node). Never mix icon families in one diagram.
- **Legend.** Light and Dark need none unless the accent needs explaining. Multi-color lists exactly the roles used.

## Light (default)

Page background `#FFFFFF`. Title `#0F172A`, body text `#1E293B`, muted text `#64748B`. Accent `#2563EB`.

| Element | fillColor | strokeColor | fontColor |
|---------|-----------|-------------|-----------|
| Node | `#FFFFFF` | `#CBD5E1` | `#0F172A` |
| Focus node (the one or two the diagram is about) | `#EFF6FF` | `#2563EB` | `#1E3A8A` |
| External / secondary node | `#F8FAFC` | `#CBD5E1` | `#475569` |
| Container / zone | `#F8FAFC` | `#E2E8F0` | `#64748B` |
| Edge | — | `#94A3B8` | `#475569` |
| Main-path edge | — | `#2563EB` | `#475569` |
| Badge | `#2563EB` | `none` | `#FFFFFF` |

Ready-to-use styles:

```text
Node:       rounded=1;absoluteArcSize=1;arcSize=12;whiteSpace=wrap;html=1;fontFamily=Helvetica;fontSize=14;spacing=12;strokeWidth=1.5;fillColor=#FFFFFF;strokeColor=#CBD5E1;fontColor=#0F172A;
Focus node: same as Node with fillColor=#EFF6FF;strokeColor=#2563EB;fontColor=#1E3A8A;
Database:   shape=cylinder3;size=12;boundedLbl=1;whiteSpace=wrap;html=1;fontFamily=Helvetica;fontSize=14;strokeWidth=1.5;fillColor=#FFFFFF;strokeColor=#CBD5E1;fontColor=#0F172A;
Container:  rounded=1;absoluteArcSize=1;arcSize=16;whiteSpace=wrap;html=1;container=1;pointerEvents=0;verticalAlign=top;align=left;spacingLeft=16;spacingTop=10;fontFamily=Helvetica;fontSize=13;fontStyle=1;strokeWidth=1.5;fillColor=#F8FAFC;strokeColor=#E2E8F0;fontColor=#64748B;
Edge:       edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#94A3B8;strokeWidth=1.5;endArrow=blockThin;endFill=1;endSize=6;fontFamily=Helvetica;fontSize=12;fontColor=#475569;labelBackgroundColor=#FFFFFF;
Main edge:  same as Edge with strokeColor=#2563EB;strokeWidth=2;
Badge:      ellipse;aspect=fixed;html=1;fillColor=#2563EB;strokeColor=none;fontColor=#FFFFFF;fontStyle=1;fontSize=13;
Title:      text;html=1;align=left;verticalAlign=middle;fontFamily=Helvetica;fontSize=28;fontStyle=1;fontColor=#0F172A;
Subtitle:   text;html=1;align=left;verticalAlign=middle;fontFamily=Helvetica;fontSize=16;fontColor=#64748B;
```

## Dark (on request)

Page background `#0B1220`. Title `#F8FAFC`, body text `#E2E8F0`, muted text `#94A3B8`. Accent `#60A5FA`.

| Element | fillColor | strokeColor | fontColor |
|---------|-----------|-------------|-----------|
| Node | `#111827` | `#334155` | `#F1F5F9` |
| Focus node | `#0F1E3D` | `#60A5FA` | `#DBEAFE` |
| External / secondary node | `#0F172A` | `#334155` | `#94A3B8` |
| Container / zone | `#0F172A` | `#1F2937` | `#94A3B8` |
| Edge | — | `#475569` | `#CBD5E1` |
| Main-path edge | — | `#60A5FA` | `#CBD5E1` |
| Badge | `#3B82F6` | `none` | `#FFFFFF` |

Use the Light styles with these colors and `labelBackgroundColor=#0B1220;` on edges. Muted label detail lines use `color="#94A3B8"`.

## Multi-color (on request)

Keep the Light or Dark base (background, text, edges, containers, badges) and color nodes by role. Use at most four roles per diagram and add a legend of exactly the roles used.

| Role | Light fill / stroke / font | Dark fill / stroke / font |
|------|----------------------------|---------------------------|
| Service / client | `#EFF6FF` / `#3B82F6` / `#1E3A8A` | `#0F1E3D` / `#60A5FA` / `#DBEAFE` |
| API / gateway | `#EEF2FF` / `#6366F1` / `#312E81` | `#1A1B3D` / `#818CF8` / `#E0E7FF` |
| Data / storage | `#ECFDF5` / `#10B981` / `#064E3B` | `#0B2A22` / `#34D399` / `#D1FAE5` |
| Queue / event | `#FFFBEB` / `#F59E0B` / `#78350F` | `#2A2110` / `#FBBF24` / `#FEF3C7` |
| Security / auth | `#F5F3FF` / `#8B5CF6` / `#4C1D95` | `#221A3D` / `#A78BFA` / `#EDE9FE` |
| Error / alert | `#FEF2F2` / `#EF4444` / `#7F1D1D` | `#2D1416` / `#F87171` / `#FEE2E2` |
| External / neutral | `#F8FAFC` / `#94A3B8` / `#334155` | `#1E293B` / `#64748B` / `#CBD5E1` |

## Motion design

Motion follows the theme: `drawio_animate` uses the theme accent for `highlight` and `travel` by default (`#2563EB` on a light page, `#60A5FA` on a dark one). Pass `color` only to match a Multi-color role. The motion should explain the diagram, not decorate it:

- **Tell the story in order.** Reveal the title, then the first actor, then each hop of the main path: `popIn` or `slideIn` the node, `drawIn` the connector to the next node, `popIn` that node. Reveal containers before their children.
- **Cascade peers.** Reveal a row of similar nodes in one step with `stagger` 80–150ms rather than one step per node.
- **Show traffic after structure.** Once everything is visible, `travel` dots along the main path (use `parallel` to run several hops as a pipeline), then `highlight` the focus node.
- **Focus by dimming.** `dim` everything except the part being explained, then `fadeIn` it back.
- **Pace for reading.** Entrances 400–700ms, connector draw-in 600–1000ms, a 300–600ms `wait` after each logical group, and a loop `hold` of 1500–2500ms so the final state can be read. Keep one full loop under about 15 seconds.
- **Restraint.** Animate the primary path and its nodes; leave legends and annotations static or reveal them once at the end.
