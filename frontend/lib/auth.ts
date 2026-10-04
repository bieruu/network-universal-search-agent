import { betterAuth } from "better-auth";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run Better Auth");
}
if (
  !secret ||
  secret.length < 32 ||
  /^(replace-with|change-me|dev-secret|your-secret)/i.test(secret)
) {
  throw new Error("BETTER_AUTH_SECRET must be a non-default secret of at least 32 characters");
}
if (!baseURL) {
  throw new Error("BETTER_AUTH_URL is required to run Better Auth");
}

const socialProviders = {
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {}),
  ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        },
      }
    : {}),
};

export const auth = betterAuth({
  database: new Pool({ connectionString: databaseUrl }),
  secret,
  baseURL,
  trustedOrigins: [baseURL],
  emailAndPassword: { enabled: true },
  socialProviders,
});
