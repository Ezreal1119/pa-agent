# Synchronize implementation and verification — 2026-10-20

Implemented and verified in `/Users/patrickxu/ProductExpertCloud`. The production knowledge directory, `.env`, source `patrick-agent`, VPS and remote Git were not changed. Runtime/test artifacts remain ignored under `.data/debug/knowledge-sync/`. No Git commit or deployment was performed.

## Delivered boundaries

- Manual administrator page and API, upload/scan, fixed batch, complete conversion, independent Pi planning, validated publication, reports/Re-Sync, delete preview/confirmation, input cleanup and restart recovery.
- UROVO-only Markdown library; protection of SKILL/MEMORY/UMS; no maintenance tools exposed to normal Q&A.
- Current source and dependent Markdown changed together behind the shared Q&A read/publication write lock. Writer errors roll back; failed rollback blocks new reads until restart recovery.
- Agent judgments about identity, revisions and semantic dependency remain probabilistic. Exhaustive source-read tracking, source identity/path/slot rules, direct/transitive link checks and baseline hashes are deterministic gates. Uncertain/incomplete data is retained.
- Full historical reports loaded on demand. The default aggregate converted text memory ceiling is 16 MiB; staged index text ceiling 8 MiB. Larger batches can be retried separately, with original and conversion data retained.
- One process must own each data directory. External rsync or legacy sync scripts are not coordinated and must stop overwriting the live library after adoption.

## Validation evidence

Artifacts are under `.data/debug/knowledge-sync/`:

| Check | Evidence / outcome |
|---|---|
| Full regression | `full-tests.log`; 172 tests passed, zero skipped, including existing Web, WeCom, MCP, files, memory and session behavior |
| Native conversions | Real PDF, DOCX, PPTX, PNG/JPG/WebP, XLSX multi-sheet/formula/note, UTF-8 > chat truncation size, scanned PDF and UTF-16 Office private copy. Local MarkItDown/LibreOffice; simulated vision success/incomplete/truncation responses |
| Real Pi SDK | Simulated Chat Completions SSE exercises actual agent tool dispatch, rejected premature finish/protected reads, request budget and no business memory/broad tools |
| Real text model | `real-model-result.json`; deepseek-flash, synthetic TEST610 rev1→rev2, actual validated publish and source cleanup; 8 calls, 25436 input / 2053 output tokens |
| Real multi-version judgment | `real-model-batch-result.json`; rev2 competing with future-dated rev3; both retained, one review for competition/date concern and one candidate rejected for an obsolete source reference; no unverified publication |
| Real vision | `real-vision.log`; qwen3.8-flash read synthetic TEST 42 image; 230 input / 58 output tokens, complete coverage |
| Browser | `synchronize-ui.png`; isolated fixture backend, login/navigation/input selection/start/review/feedback/Re-Sync/refresh; mock results not business evaluation |
| Linux | `linux-validation.log`; Ubuntu24 ARM64, Node24.22.0, real native converters, synthetic vision, serial PDF 1137ms / DOCX 1034ms / PPTX 849ms / image 51ms. Cgroup cap1100MiB, CPU2, pid192; aggregate peak404598784 bytes (about386MiB). Test-only container, not deployment architecture |

The actual VPS is Ubuntu24 **x86_64** and has not been updated or tested by this task. The Linux figures measure the small converter fixtures, not concurrent full chat + complex documents + real vision workloads. Docker was used only for local Linux validation; installation instructions remain native/systemd.

## Deliberate conservative cases

Office visual coverage with hidden rows/sheets or limited print areas is rejected if complete coverage cannot be established. Explicit missing fonts, macro/active/embedded/external package features, malformed/encrypted files, unavailable vision, truncation and budget overruns preserve originals. These outcomes are not reported as successful ingestion. A source-specific faithful PDF export or corrected input can be retried.

Historical missing binary links are tolerated. Newly introduced unresolved Markdown references and remaining replaced/deleted source references block publication. Removed exact paths belong in the report/audit, not live Vault history paragraphs. Candidate index repair can be requested in Re-Sync feedback.

## Deployment delta

Install native LibreOffice Writer/Calc/Impress, Fontconfig, Noto CJK/Liberation fonts and ripgrep. Check `npm run check:sync`; run `npm run test:sync` and full `npm test`. Update systemd ReadOnlyPaths and TasksMax while preserving existing User/Group (the user runs as root). Reload/restart product-expert only; no new timer/service and no Bridge unit change. See `docs/synchronize.md` for exact commands and operational boundaries.
