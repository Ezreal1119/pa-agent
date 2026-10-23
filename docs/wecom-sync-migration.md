# WeCom split-source publication and Guide migration

The importer still writes only changed text to Incoming files. Sync now verifies those exact Markdown bytes against the importer's successful receipt and snapshot. `docid` + worksheet ID owns one published source; filenames and administrator descriptions do not decide ownership. Ordinary non-WeCom inputs keep their existing behavior. No new npm dependency, environment setting, timer or helper installation is required for this Sync change.

## Existing Device and Accessories Guide: one-time setup

These steps are for the current VPS with 38 already-delivered Markdown files and the old complete source still present. Code update, build, service restart and administrator actions are user-operated; this implementation does not change live knowledge.

1. Update code, run `npm run build`, then restart `product-expert.service` using the existing deployment process. Keep the 38 incoming files and `.data/logs/wecom_sync/` receipts/cache. A new Run now, redownload or state reset is unnecessary.
2. Confirm the existing VPS paths below are accurate. Create Git-ignored `.data/knowledge-sync/wecom-routing.json` under the configured data root. If a routing file already exists, merge this entry; do not overwrite other documents:

   ```json
   {
     "version": 1,
     "documents": {
       "e3_AdQACAYmAP0T7YlxQzPSwe0s66gZo": {
         "indexPath": "product-knowledge-vault/shared/device-and-accessories-guide.md",
         "slot": "accessories",
         "legacySources": [
           "_shared/accessories/device-and-accessories-guide_202609182242/Device-and-Accessories-Guide-20260918.md"
         ]
       }
     }
   }
   ```

   Paths are knowledge-root relative, not absolute. An incorrect/missing legacy source blocks adoption. This local configuration authorizes adopting that existing shared page as the family navigation; it does not authorize deleting the old source. No service restart is needed after editing routing; the next Sync input reads it. Do not edit it during an active Sync.
3. Select the 38 WeCom Markdown files in Incoming files and start Sync. The model still resolves applicable canonical products, updates their Hubs and reviews relevant facts. New products and ambiguous applicability still require administrator instructions through Re-Sync. A compound worksheet may cover multiple products. A missing `accessories` word in the filename does not matter: the verified family route fixes that slot.
4. Inspect reports. Published sheets appear in the existing Guide navigation with product names and source links; sheets not published yet show **Pending Sync**. Each raw source goes under `_shared/accessories/wecom-<document-and-sheet-digest>_<timestamp>/<name>.md`, preserving independent product-local accessories, including the UPad dock document. The old overview/source remains explicitly labeled as a migration fallback while work is incomplete.
5. After all expected current worksheets have verified published replacements, use **Delete knowledge** to request retirement of **only** the old complete source. For example:

   > 退役旧整本来源 `_shared/accessories/device-and-accessories-guide_202609182242/Device-and-Accessories-Guide-20260918.md`。保留所有已发布 WeCom 分表、`product-knowledge-vault/shared/device-and-accessories-guide.md` 总入口及独立产品资料。逐一复核旧来源的直接依赖，迁移仍需保留的事实与引用；总入口只保留分表导航。不要把分表当作删除目标。

   Review the preview and confirm it. The backend verifies every expected sheet's current semantic hash and published body, and repeats the latest importer snapshot check at commit. Pending imports, incomplete migration or newer unsynchronized text block retirement. The old complete source contains image-derived evidence; new text-only sheets do not automatically replace those facts. Resolve such differences in dependent pages before confirming. Do **not** use `rm` or delete importer state.

After retirement, the existing Guide page is a lean navigation of worksheets, applicable products, brief purposes and exact locations. Detailed facts reside in linked sources. Product Hubs retain links to the stable Guide entry, so existing discovery paths continue to work. This does not prove that an untested model answer will always retrieve every relevant source.

## Ongoing updates and protection

- One changed sheet produces one incoming Markdown. Sync replaces exactly that section's registered source and updates its navigation/product dependencies. Other sheet sources and unrelated product-local documents remain intact. No model-selected replacement of another sheet or the old complete workbook is accepted.
- Renames retain document/sheet identity. Display names can change without creating another family. New sheets are added on later imports; upstream removal only marks retained sources for review, never deletes knowledge automatically.
- Verified raw Markdown is not summarized or rewritten during source publication. The generated navigation contains short generic purpose labels, links and machine ownership metadata, rather than another copy of every worksheet's facts.
- Source + ownership/navigation + affected Hubs/index/log share the existing publication journal, baseline checks and rollback. No separate persistent registry needs a second commit. Do not manually edit/remove the `wecom-source-index:v1` comment; the Library editor makes managed navigation read-only. Manual changes to managed source bytes, lost metadata or conflicting importer receipts fail visibly instead of guessing ownership.
- If Sync reports an identical verified section as Duplicate, it consumes the unchanged input without another model publication. Association-only product review cannot bypass a managed source binding; to deliberately change applicability, restore its exact imported Markdown and start a new Sync with explicit instructions. Existing generic duplicate/product-association behavior remains unchanged for ordinary files.
- Explicit deletion of a split source records withdrawal. Automatic reintroduction is blocked. Restoring it requires its exact verified imported input, the exact instruction `RESTORE WECOM <docid> <worksheet-id>`, and publication confirmation. There is no automatic force-redownload feature; unchanged consumed inputs are not delivered again by Run now. Preserve receipts/cache and backups when investigating.
- A fresh unrelated document uses a stable hashed family navigation by default. Adopting an existing family page requires explicit routing; moving an already-managed family's index or semantic slot requires a separate migration. Configured legacy sources cannot be replaced as a side effect of an ordinary update.
- First-Sync title matching retains Unicode letters/numbers, including Chinese, and ignores case, spacing and punctuation. Empty normalized titles never match. Unrelated Chinese titles do not require adopting an existing Chinese shared page; genuinely matching family titles still require explicit routing. This does not rewrite existing family identity, paths or mappings.

## Verification boundary

Tests use isolated knowledge, importer state and simulated planners. They cover old-current import receipts, independent product accessories, single-sheet replacement, renaming, safe links, partial/full retirement, late upstream changes, manual modifications, withdrawal/restoration, rollback and Library read-only protection. The real UTF-8 converter is exercised locally. Existing real-read Guide artifacts can be replayed to verify compatibility without new remote requests.

This change does not run a real model, perform live Guide publication, modify the user's original Excel, remove the old workbook or deploy to the VPS. Check the cumulative changelog for the final build/test and artifact-replay results.
