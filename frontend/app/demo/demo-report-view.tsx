"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TD, TH, THead, TRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { nvdStatusView, sourceFailureCount } from "@/lib/scan-status";
import { TERM, termNote } from "@/lib/terms";
import { DEMO_NOTICE } from "../_components/landing/playground-demo";
import {
  DEMO_REPORTS,
  demoSourceLabel,
  demoStats,
  nameListNote,
  type DemoReport,
} from "./demo-report";

/**
 * The `/demo` report surface.
 *
 * WHAT MAKES THIS PAGE ALLOWED
 * ----------------------------
 * It shows a finished scan report to anyone — signed out or signed in — while
 * making ZERO requests. No session is read, no API client is imported, no
 * fixture is fetched (they are module data). The honesty floor is the same one
 * the playground terminal lives by, applied to a whole page:
 *
 *   - `DEMO_NOTICE` (from the shared `playground-demo.ts`, not a copy) prints
 *     in the first card, and the caption "Demo — simulated output" appears at
 *     the top, beside the switcher and at the bottom — three places, because a
 *     simulated report that can be mistaken for a real one is the one bug this
 *     page must not have.
 *   - Cards whose rows come from the fixture say so in their description;
 *     cards that show illustrative detail carry an "Illustrative — demo data"
 *     badge beside the rows themselves.
 *   - Empty states are real: the fixture records no dates and no individual
 *     ports, so those lines say exactly that instead of showing a plausible
 *     number. The scripted `errors[]` on one target renders the same partial-
 *     failure block the dashboard prints, including "not checked, not
 *     confirmed absent".
 *
 * WHY CLIENT: only to switch which fixture's report is on screen. The switch
 * is a `useState` over module data — the selected report is server-rendered
 * with the page (client components render on the server too), so the HTML a
 * crawler or a no-JS visitor gets already carries this notice and one full
 * report.
 */

/** The caption every simulated surface on this page carries, in words. */
const DEMO_CAPTION = "Demo — simulated output";

export default function DemoReportView() {
  const [active, setActive] = useState(0);
  const report = DEMO_REPORTS[active] ?? DEMO_REPORTS[0];

  return (
    <div className="space-y-4">
      {/* 1 — what this page is, before any figure appears. */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50">
          Demo scan report
        </h1>
        <Badge variant="outline" className="border-accent/40 font-mono text-accent">
          {DEMO_CAPTION}
        </Badge>
      </div>
      <p className="max-w-[65ch] text-base leading-relaxed text-slate-600 dark:text-neutral-400">
        One finished report, laid out the way the dashboard lays out a real one — built from the
        sample fixtures this site ships. Switching targets just swaps which fixture is on screen;
        nothing is fetched.
      </p>

      {/* 2 — the notice. Border-accent because everything below is simulated. */}
      <Card aria-label="about this demo" className="border-accent/50">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
            {DEMO_CAPTION}
          </CardTitle>
          <Badge variant="outline" className="font-mono">
            static fixtures · zero requests
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          <p className="font-mono text-sm text-slate-700 dark:text-neutral-300">{DEMO_NOTICE}</p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600 dark:text-neutral-400">
            <li>
              Every figure comes from the site's own fixtures or is labelled illustrative — no
              scan ran to produce this page.
            </li>
            <li>
              Where the fixture has no number — dates, individual ports, a score — the report
              says so instead of inventing one.
            </li>
            <li>
              In a real report, a failed source leaves gaps, not answers: rows are
              &quot;not checked&quot;, never &quot;confirmed absent&quot;, and an empty
              vulnerability list is not proof the target is safe.
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* 3 — target switcher. Buttons, not links: it swaps module data in
          place, and `aria-pressed` is how the selected one reaches AT. */}
      <div>
        <div role="group" aria-label="Demo target" className="flex flex-wrap items-center gap-2">
          {DEMO_REPORTS.map((r, i) => (
            <button
              key={r.target}
              type="button"
              aria-pressed={i === active}
              onClick={() => setActive(i)}
              className={cn(
                "rounded-full border px-4 py-1.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                i === active
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-btn-border text-slate-600 hover:border-accent/40 hover:text-accent dark:text-neutral-400",
              )}
            >
              {r.command}
            </button>
          ))}
        </div>
        <p className="mt-2 font-mono text-xs text-slate-500 dark:text-neutral-500">
          {DEMO_CAPTION} · three fixed targets
        </p>
      </div>

      {/* 4 — the report itself. */}
      <ReportHeader report={report} />
      <StatsStrip report={report} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SourcesCard report={report} />
        <PortsCard report={report} />
        <NamesCard report={report} />
        <DetailsCard report={report} />
        <VulnerabilitiesCard report={report} />
        <RiskCard report={report} />
      </div>

      {/* 5 — out. The caption repeats so the page ends on the same promise
          it opened with, next to the two ways forward. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-btn-border bg-panel p-4">
        <p className="font-mono text-xs text-slate-500 dark:text-neutral-500">
          {DEMO_CAPTION} · this page never ran a scan
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/" className={buttonClasses("outline", "sm")}>
            Back to the landing page
          </Link>
          <Link href="/dashboard" className={buttonClasses("accent", "sm")}>
            Open dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Command, target, and the partial-failure block — the dashboard's pattern. */
function ReportHeader({ report }: { report: DemoReport }) {
  return (
    <Card aria-label={`demo report for ${report.target}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="font-mono text-base">{report.command}</CardTitle>
          <CardDescription>
            The fixture&apos;s risk line reports status{" "}
            <span className="font-mono">{report.riskStatus ?? "— (not recorded)"}</span> for this
            target.
          </CardDescription>
        </div>
        <Badge variant="outline" className="font-mono">
          {report.riskStatus ?? "status not recorded"}
        </Badge>
      </CardHeader>
      <CardContent>
        {report.errors.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-warning">
              {sourceFailureCount(report.errors.length)}
            </p>
            <ul className="flex flex-wrap gap-1.5" aria-label="sources that did not answer">
              {report.errors.map((e) => (
                <li key={e.source}>
                  <Badge variant="outline">{demoSourceLabel(e.source)}</Badge>
                </li>
              ))}
            </ul>
            <p className="font-mono text-xs text-slate-500 dark:text-neutral-500">
              {report.errors.map((e) => `${e.source}: ${e.message}`).join(" ")}
            </p>
            <p className="text-xs text-slate-600 dark:text-neutral-400">
              Anything missing below was not checked, not confirmed absent. This failure is
              scripted for the demo so the partial state is visible.
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            No source failure is scripted for this target — all four fixture lines answer.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StatsStrip({ report }: { report: DemoReport }) {
  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-btn-border bg-btn-border lg:grid-cols-4"
      aria-label="report stats"
    >
      {demoStats(report).map((s) => (
        <div key={s.key} className="bg-background/95 p-4">
          <p className="text-sm text-slate-600 dark:text-neutral-400">{s.label}</p>
          <p className="mt-1 font-mono text-3xl font-bold tabular-nums">{s.value}</p>
          <p className="mt-1 truncate text-xs text-slate-500 dark:text-neutral-500">{s.hint}</p>
        </div>
      ))}
    </div>
  );
}

/** The fixture itself: the four lines, verbatim, in a table. */
function SourcesCard({ report }: { report: DemoReport }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>The fixture&apos;s source lines</CardTitle>
        <CardDescription>
          The four lines this demo is built from, for {report.target} — verbatim.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {report.lines.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            No source lines in this fixture.
          </p>
        ) : (
          <Table>
            <THead>
              <TRow>
                <TH scope="col">Source</TH>
                <TH scope="col">What the fixture says</TH>
              </TRow>
            </THead>
            <tbody>
              {report.lines.map((l) => (
                <TRow key={l.source}>
                  <TD className="whitespace-nowrap font-mono text-xs">{l.source}</TD>
                  <TD className="font-mono text-xs text-slate-600 dark:text-neutral-400">
                    {l.says}
                  </TD>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** A count with no rows — and it says why instead of showing fake ports. */
function PortsCard({ report }: { report: DemoReport }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>{TERM.ports.label}</CardTitle>
        <CardDescription title={termNote("ports")}>
          Counted in the fixture&apos;s shodan line — not measured on this page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {report.metrics.ports == null ? (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            The fixture line for this target no longer reports a port count.
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-neutral-300">
              The fixture records{" "}
              <span className="font-mono">{report.metrics.ports}</span> ports seen for{" "}
              <span className="font-mono">{report.target}</span>.
            </p>
            <p className="text-sm text-slate-500 dark:text-neutral-500">
              The fixture does not say which ports, and this demo invents no port numbers to
              fill the table.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Illustrative names, marked beside the rows, with the count stated honestly. */
function NamesCard({ report }: { report: DemoReport }) {
  const total = report.metrics.certNames;
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{TERM.subdomains.label}</CardTitle>
          <CardDescription title={termNote("subdomains")}>
            {total == null
              ? "The fixture counts no names for this target."
              : `${total} names counted in the fixture line`}
            {" · "}
            {TERM.issuer.label}: {report.issuer ?? "not recorded"}
          </CardDescription>
        </div>
        <Badge variant="outline" className="font-mono">
          Illustrative — demo data
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {report.names.length > 0 && (
          <ul
            className="flex flex-wrap gap-1.5"
            aria-label={`illustrative names for ${report.target}`}
          >
            {report.names.map((n) => (
              <li key={n}>
                <Badge variant="secondary" className="font-mono">
                  {n}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-600 dark:text-neutral-400">{nameListNote(report)}</p>
      </CardContent>
    </Card>
  );
}

/** Registration details: registrar and counts from the fixture, dates absent. */
function DetailsCard({ report }: { report: DemoReport }) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{TERM.whois.label}</CardTitle>
          <CardDescription title={termNote("whois")}>
            Parsed from the fixture&apos;s whois line for {report.target}.
          </CardDescription>
        </div>
        {report.nameServers.length > 0 && (
          <Badge variant="outline" className="font-mono">
            Illustrative — hostnames
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        <dl className="space-y-1.5 text-sm">
          <div>
            <dt className="inline text-slate-500 dark:text-neutral-500" title={termNote("registrant")}>
              {TERM.registrant.label}:{" "}
            </dt>
            <dd className="inline font-mono">{report.registrar ?? "not recorded in the fixture"}</dd>
          </div>
          <div>
            <dt className="inline text-slate-500 dark:text-neutral-500">First registered: </dt>
            <dd className="text-slate-500 dark:text-neutral-500">
              Not in the demo fixture.
            </dd>
          </div>
          <div>
            <dt className="inline text-slate-500 dark:text-neutral-500">Expires: </dt>
            <dd className="text-slate-500 dark:text-neutral-500">
              Not in the demo fixture — and no date is invented for it.
            </dd>
          </div>
          <div>
            <dt className="inline text-slate-500 dark:text-neutral-500" title={termNote("nameservers")}>
              {TERM.nameservers.label}:{" "}
            </dt>
            <dd className="inline font-mono">
              {report.nameserverCount == null ? (
                <span className="font-mono text-slate-500 dark:text-neutral-500">
                  the fixture&apos;s whois line for this target records none
                </span>
              ) : (
                report.nameServers.join(", ")
              )}
            </dd>
          </div>
        </dl>
        {report.nameServers.length > 0 && (
          <p className="mt-2 text-xs text-slate-600 dark:text-neutral-400">
            Hostnames here are illustrative demo data; only the count comes from the fixture.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Empty or failed — never "clean". The scripted failure renders the product's
 * own `unavailable` copy; the empty state states that absence of rows is not a
 * result, and the `no_match` truth sits under both.
 */
function VulnerabilitiesCard({ report }: { report: DemoReport }) {
  const failure = report.errors.find((e) => e.source === "nvd");
  const unavailable = nvdStatusView("unavailable");
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>{TERM.cves.label}</CardTitle>
        <CardDescription title={termNote("nvd")}>
          What a real scan checks detected products against ({TERM.nvd.short}). This fixture
          carries no rows.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {failure ? (
          <div className="space-y-1.5">
            <Badge variant="destructive">{unavailable.label}</Badge>
            <p className="text-sm text-slate-600 dark:text-neutral-300">{unavailable.detail}</p>
            <p className="font-mono text-xs text-slate-500 dark:text-neutral-500">
              {failure.message}
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-neutral-500">
            No vulnerability rows in this demo fixture — the sample lines never carried any. That
            is absence of data, not a clean result.
          </p>
        )}
        <p className="text-xs text-slate-600 dark:text-neutral-400">
          An empty answer (<span className="font-mono">no_match</span>) means no catalogue entry
          matched that exact product and version — not proof the target is safe.
        </p>
      </CardContent>
    </Card>
  );
}

function RiskCard({ report }: { report: DemoReport }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>{TERM.risk.label}</CardTitle>
        <CardDescription title={termNote("risk")}>
          {TERM.risk.short} — the status word from the fixture&apos;s risk line.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="font-mono text-2xl font-bold">{report.riskStatus ?? "not recorded"}</p>
        <p className="text-sm text-slate-600 dark:text-neutral-400">
          The fixture has a status word and no numeric score, so none is shown here — a real
          report puts its score beside this word.
        </p>
      </CardContent>
    </Card>
  );
}
