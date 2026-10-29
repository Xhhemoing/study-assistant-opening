/** Inert references to already validated data; never executable instructions. */
export function createViewPlan(messageId, revision, decision) {
  return {schemaVersion: '1', source: {messageId, revision}, state: decision.state,
    views: decision.state === 'suggest' ? [] : decision.selected.map(c => ({
      key: c.key, component: c.type, source: c.sourceRef,
      fidelity: c.fidelity, ...(c.projection ? {projection: c.projection} : {}),
      requiredCapabilities: [c.type], reasons: c.reasons,
      retainSource: c.fidelity?.level === 'lossy' || (c.projection?.omittedKeys.length ?? 0) > 0
    })), originalTextRetained: true};
}
