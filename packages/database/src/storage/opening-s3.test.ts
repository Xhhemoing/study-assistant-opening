import { describe, expect, it } from "vitest";
import { OpeningStorageError, OpeningS3, type S3ClientLike } from "./opening-s3";

describe("opening S3 storage", () => {
  it("builds immutable staging and versioned final keys", () => {
    const storage = new OpeningS3({ endpoint: "http://minio", region: "us-east-1", bucket: "aistudy", accessKeyId: "a", secretAccessKey: "b", forcePathStyle: true });
    expect(storage.stagingKey("source")).toBe("opening/staging/source");
    expect(storage.finalKey("source", 0)).toBe("opening/sources/source/v0");
  });
  it("returns a typed not-found result for a missing object", async () => {
    const client: S3ClientLike = { send: async () => { const e = new Error("missing"); Object.assign(e, { name: "NotFound", $metadata: { httpStatusCode: 404 } }); throw e; } };
    const storage = new OpeningS3({ endpoint: "http://minio", region: "us-east-1", bucket: "aistudy", accessKeyId: "a", secretAccessKey: "b", forcePathStyle: true }, client);
    expect(await storage.headObject("missing")).toEqual({ exists: false, bytes: 0, etag: "", mime: "" });
    expect(OpeningStorageError).toBeDefined();
  });
});
