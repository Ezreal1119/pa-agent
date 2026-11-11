# RT30 visual review follow-up

The deployed RT30 run reported 13 pending regions. Read-only investigation found
five safety-label areas, four incidental screenshot details, two clipped icon
descriptions with complete native text, a normal join spanning two pages, and a
partially readable location/privacy explanation. The latter and safety labels
remain review items; this change does not bulk approve existing reports.

## Changes

- Minor-omission policy v2 accepts narrowly scoped screenshot details only with
  matching same-region native instructions and readable transcription: status-bar
  icons incidental to a date/time example, an extra discovery-list device name,
  the last unselected app-picker example, and the clipped unrelated bottom option
  of a PTP example whose selected control and full instructions remain readable.
  Explicit targets, selected controls, mixed critical issues and missing source
  anchors still block. No extra classification request is added. Source/audit
  records distinguish automatic acceptance from individual administrator decisions.
- Native recovery recognizes "incomplete"/stopped sentences and descriptions
  *for* icons. Unreadable icon shapes, labels and mixed issues remain excluded;
  exact prefix/span/geometry checks still constrain all proposed text repairs.
- A valid contextual page review can resolve a following-page complaint about
  missing preceding context only when that page independently transcribes the
  exact opening. Extra unreadable content still blocks. Context guidance is sent
  only following a verified preceding-page review, without supplying its quote.
- Old provisional continuation audits are reusable only when source, both image
  hashes, labels, adjacency, complete contextual result and quote checks match.
  Independent following-page verification remains mandatory. Retries do not
  spend another model request merely to repeat that already available evidence.
- Conversion version 7 reevaluates partial evidence without invalidating ordinary
  complete image checkpoints. Context-resolved following-page caches bind to the
  source; the following cache is persisted before the target complete cache.

## Verification

- Full Synchronize/notification regression: 259 passed, none failed or skipped.
- Final continuation/RT30 checks after context-guidance and cache-binding guards:
  46 passed, none failed or skipped.
- Added minimal RT30 issue snippets and source anchors as regression data; no full
  document, complete OCR transcript or production report was added to the repo.
- Four investigated screenshot exceptions qualify; safety and privacy examples
  do not. Actual native spans verify both sentence endings; the cross-page pair
  resolves without treating it as an accepted omission. Synthetic real-worker
  checks cover native metadata integration and retrying pre-fix checkpoints.
- These are offline provider fixtures and exact-source checks, not a new live
  model run against the production document.
