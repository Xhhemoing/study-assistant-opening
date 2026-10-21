import { z } from "zod";
import { uuidSchema } from "./foundation";

export const firstLearningInputSchema = z.object({
  clientKey: uuidSchema,
  topic: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(1000).default(""),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const instant = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
  }, "请填写真实日期").nullable().default(null),
  minutes: z.number().int().min(10).max(180),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(80).refine(value => {
    try { new Intl.DateTimeFormat("zh-CN", { timeZone: value }); return true; } catch { return false; }
  }, "请选择有效时区"),
  sourceIds: z.array(uuidSchema).max(32).default([]).transform(ids => [...new Set(ids)].sort()),
}).strict().refine(value => {
  const [hour, minute] = value.startTime.split(":").map(Number);
  return hour! * 60 + minute! + value.minutes < 1440;
}, "学习时段不能跨越午夜");
export type FirstLearningInput = z.infer<typeof firstLearningInputSchema>;
