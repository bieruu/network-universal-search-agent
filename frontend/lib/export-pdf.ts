/**
 * PDF rendering for the findings export.
 *
 * This is the only module in the app that imports `jspdf`, and nothing imports
 * it statically: the export card reaches for it with a dynamic `import()`, so
 * the library lands in its own chunk and loads when an analyst actually clicks
 * "PDF". The First Load JS measured in the repo's build output therefore does
 * not carry it.
 *
 * The drawing itself is deliberately dumb. `buildPdfLines` (lib/export-findings.ts)
 * has already reduced the scan to plain text - control characters stripped,
 * banners cut, lists capped - so all that is left here is wrapping, page breaks
 * and a monospace font. No value is interpreted, and there is no markup in this
 * path at all: a PDF has no HTML sink to inject into.
 */

import type { ScanResult } from "./api.ts";
import { buildPdfLines } from "./export-findings.ts";

/** A4 in points, with margins wide enough to stay printable. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 56, right: 48, bottom: 56, left: 48 };
const BODY_SIZE = 10;
const LINE_HEIGHT = 14;
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

export interface PdfResult {
  blob: Blob;
  /** How many pages were laid out - asserted in the tests. */
  pages: number;
}

/** Build the PDF for a scan and return it as a Blob, ready to download. */
export async function buildPdf(scan: ScanResult | null | undefined, now?: Date): Promise<PdfResult> {
  const { jsPDF } = await import("jspdf");
  const lines = buildPdfLines(scan, now);

  const doc = new jsPDF({ unit: "pt", format: [PAGE.width, PAGE.height] });
  doc.setFont("courier", "normal");
  doc.setFontSize(BODY_SIZE);

  let y = MARGIN.top;
  let pages = 1;
  const newPage = () => {
    doc.addPage();
    pages += 1;
    y = MARGIN.top;
  };

  for (const line of lines) {
    if (line.length === 0) {
      y += LINE_HEIGHT / 2;
      continue;
    }
    // Wrapping is per line. A banner that is one long token has to break; an
    // ordinary sentence must not lose its words, so no hyphenation is applied.
    const wrapped = doc.splitTextToSize(line, CONTENT_WIDTH) as string[];
    for (const piece of wrapped) {
      if (y > PAGE.height - MARGIN.bottom) newPage();
      doc.text(piece, MARGIN.left, y);
      y += LINE_HEIGHT;
    }
  }

  const blob = doc.output("blob");
  return { blob, pages };
}
