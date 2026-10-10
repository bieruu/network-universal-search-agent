import { ForgotPasswordForm } from "./forgot-password-form";

// Reachable while signed out, like `/sign-in` and `/sign-up`: `middleware.ts`
// matches only `/dashboard/:path*`, so these routes are outside its matcher and
// stay ungated. A password-reset page behind a session gate would be useless.
export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}