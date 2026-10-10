import { Eye, Key, Prohibit, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import Reveal from "./Reveal";

const ITEMS = [
  {
    icon: ShieldCheck,
    title: "Your searches are yours",
    body: "Sign-in is required before anything is shown, so a shared link gives away nothing.",
  },
  {
    icon: Key,
    title: "Secrets stay server-side",
    body: "The credentials used to reach each source stay on the server and are never sent to your browser.",
  },
  {
    icon: Prohibit,
    title: "Nothing private is looked up",
    body: "Addresses that only exist inside a network, such as a machine named localhost or a private 10.x address, are refused before a search starts.",
  },
  {
    icon: Eye,
    title: "A record you can point to",
    body: "Every search is kept against your account with the target and the time, and past results never change once shown.",
  },
];

export default function SecurityStrip() {
  return (
    <section id="security" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24">
      <Reveal>
        <h2 className="max-w-[20ch] text-3xl font-bold tracking-tighter text-slate-900 dark:text-neutral-50 md:text-4xl">
          Secure by default, not by toggle
        </h2>
      </Reveal>
      <ul className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        {ITEMS.map((c, i) => (
          <li key={c.title} className="border-l-2 border-accent/60 pl-4">
            <Reveal delay={Math.min(i * 0.05, 0.15)}>
              <c.icon
                size={20}
                weight="regular"
                className="text-accent motion-safe:animate-bob"
                style={{ animationDelay: `${i * 0.6}s` }}
                aria-hidden="true"
              />
              <h3 className="mt-2 text-sm font-semibold text-slate-900 dark:text-neutral-100">{c.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-neutral-400">{c.body}</p>
            </Reveal>
          </li>
        ))}
      </ul>
    </section>
  );
}
