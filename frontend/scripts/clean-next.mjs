// Pre-clean the Next.js build dir (.next) before `dev` / `build`.
//
// Why this exists:
//   When the repo lives under OneDrive (Windows "Files On-Demand"), the files
//   inside `.next` can become placeholder / reparse points. Next.js cleans
//   `.next` on startup with its own recursive delete that calls `readlink` on
//   every entry — reparse points throw `EINVAL`, so `next dev` / `next build`
//   crash before they ever become Ready:
//     EINVAL: invalid argument, readlink '...\.next\types\package.json'
//   Node's own `rm` tolerates those entries, so a pre-clean avoids the crash.
//
// Scope:
//   Only runs on Windows when the project path is under OneDrive (where the
//   bug can happen); other setups keep Next's incremental cache untouched.
//   Force it anywhere with:  FORCE_CLEAN_NEXT=1
import { rmSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const underOneDrive = process.platform === "win32" && cwd.toLowerCase().includes("onedrive");
const forced = process.env.FORCE_CLEAN_NEXT === "1";

if (!underOneDrive && !forced) {
  process.exit(0);
}

const dir = join(cwd, ".next");
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
} catch (err) {
  // Never block dev/build: if it cannot clean, let Next try anyway.
  console.warn(`[clean-next] could not remove ${dir}: ${err?.code ?? err?.message ?? err}`);
}
