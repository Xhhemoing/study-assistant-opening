"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Segmented } from "../opening/v3/ui/segmented";
import { useLayoutPref, type Corner, type Density, type Skin } from "../opening/v3/shell/use-layout-pref";

/** 外观：材质 / 密度 / 圆角，只存本机，写到外观层 data-*。 */
export function UiStyleSettings() {
  const [pref, setPref] = useLayoutPref();
  // 本机偏好在水合后才读取：首屏输出确定、不选中任何项
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (!hydrated) return null;
  return (
    <div className="grid gap-3">
      <Row label="材质" hint="玻璃：顶栏、浮层半透明；纸面：实色">
        <Segmented<Skin> name="skin" label="材质" value={pref.skin} onChange={skin => setPref({ skin })} options={[{ value: "glass", label: "玻璃" }, { value: "paper", label: "纸面" }]} />
      </Row>
      <Row label="密度" hint="紧凑约小 15%；触屏仍保证 44px 点击区域">
        <Segmented<Density> name="density" label="密度" value={pref.density} onChange={density => setPref({ density })} options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒适" }]} />
      </Row>
      <Row label="圆角">
        <Segmented<Corner> name="corner" label="圆角" value={pref.corner} onChange={corner => setPref({ corner })} options={[{ value: "round", label: "圆润" }, { value: "crisp", label: "利落" }]} />
      </Row>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><p className="text-sm text-text">{label}</p>{hint ? <p className="text-xs text-text-3">{hint}</p> : null}</div>
      {children}
    </div>
  );
}
