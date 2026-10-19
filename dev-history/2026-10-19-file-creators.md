# Excel and UTF-8 text creators

Implemented in `/Users/patrickxu/ProductExpertCloud` only.

- `excel_create` accepts filename + bounded sheets/headers/rectangular literal rows. It writes a fresh workbook with formatting/freezing/filtering in an isolated worker, validates the Office package, and reads every supplied cell back before publication. Strings beginning with = remain strings; no formulas/macros/links/code objects.
- `text_file_create` accepts filename + complete UTF-8 content. It preserves bytes/whitespace, rejects invalid UTF-8/NUL, limits to262144 characters/1MiB, and never executes code or HTML. Lightweight text execution does not import Excel/Office parsers.
- No arbitrary filesystem paths, source templates, external program execution or overwrite. Separate input/output extension sets keep uploads restricted to their original formats. Common work-directory cleanup, file/session quotas, UUID publication, mode400 outputs, manifest hashing, run association and authenticated forced downloads are reused. Count cap200 also applies to outputs.
- Both independently switchable, initially off even when the original file tools are enabled. Legacy six-tool preferences gain two false fields. Creator skills activate only with the selected tools. MCP text-only sessions continue to exclude all file tools, verified with all eight enabled for Web.
- Web/WeCom file delivery uses backend registration, not model filenames. No new dependencies, Python requirements or Docker requirement; ExcelJS already existed.

Validation:

- `npm test`:155/155 passed, about21.8s; `.data/debug/file-create/full-tests.log`.
- `npm run test:file-create`:production native5/5 passed, about6.8s; `.data/debug/file-create/production-tests.log`.
- Added real-file tests for workbook contents/styles/literal formulas/null/empty/Unicode,21 text suffixes, source-free execution, invalid arguments, path escape, no overwrite, ownership, symlink denial, quotas, timeout/cancel cleanup, migration/defaults and30-day removal.
- Real local Core SDK + fake model tests verify output events/cards, attachment/nosniff/octet-stream responses, authenticated downloads, disabled-module/restart recovery, session deletion. Simulated WeCom receives exact realxlsx/html/java/md bytes from text-only questions.
- Browser fake-model fixture verifies default-off toggles, independent activation, workbook/HTML cards without model filenames, reload/card restoration and retained switch settings. Screenshots `.data/debug/file-create/settings.png` and `web-outputs.png` contain synthetic data. Own tab and65284 server closed.
- Frontend syntax and diff checks passed. No real model/WeCom calls or Linux/VPS execution for these new creators; platform acceptance of all text/code suffixes remains a real-WeCom deployment check.

Actual `.env`, business skills/memory, user preferences/contacts and VPS untouched. Reference patrick-agent/pi-patrick were not changed. No commit/push/deploy performed.
