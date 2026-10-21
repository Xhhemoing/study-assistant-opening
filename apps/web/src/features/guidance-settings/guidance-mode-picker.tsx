"use client";

import { ui } from "../opening/design/ui";
import { Plus, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { GuidanceMode } from "@aistudy/domain";
import {
  dailySlotsEqual,
  GUIDANCE_MODE_OPTIONS,
  isValidDailySlot,
  type DailyProtectedSlot,
} from "./guidance-mode-model";

export interface GuidanceModeDraft {
  mode: GuidanceMode;
  protectedSlots: DailyProtectedSlot[];
}

export function GuidanceModePicker({
  value,
  onChange,
}: {
  value: GuidanceModeDraft;
  onChange: (value: GuidanceModeDraft) => void;
}) {
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("20:00");
  const [slotError, setSlotError] = useState("");

  function addSlot() {
    const slot: DailyProtectedSlot = { start, end };
    if (!isValidDailySlot(slot)) {
      setSlotError("结束时间需晚于开始时间。");
      return;
    }
    setSlotError("");
    if (value.protectedSlots.some((item) => dailySlotsEqual(item, slot))) {
      setSlotError("该时段已预留。");
      return;
    }
    onChange({
      ...value,
      protectedSlots: [...value.protectedSlots, slot].sort((a, b) =>
        a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
      ),
    });
  }

  function removeSlot(slot: DailyProtectedSlot) {
    onChange({
      ...value,
      protectedSlots: value.protectedSlots.filter((item) => !dailySlotsEqual(item, slot)),
    });
  }

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-text">指导模式</legend>
        <p className="text-xs text-text-3">
          决定系统能否自动调整计划，以及建议是否需要确认。
        </p>
        <div className="divide-y divide-line border-y border-line">
          {GUIDANCE_MODE_OPTIONS.map((option) => (
            <label
              className={`block cursor-pointer px-3 py-3 transition-colors duration-150 motion-reduce:transition-none focus-within:ring-2 focus-within:ring-accent ${
                value.mode === option.value
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface hover:bg-surface-2"
              }`}
              key={option.value}
            >
              <input
                checked={value.mode === option.value}
                className="sr-only"
                name="guidance-mode"
                onChange={() => onChange({ ...value, mode: option.value })}
                type="radio"
                value={option.value}
              />
              <span className="block text-sm font-semibold text-text">{option.label}</span>
              <span className="mt-1 block text-xs leading-5 text-text-2">
                {option.description}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <section className="space-y-3" aria-labelledby="protected-exploration-heading">
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" size={16} className="text-text-3" />
          <h3 className="text-sm font-semibold text-text" id="protected-exploration-heading">
            预留探索时间
          </h3>
        </div>
        <p className="text-xs text-text-3">
          教练模式自动排计划时不会占用这些时段。
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="text-xs text-text-3">开始</span>
            <input
              className={ui.input}
              onChange={(event) => setStart(event.target.value)}
              type="time"
              value={start}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-text-3">结束</span>
            <input
              className={ui.input}
              onChange={(event) => setEnd(event.target.value)}
              type="time"
              value={end}
            />
          </label>
          <button
            className={ui.secondary}
            onClick={addSlot}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            添加
          </button>
        </div>
        {slotError ? (
          <p className="text-sm text-danger" role="alert">
            {slotError}
          </p>
        ) : null}
        {value.protectedSlots.length > 0 ? (
          <ul className="space-y-2">
            {value.protectedSlots.map((slot) => (
              <li
                className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-sm text-text"
                key={`${slot.start}-${slot.end}`}
              >
                <span>
                  {slot.start} – {slot.end}
                </span>
                <button
                  aria-label={`移除 ${slot.start}–${slot.end} 预留时段`}
                  className={ui.icon}
                  onClick={() => removeSlot(slot)}
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-3">尚未预留任何探索时段。</p>
        )}
      </section>
    </div>
  );
}
