import { createElement, isValidElement, type FormEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
const states: unknown[] = [];
const refs: Array<{ current: unknown }> = [];
const effects: Array<() => unknown> = [];
let cleanups: Array<() => void> = [];
let stateIndex = 0;
let refIndex = 0;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode; href: string }) => createElement("a", props, children) }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { effects.push(effect); },
  useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
  useState: (initial: unknown) => {
    const index = stateIndex++;
    if (states[index] === undefined) states[index] = initial;
    return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  },
}));

import { CourseCreate } from "./course-create";

type ControlProps = {
  children?: ReactNode;
  id?: string;
  value?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onClick?: () => void;
};

function findControl(node: ReactNode, match: (element: ReactElement<ControlProps>) => boolean): ReactElement<ControlProps> | undefined {
  if (Array.isArray(node)) return node.map(child => findControl(child, match)).find(Boolean);
  if (!isValidElement<ControlProps>(node)) return;
  return match(node) ? node : findControl(node.props.children, match);
}

function renderForm() {
  stateIndex = 0;
  refIndex = 0;
  effects.length = 0;
  return CourseCreate({ opening: true });
}

function change(id: string, value: string) {
  findControl(renderForm(), control => control.props.id === id)?.props.onChange?.({ target: { value } });
}

function submit() {
  const handler = findControl(renderForm(), control => control.type === "form")?.props.onSubmit;
  if (!handler) throw new Error("Course form was not rendered");
  return handler({ preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>);
}

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function mount() {
  renderForm();
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
  }
}

function unmount() {
  cleanups.forEach(cleanup => cleanup());
  cleanups = [];
  states.length = 0;
  refs.length = 0;
}

const draftKey = "aistudy.course-draft.v1:workspace-a:user-a";
let stored: Map<string, string>;
const sessionStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };

beforeEach(() => {
  stored = new Map();
  sessionStorage.getItem.mockImplementation((key: string) => stored.get(key) ?? null);
  sessionStorage.setItem.mockImplementation((key: string, value: string) => { stored.set(key, value); });
  sessionStorage.removeItem.mockImplementation((key: string) => { stored.delete(key); });
  vi.stubGlobal("window", { sessionStorage });
  vi.stubGlobal("fetch", vi.fn(async input => String(input) === "/api/auth/me"
    ? Response.json({ user: { id: "user-a", workspaceId: "workspace-a" } })
    : Response.json({ course: { id: "course-a" } }, { status: 201 })));
});

afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("course creation draft", () => {
  it("restores input after leaving and clears the draft after successful creation", async () => {
    mount();
    await flush();
    change("course-title", "高等数学");
    change("course-description", "每周学习三次");
    expect(stored.has(draftKey)).toBe(true);
    unmount();
    mount();
    await flush();
    expect(findControl(renderForm(), control => control.props.id === "course-title")?.props.value).toBe("高等数学");
    expect(findControl(renderForm(), control => control.props.id === "course-description")?.props.value).toBe("每周学习三次");
    await submit();
    expect(stored.has(draftKey)).toBe(false);
    expect(push).toHaveBeenCalledWith("/opening/courses/course-a");
  });

  it("does not overwrite typing while account information is loading", async () => {
    stored.set(draftKey, JSON.stringify({ title: "旧草稿", slug: "old", description: "" }));
    let resolveIdentity!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { resolveIdentity = resolve; }));
    mount();
    change("course-title", "新输入");
    resolveIdentity(Response.json({ user: { id: "user-a", workspaceId: "workspace-a" } }));
    await flush();
    expect(findControl(renderForm(), control => control.props.id === "course-title")?.props.value).toBe("新输入");
    expect(JSON.parse(stored.get(draftKey)!).title).toBe("新输入");
  });

  it("does not restore another account's draft", async () => {
    stored.set("aistudy.course-draft.v1:workspace-a:user-b", JSON.stringify({ title: "其他账号", slug: "other", description: "" }));
    mount();
    await flush();
    expect(findControl(renderForm(), control => control.props.id === "course-title")?.props.value).toBe("");
  });

  it.each(["broken JSON", JSON.stringify({ title: 1, slug: "bad", description: "" })])("ignores an unreadable draft: %s", async saved => {
    stored.set(draftKey, saved);
    mount();
    await flush();
    change("course-title", "可继续填写");
    await submit();
    expect(push).toHaveBeenCalledOnce();
  });

  it("still submits when session storage is unavailable", async () => {
    sessionStorage.getItem.mockImplementation(() => { throw new Error("blocked"); });
    sessionStorage.setItem.mockImplementation(() => { throw new Error("blocked"); });
    sessionStorage.removeItem.mockImplementation(() => { throw new Error("blocked"); });
    mount();
    await flush();
    change("course-title", "无需存储权限");
    await submit();
    expect(push).toHaveBeenCalledOnce();
  });
});

describe("course creation feedback", () => {
  beforeEach(async () => {
    mount();
    await flush();
    change("course-title", "高等数学");
  });

  it.each([
    [401, "登录状态已过期"],
    [403, "没有创建课程的权限"],
    [409, "课程可能已创建"],
    [400, "名称不符合要求"],
    [503, "服务暂时不可用"],
  ])("shows actionable feedback for HTTP %s and retains the draft", async (status, expected) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "名称不符合要求" } }, { status }));
    await submit();
    expect(renderToStaticMarkup(renderForm())).toContain(expected);
    expect(stored.has(draftKey)).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });


  it("lets the learner create a separate course after a restored legacy URL conflicts", async () => {
    unmount(); stored.set(draftKey, JSON.stringify({ title: "高等数学", slug: "calculus", description: "" }));
    mount(); await flush();
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: {} }, { status: 409 }));
    await submit();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body)).slug).toBe("calculus");
    const action = findControl(renderForm(), element => element.props.children === "另建一门课程");
    expect(action).toBeDefined(); action!.props.onClick!();
    await submit();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body)).slug).toMatch(/^course-[0-9a-f-]{36}$/);
    expect(push).toHaveBeenCalledOnce();
  });

  it("creates a URL automatically and reuses it after an uncertain response", async () => {
    expect(renderToStaticMarkup(renderForm())).not.toContain('id="course-slug"');
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
    await submit();
    const first = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body));
    expect(first.slug).toMatch(/^course-[0-9a-f-]{36}$/);
    expect(first.title).toBe("高等数学");
    unmount(); mount(); await flush();
    await submit();
    const creates = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/courses");
    expect(JSON.parse(String(creates[1]![1]?.body)).slug).toBe(first.slug);
  });

  it("explains uncertain results after a network failure without blaming the slug", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await submit();
    expect(renderToStaticMarkup(renderForm())).toContain("未能确认创建结果");
    expect(renderToStaticMarkup(renderForm())).not.toContain("Slug 已被使用");
    expect(stored.has(draftKey)).toBe(true);
  });

  it("ignores rapid duplicate submissions while pending and permits retry after a rejection", async () => {
    let resolveRequest!: (response: Response) => void;
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { resolveRequest = resolve; }));
    const pending = submit();
    await submit();
    expect(fetch).toHaveBeenCalledOnce();
    resolveRequest(Response.json({ error: { message: "服务不可用" } }, { status: 503 }));
    await pending;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ course: { id: "course-b" } }, { status: 201 }));
    await submit();
    expect(push).toHaveBeenCalledWith("/opening/courses/course-b");
  });
});
