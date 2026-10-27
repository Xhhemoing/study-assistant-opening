import { ASSISTANT_HOME_HREF, KNOWLEDGE_HOME_HREF, LEARNING_HOME_HREF } from "./destinations";

export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "assistant" | "start" | "courses" | "review" | "library" | "sprint" | "cards" | "search";
  group: "core" | "tools";
};

/** 三个固定入口，顺序稳定，不随推荐重排；桌面、手机与旧入口共用。 */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: ASSISTANT_HOME_HREF, label: "助理", icon: "start", group: "core" },
    { href: LEARNING_HOME_HREF, label: "学习", icon: "courses", group: "core" },
    { href: KNOWLEDGE_HOME_HREF, label: "知识库", icon: "library", group: "core" },
  ];
}

const ASSISTANT_OWNED = ["/opening/today", "/opening/agent", "/opening/assistant", "/opening/suggestions"];
const LEARNING_OWNED = ["/opening/courses", "/opening/review", "/opening/cards", "/opening/sprint", "/opening/practice"];
const KNOWLEDGE_OWNED = ["/opening/library", "/opening/search"];

/** 每个路径只高亮一个入口；设置等系统页不属于三入口。 */
export function navigationIsActive(href: string, pathname: string, _search = ""): boolean {
  const hrefPath = href.split("?")[0] ?? href;
  const path = pathname.split("?")[0] ?? pathname;
  const within = (owner: string) => path === owner || path.startsWith(`${owner}/`);
  if (ASSISTANT_OWNED.some(within)) return hrefPath === ASSISTANT_HOME_HREF;
  if (LEARNING_OWNED.some(within)) return hrefPath === LEARNING_HOME_HREF;
  if (KNOWLEDGE_OWNED.some(within)) return hrefPath === KNOWLEDGE_HOME_HREF;
  return within(hrefPath);
}
