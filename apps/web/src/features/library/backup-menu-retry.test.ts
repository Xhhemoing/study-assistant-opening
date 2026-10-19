import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const states: unknown[] = [];
let index = 0;
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const current = index++;
    if (!(current in states)) states[current] = initial;
    return [states[current], (value: unknown) => { states[current] = value; }];
  },
}));
import { BackupMenu } from "./backup-menu";

type Props = { children?: ReactNode; type?: string; disabled?: boolean; onClick?: () => void; onChange?: (event: { target: { files?: File[]; value: string } }) => void };
function control(node: ReactNode, match: (element: ReactElement<Props>) => boolean): ReactElement<Props> | undefined {
  if (Array.isArray(node)) return node.map(child => control(child, match)).find(Boolean);
  if (!isValidElement<Props>(node)) return;
  return match(node) ? node : control(node.props.children, match);
}
function render() { index = 0; return BackupMenu(); }
function button(label: string) {
  const found = control(render(), element => element.type === "button" && JSON.stringify(element.props.children).includes(label));
  expect(found).toBeDefined();
  return found!;
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { states.length = 0; index = 0; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("native backup retry actions", () => {
  it("retries the failed restore file with the current conflict policy and clears the error on success", async () => {
    const packed = { format: "aistudy-native", records: { documents: [] } };
    const file = new File([JSON.stringify(packed)], "backup.json", { type: "application/json" });
    fetchMock.mockResolvedValueOnce(new Response("conflict", { status: 409 }))
      .mockResolvedValueOnce(Response.json({ warnings: [] }));
    const input = control(render(), element => element.type === "input" && element.props.type === "file")!;
    const target = { files: [file], value: file.name };
    input.props.onChange!({ target });
    expect(target.value).toBe("");
    await flush();
    expect(button("重试恢复").props.disabled).toBe(false);
    expect(control(render(), element => element.type === "button" && JSON.stringify(element.props.children).includes("重试导出"))).toBeUndefined();
    const skip = control(render(), element => element.type === "label" && JSON.stringify(element.props.children).includes("跳过（"))!;
    control(skip, element => element.type === "input")!.props.onChange!({ target: { value: "" } });
    button("重试恢复").props.onClick!();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/backups/restore", "/api/backups/restore"]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies).toEqual([{ package: packed, conflictPolicy: "reject" }, { package: packed, conflictPolicy: "skip" }]);
    expect(control(render(), element => element.type === "button" && JSON.stringify(element.props.children).includes("重试恢复"))).toBeUndefined();
  });

  it("keeps export failures on the export endpoint and disables actions while pending", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    button("导出原生内容备份").props.onClick!();
    await flush();
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    button("重试导出").props.onClick!();
    expect(button("导出原生内容备份").props.disabled).toBe(true);
    expect(control(render(), element => element.type === "input" && element.props.type === "file")!.props.disabled).toBe(true);
    finish(Response.json({ package: {} }));
    await flush();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/backups/export", "/api/backups/export"]);
    expect(button("导出原生内容备份").props.disabled).toBe(false);
  });

  it("keeps invalid restore files on the restore retry path without exporting", async () => {
    const file = new File(["bad json"], "invalid.json");
    control(render(), element => element.type === "input" && element.props.type === "file")!.props.onChange!({ target: { files: [file], value: file.name } });
    await flush();
    button("重试恢复").props.onClick!();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button("重试恢复").props.disabled).toBe(false);
  });
});
