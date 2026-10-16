import {
  measurementActionInputSchema, measurementNextInputSchema, measurementOverviewSchema,
  measurementStartInputSchema, measurementStatusInputSchema,
  type MeasurementActionInput, type MeasurementNextInput, type MeasurementStartInput, type MeasurementStatusInput,
} from "@aistudy/contracts";
import { z } from "zod";

const courseList = z.object({ courses: z.array(z.object({ id: z.string().uuid(), title: z.string() })) });
const errorBody = z.object({ error: z.object({ message: z.string() }) });
export type MeasurementCourse = z.infer<typeof courseList>["courses"][number];

export function createMeasurementClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetcher(path, {
      method, cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json: unknown = await response.json();
    if (!response.ok) {
      const parsed = errorBody.safeParse(json);
      throw new Error(response.status === 401 ? "登录状态已过期，请重新登录。"
        : response.status >= 500 ? "测试服务暂不可用，请重试。已保存的记录会保留。"
        : parsed.success ? parsed.data.error.message : "操作未完成，请重新读取测试记录。");
    }
    return json;
  }
  const overview = async (path: string, method = "GET", body?: unknown) =>
    measurementOverviewSchema.parse(await request(path, method, body));

  return {
    async courses() { return courseList.parse(await request("/api/courses")).courses; },
    read(courseId: string) { return overview(`/api/opening/measurement?courseId=${encodeURIComponent(courseId)}`); },
    start(input: MeasurementStartInput) { return overview("/api/opening/measurement", "POST", measurementStartInputSchema.parse(input)); },
    status(input: MeasurementStatusInput) { return overview("/api/opening/measurement", "PATCH", measurementStatusInputSchema.parse(input)); },
    next(input: MeasurementNextInput) { return overview("/api/opening/measurement/attempts", "POST", measurementNextInputSchema.parse(input)); },
    act(id: string, input: MeasurementActionInput) { return overview(`/api/opening/measurement/attempts/${encodeURIComponent(id)}`, "POST", measurementActionInputSchema.parse(input)); },
  };
}
