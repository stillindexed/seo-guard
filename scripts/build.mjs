// build.mjs — copies src/ to dist/ with no transformation. There are no
// dependencies to bundle; the Action runs plain Node 24 modules.
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
cpSync(new URL("../src/", import.meta.url), new URL("../dist/", import.meta.url), { recursive: true });
console.log("built dist/ from src/");
