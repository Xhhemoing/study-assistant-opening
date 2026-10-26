"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantProposalCreate, AssistantProposalRecord, AssistantProposalTool, LearningObservation } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { userFacingMessage } from "../../../lib/user-facing-error";

type ProposalKind = AssistantProposalTool["name"];
type Input = { api: OpeningApi; sourceTurnId: string | null; courseId: string | null; refreshKey?: string; enabled: boolean };
const localDate = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const needsCourse = (kind: ProposalKind) => kind === "propose_plan_change" || kind === "flag_dispute";

/** One owner survives moving the panel between the main conversation and its sidebar. */
export function useProposalPanel({ api, sourceTurnId, courseId, refreshKey, enabled }: Input) {
  const learning = useMemo(() => createOpeningLearningClient(), []);
  const intentScope = useMemo(() => ({ api, sourceTurnId, courseId }), [api, sourceTurnId, courseId]);
  // Reloading the same conversation pauses reads, but must retain an uncertain write intent.
  const scope = useMemo(() => ({ intentScope, enabled }), [intentScope, enabled]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const [rows, setRows] = useState<AssistantProposalRecord[]>([]);
  const [observations, setObservations] = useState<LearningObservation[]>([]);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [observationError, setObservationError] = useState<string | null>(null);
  const [kind, setKind] = useState<ProposalKind>("propose_note");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [back, setBack] = useState("");
  const [date, setDate] = useState(localDate);
  const [observationId, setObservationId] = useState("");
  const [message, setMessage] = useState("");
  const [actionScope, setActionScope] = useState<typeof scope | null>(null);
  const actionFlight = useRef<typeof scope | null>(null);
  const pending = useRef<{ fingerprint: string; input: AssistantProposalCreate } | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!scope.enabled || liveScope.current !== scope) return;
    const request = ++generation.current;
    const current = () => liveScope.current === scope && request === generation.current;
    setLoading(true); setReadError(null); setObservationError(null);
    await Promise.all([
      (async () => {
        try { const proposals = await api.listAssistantProposals(); if (current()) setRows(proposals); }
        catch (error) { if (current()) setReadError(userFacingMessage(error, "建议暂时无法读取")); }
      })(),
      (async () => {
        try { const facts = courseId ? await learning.listObservations(courseId) : []; if (current()) setObservations(facts); }
        catch (error) { if (current()) { setObservations([]); setObservationError(userFacingMessage(error, "作答记录暂时无法读取")); } }
      })(),
    ]);
    if (current()) setLoading(false);
  }, [api, courseId, learning, scope]);

  useEffect(() => {
    setRows([]); setObservations([]); setReadError(null); setObservationError(null); setMessage("");
    pending.current = null;
    return () => { generation.current++; };
  }, [intentScope]);
  useEffect(() => {
    if (enabled) void refresh(); else setLoading(false);
    return () => { generation.current++; };
  }, [enabled, refresh, refreshKey]);
  useEffect(() => {
    if (!courseId) setKind(current => needsCourse(current) ? "propose_note" : current);
  }, [courseId]);

  async function propose() {
    if (!sourceTurnId || !enabled || liveScope.current !== scope || actionFlight.current === scope) return;
    if (!courseId && needsCourse(kind)) { setMessage("请从课程进入助理后使用这项建议。"); return; }
    actionFlight.current = scope; setActionScope(scope); setMessage("");
    try {
      const observation = observations.find(row => row.id === observationId);
      let tool: AssistantProposalTool;
      switch (kind) {
        case "propose_teaching_move":
          if (!courseId) throw new Error("请从课程进入助理后安排讲解。");
          tool = { name: kind, arguments: { courseId, topic: text } }; break;
        case "propose_plan_change": {
          const current = await api.getToday(date);
          tool = { name: kind, arguments: { date, expectedAcceptedVersion: current.acceptedVersion } }; break;
        }
        case "propose_card":
          if (!observation) throw new Error("请选择要整理的真实作答。");
          tool = { name: kind, arguments: { observationId: observation.id, front: text, back } }; break;
        case "propose_note": tool = { name: kind, arguments: { title, text } }; break;
        case "propose_memory": tool = { name: kind, arguments: { text, courseId } }; break;
        case "flag_dispute":
          if (!observation) throw new Error("请选择需要复核的真实作答。");
          tool = { name: kind, arguments: { rootObservationId: observation.rootObservationId ?? observation.id, expectedHead: observation.effectiveHeadId ?? observation.id, reason: text } }; break;
      }
      if (liveScope.current !== scope) return;
      const fingerprint = JSON.stringify({ sourceTurnId, tool });
      if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, input: { sourceTurnId, tool, clientKey: `assistant-proposal:${crypto.randomUUID()}` } };
      await api.proposeAssistantAction(pending.current.input);
      if (liveScope.current !== scope) return;
      pending.current = null;
      setMessage("建议已准备好，请检查内容后接受。");
      await refresh();
    } catch (error) {
      if (liveScope.current === scope) setMessage(userFacingMessage(error, "暂时无法确认建议是否已保存；重新读取后可重试同一内容。"));
    } finally {
      if (actionFlight.current === scope) actionFlight.current = null;
      if (liveScope.current === scope) setActionScope(null);
    }
  }

  async function decide(row: AssistantProposalRecord, action: "accept" | "reject") {
    if (!enabled || liveScope.current !== scope || actionFlight.current === scope) return;
    actionFlight.current = scope; setActionScope(scope); setMessage("");
    try {
      await api.decideAssistantProposal(row.id, { expectedVersion: row.version, action, clientKey: `proposal-decision:${row.id}:${row.version}:${action}` });
      if (liveScope.current === scope) await refresh();
    } catch (error) {
      if (liveScope.current === scope) setMessage(userFacingMessage(error, "结果未确认，请重新读取后再操作。"));
    } finally {
      if (actionFlight.current === scope) actionFlight.current = null;
      if (liveScope.current === scope) setActionScope(null);
    }
  }

  return {
    rows, observations, draftCount: enabled ? rows.filter(row => row.status === "draft").length : 0,
    loading, readError, observationError, busy: actionScope === scope, message, refresh, sourceTurnId, courseId,
    kind, setKind, text, setText, title, setTitle, back, setBack, date, setDate, observationId, setObservationId, propose, decide,
  };
}

export type ProposalPanelModel = ReturnType<typeof useProposalPanel>;
