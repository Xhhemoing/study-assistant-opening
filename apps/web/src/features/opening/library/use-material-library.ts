"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { createMaterialOrganizationClient, type MaterialOrganization, type OrganizationResult } from "./material-organization-client";
import { deleteSelectedMaterials } from "./material-batch-delete";
import { selectedMaterials, type MaterialSpace } from "./material-spaces";

const empty: MaterialOrganization = { courses: [], memberships: [] };
export function useMaterialLibrary(api: OpeningApi, options: { uploadCourseId?: string | null } = {}) {
  const uploadCourseId = options.uploadCourseId ?? null;
  const client = useMemo(() => createMaterialOrganizationClient(), []);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [organization, setOrganization] = useState(empty);
  const [space, setSpace] = useState<MaterialSpace>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false), [organizationReady, setOrganizationReady] = useState(false);
  const [error, setError] = useState(""), [organizationError, setOrganizationError] = useState("");
  const [result, setResult] = useState<OrganizationResult | null>(null);
  const mounted = useRef(true), locked = useRef(false);
  const requestSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const [materials, spaces] = await Promise.allSettled([api.listSources(), client.read()]);
    if (!mounted.current || sequence !== requestSequence.current) return;
    if (materials.status === "fulfilled") {
      setSources(materials.value); setSelected(value => selectedMaterials(value, materials.value)); setError("");
    } else setError("材料暂时无法读取，已保留现有列表。");
    if (spaces.status === "fulfilled") { setOrganization(spaces.value); setOrganizationReady(true); setOrganizationError(""); }
    else { setOrganizationReady(false); setOrganizationError("课程关系暂时无法读取，整理操作已暂停；现有原件仍可查看。"); }
    if (materials.status === "rejected" || spaces.status === "rejected") throw new Error("部分资料信息未能更新");
  }, [api, client]);
  const load = useCallback(async () => {
    setRefreshing(true);
    try { await refresh(); }
    catch { /* The failing read has already set its specific error without clearing stored data. */ }
    finally { if (mounted.current) { setLoading(false); setRefreshing(false); } }
  }, [refresh]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; requestSequence.current++; }; }, [load]);
  const selection = useMemo(() => new Set(selectedMaterials(selected, sources)), [selected, sources]);
  const changeSpace = useCallback((next: MaterialSpace) => { if (locked.current) return; setSpace(next); setSelected([]); setResult(null); }, []);
  function toggle(id: string) { if (!locked.current) setSelected(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]); }
  function togglePage(ids: string[]) {
    if (locked.current) return;
    setSelected(value => ids.every(id => value.includes(id)) ? value.filter(id => !ids.includes(id)) : [...new Set([...value, ...ids])]);
  }
  async function batch(courseId: string, role?: "core" | "reference" | "optional") {
    if (locked.current || !organizationReady || !selection.size) return;
    locked.current = true; setBusy(true); setResult(null);
    try {
      const next = role ? await client.addToCourse(courseId, [...selection], role)
        : await client.removeFromCourse(courseId, [...selection]);
      if (!mounted.current) return;
      setResult(next); setSelected(next.failed.map(item => item.id));
      await refresh();
    } catch (reason) {
      if (mounted.current) setOrganizationError(reason instanceof Error ? reason.message : "整理结果尚未确认，请刷新后核对。");
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function createCourse(title: string) {
    if (locked.current || !organizationReady) return;
    locked.current = true; setBusy(true);
    try {
      const course = await client.createCourse(title);
      if (!mounted.current) return;
      setOrganization(value => ({ ...value, courses: [...value.courses, { ...course, archived: false }] }));
      setSpace(`course:${course.id}`); setSelected([]); setResult(null);
      try { await refresh(); } catch { setOrganizationError("课程已创建，但列表刷新失败；请重新读取。"); }
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function assignOne(sourceId: string, courseId: string, role: "core" | "reference" | "optional") {
    if (locked.current || !organizationReady) return;
    locked.current = true; setBusy(true); setResult(null);
    try {
      const next = await client.addToCourse(courseId, [sourceId], role);
      if (!mounted.current) return;
      setResult(next);
      await refresh();
    } catch (reason) {
      if (mounted.current) setOrganizationError(reason instanceof Error ? reason.message : "整理结果尚未确认，请刷新后核对。");
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function deleteSelected() {
    if (locked.current || !selection.size) return;
    locked.current = true; setBusy(true); setResult(null);
    try {
      const next = await deleteSelectedMaterials([...selection]);
      if (!mounted.current) return;
      setResult(next);
      setSelected(next.failed.map(item => item.id));
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "删除结果尚未确认，请刷新后核对。");
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  return { sources, organization, space, selection, loading, refreshing, busy, organizationReady, error, organizationError, result, uploadCourseId,
    refresh, load, changeSpace, toggle, togglePage, batch, assignOne, deleteSelected, createCourse, clearSelection: () => { if (!locked.current) setSelected([]); } };
}
