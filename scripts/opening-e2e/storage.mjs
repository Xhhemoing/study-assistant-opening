import { S3Client, HeadBucketCommand, CreateBucketCommand,
  PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

export async function prepareOpeningE2eStorage(env) {
  const s3 = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }, forcePathStyle: true });
  const Bucket = env.S3_BUCKET;
  try {
    try { await s3.send(new HeadBucketCommand({ Bucket })); }
    catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
      await s3.send(new CreateBucketCommand({ Bucket }));
    }
    const cors = await fetch(`${env.S3_ENDPOINT}/${Bucket}/cors-probe`, { method: "OPTIONS", headers: {
      Origin: env.PUBLIC_BASE_URL, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type",
    } });
    if (!cors.ok || cors.headers.get("access-control-allow-origin") !== env.PUBLIC_BASE_URL) {
      throw new Error("Isolated MinIO CORS does not permit the browser upload origin");
    }
    const Key = `acceptance-probes/${randomUUID()}`;
    try {
      await s3.send(new PutObjectCommand({ Bucket, Key, Body: "opening-e2e-storage-probe" }));
      const response = await s3.send(new GetObjectCommand({ Bucket, Key }));
      if (await response.Body.transformToString() !== "opening-e2e-storage-probe") throw new Error("Storage bytes mismatch");
    } finally { await s3.send(new DeleteObjectCommand({ Bucket, Key })); }
  } finally { s3.destroy(); }
}
