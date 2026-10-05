# Screenshot marks

Arrows, boxes, ellipses, highlighter, text, numbered steps, spotlight (dim everything but one
area) and blur (hide personal data) are stored as data next to the image
(`<image>.annotations.json`, `schemas/annotations.schema.json`). They never change the original
pixels: the viewer draws them on a canvas, and the "Marks" toggle shows the raw screenshot.

Three writers, one sidecar:

- **Test Agent, while testing.** Each brief points to `tc/<id>/.capture.js`. The agent sets
  `file` and `marks` (selector + type + label) and runs it with `browser_run_code_unsafe`. In one
  call it measures element boxes from the live DOM, takes the screenshot, and stores the marks
  plus an `elements` map of those boxes.
- **Chat agent or orchestrator.** `$Q annotate <run> <tc> <image> --list | --add '<json>'
  [--replace] | --remove <ids|all>`. `$Q annotate --help` prints the mark syntax. `--list` prints
  the image size and the captured element boxes, so a mark can land on an element without guessing.
- **Reviewer, in the viewer.** "Edit marks" on a screenshot; tools `v a b e h t s f x`, color
  swatches, label, move, undo, delete. "Save marks" writes the sidecar; "Export PNG" writes a
  flattened copy to `tc/<id>/exports/`.
