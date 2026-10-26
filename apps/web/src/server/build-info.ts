import "server-only";

/** Public release metadata, compiled into the server at build time. */
export function buildInfo(): { commit: string | null; builtAt: string | null } {
  const commit = process.env.AISTUDY_COMMIT;
  const builtAt = process.env.AISTUDY_BUILT_AT;
  return {
    commit: commit && /^[a-f0-9]{7,40}$/i.test(commit) ? commit.slice(0, 8) : null,
    builtAt: builtAt && Number.isFinite(Date.parse(builtAt)) ? builtAt : null,
  };
}
