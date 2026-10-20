import "dotenv/config";
import { execFile } from "node:child_process";
import path from "node:path";
const run = (bin, args) =>
  new Promise((resolve) =>
    execFile(bin, args, { timeout: 20000, maxBuffer: 1048576 }, (error) =>
      resolve(!error),
    ),
  );
const markitdown =
  process.env.MARKITDOWN_COMMAND ||
  path.resolve(".data/file-runtime/bin/markitdown");
const checks = [
  [
    "Node.js >= 22.19",
    Number(process.versions.node.split(".")[0]) > 22 ||
      (Number(process.versions.node.split(".")[0]) === 22 &&
        Number(process.versions.node.split(".")[1]) >= 19),
  ],
  ["MarkItDown", await run(markitdown, ["--help"])],
  [
    "LibreOffice",
    await run(process.env.SYNC_SOFFICE_COMMAND || "soffice", [
      "--headless",
      "--version",
    ]),
  ],
  ["Fontconfig", await run("fc-match", ["sans-serif"])],
  ["ripgrep", await run("rg", ["--version"])],
  [
    "Text model configured",
    !!(process.env.API_KEY && process.env.BASE_URL && process.env.MODEL_ID),
  ],
  [
    "Vision model configured (required for PDF, Office rendering and images)",
    !!(
      process.env.VISION_LLM_API_KEY &&
      process.env.VISION_LLM_BASE_URL &&
      process.env.VISION_LLM_MODEL
    ),
  ],
];
for (const [name, ok] of checks)
  console.log(`${ok ? "OK" : "MISSING"}  ${name}`);
console.log(
  "Source-specific fonts and document coverage are checked during conversion. No knowledge files were changed.",
);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
