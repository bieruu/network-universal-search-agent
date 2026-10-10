import { ResetPasswordForm } from "./reset-password-form";

// Ungated: `middleware.ts` matches only `/dashboard/:path*`, so a signed-out
// user holding only an emailed token can still reach this page. That is the
// whole point of the flow.
//
// The token is read here, on the server, from the query string. Better Auth's
// emailed link points at `/api/auth/reset-password/:token`, validates it, and
// redirects here with either `?token=...` or `?error=INVALID_TOKEN`.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  return <ResetPasswordForm token={first(params.token)} error={first(params.error)} />;
}