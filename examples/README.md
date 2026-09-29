# Examples

## tree.ts: markdown to a PageIndex tree, no LLM

```sh
bun examples/tree.ts                    # bundled sample: sample-design-doc.md
bun examples/tree.ts path/to/doc.md     # opt in: your own markdown file
bun examples/tree.ts --page-lines 15    # lines per virtual page for the merge (default 30)
```

The bundled `sample-design-doc.md` is an invented design document for "Lanternfish", a fictional feature-flag service. It has nested sections, tables and code blocks, and one bold-only line, so every part of the tree builder is exercised.

The demo runs `mdToTree` with `addNodeSummary: false`, so it makes no LLM calls and needs no API key. It then renders:

- the pipeline stages, timed from the library's own progress messages;
- document stats: lines, headings, tree nodes, roots, depth and approximate tokens (`countTokens` estimates about 4 characters per token);
- the tree: node ids, heading level (`h1` to `h6`, or `**` for a bold-only line, which upstream PageIndex v0.2.19 treats as a level-1 heading), the line range each node covers including its children, approximate tokens, and a map of where the section sits in the file;
- the deterministic tree merge. `mergeTree` collapses any subtree whose structure does not beat a linear scan, and keeps the removed titles on the parent as `keyItems` (marked `◆`).

`mergeTree` works on page ranges. In the library it runs as part of the PDF pipeline, while markdown mode records line numbers, not pages. To show the merge on markdown, the demo runs the real `mergeTree` on a copy of the tree in which each "page" is a 30-line chunk (`--page-lines` changes this). The tree returned by `mdToTree` is not changed.

It imports the library straight from `../src`, so no build step is needed.

## Styling

The demo uses [`@oakoliver/lipgloss`](https://www.npmjs.com/package/@oakoliver/lipgloss) for styling when it is installed (`bun add -d @oakoliver/lipgloss`). It is not a dependency of this package. Without it, `style.ts` falls back to a small built-in subset of the same API that prints plain truecolor ANSI, so the output looks almost the same. Set `NO_LIPGLOSS=1` to force the fallback.

Type-check with `bunx tsc --noEmit -p examples/tsconfig.json`.
