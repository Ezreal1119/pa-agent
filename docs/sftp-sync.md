# SFTP source imports

The importer reads a configured SFTP account and a path-only JSONL list. It downloads changed contents into the product knowledge `newly_added/` inbox. Knowledge classification/conversion/publication is a separate **Start Sync** action. It never writes/deletes remote files. Manual Web/CLI runs and an optional daily systemd timer share the same implementation. Repository templates do not install or enable services automatically; no WeCom notification is provided.

## VPS configuration

Use the existing root service. From `/opt/ProductExpertCloud`, after pulling the branch:

```bash
npm ci
npm run build
npm run test:sftp
```

Add this configuration to the existing `.env` (real password stays only there):

```dotenv
SFTP_HOST=120.76.195.35
SFTP_PORT=22
SFTP_USERNAME=urovo-duanxiongbao
SFTP_PASSWORD="your SFTP password"
SFTP_LEGACY_KEX=true
SFTP_HOST_FINGERPRINT=SHA256:U7gTHqAEWWcc9s4RaafFus7Ijsdvqbd/3IS8Juih3ys
SFTP_PATHS_FILE=.data/sftp_sync_paths.jsonl
```

The fingerprint above was **observed on the local test connection on 2026-10-20**, not independently certified. `npm run sftp:check-host` displays the current host key without sending a password; compare with the server administrator's value before adopting a different key. A changed key is rejected before password authentication. Legacy KEX is an explicit per-account option for this Serv-U server; modern servers should leave it false. Only group14-sha1 is appended, not group1 or obsolete ciphers.

Create the JSONL list, with **only `path`** on each non-empty line:

```bash
nano /opt/ProductExpertCloud/.data/sftp_sync_paths.jsonl
```

```jsonl
{"path":"/os/i9100/SQ29MB/SQ29MB修改记录.xlsx"}
```

```bash
chmod 600 /opt/ProductExpertCloud/.env
chmod 600 /opt/ProductExpertCloud/.data/sftp_sync_paths.jsonl
systemctl restart product-expert.service
```

Open **Synchronize → Source imports → SFTP imports → Run now**. Results persist when the browser closes. Inspect **Downloaded**, **Unchanged**, or the reason for each failed path; a mixed batch finishes as **Completed with errors**. Newly delivered files appear in **Incoming files**. Select them and click **Start Sync** when ready.

Alternatively run a one-shot CLI:

```bash
cd /opt/ProductExpertCloud
npm run sftp:sync
```

It returns nonzero for failures/partial failures/stops. The web service and CLI share a cross-process lock; concurrent imports are rejected. The JSONL list is read afresh at each start, so editing paths does not require a restart. Changing credentials/configuration requires restarting product-expert. No WeCom service restart is needed. Existing `ReadWritePaths=.../.data` covers both inbox and reports; no systemd template change is required. If rsync preserved Mac ownership, ensure these writable directories belong to the service user; do not make files world-writable.

## Daily systemd timer

`deploy/product-expert-sftp.service` and `deploy/product-expert-sftp.timer` reproduce the VPS configuration supplied by the administrator on 2026-10-21. The service runs as root, invokes the existing compiled CLI directly (128 MiB JS heap, 256M service memory limit, 50% CPU quota, two-hour job timeout), and reads `.env` from `/opt/ProductExpertCloud`. It does not rebuild or require the Web service to be running.

The timer uses `OnCalendar=*-*-* 03:00:00 Asia/Shanghai`: **daily at 03:00 Beijing time**, independent of the VPS timezone. `Persistent=true` allows one catch-up after downtime. The matching basename automatically selects `product-expert-sftp.service` without an explicit `Unit=`. Library imports has separate units and a separate Monday 06:00 Beijing schedule.

For the VPS that already has these identical files, adding repository templates requires **no reinstall, daemon reload or restart**. Git pull only updates the repository; it does not synchronize `/etc/systemd/system/`.

For a new installation, first build the code and configure `.env` and the JSONL list as above, then explicitly install and enable the units:

```bash
cd /opt/ProductExpertCloud
sudo install -m 644 deploy/product-expert-sftp.service /etc/systemd/system/
sudo install -m 644 deploy/product-expert-sftp.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now product-expert-sftp.timer
systemctl list-timers --all product-expert-sftp.timer
```

To trigger one run or inspect its log:

```bash
sudo systemctl start product-expert-sftp.service
sudo journalctl -u product-expert-sftp.service -n 100 --no-pager
```

The templates preserve the supplied root configuration. If deploying with another account, adapt its access to the code, `.env`, JSONL, reports and inbox. The active VPS unit contents were provided by the administrator; timer enablement and runtime behavior were not remotely inspected or validated in this template-sync change.

## Inputs and persistence

- UTF-8 JSONL, max 4 MiB / 10000 lines; repeated paths are deduplicated. Invalid lines get individual failed results, never echo the malformed JSON. Valid lines continue.
- Absolute POSIX paths only, no traversal/control characters. Regular files only. Format whitelist matches Synchronize: PDF, DOCX, XLSX, PPTX, PNG/JPG/WebP, TXT, MD; reserved README/SKILL/MEMORY/SYNC files are rejected.
- Up to 100 MiB/file, serial streaming, SHA256 computed while receiving, default 256 MiB disk reserve. No document parser or model is invoked by the importer.
- `.data/logs/sftp_sync/state.json`: last successfully delivered content hashes, names and publication recovery journal. Identity is derived internally from host/port/account/path; no ID field in the JSONL.
- `<run UUID>.json`: full durable report; `.summary.json`: compact list entry; `.jsonl`: events; `work/`: private incomplete download/publication staging; `runner.lock/`: heartbeat lock. New files are mode 600, new private directories mode 700. Reports/audit are not subject to chat retention.
- Local credentials are never returned to browser/reports. `.env`, list, logs/state, staging and downloaded documents remain Git ignored.

## Failure handling and recovery

Download to a private temporary file, enforce size, verify received length and compare remote size/mtime before/after. Unstable/incomplete files do not reach the inbox. Fully received files are fsynced and published via an exclusive atomic hardlink, so a consumer never sees a partial file. If the same remote path later has new bytes while the previous copy is still in Incoming files (not yet consumed by Sync), the inbox file is replaced atomically (hardlink a complete staging copy, then rename). After Sync has consumed the original, a later remote change is a new Incoming file under the original name. This requires staging and inbox to reside on the same filesystem (the standard `.data` layout); an `EXDEV` error is reported rather than falling back to a partial copy.

The durable journal is saved before publication. State advances only after complete inbox delivery; verified pending publication resumes on the next run/startup. A changed pending destination fails closed for administrator investigation. After a successful Sync consumes the source, its recorded hash still prevents re-delivery. If a crash occurs in the small delivery/state-commit interval and another consumer has already removed the delivered file, recovery can no longer prove that delivery: it stops for review rather than silently acknowledging or downloading it again. Preserve state, report and staging when investigating. Do not reset state merely to clear an error, because that intentionally allows re-importing old content.

Default: three attempts per file, 20-second SSH connection deadline, ten-minute per-file deadline; finite exponential retry delay. Missing paths, permissions, unsupported files, oversized files and negotiation/configuration failures are not repeatedly retried. Authentication, host-key, exhausted connection retries or disk-space failures stop the remaining batch; independent per-file failures continue. **Stop** cancels active network/stream work and removes incomplete downloads; a file already durably delivered remains delivered. CLI and web can stop a shared active run through the saved stop marker. On restart, unfinished reports become **Interrupted**; rerun checks committed hashes and attempts the remainder. A stale lock is recoverable after its 60-second heartbeat timeout.

Source size/mtime checks are best effort, not a transactional snapshot of a server being concurrently edited. Prefer importing files after upstream writers finish saving. Pure SFTP exposes no standard hash operation, so unchanged detection saves duplicate inbox/storage/Sync work, **not the remote read bandwidth**. No SSH shell or remote checksum command is used.

Missing configuration or a recoverable SFTP journal problem is shown in Source imports and does not disable ordinary chat. Persistent report/state I/O errors are surfaced; when the disk itself cannot accept reports, fix storage first and inspect retained state before rerunning.

## Verification

`npm run test:sftp` covers path-only input, size/path restrictions, complete streaming, content dedup after inbox cleanup, replacing an unsynced copy, retries and partial batches, cancellation, shared locking, pending publication recovery, links and admin HTTP access. Transport fixtures are simulated; real remote validation is recorded separately in the core changelog. VPS/Ubuntu validation must not be inferred from local tests.

Active imports keep the stop-polling timer referenced until completion, then clear it. This prevents Node 22 CLI/test processes from exiting while waiting for a transfer deadline or a cross-process stop request. Regression coverage uses a separate process without a real socket, checks that the deadline is recorded, and requires the process to exit after cleanup. Run the suite using the deployed Node version; Node 25 results alone do not establish Node 22 compatibility. This correction needs only a code update and rebuild, with no `.env`, dependency or systemd change.
