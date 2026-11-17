import { expect, it } from "vitest";
import { OpeningApiError } from "../client/api";
import { UploadUserError, uploadErrorMessage } from "./upload-error";

it("shows explicitly safe local errors and actionable API rejection messages", () => {
  expect(uploadErrorMessage(new UploadUserError("上传已取消"), "失败")).toBe("上传已取消");
  expect(uploadErrorMessage(new OpeningApiError(409, "存储配额不足，请清理后重试。\n at privateFunction /secret:12"), "失败")).toBe("存储配额不足，请清理后重试。");
});

it("does not expose native, network, or internal server exception details", () => {
  expect(uploadErrorMessage(new Error("https://private.example?token=secret\n at /server/private"), "失败")).toBe("失败");
  expect(uploadErrorMessage(new OpeningApiError(500, "password=secret"), "失败")).toBe("失败");
  expect(uploadErrorMessage(new OpeningApiError(400, "request failed (400)"), "失败")).toBe("失败");
  expect(uploadErrorMessage(new OpeningApiError(400, "Invalid request body", "VALIDATION"), "失败")).toBe("失败");
  expect(uploadErrorMessage(new OpeningApiError(400, "参数 zod 错误", "VALIDATION"), "失败")).toBe("失败");
});

it("maps raw English 4xx backend messages to localized Chinese copy by error code", () => {
  const magic = uploadErrorMessage(new OpeningApiError(400, "stored object magic bytes do not match declared MIME", "UPLOAD_MISMATCH"), "失败");
  const notUploaded = uploadErrorMessage(new OpeningApiError(400, "upload not found; PUT to uploadUrl first", "UPLOAD_MISMATCH"), "失败");
  const conflict = uploadErrorMessage(new OpeningApiError(409, "Upload is no longer pending", "CONFLICT"), "失败");
  const notFound = uploadErrorMessage(new OpeningApiError(404, "Pending upload not found", "NOT_FOUND"), "失败");
  for (const text of [magic, notUploaded, conflict, notFound]) {
    expect(text).toMatch(/[\u4e00-\u9fff]/);
    expect(text).not.toMatch(/magic bytes|upload not found|no longer pending|Pending upload/i);
  }
  expect(new Set([magic, conflict, notFound]).size).toBe(3);
});
