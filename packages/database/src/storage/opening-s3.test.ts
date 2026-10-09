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

  it("copies a versioned object with CopyObjectCommand", async () => {
    const calls: unknown[] = [];
    const client: S3ClientLike = {
      send: async (command) => {
        calls.push(command);
        return {};
      },
    };
    const storage = new OpeningS3(
      { endpoint: "http://minio", region: "us-east-1", bucket: "aistudy", accessKeyId: "a", secretAccessKey: "b", forcePathStyle: true },
      client,
    );
    await storage.copyObject("opening/sources/src/v1", "opening/sources/src/v2");
    expect(calls).toHaveLength(1);
    const input = (calls[0] as { input: Record<string, string> }).input;
    expect(input).toMatchObject({
      Bucket: "aistudy",
      Key: "opening/sources/src/v2",
      CopySource: "aistudy/opening/sources/src/v1",
    });
    await storage.copyObject("same", "same");
    expect(calls).toHaveLength(1);
  });


  it("puts object bytes with PutObjectCommand", async () => {
    const calls: unknown[] = [];
    const client: S3ClientLike = {
      send: async (command) => {
        calls.push(command);
        return {};
      },
    };
    const storage = new OpeningS3(
      { endpoint: "http://minio", region: "us-east-1", bucket: "aistudy", accessKeyId: "a", secretAccessKey: "b", forcePathStyle: true },
      client,
    );
    const body = new Uint8Array([1, 2, 3]);
    await storage.putObject("opening/sources/src/v1", body, { mime: "application/octet-stream" });
    expect(calls).toHaveLength(1);
    const input = (calls[0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      Bucket: "aistudy",
      Key: "opening/sources/src/v1",
      ContentLength: 3,
      ContentType: "application/octet-stream",
    });
    expect(input.Body).toBe(body);
  });

});
