# Changelog

## 3.0.0 — sync with upstream PageIndex v0.5.0

Upstream moved from v0.2.19 (2026-09-21) to v0.5.0 (2026-10-29): 92 commits,
releases 0.2.20–0.2.22 and 0.4.0–0.5.0 (there is no 0.3 release line). Every
change is listed below with its disposition:

- **applies**: ported in this release;
- **Python-only**: belongs to a surface this port does not have (the SDK
  client, chat, agent tools, MCP, cloud API, LiteLLM, Claude Code, Flash);
- **already equivalent**: the port already behaved this way.

### Breaking changes

- **Default index model is `gpt-6-luna`** (was `gpt-5.6-luna`), as upstream 0.4.0.
- **PDF tree shape** (upstream 0.2.21, marked breaking there too):
  - a parent whose first child starts on a later page gets an
    `"<title> (intro)"` child for those opening pages, so node IDs shift;
  - a parent's `startIndex`/`endIndex` now cover its whole section (they used
    to stop where its first child started);
  - with `addNodeText`, a parent's `text` is its own pages only (up to its
    first child's page), and empty when an intro node holds them.
- **PDF summaries are built bottom-up** (upstream 0.2.21): a leaf is
  summarized from its own pages, a parent from its opening pages plus its
  children's summaries. Leaves shorter than a summary (200 tokens) keep their
  own text instead of a model call. Prompts and replies changed (JSON
  `{"summary": ...}`, at most 150 words).
- **Large PDF leaves are split with the LLM.** `maxPageNumEachNode` and
  `maxTokenNumEachNode` were accepted but ignored; a leaf over both limits is
  now re-indexed and split, as upstream has always done.
- **Retries follow upstream's rule** (0.5.0): only network failures and
  408/409/429/5xx are retried; anything else (402, 413, 422, …) throws
  `LLMRetriesExhausted` on the first attempt. Waits honour `Retry-After` and
  back off exponentially, up to 30 s. The OpenAI client no longer adds its own
  two retries per attempt.
- **A structure check out of retries stops the run** instead of reading as
  "no" or being skipped (upstream 0.5.0).
- `verifyToc` also returns `accuracy`; `fixIncorrectToc` only moves an entry
  to the proposed page once the check confirms it (as upstream always did).

### Indexing and tree building

| Upstream change | Version | Disposition |
|---|---|---|
| Intro nodes for parents that open before their first child (`add_intro_nodes`, after `post_processing` and again after large-node splitting) | 0.2.21 (#541, #554) | applies: `addIntroNodes`, used by `buildTree` and the PDF pipeline |
| Parent ranges cover their subtree (`cover_subtree_ranges`) | 0.2.21 | applies: `coverSubtreeRanges` |
| Node text is each node's own pages (`own_pages`) | 0.2.21 | applies: `addNodeText`, `addNodeTextWithLabels`, `ownPages` |
| Merge does not list an intro's title in `key_items` | 0.2.21 | applies: `mergeTree` |
| Large-node split: never split a node that has children; never re-split pages a split above just rebuilt ("PART II" above "Chapter 3" looped forever); an intro's split skips its parent's heading | 0.2.22 (#554) | applies: `processLargeNodeRecursively` (newly ported, with upstream's `process_no_toc` meta-processing as `metaProcessorNoToc`) |
| A TOC item never ends before it starts (`post_processing` clamp) | 0.2.22 | applies: `postProcessing` |
| Start-of-page, verify and fix checks re-raise unrecoverable errors | 0.5.0 (#622) | applies |
| `claude-code/` models refused in standard mode | 0.4.2 | Python-only (no Claude Code route) |
| Token usage reported from local indexing | 0.4.5 (#572) | Python-only (SDK client `usage`); not ported, see below |
| `count_tokens` falls back to the default tokenizer for unknown models | 0.5.0 | already equivalent (the port estimates tokens without a model-specific tokenizer) |

### Summaries and description

| Upstream change | Version | Disposition |
|---|---|---|
| Standard mode summarizes like Flash (`summarize_tree` replaces `generate_summaries_for_structure`); short nodes keep their own text | 0.2.21 | applies: `summarizeTree` (64 at a time in the PDF pipeline) |
| Summaries run deepest node first | 0.2.20 (#432) | applies: priority gate by depth |
| Summary prompts ask for at most `summary_max_words` (150) words and drop the `points` list | 0.2.20 / 0.4.0 | applies; prompts byte-identical to upstream (checked against a fixture generated from upstream's f-strings) |
| Raw-text cutoff is the summary's own length (150 words ≈ 200 tokens) | 0.4.1 (#590) | applies |
| A node left unsummarized falls back to its subsection titles or its text; the all-failed error names the first failure | 0.4.0 / 0.5.0 | applies |
| Document description reads only the top level | 0.4.0 (#566) | applies when summaries are on |
| Summaries start while expand is still deciding (`SummaryScheduler.mark_final`), same-page retitling, shared-page splitting, `summary_reasoning_effort`, `summary_concurrency` / `summary_max_words` knobs, 128-wide Flash summaries | 0.2.20–0.5.0 | Python-only (Flash pipeline) |
| `reasoning_effort="none"` turns Claude's thinking off in summaries | 0.5.0 | Python-only (Flash summaries, LiteLLM routing) |

### Retrieval and search API

| Upstream change | Version | Disposition |
|---|---|---|
| Node navigation: `get_node`, `get_node_parent`, `get_node_path`, `get_node_map` | 0.2.21 (#542) | applies: `getNode`, `getNodeParent`, `getNodePath`, `getNodeMap` |
| `create_node_mapping` reads a node's own range | 0.2.21 | applies: `createNodeMapping` |
| `unify_tree`, `get_tree` wire format, `get_ocr(format="node")` | 0.2.21 | Python-only (SDK client); the port's output already uses `startIndex`/`endIndex`/`summary` |
| Chat, streaming, `ChatObject`, Messages/Responses lanes, prompt-cache history, reasoning round-trips, metadata schemas, citations, `list_documents`, agent tools text | 0.2.20–0.5.0 | Python-only (retrieval and chat client are out of scope) |

### Models and providers

| Upstream change | Version | Disposition |
|---|---|---|
| Default index model `gpt-6-luna` (chat `gpt-6-sol`) | 0.4.0 (#568) | applies (index model; there is no chat model here) |
| Retry rule after the official SDKs: retry 408/409/429/5xx and network failures, honour `Retry-After` (≤ 60 s) and `x-should-retry`, exponential jittered backoff capped at 30 s, 10 attempts, retry a 200 with no choices | 0.5.0 (#622) | applies: `shouldRetry`, `retryAfter`, `retryDelay`; the OpenAI client is created with `maxRetries: 0` |
| A missing OpenAI key fails at once | 0.5.0 | already equivalent (a 401 is never retried) |
| LiteLLM model-map refresh, `drop_params`, `extra_body` checks, Anthropic/Bedrock/Vertex routes, OpenRouter, Claude Code subscription, forked-worker fixes, cloud session retries and read timeouts | 0.2.20–0.5.0 | Python-only (this port talks to OpenAI-compatible endpoints only) |

### Config format and CLI

| Upstream change | Version | Disposition |
|---|---|---|
| `config.yaml` comments name `gpt-6-luna` / `gpt-6-sol` | 0.4.0 | applies (default model; the port has no config file) |
| `LocalIndexConfig` and CLI gain `summary_max_words`, `summary_concurrency`, `summary_reasoning_effort` (Flash mode only) | 0.2.20–0.4.0 | Python-only (Flash) |

### PDF and Markdown handling

| Upstream change | Version | Disposition |
|---|---|---|
| `page_index_md.py` | — | unchanged upstream; nothing to port |
| Flash parser: word gaps from font widths, running headers, "Table of Contents" links, notes ≥ 20, slides, two-column reading order, expand in any script, expand retry on a broken reply | 0.2.22–0.4.1 | Python-only (Flash is not ported) |

### Not ported, and why

- **PageIndex Flash** and the LLM `optimize_tree` expand pass: a separate,
  layout-based PDF engine (pdfium character extraction); out of scope as in
  2.0.0.
- **SDK client, chat, agent tools, MCP bridge, cloud API, metadata, citations**:
  the port builds the index; searching it stays with your application.
- **LiteLLM routing and Claude Code subscriptions**: would add dependencies;
  OpenAI-compatible endpoints cover local and hosted models.
- **Token usage on the result**: upstream reports it from its local SDK
  client. It needs per-run accounting across concurrent calls; left for a
  later release.
- **Pre-existing differences from upstream's standard pipeline**, unchanged
  here: a TOC without page numbers is processed directly (upstream falls back
  to it only after the page-number pass verifies badly), and the main pipeline
  does not fall back between modes on low verification accuracy.

### Tests

New `tests/upstream-sync-0.5.test.ts` (51 tests) ports upstream's tests for
intro nodes, ranges, the large-node split, bottom-up summaries, the retry rule,
the standard checks and node navigation, plus two end-to-end runs of the PDF
pipeline over a scripted fake LLM. 138 tests in all.

## 2.0.0 — sync with upstream PageIndex v0.2.19

Baseline was upstream `959452d` (2026-03-04). Prompt-injection hardening,
page-number validation, truncation continuation, upstream LLM error handling
(`LLMRetriesExhausted`), `summaryModel`, deterministic tree merge, Markdown
bold headings and `lineCount`. Breaking: default model `gpt-5.6-luna`, errors
throw, the Markdown CLI no longer summarizes by default, PDF output shape.
