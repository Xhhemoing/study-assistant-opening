import { expect, it } from "vitest";
import { openingUploadBatchBytes, openingUploadBatchFiles, uploadBatchRejection } from "./upload-preflight";

it("allows the largest supported video and exact count/byte boundaries", () => {
  expect(uploadBatchRejection([{ size: openingUploadBatchBytes }])).toBeNull();
  expect(uploadBatchRejection(Array.from({ length: openingUploadBatchFiles }, () => ({ size: 1 })))).toBeNull();
  expect(uploadBatchRejection([{ size: 1 }], { count: 19, bytes: openingUploadBatchBytes - 1 })).toBeNull();
});

it("includes retained failed uploads in both limits", () => {
  expect(uploadBatchRejection([{ size: 1 }], { count: 20, bytes: 20 })).toContain("最多 20 份");
  expect(uploadBatchRejection([{ size: 2 }], { count: 1, bytes: openingUploadBatchBytes - 1 })).toContain("总大小不能超过 512 MiB");
});
