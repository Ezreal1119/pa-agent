# Weekly library imports

**Synchronize → Source imports → Library imports** downloads eligible files from the latest complete library synchronization report into `urovo-product-expert/newly_added/`. **Run now**, **Stop**, configuration status, history and per-file classification/delivery results are independent of SFTP imports. Closing the page does not stop a run. The existing two-second polling restores progress after a refresh. This importer never starts knowledge Sync, handles upstream deletions, or catches up historical reports.

## VPS update and configuration

These are instructions for the administrator, **not operations performed in the implementation round**. Keep your normal code update workflow, existing service user and existing `.env`; build once after updating code:

```bash
cd /opt/ProductExpertCloud
npm ci
npm run build
nano .env
```

Add these two values (use the real password only in the server's ignored `.env`):

```dotenv
LIBRARY_IMPORT_BASE_URL=https://tool-files.patrick-shenzhen.org
LIBRARY_IMPORT_ADMIN_PASSWORD="your library administrator password"
```

The base URL must be a public HTTPS origin, without a path, query, credentials or fragment. The importer uses the existing `API_KEY`, `BASE_URL`, `MODEL_ID`, `MAX_TOKENS` and saved Agent settings reasoning level. It does not need another model, vision configuration, LibreOffice, new npm dependencies, or knowledge/Memory access. Changes to credentials require restarting the Web service for its manual importer; the standalone CLI reads `.env` afresh each invocation.

```bash
chmod 600 .env
systemctl restart product-expert.service
```

The service user must be able to read `.env` and write `.data/logs/library_sync/` and `.data/urovo-product-expert/newly_added/`. Existing main-service `ReadWritePaths=.../.data` is sufficient. Do not make files world-writable; if this VPS uses root, preserve that choice in the optional standalone service too.

To run once without Web:

```bash
cd /opt/ProductExpertCloud
npm run library:import
```

This command runs **existing `dist/library-import/cli.js`**, with no build step. A missing/stale build must be corrected during deployment, not in the weekly job. Exit 0 means the batch completed (including documented classification skips/uncertain cases); partial failures return 1 and cancellation returns 130. Read the report for business skips as well as process exit status.

## Selection, classification and delivery

1. Fetch `/api/sync-reports` using `X-Admin-Password`. Select the greatest valid `completedAt` among complete report summaries, then fetch `/api/sync-reports?runId=...` and public `/api/files`. The selected report ID is fixed for the run and checked against its completed detail. Malformed manifests fail the batch. Repeated added/updated keys are processed once. A key absent from the current file list is skipped; current metadata is authoritative.
2. Filter by safe filename extension and declared size: PDF, PPTX, XLSX, DOCX, maximum **100 MiB**. DOC/XLS/PPT, images, TXT and other types are excluded here even when another workflow supports them.
3. The shared text model receives only `name`, `documentType`, `displayPath`, a classification instruction and an explicit seven-category JSON contract: `accessories_guide`, `product_brochure(PB)`, `presentation`, `specs`, `user_guide`, `outside`, `uncertain`. No tools, knowledge, Memory, conversation or download URL is supplied to it. Nonmatching and uncertain items are reported and not downloaded. Identical classification evidence reuses the cache, recording its original model and zero new token usage. Model settings/effort are snapshotted once per run.
4. Eligible files download serially into private `newly_added/.library-import-work/` staging on the destination mount. Only public HTTPS on port 443 is allowed, including every redirect; all resolved DNS addresses are checked and an approved address is pinned per connection. Private, loopback, link-local, transition and other special addresses are rejected. Library HTTP requests include `User-Agent: Mozilla/5.0` for public origins that reject an absent User-Agent; anonymous redirect requests retain this header. Admin-password API calls do not follow redirects. Downloads have no administrator/authentication header, including when their host equals the API host. Redirects are capped at five; transient network/408/429/5xx failures have up to three attempts with bounded delays. Model calls have a two-minute deadline, API reads one minute, downloads ten minutes per attempt, and idle sockets thirty seconds. A 256 MiB reserve is checked before and during receiving; unknown sizes reserve space for the full 100 MiB limit.
5. Verify actual byte count/declared length, SHA256 and document structure in an isolated Node process (120-second deadline, 384 MiB JS heap). PDF pages/operators must parse without a password. Office files must be unencrypted ZIPs with matching content types/main parts, valid XML and CRCs; macros are rejected. Existing bounded Office preflight is reused with maintenance limits: 200 sheets, 500 slides, 500,000 cells, 256 MiB expanded content, 2,000 ZIP entries and the existing media/XML guards. A legitimate but excessive document is reported as failed, not silently truncated. No rendering, OCR, external embedded-link retrieval or full conversion occurs during import.
6. Publish complete files exclusively and atomically, never overwriting a collision. Same name and bytes already in Incoming are reused. Different bytes use `__library_<hash>_<suffix>` in the filename, preserving the extension. Persist successful source/key+content hashes; content already delivered for that source is not redelivered even if Sync removed its original.

Re-running the current latest report skips completed entries without downloading them again, and retries incomplete entries. If a newer report appears, the next run selects only that new report; older unfinished work remains in history. A later report containing a previously seen source/content hash is downloaded for hash comparison but not delivered again. Classification skips and uncertainty are completed checks and reuse their unchanged decision; a new metadata fingerprint triggers new classification.

The upstream report is metadata-based. If upstream silently replaces bytes without producing an added/updated entry, this importer cannot discover that unreported change. It intentionally does not scan the entire catalog.

## Reports, errors and recovery

Everything is under ignored `.data/logs/library_sync/`:

- `state.json`: versioned source/content ledger, per-report completion records, metadata classification cache, pending-publication journal.
- `<UUID>.json`: full report, selected source report, metadata, status/stage, classification/reason, model provenance, actual returned tokens, download attempts, hash, bytes, target and error.
- `<UUID>.summary.json` and `<UUID>.jsonl`: history summaries and events.
- `runner.lock/`: cross-process heartbeat; `<UUID>.stop`: cross-process stop request.
- Binary temporary files live in `urovo-product-expert/newly_added/.library-import-work/*.part` (private mode 700 directory, ignored by Incoming/Sync scans). The old `logs/library_sync/work/` location is retained only for legacy recovery/cleanup; state, reports and classification cache remain in `logs/library_sync/`.

Reports and state are not part of chat retention. Never delete state merely to clear an error: resetting it deliberately allows old content to be downloaded again. Missing configuration leaves ordinary chat usable; malformed state/cache fails closed and is shown as a recovery error.

Authentication/authorization failure, disk exhaustion, exhausted download connection errors, or uncertain publication stop the remaining batch; ordinary per-file validation/classification failures can leave other independent files running. Failures do not mark the source hash delivered. Stop aborts network/worker work and removes uncommitted staging. Publication already in its short commit section completes safely. CLI and Web share a heartbeat lock and stop marker; overlapping starts return 409. There is no global exclusion between SFTP and Library imports; both use complete-file exclusive delivery, and source-specific content dedup is independent.

After a process restart, proven complete pending delivery is committed and old active reports become Interrupted. If the CLI dies while Web stays up, status polling attempts recovery once the stale lock can be acquired (heartbeat stale after sixty seconds). Orphan incomplete downloads are removed and can be retried. Missing/changed ambiguous destinations fail closed for manual review: preserve reports, state and work files rather than guessing success. In particular, if another consumer removed a just-delivered file before its ledger commit during a crash, automatic recovery cannot prove whether it was consumed. Staging now lives inside the inbox mount, so normal publication never links across the separate systemd ReadWritePaths mounts. Legacy EXDEV failures can migrate verified private staging into the hidden inbox directory: the saved report must prove that the matching link failed with EXDEV, the public target must be absent, and source/completion identity plus SHA256 must match. The copy is fsynced and its new location journaled before publication. An interrupted migrated attempt uses normal conservative recovery; the old error is not reused as permission to redeliver. No visible partial-copy fallback or broadening of systemd write access is used.

## Optional weekly systemd timer

Templates are provided only: `deploy/product-expert-library-import.service` and `.timer`. **No timer/service was installed or enabled.** They do not require `product-expert.service` running and execute the CLI directly from the compiled build.

Inspect your current runtime identity first:

```bash
systemctl show product-expert.service -p User -p Group
command -v node
```

Copy the templates, then edit **User, Group and Node PATH** to match your installation. The shipped user is `productexpert`; if your existing service uses root, set both User and Group to root. Do not change ownership of the whole business knowledge tree just to match a template.

```bash
sudo install -m 644 deploy/product-expert-library-import.service /etc/systemd/system/
sudo install -m 644 deploy/product-expert-library-import.timer /etc/systemd/system/
sudo nano /etc/systemd/system/product-expert-library-import.service
```

Before starting the sandboxed service, create both writable paths (ReadWritePaths requires them to exist). Use your actual runtime account/group below; this example matches the shipped dedicated-user template:

```bash
sudo mkdir -p /opt/ProductExpertCloud/.data/logs/library_sync
sudo mkdir -p /opt/ProductExpertCloud/.data/urovo-product-expert/newly_added
sudo chown productexpert:productexpert /opt/ProductExpertCloud/.data/logs/library_sync /opt/ProductExpertCloud/.data/urovo-product-expert/newly_added
sudo chmod 700 /opt/ProductExpertCloud/.data/logs/library_sync /opt/ProductExpertCloud/.data/urovo-product-expert/newly_added
sudo systemctl daemon-reload
```

Ensure that account also owns/can traverse any existing report files, read `.env` and the code/build. Existing root-owned importer state must be migrated deliberately if switching users. First manually run and inspect before enabling the timer:

```bash
sudo systemctl start product-expert-library-import.service
sudo journalctl -u product-expert-library-import.service -n 100 --no-pager
sudo systemctl enable --now product-expert-library-import.timer
systemctl list-timers product-expert-library-import.timer
```

The timer uses `OnCalendar=Mon *-*-* 06:00:00 Asia/Shanghai`, independent of the VPS timezone. `Persistent=true` catches up once after downtime; it does not replay all missed weeks or old library reports. `AccuracySec=1min` allows normal systemd scheduling slack. To cancel a running job use the page's Stop or `systemctl stop product-expert-library-import.service`. There is no WeCom notification in this feature.

## API and validation boundary

Administrator-only routes, using the existing Cookie/Origin/CSRF policy:

- `GET /api/library-import/status`: configuration (no credentials), active run, summaries and recovery error.
- `POST /api/library-import/runs` with `{}`: start; returns **202** and run ID immediately.
- `GET /api/library-import/runs/<UUID>`: report/progress.
- `POST /api/library-import/runs/<UUID>/stop` with `{}`: stop request.

No arbitrary source URL, target path, credentials or prompt is accepted over these endpoints. WeCom and MCP credentials do not grant maintenance access. Page rendering uses text nodes for upstream/model values.

**Implementation round: no build, typecheck, tests, browser verification, real model request, real download, Ubuntu/resource measurement or timer validation was executed, per administrator instruction.** New simulated test fixtures are unexecuted. They cover latest selection/current metadata, formats/size, five categories plus skips/uncertainty, repeat runs/consumed originals, collisions, retry/auth/disk failures, stop/lock, pending recovery, private URL/path rejection, classifier payload/usage and administrator HTTP boundaries. They do not establish actual provider, PDF/Office compatibility, external DNS/TLS redirect behavior or production resource performance.

When you choose to validate later, use Node 22.23.2 and an isolated `.data`/test account; first build, then run `node --test tests/library-import*.test.mjs`. Also verify real representative PDF/PPTX/XLSX/DOCX, corrupt/encrypted/oversized files, force-kill recovery, redirect/DNS rejection, mobile UI and actual timer/calendar behavior before production reliance. Do not infer these results from written fixtures.

### 2026-10-21: origin rejects requests without User-Agent

The administrator reported a download-stage HTTP 403 for `i9100(EN)-PB-20261014.pdf` after successful report retrieval and classification. Local HEAD-only inspection reproduced 403 with Node's absent User-Agent, 200 with `User-Agent: Mozilla/5.0`, and 403 with Referer alone. This is response-header evidence from the local host, not a successful GET/file download or VPS verification. The transport now adds the User-Agent without adding cookies, Referer or credentials to downloads. Unauthenticated redirects continue to work; authenticated API redirects remain forbidden. No `.env`, dependency or systemd change is needed. The implementation change and new simulated HTTP regression fixtures were not built or run in this round. After deploying/rebuilding, rerun the existing import; keep the state/cache so failed and unattempted entries can resume.


### 2026-10-21: EXDEV at publication under systemd

The VPS log showed successful download/validation followed by `EXDEV` linking `logs/library_sync/work/*.part` to `newly_added/<file>`. Separate `ReadWritePaths` bind mounts can reject hardlinks even when the directories share an underlying disk. New downloads stage in the ignored inbox child `.library-import-work/`, making staging and final target part of the same writable mount; disk checks cover both log storage and inbox storage. The service template retains its two narrow writable paths (only a comment changes).

Keep the existing `state.json`, report and old `work/` files. After updating code and building, restart Web and start the standalone service again; proven old EXDEV records are migrated/recovered before the next run. No `.env`, npm dependency, installed unit or timer change is needed. Unknown crash points, modified hashes, existing conflicting targets and interrupted migrated attempts still fail closed for review. Fix-stage build, tests and actual VPS/download validation were not run, per the standing administrator instruction; written fixtures are not a validation result.
