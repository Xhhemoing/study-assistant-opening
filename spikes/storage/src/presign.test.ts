import { describe, expect, it } from "vitest";
import { createS3Client, presignDownload, presignUpload } from "./presign";

describe("S3-compatible presigned URLs", () => {
  it("generates upload and download URLs against a path-style endpoint", async () => {
    const config = {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "aistudy-spike",
      accessKeyId: "spike-key",
      secretAccessKey: "spike-secret",
    };

    const client = createS3Client(config);
    const key = "workspaces/ws-1/sources/doc.pdf";

    const uploadUrl = await presignUpload(client, config.bucket, key, 60);
    const downloadUrl = await presignDownload(client, config.bucket, key, 60);

    expect(uploadUrl).toContain("127.0.0.1:9000");
    expect(uploadUrl).toContain(config.bucket);
    expect(uploadUrl).toContain("X-Amz-Signature=");
    expect(uploadUrl).toContain("X-Amz-Expires=60");

    expect(downloadUrl).toContain(key.split("/")[0]!);
    expect(downloadUrl).toContain("X-Amz-Signature=");
    expect(downloadUrl).toContain("X-Amz-Expires=60");

    client.destroy();
  });
});
