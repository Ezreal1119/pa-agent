# WeCom online document imports

Synchronize → **Source imports → WeCom imports** reads ordinary online spreadsheets (`e3_`) and Word documents (`w3_`) through official `wecom-cli` read-only commands. No MCP server or AI is involved. Changed text becomes Markdown in `.data/urovo-product-expert/newly_added/`; start **Sync** yourself when ready. Images are not downloaded or recognized. Smart spreadsheets/documents and slides are unsupported in this first version.

## Configuration and document list

```dotenv
WECOM_CLI_BIN=wecom-cli
WECOM_CLI_CONFIG_DIR=.data/wecom-auth
WECOM_IMPORT_DOCS_FILE=.data/wecom_sync_docs.jsonl
# Optional, bounded timeouts:
# WECOM_IMPORT_REQUEST_TIMEOUT_MS=45000
# WECOM_IMPORT_DOCUMENT_TIMEOUT_MS=600000
```

Paths resolve from the project directory. With no overrides, the auth directory and list are under `AGENT_DATA_DIR` (default `.data`). The `.env.example` uses explicit `.data` paths; adjust those if you use a different data root. Keep authorization, lists, snapshots and reports Git-ignored. The importer never implicitly copies Bridge bot credentials, access tokens or extra CLI headers from the Web process environment. Authorize this CLI independently, using an identity with access to the selected documents.

Each JSONL line contains only `docid` and a nonempty human-readable `description`:

```jsonl
{"docid":"e3_AdQACAYmAP0T7YlxQzPSwe0s66gZo","description":"Device and Accessories Guide"}
```

`docid` is the stable source identity; description is a label, not a prompt or a change indicator. Settings edits the **actual configured JSONL**. **Check** validates JSON, fields, supported IDs, duplicates and descriptions locally without contacting WeCom. Editing invalidates Check. **Save documents** validates again, checks the opened revision, backs up the old list and atomically saves. Import and list-save share the same cross-process lock: wait for an active import to end before saving. **Reload documents** sees VPS-side edits; unsaved drafts require discard confirmation.

The UI's configuration status checks whether the authorization directory exists, not whether remote authorization is still valid. Run now reports permission or authorization failures. Missing lists are readable as empty drafts; an empty or invalid list cannot start an import. The page never returns credentials.

## Collection and change detection

- Spreadsheets first call `sheet version get`. The last successful version, with a verified cached snapshot and no pending delivery, skips all cell reads. First/changed versions read workbook metadata, **all worksheets including hidden ones**, explicit ranges in chunks of at most 4,000 cells, formulas, text links and actual merge ranges. Truncation, unreadable cells, inconsistent lists/ranges and overlapping merges fail the document.
- Version is checked again after a complete read. A changed workbook gets one whole-read retry; a second mismatch delivers nothing. No mixed-version snapshot is published.
- A normalized SHA256 per worksheet includes actual names, meaningful cell values/types, formulas, text links and merge relationships. Images, cell styles, collection time and workbook version are excluded. Only changed worksheets produce Markdown. A mere workbook version/style/image change produces **Unchanged** after the complete text comparison.
- Word reads `doc contents get` with Markdown each time; there is no assumed cheap version precheck. Inline text and files generated in that request's private directory are supported. Hash the normalized body and title; ignore embedded image markup. Word has simulated coverage only until a real authorized sample is supplied.
- Markdown preserves real names, source, cell row/column coordinates, text, numbers, formulas and links without AI summarization. True merged spans repeat the anchor value with `merged from A1` annotations; ordinary blanks stay blank. Every file states that images are excluded. It is a text snapshot, not an Office export.

Limits: 200 worksheets / 500,000 read cells per workbook, 16 MiB normalized snapshot and 16 MiB per Markdown, three attempts for transient CLI/network/rate errors, 45-second default request timeout and 10-minute default document deadline and two-hour batch deadline. Keep at least 256 MiB free in addition to the proposed write. The CLI and its native child are canceled together on POSIX. Authorization failure or disk exhaustion stops the batch; independent document errors allow later documents to continue.

## Delivery, deduplication and recovery

State, successful snapshot caches, full JSON reports, JSONL events and summaries live in `.data/logs/wecom_sync/`. No token, password or raw CLI error output is logged. Descriptions and document text remain business data; protect this directory as you protect the knowledge base.

A filename contains a source/worksheet identity digest. Once assigned, it survives description changes and renames. Identical titles from different sources stay separate. Compare the **latest successful** worksheet hash, not a ledger of every historical value: A → B → A delivers the restored A as a real update. After successful delivery, consuming/deleting the incoming file does not trigger redelivery of unchanged content.

Complete documents are verified before any of their outputs are staged. Hidden `.wecom-import-work/` inside `newly_added/` keeps temporary files on the destination mount and out of Incoming files. A durable pending record precedes atomic publication. New files use exclusive links; updated unconsumed files are replaced only when they still match the importer's recorded prior Markdown hash. An edited, linked or otherwise unowned file fails with a conflict; it is preserved. Existing Sync input-hash checks remain unchanged and protect a later replacement from stale cleanup.

Startup takes the same CLI/Web lock and recovers pending outputs **before** the version shortcut. Verified already-published bytes or owned staging resume; a proven two-link interrupted publication is completed. When neither staging nor target can prove delivery, recovery fails closed: preserve the state and files for investigation, rather than risk duplicate publication. A run interrupted before durable staging can simply be run again. Do not delete `state.json` to clear an error: that discards ownership and successful hashes. The reports show recovery errors, output hashes and paths.

Removing a source or worksheet is recorded on the next read. It never deletes formal knowledge or existing Incoming files. WeCom authorization loss/deletion is a reported failure, not an instruction to remove knowledge. Snapshots from removed sources are retained for continuity; unreferenced work/cache files are cleaned under the importer lock.

## Publishing split worksheets with Sync

Only changed worksheets enter Incoming files. Sync verifies importer receipts/cache and binds each source by `docid` + worksheet ID, rather than guessing ownership from its filename. A shared family navigation is maintained by the backend in the same publication transaction. Existing product-local accessories remain independent. This is separate from importing: delivered files have not yet become knowledge.

For a workbook previously synchronized as a complete Excel document, use the [one-time migration procedure](wecom-sync-migration.md) before its split files' first Sync. Keep the old complete source until all replacements are verified and its dependent facts have been reviewed. Do not delete importer state or rename imported Markdown to force a rerun.

## CLI and administrator API

Build once after updating code; timers run the existing build:

```sh
npm run build
npm run wecom:import
```

The CLI loads `.env`; exits 0 for completed imports, 1 for failure/partial failure and 130 for cancellation. SIGINT/SIGTERM cancels active reads. Do not run another import while Web/CLI already holds the lock. No model configuration is needed for this importer.

Cookie-authenticated administrator endpoints:

- `GET /api/wecom-import/status`
- `POST /api/wecom-import/runs` with `{}` → **202**, asynchronous run ID.
- `GET /api/wecom-import/runs/<UUID>`
- `POST /api/wecom-import/runs/<UUID>/stop` with `{}`
- `GET /api/wecom-import/settings/docs`
- `POST /api/wecom-import/settings/docs/check` with `{text}`
- `PUT /api/wecom-import/settings/docs` with `{text, revision}`
- `GET /api/wecom-import/settings/schedule`
- `PUT /api/wecom-import/settings/schedule` with `{schedule, revision}`

Mutations use existing Origin/CSRF checks. Bridge and MCP machine credentials grant no administrator access. Callers cannot choose commands, paths to read, output directories or download addresses. Request-provided JSONL is data only.

## VPS installation (user-operated)

The npm application dependencies are unchanged. The **official CLI is a separate VPS prerequisite**; local regression used `@wecom/cli` **1.2.1** and Node **22.23.2**. For the current root-operated VPS:

1. Update your code and build as usual. Install the official CLI if absent:

   ```sh
   cd /opt/ProductExpertCloud
   npm run build
   npm install -g @wecom/cli@1.2.1
   command -v wecom-cli
   ```

2. Create writable state/inbox/auth directories and initialize isolated authorization. Do this as the **same user** as the Web/import service. These commands assume the existing root deployment:

   ```sh
   install -d -m 0700 .data/wecom-auth .data/logs/wecom_sync .data/urovo-product-expert/newly_added
   WECOM_CLI_CONFIG_DIR=/opt/ProductExpertCloud/.data/wecom-auth wecom-cli auth init --manual
   ```

   Follow CLI prompts for the independently authorized identity. Tokens are refreshed by the official CLI using this directory; revoked grants or changed permissions still require reauthorization. Set the three paths from the configuration section in `.env`; use the actual absolute executable path returned by `command -v` if it is outside the service PATH. CLI binaries/packages must be outside `/root` or `/home` because the service uses `ProtectHome=yes`.

3. Restart the Web service after configuring `.env`, open WeCom **Settings**, paste the document list, **Check** and **Save documents**. Run now once and inspect reports/Incoming Markdown; this does not start Sync.

4. Install the **new** importer service/timer. The templates default to `productexpert`; for this existing root deployment change only the installed service's User/Group to root:

   ```sh
   install -o root -g root -m 0644 deploy/product-expert-wecom-import.service deploy/product-expert-wecom-import.timer /etc/systemd/system/
   sed -i 's/^User=productexpert$/User=root/; s/^Group=productexpert$/Group=root/' /etc/systemd/system/product-expert-wecom-import.service
   ```

   Non-root deployments should retain or adjust User/Group and directory ownership accordingly. Custom data/auth paths must also be reflected in the service's fixed `ReadWritePaths`. Keep the list readable by that user. The service can refresh authorization and write importer logs/inbox, while the knowledge references remain protected.

5. **Create all three fixed drop-in directories before updating the shared helper**. Otherwise its mount sandbox can fail with `226/NAMESPACE`, including when editing an unrelated timer. Do not overwrite your existing SFTP/Library timers:

   ```sh
   install -d -o root -g root -m 0755 /usr/local/libexec /etc/systemd/system/product-expert-sftp.timer.d /etc/systemd/system/product-expert-library-import.timer.d /etc/systemd/system/product-expert-wecom-import.timer.d
   install -o root -g root -m 0644 dist/sftp-sync/schedule.js /usr/local/libexec/product-expert-sftp-settings.mjs
   install -o root -g root -m 0644 deploy/product-expert-sftp-settings.socket deploy/product-expert-sftp-settings@.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now product-expert-sftp-settings.socket
   systemctl restart product-expert-sftp-settings.socket
   ```

   Non-root Web access uses the existing restricted socket group override described in [SFTP helper installation](sftp-sync.md#one-time-timer-settings-helper-installation-existing-root-deployment). No new privileged socket or arbitrary systemctl access is introduced.

6. Enable the new timer when ready, then check the real state:

   ```sh
   systemctl enable --now product-expert-wecom-import.timer
   systemctl list-timers product-expert-wecom-import.timer
   journalctl -u product-expert-wecom-import.service -n 80 --no-pager
   ```

   Default: **daily 04:00 Asia/Shanghai**, `Persistent=true`. Enabling/restarting may catch up one missed run. Settings reads/writes this actual timer, separately from SFTP and Library; Save schedule applies a version-checked drop-in, verifies the result and rolls back on failure. Manual VPS edits appear with **Reload schedule**. Timer changes do not cancel an already-running importer. The CLI does not require the Web service to be running.

## Verification

Automated checks use Node 22.23.2 and isolated fixtures; run `npm run test:wecom-import` after building. Test results and the authorized Guide comparison are recorded in `docs/core-changelog.md`. Word inline/file responses use simulations; no real Word sample has been validated. macOS tests simulate systemctl and use an actual local Unix socket; real Ubuntu timer activation, credential initialization/refresh over time and filesystem permissions must be checked during your VPS deployment. No production Sync or installed systemd units are modified by the tests.
