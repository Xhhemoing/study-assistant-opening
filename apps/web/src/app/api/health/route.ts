import { healthResponseSchema } from "@aistudy/contracts";

export function GET(): Response {
  const body = healthResponseSchema.parse({
    status: "ok",
    service: "aistudy-web",
  });
  return Response.json(body);
}
