# Troubleshooting — Common Mistakes

Read this when something looks wrong in the output (rendering, export, layout, edges) or when a CLI invocation fails. Most rows have a one-line fix.

| Mistake | Fix |
|---------|-----|
| Missing `id="0"` and `id="1"` root cells | Always include both at the top of `<root>` |
| Shapes not connected | `source` and `target` on edge must match existing shape `id` values |
| Self-closing edge `mxCell` (`<mxCell ... edge="1" />`) | Use the expanded form with `<mxGeometry relative="1" as="geometry" />` child — self-closing edges won't render |
| `--` inside XML comments | Illegal per XML spec — use single hyphens or rephrase |
| Special characters in `value` | Use XML entities: `&amp;` `&lt;` `&gt;` `&quot;` |
| Literal `\n` in label text | Use `&#xa;` for line breaks in `value` attributes |
| Overlapping shapes | Scale spacing with complexity (200–350px) and leave routing corridors; move elements apart and run `drawio_fit_canvas` so the page grows around the content — never shrink elements to fit the page |
| Edges crossing through shapes | Add waypoints, distribute entry/exit points, or increase spacing |
| Arrowhead overlaps bend | Final edge segment before target must be ≥20px — increase spacing or add waypoints |
| Automatic correction loop reaches its limit | Pass inspection previews (the first preview of each review pass) do not consume retries. Allow at most **8 correction retries total**; each retry is one targeted source edit → `drawio_validate` → replacement preview cycle. If a finding remains at the limit, stop editing, keep the best validated state, finish the remaining passes as inspection-only, continue to final export, and name the unresolved finding and its pass in the final report — never loop or wait for input. |
| `command not found: draw.io` after `brew install --cask drawio` | Homebrew installs the binary as `drawio` (no dot). Use `drawio --version`, not `draw.io --version`. The dot-name only exists inside the `.app` bundle (`/Applications/draw.io.app/Contents/MacOS/draw.io`) and on Windows (`draw.io.exe`). |
| Export command not found on macOS | Try full path `/Applications/draw.io.app/Contents/MacOS/draw.io` |
| Vision reports that the preview dimensions are too large | Re-export with `drawio_export` in preview mode and set a smaller `width`. If a 2000px full-diagram preview makes labels unreadable, tighten the canvas, simplify or split the layout, or use a focused review artifact. |
| Linux: renderer unavailable when running Pi as root | Restart Pi as an unprivileged user. DrawMe refuses to launch the Linux renderer as root rather than disable its sandbox. |
| Linux: no display | Install Xvfb (`xvfb-run` must be on PATH), then run `/drawme-check` in Pi. DrawMe uses Xvfb automatically for discovery and rendering when no display is available. |
| Linux: draw.io cannot access its home/app-data directory | Run Pi as a user with a writable home directory. |
| PDF export fails | Ensure Chromium is available (draw.io bundles it on desktop) |
| Background color wrong in CLI export | Known CLI bug; add `--transparent` flag or set background via style |
| Vision returns "Could not process image" | Use `drawio_export` in PNG preview mode, which verifies the image and omits editable XML, instead of attaching a final embedded PNG. |
| Final embedded PNG won't open in image viewers | Export it again with `drawio_export` in final mode. The tool automatically repairs draw.io's truncated IEND chunk. SVG/PDF are unaffected. |
| WSL: `drawio` not found | Install the native Linux draw.io desktop CLI inside WSL; DrawMe cannot use the Windows `.exe` from WSL. If headless, install Xvfb too. |

For a custom installation or an unavailable renderer, see [CLI discovery](../../docs/reference.md#drawio_check).
