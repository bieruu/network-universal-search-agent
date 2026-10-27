// Pre-flight check for the Next.js native SWC binding, run by `predev`.
//
// Why this exists:
//   `next dev` loads its compiler through
//     require("@next/swc-<platform>-<arch>")
//   resolved from `node_modules/next/dist/build/swc`. Node walks UP the
//   directory tree, so a `node_modules` in a parent folder (a stray install in
//   the user's home directory, for example) can satisfy that require with a
//   binary built for a DIFFERENT Next version.
//
//   The failure is nasty because it is not a version-mismatch error: Next 15
//   serialises an SWC options object that includes `disablePageConfig`, and a
//   Next 16 binary rejects that unknown serde field:
//     ./middleware.ts  Error: Caused by: unknown field 'disablePageConfig' ...
//     ENOENT ... .next\fallback-build-manifest.json
//   while the only hint is the startup warning
//     Mismatching @next/swc version, detected: 16.3.8 while Next.js is on 15.5.28
//
//   The offending `node_modules` is OUTSIDE this repo and belongs to the user,
//   so we cannot remove it. We can only detect it and say what to run.
//
// Scope:
//   Warn and continue by default - a wrong binding is still worth letting the
//   developer try, since Next may recover (or may be about to be reinstalled).
//   Set NEXT_SWC_STRICT=1 to turn the warning into a non-zero exit.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(here);

// Node reports `linux` for both glibc and musl; Next ships one binding per libc.
const linuxLibc = () => {
  try {
    const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
    return glibc ? "gnu" : "musl";
  } catch {
    return "gnu";
  }
};

/** Package name Next will attempt to require on this platform, or null. */
export const swcPackageFor = (platform, arch) => {
  if (platform === "win32") return `@next/swc-win32-${arch}-msvc`;
  if (platform === "darwin") return `@next/swc-darwin-${arch}`;
  if (platform === "linux") return `@next/swc-linux-${arch}-${linuxLibc()}`;
  return null;
};

/** Normalise to forward slashes without a trailing separator. */
const toPosix = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** True when `target` lives inside `root` (a sibling named `root-suffix` does not count). */
export const isInside = (root, target, caseInsensitive = false) => {
  const r = caseInsensitive ? toPosix(root).toLowerCase() : toPosix(root);
  const t = caseInsensitive ? toPosix(target).toLowerCase() : toPosix(target);
  return t === r || t.startsWith(`${r}/`);
};

/**
 * Compare the installed Next version with the SWC binding Node would actually
 * load. Pure: takes everything it needs, returns a verdict instead of printing.
 *
 * @param {object} input
 * @param {string | null | undefined} input.nextVersion  version from node_modules/next/package.json
 * @param {string | null | undefined} input.swcVersion   version from the resolved binding's package.json
 * @param {string | null | undefined} input.swcPath      directory of the resolved binding
 * @param {string} input.projectDir                      the frontend/ root that owns the expected install
 * @param {string | null} [input.packageName]            binding package name, for the message
 * @param {boolean} [input.caseInsensitive]              Windows-style path comparison
 * @returns {{ status: "ok" | "skipped" | "missing" | "mismatch" | "outside", ok: boolean, message: string }}
 */
export const compareNextSwc = ({
  nextVersion,
  swcVersion,
  swcPath,
  projectDir: root,
  packageName,
  caseInsensitive = process.platform === "win32",
}) => {
  if (!nextVersion) {
    return { status: "skipped", ok: true, message: "" };
  }

  const name = packageName ?? "@next/swc-<platform>";
  const fix = `npm install ${name}@${nextVersion} --no-save --no-package-lock`;

  if (!swcPath || !swcVersion) {
    return {
      status: "missing",
      ok: false,
      message: [
        `[check-next-swc] ${name} is not installed, but next@${nextVersion} requires it.`,
        `  Next would fall back to a binary found higher up the tree, or fail to start.`,
        `  Fix (from frontend/): ${fix}`,
      ].join("\n"),
    };
  }

  const inside = isInside(root, swcPath, caseInsensitive);
  const versionsMatch = String(swcVersion).trim() === String(nextVersion).trim();
  if (inside && versionsMatch) {
    return { status: "ok", ok: true, message: "" };
  }

  const lines = [
    `[check-next-swc] The native SWC binding does not belong to this Next.js install.`,
    `  next:                      ${nextVersion}   (${join(root, "node_modules", "next")})`,
    `  ${name}: ${swcVersion}`,
    `  resolved:                  ${swcPath}`,
  ];
  if (!inside) {
    // The usual cause: a stray node_modules in a parent folder of the project.
    lines.push(
      `  This path is OUTSIDE the project, so Node walked past frontend/node_modules`,
      `  and loaded a binding it found higher up (a home-directory install, for example).`,
    );
  }
  if (!versionsMatch) {
    lines.push(
      `  The 15.x compiler serialises SWC options (e.g. disablePageConfig) that a`,
      `  differently-versioned binary rejects: "unknown field 'disablePageConfig'"`,
      `  followed by a missing .next/fallback-build-manifest.json.`,
    );
  }
  lines.push(
    `  Fix (from frontend/): ${fix}`,
    `  Set NEXT_SWC_STRICT=1 to make this check fail the build instead of warning.`,
  );

  return {
    status: inside ? "mismatch" : "outside",
    ok: false,
    message: lines.join("\n"),
  };
};

/** Find the package.json that owns an already-resolved entry point. */
const packageJsonFor = (entry) => {
  let dir = dirname(entry);
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const main = () => {
  const nextPkgFile = join(projectDir, "node_modules", "next", "package.json");
  if (!existsSync(nextPkgFile)) {
    // No local Next install (fresh clone, install still running): nothing to judge.
    process.exit(0);
  }
  const nextPkg = readJson(nextPkgFile);
  if (typeof nextPkg?.version !== "string" || nextPkg.version === "") {
    // Present but unparseable (interrupted install, truncated file): that is a
    // broken install, not a fresh clone - do not exit 0 as if there were
    // nothing to check. Fail closed only when asked to be strict.
    console.warn(
      `[check-next-swc] ${nextPkgFile} has no readable "version" field, so the native SWC binding cannot be verified. Reinstalling next should fix it.`,
    );
    process.exit(process.env.NEXT_SWC_STRICT === "1" ? 1 : 0);
  }

  const packageName = swcPackageFor(process.platform, process.arch);
  if (!packageName) {
    process.exit(0);
  }

  let swcDir = null;
  let swcPkg = null;
  try {
    // Mirror where Next resolves it from, so we see exactly what Next will load.
    const requireFromNext = createRequire(join(projectDir, "node_modules", "next", "dist", "build", "swc", "index.js"));
    const pkgFile = packageJsonFor(requireFromNext.resolve(packageName));
    swcPkg = pkgFile ? readJson(pkgFile) : null;
    swcDir = pkgFile ? dirname(pkgFile) : null;
  } catch {
    swcDir = null;
  }

  const verdict = compareNextSwc({
    nextVersion: nextPkg.version,
    swcVersion: swcPkg?.version ?? null,
    swcPath: swcDir,
    projectDir,
    packageName,
  });

  if (verdict.ok) {
    process.exit(0);
  }

  console.warn(verdict.message);
  process.exit(process.env.NEXT_SWC_STRICT === "1" ? 1 : 0);
};

// Importable from tests without running the CLI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
