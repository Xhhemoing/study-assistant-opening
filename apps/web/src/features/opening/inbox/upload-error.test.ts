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
});
