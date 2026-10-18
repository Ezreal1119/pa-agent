# Expert skill templates

The versioned SKILL.md files are generic deployment templates. Copy each to its matching directory under the configured .data root when deploying; maintained data is never overwritten automatically.

urovo-product-expert remains the default expert: its full deployed SKILL.md and MEMORY.md are required and read afresh for each run. ums-expert is an ordinary, optional skill: the SDK advertises its deployed SKILL.md name/description/path, and the agent uses read to load the body only for relevant UMS questions. Its references are resolved beside that deployed file. There is no UMS MEMORY loading step; old UMS memory files are retained but unused.

Knowledge, memory, and maintenance backups stay in .data outside Git. Shared memory/MEMORY.md injection remains independent. See the project README for required files, context limits and session retention.
