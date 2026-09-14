// Copy the static frontend from the repo root into server/public/.
//
// Why this exists: the frontend lives at the repo root, one level above server/,
// but production (Railway) deploys with "Root Directory" set to server/, so only
// server/ ships in the container — the root files are unreachable and "/" 404s.
// This makes a fresh copy inside server/ at start time so express.static can
// serve it regardless of which directory the host treats as the deploy root.
//
// Runs on every `npm start` (via prestart), so server/public/ is always
// regenerated from the current source and never goes stale. server/public/ is
// gitignored — it's generated output, not a source of truth.
//
// Dependency-free: uses only Node's built-in fs, so nothing extra to install and
// nothing that could drift out of the lockfile.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url)); // server/scripts
const SERVER_DIR = path.join(scriptDir, "..");                  // server
const REPO_ROOT = path.join(SERVER_DIR, "..");                  // repo root
const DEST = path.join(SERVER_DIR, "public");                   // server/public

// Directories at the repo root that make up the frontend. Everything else at the
// root (server/, .git, node_modules, docs) is deliberately left out.
const FRONTEND_DIRS = ["admin", "assets"];

// File extensions that make up the frontend. Selecting by extension rather than
// a hardcoded filename list means a newly added page/script/style at the root
// gets picked up automatically — no need to touch this script when the frontend
// grows.
const FRONTEND_EXTENSIONS = new Set([".html", ".css", ".js", ".ico", ".svg", ".webmanifest", ".map", ".txt"]);

// Root-level files to never copy even if their extension matches (docs, config).
const EXCLUDE_FILES = new Set(["README.md"]);

function copyRootFiles() {
  const copied = [];
  for (const name of fs.readdirSync(REPO_ROOT)) {
    if (EXCLUDE_FILES.has(name)) continue;
    const src = path.join(REPO_ROOT, name);
    if (!fs.statSync(src).isFile()) continue;             // dirs handled separately
    if (!FRONTEND_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    fs.copyFileSync(src, path.join(DEST, name));
    copied.push(name);
  }
  return copied;
}

function copyDirs() {
  const copied = [];
  for (const dir of FRONTEND_DIRS) {
    const src = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
    fs.cpSync(src, path.join(DEST, dir), { recursive: true });
    copied.push(dir + "/");
  }
  return copied;
}

function main() {
  // Start clean so a file deleted from the source doesn't linger in the copy.
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });

  const files = copyRootFiles();
  const dirs = copyDirs();

  if (files.length === 0) {
    // A wrong working directory or a moved repo layout would silently ship an
    // empty site otherwise — fail loudly instead so "/" never 404s unnoticed.
    console.error(`✖ copy-frontend: no frontend files found in ${REPO_ROOT}. Nothing copied.`);
    process.exit(1);
  }

  console.log(`✓ Copied frontend → ${path.relative(SERVER_DIR, DEST)}/ ` +
    `(${files.length} files + ${dirs.length} folder${dirs.length === 1 ? "" : "s"}: ${dirs.join(", ") || "none"})`);
}

main();
