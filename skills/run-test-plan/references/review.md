# Step 5 — Review and report

## Review (human in the loop)

Tell the human the run is ready in the viewer and give the counts. They mark each case
**Approve / Needs retest / Reject** with a comment, which lands in `review.json`. Shortcuts:
`j`/`k` move between cases, `a`/`n`/`r` pick a verdict, `c` focuses the comment, `Ctrl+Enter`
saves and jumps to the next unreviewed case, `?` lists them all.

Treat the verdicts as decisions:

- `approved` → can be reported.
- `needs-retest` / `rejected` → `$Q init <plan> --retest <runId>` creates a new run with exactly
  those cases (plus any fail/blocked/pending). The comment tells you what to change in the plan
  or brief first.

## Report

Draft the issue comment from `run.json` + `review.json`, following the user's own comment rules
if they have any, and post or transition only after the human confirms. Cite the run id instead
of local paths. Screenshots with marks can be flattened with the viewer's "Export PNG"
(`tc/<id>/exports/`) to attach them.
