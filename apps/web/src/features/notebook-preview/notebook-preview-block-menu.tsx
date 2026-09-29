import { AlignLeft, Braces, CheckSquare2, ClipboardCheck, Heading2, Image as ImageIcon, Link2, Quote, Search, Table2, Video } from "lucide-react";
import { useState } from "react";

import { ui } from "../opening/design/ui";
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

export function BlockMenu() {
  const [query, setQuery] = useState("");
  const visible = blockOptions.filter(option => `${option.label}${option.description}`.includes(query.trim()));
  return <section aria-label="内容块示例目录">
    <p className="mb-4 text-xs leading-6 text-zinc-500">浏览内容块类型示例。此预览不提供插入、编辑或拖动内容块。</p>
    <label className="relative block"><Search aria-hidden="true" className="absolute left-2.5 top-2.5 text-zinc-400" size={14} /><span className="sr-only">筛选内容块</span><input autoComplete="off" className={`${ui.input} pl-8`} onChange={event => setQuery(event.target.value)} placeholder="搜索内容块" value={query} /></label>
    <div className="mt-3">{blockGroups.map(group => {
      const options = visible.filter(option => option.group === group);
      return options.length ? <section className="border-b border-zinc-200 py-3 last:border-0" key={group}><h3 className="mb-2 text-xs font-medium text-zinc-500">{group}</h3><ul className="space-y-3">{options.map(({ label, description, icon: Icon }) => <li className="flex items-center gap-3" key={label}><Icon aria-hidden="true" size={16} className="shrink-0 text-zinc-500" /><div><p className="text-sm text-zinc-800">{label}</p><p className="mt-0.5 text-xs text-zinc-500">{description}</p></div></li>)}</ul></section> : null;
    })}{!visible.length ? <p className="py-5 text-sm text-zinc-500" role="status">没有匹配的内容块，试试其他名称。</p> : null}</div>
  </section>;
}
