# MCP in Settings / current WeCom notification names

Implemented in `/Users/patrickxu/ProductExpertCloud`.

- Agent Settings now embeds four MCP cumulative metrics and a separate immediate switch. Dedicated `/api/mcp/settings` uses existing administrator auth/CSRF, writes optional `mcp.enabled` to existing preferences, preserves other settings and totals, and works without disposing active runtimes. Saved preference supersedes the initial env flag. Empty key cannot enable access.
- Removed standalone MCP sidebar/page/script. Old page URL redirects to workspace and opens Settings; detailed admin usage API remains available for compatibility.
- Notifications already preferred backend contact notes. Fixed recovery of unsent cached notification chunks so they regenerate using the current trimmed name. Acknowledged chunks remain stable. Existing sent messages are not rewritten. Contact names, not conversation titles, control the notification sender label.
- Added real local HTTP integration covering administrator name edit → Bridge API → direct/group notifications and renamed subsequent messages; all have names and omit the sender ID. Added queued cached-ID recovery test and persistent/live MCP toggle tests.
- Full `npm test`:148 passed,0 failed, about28.7s; `.data/debug/mcp/settings-full-tests.log`. Frontend/Bridge syntax and diff checks passed.
- Browser QA with isolated fixture: sidebar removal, four metrics, immediate off, reload retains off, re-enable; synthetic count1/input1240/output180/total1420 unchanged. Screenshot `.data/debug/mcp/settings-merged.png`. Own tab and60219 service closed.

No actual `.env`, saved user settings, contacts, knowledge/memories, reference project or VPS changed. No production notifications/model calls, commits, pushes or deployment performed. After syncing/building, restart product-expert and wecom-bridge independently to load both changes; future note edits need no restart.
