"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { learningAssetLinkCreateSchema, learningAssetLinkDetachSchema, type LearningAssetLinkView, type StudyContextAnchor } from "@aistudy/contracts";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { createLearningAssetLinkClient, LearningAssetLinkRequestError, type LearningAssetLinkClient } from "./learning-asset-link-client";
import { LearningLinkTargetForm, type LearningLinkTarget } from "./learning-link-target-form";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
const commandSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("create"), input: learningAssetLinkCreateSchema }), z.object({ kind: z.literal("detach"), input: learningAssetLinkDetachSchema })]);
type Command = z.infer<typeof commandSchema>;
export function AssetLearningLinks(props: { assetType: "source" | "document"; assetId: string; assetVersion?: number; origin?: StudyContextAnchor | null; client?: LearningAssetLinkClient }) { return <AssetLinks key={`${props.assetType}:${props.assetId}`} {...props} />; }
function AssetLinks({ assetType, assetId, assetVersion, origin = null, client: suppliedClient }: { assetType: "source" | "document"; assetId: string; assetVersion?: number; origin?: StudyContextAnchor | null; client?: LearningAssetLinkClient }) {
  const client = useMemo(() => suppliedClient ?? createLearningAssetLinkClient(), [suppliedClient]);
  const [namespace] = useState(getVerifiedSessionNamespace), key = `aistudy:learning-link-command:${namespace}:${assetType}:${assetId}`;
  const [restoreProblem] = useState(() => { if (!namespace) return ""; try { const raw = sessionStorage.getItem(key); if (!raw) return ""; const value = commandSchema.safeParse(JSON.parse(raw)); return value.success && (value.data.kind === "detach" || (value.data.input.assetType === assetType && value.data.input.assetId === assetId)) ? "" : "上次关联的信息无法读取，尚未提交新操作；请保留记录并查看已有的关联。"; } catch { return "上次关联的信息无法读取，请先恢复浏览器存储。"; } });
  const [pending, setPending] = useState<Command | null>(() => { try { if (namespace) { const raw = sessionStorage.getItem(key); const value = raw ? commandSchema.safeParse(JSON.parse(raw)) : null; if (value?.success && (value.data.kind === "detach" || (value.data.input.assetId === assetId && value.data.input.assetType === assetType))) return value.data; } } catch { /* Keep personal content in the original asset. */ } return null; });
  const [links, setLinks] = useState<LearningAssetLinkView[] | null>(null), [target, setTarget] = useState<LearningLinkTarget>({ courseId: origin?.courseId ?? null, goalId: null, requirementId: null });
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [error, setError] = useState(""), [storageError, setStorageError] = useState(false);
  const active = useRef(true), writing = useRef(false), pendingRef = useRef(pending); pendingRef.current = pending;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function owned() { return namespace !== null && namespace === getVerifiedSessionNamespace(); }
  function remember(command: Command | null) { if (!owned()) return false; try { if (command) sessionStorage.setItem(key, JSON.stringify(command)); else sessionStorage.removeItem(key); return true; } catch { return false; } }
  useEffect(() => { let live = true; setError(""); void client.list({ assetType, assetId }).then(value => { if (!live) return; setLinks(value.links); const command = pendingRef.current; if (command?.kind === "detach" && value.links.some(row => row.link.id === command.input.id && row.link.revision > command.input.expectedRevision)) { remember(null); setPending(null); } }).catch(reason => { if (live) { setLinks(null); setError(userFacingMessage(reason, "关联暂不可读取，请重试；不会新增或移除原资产。")); } }); return () => { live = false; }; }, [client, assetId, assetType, reload]);
  async function execute(command: Command) {
    if (writing.current || !owned() || restoreProblem) return;
    const retryingUnknown = pending !== null;
    if (!remember(command)) { setStorageError(true); setError("无法保存这次关联的信息，尚未提交。请恢复浏览器存储后重试。"); return; }
    writing.current = true; setBusy(true); setPending(command); setError("");
    try { const result = command.kind === "create" ? await client.create(command.input) : await client.detach(command.input); if (!owned()) return; remember(null); if (active.current) { setPending(null); setLinks(previous => [...(previous ?? []).filter(row => row.link.id !== result.link.id), result]); setEditing(false); } }
    catch (reason) { if (active.current) { if (!retryingUnknown && reason instanceof LearningAssetLinkRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) { remember(null); setPending(null); } setError(userFacingMessage(reason, "关联结果待确认，请保留本页并再次确认这次关联。")); } }
    finally { writing.current = false; if (active.current) setBusy(false); }
  }
  function associate() { const parsed = learningAssetLinkCreateSchema.safeParse({ assetType, assetId, assetVersion: assetType === "source" ? assetVersion ?? null : null, purpose: "reference", ...target, origin, clientKey: `asset-link:${crypto.randomUUID()}` }); if (!parsed.success) { setError("请核对课程、目标与课程要求，未选择时可继续独立使用原资产。"); return; } void execute({ kind: "create", input: parsed.data }); }
  const locked = busy || Boolean(pending) || Boolean(restoreProblem);
  return <section className="space-y-3 border-t border-line pt-3" aria-label="学习关联与原位置"><h3 className="text-sm font-medium">学习关联与原位置</h3><p className="text-xs leading-6 text-text-3">复用同一资料或笔记，关联课程、目标或课程要求；不作为掌握证据，不创建学习活动。解除关联保留原资产与历史，不移除课程中其他引用。</p>
    {links ? links.length ? <ul className="space-y-3">{links.map(row => <li key={row.link.id} className="space-y-2 border-b border-line pb-3"><p className="text-sm text-text-2">{row.courseTitle ?? "独立使用"}{row.goalTitle ? ` · ${row.goalTitle}` : ""}{row.requirementTitle ? ` · ${row.requirementTitle}` : ""}{row.link.status === "detached" ? " · 历史关联" : ""}</p><div className="flex flex-wrap gap-2">{row.originAvailable && row.originHref ? <a className={ui.secondary} href={row.originHref}>返回原活动或阅读位置</a> : null}{row.sourceHrefs.map(ref => <a className={ui.quiet} key={ref.href} href={ref.href}>{ref.label}</a>)}</div>{row.warnings.map((warning, index) => <p className="text-xs leading-6 text-warn" role="status" key={index}>{warning}</p>)}{row.link.status === "active" ? <button className={ui.quiet} disabled={locked} type="button" onClick={() => void execute({ kind: "detach", input: { id: row.link.id, expectedRevision: row.link.revision } })}>解除这条关联</button> : null}</li>)}</ul> : <p className="text-xs text-text-3">尚无学习关联；可以继续独立使用。</p> : <p role="status" className="text-xs text-text-3">关联尚未读取。</p>}
    {!editing ? <button className={ui.quiet} type="button" disabled={locked || links === null} onClick={() => setEditing(true)}>关联课程、目标或要求</button> : <div className="space-y-3"><LearningLinkTargetForm value={target} onChange={setTarget} disabled={locked} /><div className="flex gap-2"><button className={ui.secondary} type="button" disabled={locked} onClick={associate}>确认关联原资产</button><button className={ui.quiet} type="button" disabled={locked} onClick={() => setEditing(false)}>取消</button></div></div>}
    {pending ? <div role="status" className="space-y-2"><p className="text-xs text-warn">关联结果待确认，原版本与内容保留。</p><button className={ui.secondary} type="button" disabled={busy} onClick={() => void execute(pending)}>重新确认这次关联操作</button></div> : null}{storageError ? <p className="text-xs text-warn">浏览器无法保留这次操作的信息，尚未提交新操作。</p> : null}{error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
    <button className={ui.quiet} type="button" disabled={busy} onClick={() => setReload(value => value + 1)}>重新读取学习关联</button>
    {restoreProblem ? <p role="alert" className="text-xs text-warn">{restoreProblem}</p> : null}
  </section>;
}
