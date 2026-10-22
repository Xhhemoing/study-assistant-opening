import { z } from "zod";
import { courseExamInputSchema, type CourseExamInput } from "@aistudy/contracts";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";

const checkpointSchema = z.object({ version: z.literal(1), courseId: z.string().uuid(), input: courseExamInputSchema }).strict();

/** Capture verified ownership once so a late request cannot overwrite the next login's checkpoint. */
export function createCourseExamCheckpointStore(courseId: string) {
  const namespace = getVerifiedSessionNamespace();
  const key = namespace ? `study:course-exam:v1:${encodeURIComponent(namespace)}:${courseId}` : null;
  function storage() {
    if (!key) throw new Error("组卷请求尚未确认账号身份，未发送新请求。请重新登录后重试。");
    return window.sessionStorage;
  }
  return {
    read(): CourseExamInput | null {
      try {
        const raw = storage().getItem(key!);
        if (!raw) return null;
        const saved = checkpointSchema.parse(JSON.parse(raw));
        if (saved.courseId !== courseId) throw new Error("course changed");
        return saved.input;
      } catch { throw new Error("无法恢复原组卷请求，已停止新组卷。请恢复浏览器存储后重试，或显式另开一份。"); }
    },
    write(input: CourseExamInput) {
      const saved = checkpointSchema.parse({ version: 1, courseId, input });
      try { storage().setItem(key!, JSON.stringify(saved)); }
      catch { throw new Error("无法保存组卷请求，尚未发送。请允许浏览器存储后重试。"); }
    },
    clear() {
      try { storage().removeItem(key!); }
      catch { throw new Error("无法清除原组卷请求，尚未另开一份。请恢复浏览器存储后重试。"); }
    },
  };
}
