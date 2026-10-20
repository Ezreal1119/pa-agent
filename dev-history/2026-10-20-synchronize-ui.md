# Synchronize follow-up — tabs, README exclusion, 100 MiB

User request: ignore README.md, simplify the layout into independently toggleable sections, raise only maintenance uploads to100MiB and keep chat30MiB. All implementation/verification is in ProductExpertCloud.

- Case-insensitive README.md is skipped on recursive scanning. Uploads return ignored and do not create a file. Existing manual README files remain on disk.
- Maintenance has a dedicated100MiB limit, covering incoming metadata, streaming writes, error messages and converter configuration. Chat file configuration, .env and .env.example are unchanged. Existing expansion/page/model budgets still apply.
- Incoming files / Sync reports / Delete knowledge are accessible tabs, with only one visible panel. Selected tab/report survive refresh through URL state. Start/Re-Sync/Preview move to reports. File selection, select-all, count, disabled controls, drag/drop and responsive report history/detail layout were checked.
- Dedicated synchronize.css avoids changing chat/contact layout. File and report content continue to use textContent.
- Nginx documentation now uses client_max_body_size100m. Existing proxies set to30m must change that one directive and pass nginx-t before reload to accept larger Sync inputs; the chat backend remains30MiB.

Validation: npm test173passed/0failed/0skipped, plus frontend syntax and git diff checks. Real streaming accepts exactly104857600 bytes and rejects104857601 without leftover partial uploads. Administrator HTTP accepts31MiB. The same server advertises Sync100MiB and chat30MiB. README upload returns ignored; recursive README files in mixed case are absent from incoming results and remain stored.

Browser verification used an isolated fixture under .data/debug/knowledge-sync-layout. Checked tab isolation, URL/refresh restoration, Home keyboard navigation, select-all, starting a run switching to reports, feedback surviving a tab round trip, Re-Sync creation/publication, changes/coverage display and cleaned inputs. The test planner/converter are simulated; no real model calls or production knowledge modifications were performed in this follow-up. Logs and screenshots are kept in the debug folder; this is not a VPS deployment or a new file-conversion accuracy claim.
