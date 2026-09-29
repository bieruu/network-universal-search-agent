import { Eye, Key, Prohibit, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import Reveal from "./Reveal";

const ITEMS = [
  {
    icon: ShieldCheck,
    title: "Session-gated",
    body: "Middleware guards the dashboard; the API rejects missing sessions with 401.",
  },
  {
    icon: Key,
    title: "Secrets stay server-side",
    body: "Shodan key and DB URLs live in backend env only. The bundle carries none.",
  },
  {
    icon: Prohibit,
    title: "Private ranges blocked",
    body: "Localhost, RFC1918, and link-local targets are rejected front and back.",
  },
  {
    icon: Eye,
    title: "Audit by default",
    body: "Scans persist as immutable snapshots with user, target, and request ID.",
  },
];

export default function SecurityStrip() {
  return (
    <section id="security" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24">
      <Reveal>
        <h2 className="max-w-[20ch] text-3xl font-bold tracking-tighter text-neutral-50 md:text-4xl">
          Secure by default, not by toggle
        </h2>
      </Reveal>
      <ul className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        {ITEMS.map((c, i) => (
          <Reveal key={c.title} delay={Math.min(i * 0.05, 0.15)}>
            <li className="border-l-2 border-[#00E59B]/60 pl-4">
              <c.icon size={20} weight="regular" className="text-[#00E59B]" aria-hidden="true" />
              <h3 className="mt-2 text-sm font-semibold text-neutral-100">{c.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-neutral-400">{c.body}</p>
            </li>
          </Reveal>
        ))}
      </ul>
    </section>
  );
}
