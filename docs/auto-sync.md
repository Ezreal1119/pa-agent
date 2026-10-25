# Daily Auto-sync

Synchronize → **Sync reports → Settings** sets one daily Beijing-time run. It is disabled on first installation. The initial 07:00 is only a default time; choose a time and explicitly enable/save before any scheduled run. The dialog reads the actual systemd calendar, next trigger and last dispatch/results, with reload, draft preservation and revision conflict handling.

At the scheduled time the Web backend snapshots all eligible Incoming files and calls existing Sync. Empty/busy runs are skipped, not queued. More than fifty files are split into serial batches of at most fifty, each with an ordinary report; later arrivals wait for another schedule. Stopping the active batch stops the rest of that snapshot. A restart interrupts work rather than replaying it automatically. Existing conversion, request budgets, source/version checks and publication/confirmation rules are unchanged.

Previously handled **filename + source hash** pairs in existing reports are excluded from automatic selection, including failed, needs-review, interrupted/stopped and retained published inputs. They often remain in Incoming: use the existing manual Re-Sync, decision/confirmation or cleanup controls. New content hashes are eligible again. Invalid/unselectable files stay visible in Incoming and are counted separately. Manual Sync selection remains unchanged. No old workbook or confirmation-required preview is automatically deleted/confirmed.

Your computer/browser can be off; the VPS and `product-expert.service` must run. Auto-sync uses **Persistent=false**, so enabling/restarting its timer or recovery from downtime does not catch up a missed run. SFTP/Library/WeCom import timers keep their existing schedules/catch-up policies; imports themselves still do not invoke Sync. Choose an Auto-sync time after expected imports finish.

## VPS installation

Update code using your usual deployment process. After current maintenance tasks finish, run as root:

```bash
cd /opt/ProductExpertCloud
npm run build
bash scripts/install-auto-sync.sh
systemctl restart product-expert.service
```

Refresh **Synchronize → Sync reports → Settings**, choose a daily Beijing time, enable and save. Verify **Saved and applied to systemd** and the next trigger. Installation does not enable a new Auto-sync timer or start Sync; later reinstallations preserve its existing enable/disable state and saved schedule overrides. The script does not restart the main Web service; the separate restart command does. Bridge needs no restart.

The installer adds the fixed Auto-sync service/timer and a User/Group drop-in matching the actual Web account. It updates the existing root-owned standalone timer helper from compiled `dist/sftp-sync/schedule.js` and its socket/service templates, creates fixed drop-in directories, and gives only the Web group access to the settings socket. Existing import units/schedule overrides are preserved. The new Auto-sync drop-in path is an optional helper mount so import-only installations with the original three directories still work. No `.env`, dependency, general sudo or main-service filesystem permission change is made. If the Web service overrides `AGENT_DATA_DIR` outside `.env`, give the new Auto-sync service the same override; the standard deployment uses `/opt/ProductExpertCloud/.data`.

Inspect without starting a run:

```bash
systemctl list-timers --all product-expert-auto-sync.timer
systemctl cat product-expert-auto-sync.service product-expert-auto-sync.timer
journalctl -u product-expert-auto-sync.service -n 50 --no-pager
```

`systemctl start product-expert-auto-sync.service` **starts an actual dispatch** and may call models/publish clear updates; it is not an installation check. The oneshot output acknowledges dispatch; completion and file results are in Sync reports and Settings.

## Implementation and boundaries

Settings reuse `SftpScheduleClient`/`SftpTimerManager` with a fixed `sync` source bound only to `product-expert-auto-sync.timer`. Auto-sync is daily-only with catch-up off; existing import behaviour is preserved. Saves keep schema/revision checks, root-owned atomic overrides, systemd verification and rollback. `/api/sync/settings/schedule` remains administrator-cookie-only with existing Origin/CSRF and machine credential restrictions.

The CLI never creates another SyncService or runs models. It sends only `{"operation":"run"}` to the existing Web process over `.data/knowledge-sync/auto-sync.sock`, mode0600 within the private knowledge-sync directory. No network dispatch endpoint, new credential, client file list, decision or arbitrary command is exposed. Missing/unsafe socket state does not prevent ordinary Web/Sync startup; Settings reports it and refuses enabling until resolved. Active sockets are not replaced; stale same-owner sockets may be recovered.

Git-ignored `.data/knowledge-sync/auto-sync-last.json` atomically stores timestamps, selected/held/invalid counts, report IDs, results and redacted errors. Actual reports remain canonical; no persistent retry queue or second publication mechanism is introduced. Each scheduled batch rechecks snapshot hashes and prior handling while reserving existing Sync, preventing changed files/intervening manual work from silently taking their place.

Local validation uses isolated data, real Unix sockets/CLI/HTTP/UI harnesses and mock planners, not production model/publishing or installed Linux timers. Live VPS timer activation and next trigger must be checked after installation.
