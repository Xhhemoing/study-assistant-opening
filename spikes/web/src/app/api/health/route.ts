export function GET(): Response {
  return Response.json({
    status: "ok",
    service: "aistudy-web-spike",
  });
}
