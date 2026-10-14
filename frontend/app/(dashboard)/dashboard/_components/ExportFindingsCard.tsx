"use client";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonClasses } from "@/components/ui/button";
import type { ScanResult } from "@/lib/api";
import {
  EXPORT_CAVEAT_SUMMARY,
  EXPORT_MIME,
  buildJsonExport,
  buildMarkdownExport,
  exportFileName,
  type ExportFormat,
} from "@/lib/export-findings";

/**
 * The export surface.
 *
 * Everything the dashboard rendered for one scan can be downloaded from here,
 * client-side. No request is made and nothing is stored: the file is built in
 * the browser from the scan object the page already holds, so it cannot contain
 * a field the analyst was not shown and it cannot leave the session.
 *
 * Three rules this component is responsible for:
 *
 *  1. The JSON and Markdown builders are dependency-free and imported
 *     statically; the PDF path is a dynamic `import()` so `jspdf` lands in its
 *     own chunk and only loads when someone asks for a PDF.
 *  2. A failure is a destructive Badge that says what happened, not a silent
 *     no-op — an export that quietly produces nothing is worse than one that
 *     fails loudly.
 *  3. The caveats travel with the button. `EXPORT_CAVEAT_SUMMARY` is rendered
 *     above the controls so the card and the file promise the same thing.
 */

/** Label, and how long the button stays busy while the file is built. */
const FORMATS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: "json", label: "JSON", hint: "Machine-readable — every field the dashboard printed, with plain-text values." },
  { format: "markdown", label: "Markdown", hint: "Readable in any editor — external text is escaped and banners stay verbatim." },
  { format: "pdf", label: "PDF", hint: "A paginated monospace report, built in your browser." },
];

function failureMessage(format: ExportFormat, error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message : "";
  const where = format === "pdf" ? "the PDF generator" : "the file builder";
  return `We could not build the ${format.toUpperCase()} file — ${where} failed in your browser.${detail ? ` (${detail})` : ""} Nothing was downloaded; try again.`;
}

export default function ExportFindingsCard({
  scan,
  loading,
}: {
  scan: ScanResult | null;
  loading: boolean;
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<string | null>(null);

  const failedSources = scan?.errors?.length ?? 0;

  const download = async (format: ExportFormat) => {
    if (!scan || busy) return;
    setBusy(format);
    setError(null);
    setBuilt(null);
    try {
      const { blob } = await buildFile(format, scan);
      const name = exportFileName(format, scan.target);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on the next tick: Safari cancels the download if the URL goes
      // away in the same frame as the click.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setBuilt(`Saved ${name}`);
    } catch (e: unknown) {
      setError(failureMessage(format, e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="relative flex flex-col overflow-hidden">
      <CardHeader>
        <CardTitle>Export findings</CardTitle>
        <CardDescription>{EXPORT_CAVEAT_SUMMARY}</CardDescription>
      </CardHeader>
      <CardContent className="relative">
        {loading ? (
          <Skeleton className="h-24" />
        ) : !scan ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            No findings to export yet — run a search first. The file is built from what this screen showed you, so
            there is nothing to build before there is a scan.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Export format">
              {FORMATS.map((f) => (
                <button
                  key={f.format}
                  type="button"
                  title={f.hint}
                  disabled={busy !== null}
                  aria-busy={busy === f.format}
                  onClick={() => void download(f.format)}
                  className={buttonClasses(busy === f.format ? "accent" : "outline", "sm")}
                >
                  {busy === f.format ? `Building ${f.label}…` : f.label}
                </button>
              ))}
            </div>

            {failedSources > 0 && (
              <p className="mt-3 text-xs text-warning">
                {failedSources} {failedSources === 1 ? "source did" : "sources did"} not answer this scan. The export
                lists {failedSources === 1 ? "it" : "each one"} with its message instead of leaving a gap, and reports
                the result as incomplete.
              </p>
            )}

            <ul className="mt-3 flex flex-col gap-1 text-xs opacity-60">
              <li>Built in your browser from this page&apos;s result — nothing is uploaded and no copy is kept.</li>
              <li>External text is written as plain text, banners are cut short, and every cut is stated in the file.</li>
              <li>Only what this screen showed you is included; no new fields are collected.</li>
            </ul>

            {built && (
              <p className="mt-3 text-xs opacity-60" aria-live="polite">
                {built}
              </p>
            )}
            {error && (
              <div className="mt-3">
                <Badge variant="destructive">{error}</Badge>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Build the file for one format.
 *
 * `lib/export-findings.ts` carries no dependency of its own — it reduces the
 * scan to plain strings — so it is imported statically. The PDF path is the
 * only dynamic `import()` here because it is the only one that reaches for
 * `jspdf`: the library lands in its own chunk and loads when an analyst clicks
 * "PDF", which is why it does not appear in the build's First Load JS.
 */
async function buildFile(format: ExportFormat, scan: ScanResult): Promise<{ blob: Blob }> {
  if (format === "json") {
    return { blob: new Blob([buildJsonExport(scan)], { type: EXPORT_MIME.json }) };
  }
  if (format === "markdown") {
    return { blob: new Blob([buildMarkdownExport(scan)], { type: EXPORT_MIME.markdown }) };
  }
  const { buildPdf } = await import("@/lib/export-pdf");
  return { blob: (await buildPdf(scan)).blob };
}
