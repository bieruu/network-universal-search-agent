import Link from "next/link";
import { AuthShell } from "@/app/(auth)/_components/auth-shell";
import { buttonClasses } from "@/components/ui/button";
import { resolveSignupPolicy, signupClosedBody, SIGNUP_CLOSED_TITLE } from "@/lib/signup-gate";
import SignUpForm from "./sign-up-form";

// The gate below is presentation only — the authoritative check lives in
// `lib/auth.ts` (betterAuth `databaseHooks.user.create.before`), which cannot
// be bypassed by posting straight to the auth endpoint. This route is forced
// dynamic so the copy always reflects the env actually loaded at request time
// rather than a value baked in at build time.
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  const policy = resolveSignupPolicy();

  if (!policy.enabled) {
    return (
      <AuthShell title={SIGNUP_CLOSED_TITLE} description="This deployment is not accepting new accounts.">
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
        >
          <p>{signupClosedBody(policy)}</p>
          <Link className={`${buttonClasses("accent")} mt-4 w-full`} href="/sign-in">
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return <SignUpForm restricted={policy.restricted} />;
}
