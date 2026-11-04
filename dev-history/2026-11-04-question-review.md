# Daily question review and generalized question lists

Implemented an isolated, opt-in question review module without a webpage or any knowledge, memory, retrieval-policy or WeCom notification writes. The web service exposes administrator-only management routes and a private Unix socket; actual review runs in a bounded child process using the current question-answering model and independent in-memory prompts.

The reader reconstructs complete Web, WeCom and MCP question-answer rounds, including tool evidence and bounded prior context. It handles SDK run metrics that appear before the next user entry, branch ancestry, copied-session deduplication, interrupted answers and unavailable evidence. Fixed source snapshots and checkpoints allow an explicit retry to reuse completed batches.

Candidates undergo independent privacy review, programmatic validation and generalization. Exported questions retain necessary public product and version conditions, omit raw source text and identity metadata, and are always pending verification. Semantic merging preserves scope and counts distinct source questions. Unsafe candidates are withheld. Original model dialogues are not persisted.

Settings default to disabled, 02:00 Asia/Shanghai, twenty minutes and one hundred model requests per execution or explicit retry. Requests across retries remain cumulatively counted. Scheduling does not backfill missed days. The module has independent private state, cancellation, concurrency rejection, request idempotency, recovery, export and CLI management.

Validation: TypeScript build passed; the full suite passed 668 tests with no failures or skips. Tests cover real child/socket/CLI orchestration against a mock model, input reconstruction, privacy, output validation, grouping, authentication isolation, limits, cancellation, recovery, scheduling and DST.

## Production trial

Deployed only this feature and its thin server/package integration to the existing production checkout. Existing unrelated local firmware and Sync changes were excluded. Original integration files and build outputs were backed up before deployment. No environment configuration, Bridge code, tunnel configuration or local firmware service was changed. The main service was restarted; the Bridge remained active. Scheduled review remains disabled.

Fixed window: 2026-11-02 17:23:43 through 2026-11-04 17:23:43 Asia/Shanghai. Scanned 42 session files and 149 question-answer records. All 148 eligible complete rounds were reviewed, with zero remaining. One unfinished round and 29 rounds with limited context/evidence make the final status conservatively partial. Exported 70 generalized questions: 32 knowledge gaps, 35 possible answer issues, 3 insufficient-information questions, and zero retrieval omissions. Withheld 39 candidate findings through privacy/generalization checks. These are investigation leads, not established factual errors.

Initial trial lookup loops were bounded with a read budget and submit-only final turns. A timed-out execution retained completed checkpoints; explicit retries reused them and completed remaining review and generalization. Total model requests across trial and retries: 123. No original production conversations were downloaded. Only sanitized final exports and aggregate verification metadata were retrieved into ignored local storage.

## Source integrity

All 42 original session prefixes remained intact. Of 713 knowledge, memory and UMS files, 712 remained byte-identical. The main memory received a 761-byte append from a concurrent existing Memory Injection submission. Verified that workflow's backup hash equals the pre-review baseline, its committed output equals the current memory, and the original prefix remains intact. The review module did not write the memory. Do not describe this trial as all memory files remaining byte-identical.

Readable results and sanitized JSON are in ignored `.data/question-review-results/`; they are deliberately not added to Git. Operational documentation is in `docs/question-review.md`.
