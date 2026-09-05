import {
  AlignLeft,
  Braces,
  CheckSquare2,
  ClipboardCheck,
  Heading2,
  Image as ImageIcon,
  Link2,
  Quote,
  Search,
  Table2,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { blockGroups, type BlockOption } from "./notebook-preview-types";

const blockOptions: BlockOption[] = [
  { label: "文本", description: "开始写作", icon: AlignLeft, actionName: "插入文本块", group: "基础内容" },
  { label: "标题 2", description: "组织页面层级", icon: Heading2, actionName: "插入标题块", group: "基础内容" },
  { label: "待办", description: "追踪一个行动", icon: CheckSquare2, actionName: "插入待办块", group: "基础内容" },
  { label: "引用", description: "强调一段原文", icon: Quote, actionName: "插入引用块", group: "基础内容" },
  { label: "表格", description: "比较或整理数据", icon: Table2, actionName: "插入表格块", group: "媒体与数据" },
  { label: "图片", description: "添加视觉材料", icon: ImageIcon, actionName: "插入图片块", group: "媒体与数据" },
  { label: "视频", description: "嵌入学习资料", icon: Video, actionName: "插入视频块", group: "媒体与数据" },
  { label: "概念", description: "可引用的术语定义", icon: Braces, actionName: "插入概念块", group: "学习闭环" },
  { label: "来源摘录", description: "保留原文与页码锚点", icon: Link2, actionName: "插入来源摘录块", group: "学习闭环" },
  { label: "练习", description: "创建独立作答任务", icon: ClipboardCheck, actionName: "插入练习块", group: "学习闭环" },
];

function BlockMenuOption({
  actionName,
  description,
  icon: Icon,
  label,
  onSelect,
}: BlockOption & { onSelect: () => void }) {
  return (
    <button
      aria-label={actionName}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-300"
      onClick={onSelect}
      type="button"
    >
      <span className="grid size-8 place-items-center rounded border border-white/10 text-stone-400">
        <Icon aria-hidden="true" size={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-stone-100">{label}</span>
        <span className="block truncate text-xs text-stone-500">{description}</span>
      </span>
    </button>
  );
}

export function BlockMenu({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const visibleOptions = blockOptions.filter((option) => `${option.label}${option.description}`.includes(query));

  return (
    <section
      aria-label="插入内容块"
      className="absolute left-0 top-10 z-30 w-[min(21rem,calc(100vw-2rem))] rounded-lg border border-white/10 bg-[#242424] p-2 shadow-2xl"
    >
      <h2 className="sr-only">插入内容块</h2>
      <label className="flex items-center gap-2 border-b border-white/10 px-2 pb-2">
        <Search aria-hidden="true" className="text-stone-500" size={15} />
        <span className="sr-only">筛选内容块</span>
        <input
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm text-stone-100 outline-none placeholder:text-stone-500"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入 / 搜索内容块"
          value={query}
        />
      </label>
      <div className="max-h-80 overflow-y-auto py-1">
        {blockGroups.map((group) => {
          const options = visibleOptions.filter((option) => option.group === group);
          if (options.length === 0) return null;

          return (
            <section className="py-2" key={group}>
              <h3 className="px-2 text-[11px] font-medium text-stone-500">{group}</h3>
              <div className="mt-1">
                {options.map((option) => <BlockMenuOption {...option} key={option.label} onSelect={onClose} />)}
              </div>
            </section>
          );
        })}
      </div>
      <footer className="border-t border-white/10 px-2 pt-2 text-[11px] text-stone-500">
        输入 <kbd className="rounded border border-white/10 px-1">/</kbd> 随时打开
      </footer>
    </section>
  );
}

export type BlockControlIcon = LucideIcon;
