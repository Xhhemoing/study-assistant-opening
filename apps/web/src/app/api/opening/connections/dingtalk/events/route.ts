import { getAuthRuntime } from "../../../../../../server/runtime";
import { OpeningS3 } from "@aistudy/database";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createDingTalkCallbackHttpService,
  DingTalkClientError,
  OpeningConnectionError,
  OpeningSourceError,
  MAX_DINGTALK_EVENT_BYTES,
} from "../../../../../../features/opening/connections/dingtalk-callback-service";

export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const runtime = getAuthRuntime();
    const url = new URL(request.url);
    const signature = url.searchParams.get("signature");
    const timestamp = url.searchParams.get("timestamp");
    const nonce = url.searchParams.get("nonce");
    if (!signature || !timestamp || !nonce) {
      throw new DingTalkClientError("FORMAT", "callback query parameters are incomplete");
    }
    const encryptedBody = await request.text();
    if (!encryptedBody || encryptedBody.length > MAX_DINGTALK_EVENT_BYTES) {
      throw new DingTalkClientError("FORMAT", "callback body is invalid");
    }
    const storage = new OpeningS3({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET ?? "aistudy", accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin", forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false" });
    const service = createDingTalkCallbackHttpService(runtime.sql, {
      uploadStaging: async input => {
        await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: input.key, Body: input.bytes, ContentType: input.mime }));
      },
      uploadFinal: async input => {
        await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: input.key, Body: input.bytes, ContentType: input.mime }));
      },
    });
    const result = await service.callback({ signature, timestamp, nonce, encryptedBody });
    void result;
    const ack = service.success(timestamp, nonce);
    response = Response.json(ack, { headers: { "Cache-Control": "no-store" } });
    return response;
  } catch (error) {
    if (error instanceof DingTalkClientError) {
      response = Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "INVALID_CONFIG" ? 503 : 400 },
      );
    } else if (error instanceof OpeningConnectionError) {
      response = Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "NOT_FOUND" ? 404 : 409 },
      );
    } else if (error instanceof OpeningSourceError) {
      response = Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "NOT_FOUND" ? 404 : 409 },
      );
    } else {
      response = Response.json(
        { error: { code: "CONFIGURATION", message: "callback processing failed" } },
        { status: 500 },
      );
    }
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
