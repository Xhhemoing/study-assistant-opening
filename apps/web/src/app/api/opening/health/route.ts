/** Public process liveness only. Dependency diagnostics stay in the operator CLI. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ status: "ok", kind: "liveness" }, {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
