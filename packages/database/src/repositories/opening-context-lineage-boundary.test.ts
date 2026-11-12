import { describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import { contextSourceRefsIncluded, mergeContextSourceRefs, parseContextSourceRefs, turnContextSourceRefs } from "./opening-context-provenance";

const id = "a0b0c0d0-1111-4222-8333-000000000000", other = "b0b0c0d0-1111-4222-8333-000000000000";
const ref = { sourceId: id, sourceVersion: 0 };
type Fragment = { text: string; values: unknown[] };
function sqlFixture() {
  const sql = Object.assign(vi.fn((parts: TemplateStringsArray, ...values: unknown[]): Fragment => {
    let text = parts[0]!; const flat: unknown[] = [];
    for (let n = 0; n < values.length; n++) {
      const value = values[n];
      if (value && typeof value === "object" && "text" in value && "values" in value) {
        const fragment = value as Fragment; text += fragment.text; flat.push(...fragment.values);
      } else { text += "?"; flat.push(value); }
      text += parts[n + 1];
    }
    return { text: text.replace(/\s+/g, " ").trim(), values: flat };
  }), { unsafe: (text: string): Fragment => ({ text, values: [] }) });
  return sql;
}

describe("context lineage parser is all-or-unknown across mixed entries", () => {
  it.each([
    ["null after valid", [ref, null]], ["null before valid", [null, ref]],
    ["invalid UUID after valid", [ref, { sourceId: "bad", sourceVersion: 1 }]],
    ["missing version after valid", [ref, { sourceId: other }]],
    ["unsafe version after valid", [ref, { sourceId: other, sourceVersion: Number.MAX_SAFE_INTEGER + 1 }]],
    ["negative version after valid", [ref, { sourceId: other, sourceVersion: -1 }]],
    ["string version after valid", [ref, { sourceId: other, sourceVersion: "1" }]],
    ["nested array after valid", [ref, []]],
  ])("returns unknown for %s rather than leaking partial lineage", (_name, input) => expect(parseContextSourceRefs(input)).toBeNull());
  it("normalizes UUID case, retains distinct versions and first-seen order without mutating input", () => {
    const input = [{ sourceId: id.toUpperCase(), sourceVersion: 0 }, { sourceId: other, sourceVersion: 1 },
      { sourceId: id, sourceVersion: 0 }, { sourceId: id, sourceVersion: 1 }];
    const before = structuredClone(input);
    expect(parseContextSourceRefs(input)).toEqual([ref, { sourceId: other, sourceVersion: 1 }, { sourceId: id, sourceVersion: 1 }]);
    expect(input).toEqual(before);
  });
  it("merges across groups without collapsing distinct versions or reordering earlier keys", () => {
    expect(mergeContextSourceRefs([{ sourceId: id.toUpperCase(), sourceVersion: 0 }, { sourceId: other, sourceVersion: 2 }],
      [{ sourceId: id, sourceVersion: 0 }, { sourceId: id, sourceVersion: 1 }])).toEqual([ref, { sourceId: other, sourceVersion: 2 }, { sourceId: id, sourceVersion: 1 }]);
  });
});

describe("context lineage SQL mode and scope emission", () => {
  it.each([
    { name: "live defaults", historical: undefined, availability: undefined, expectedHistorical: false, bypassAvailability: false },
    { name: "historical defaults", historical: true, availability: undefined, expectedHistorical: true, bypassAvailability: true },
    { name: "historical requires availability", historical: true, availability: true, expectedHistorical: true, bypassAvailability: false },
    { name: "live permits unavailable versions", historical: false, availability: false, expectedHistorical: false, bypassAvailability: true },
  ])("binds independent historical and availability options: $name", ({ historical, availability, expectedHistorical, bypassAvailability }) => {
    const db = sqlFixture(), refs = { text: "lineage.refs", values: [] };
    const actual = contextSourceRefsIncluded(db as unknown as TransactionSql, "workspace", refs as never, historical, availability) as unknown as Fragment;
    expect(actual.values).toEqual(["workspace", bypassAvailability, "workspace", expectedHistorical, "workspace"]);
    expect(actual.text).toContain("COALESCE(jsonb_typeof(lineage.refs) = 'array', false)");
    expect(actual.text).toContain("CASE WHEN jsonb_typeof(lineage.refs) = 'array' THEN lineage.refs ELSE '[]'::jsonb END");
    expect(actual.text).toContain("NOT EXISTS ( SELECT 1 FROM opening_sources provenance_source");
    expect(actual.text).toContain("provenance_source.id::text = lower(provenance_ref->>'sourceId') AND provenance_source.workspace_id = ?");
    expect(actual.text).toContain("provenance_version.workspace_id=? AND provenance_version.source_id=provenance_source.id");
    expect(actual.text).toContain("provenance_exclusion.workspace_id = ? AND provenance_exclusion.source_id = provenance_source.id");
  });
  it.each(["t", "u", "a"] as const)("uses %s columns for direct user lineage and saved assistant lineage", alias => {
    const db = sqlFixture();
    const actual = turnContextSourceRefs(db as unknown as TransactionSql, alias) as unknown as Fragment;
    expect(actual.values).toEqual([]);
    expect(actual.text).toContain(`CASE WHEN ${alias}.role = 'assistant' THEN ${alias}.context_source_refs`);
    expect(actual.text).toContain(`FROM unnest(${alias}.source_ids) sid(id)`);
    expect(actual.text).toContain(`${alias}.source_versions->sid.id::text`);
    expect(actual.text).toContain(`jsonb_typeof(${alias}.citations)='array' THEN ${alias}.citations ELSE '[null]'::jsonb END`);
    expect(actual.text).toContain("UNION ALL");
  });
});
