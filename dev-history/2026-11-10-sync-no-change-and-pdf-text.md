# Synchronize: no-change completion and native PDF text verification

## Scope

Fix two investigated cases: an administrator-approved duplicate accessory guide
remaining in business review, and clipped PDF sentence endings recoverable from
the same page's native text layer. No deployment or production job retries were
performed as part of this implementation.

## No-change completion

- `finish_sync` supports `action=no_change` for ordinary uploads. The agent must
  read the entire candidate and existing source, name that source, supply its
  current hash, and quote the current administrator's explicit keep-current
  instruction. The prompt prohibits treating feedback presence as permission.
- Backend validation rejects missing/currently mismatched evidence, staged
  edits, source replacements, coverage changes, exceptions, and use in deletion,
  association-only or verified WeCom workflows. Business ambiguity remains review.
- A zero-change transaction enforces the library baseline and supplies durable
  completion. Persist the decision before committing, so crash recovery retains
  `unchanged` rather than reporting a publication. No library page or log is
  edited. Normal hash-checked Incoming cleanup follows successful completion;
  reports retain the input hash, source pointer and decision evidence.
- The Web report and notification summary display completed/no changes, separately
  from published or duplicate product-association workflows.

## PDF text recovery

- The existing PDF render worker records bounded native text spans and geometry
  per rendered region. Only PDF inputs participate; Office and image inputs keep
  their existing behavior. Native extraction failure retains visual inspection.
- After incomplete OCR, only text clipping/truncation with a possible native
  completion may receive one extra, metered vision check within the file's
  existing deadline/request budget. Normal successful pages get no extra call.
- The reviewer returns exact local repairs, not a rewritten transcription. Each
  repair must retain a unique visible prefix, match complete consecutive native
  spans in the same region/local column, and resolve every reported issue.
  Backend checks reject invented text, visible numeric changes, overlaps, wrong
  positions, incomplete coverage and unrelated visual issues.
- Failed/ambiguous checks retain the original manual review. Audits and successful
  caches bind to source/pixel evidence. Explicit Retry region clears failed native
  review state; unchanged evidence does not repeatedly incur optional calls.
- Conversion version advances to 5 while existing valid per-image OCR caches are
  reusable. There is no database migration, new dependency or configuration.

## Verification

- Build and Web JavaScript syntax/patch checks pass.
- Full Synchronize + notification regression: 242 passed, 0 failed/skipped.
- After the final crash-ordering adjustment: 63 relevant completion/recovery,
  report, auto-sync and termination tests passed, 0 failed/skipped.
- New coverage includes administrator evidence, stale baselines, zero live
  changes, pre-commit decision durability, restart after an empty transaction,
  genuine clipped PDF fixtures, exact span checks, forged repairs, request
  failures, exhausted budgets and source changes with unchanged pixels.
- Offline validation against the investigated Upad page confirmed that both
  clipped endings satisfy the exact local-span repair checks. This validates the
  source evidence and deterministic guards, not a live provider response.
- Existing question-review work was preserved byte-for-byte.

## Production follow-up after deployment

Re-Sync the accessory guide using its existing explicit keep-current decision.
Retry the pending Upad region; other completed OCR regions remain reusable.
Neither old report statuses nor library contents are bulk rewritten by this change.
