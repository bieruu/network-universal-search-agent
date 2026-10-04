import { toNextJsHandler } from "better-auth/next-js";

export const runtime = "nodejs";

type AuthHandlers = ReturnType<typeof toNextJsHandler>;
let handlers: Promise<AuthHandlers> | undefined;

function getHandlers() {
  handlers ??= import("@/lib/auth").then(({ auth }) => toNextJsHandler(auth));
  return handlers;
}

export async function GET(request: Request) {
  return (await getHandlers()).GET(request);
}

export async function POST(request: Request) {
  return (await getHandlers()).POST(request);
}
