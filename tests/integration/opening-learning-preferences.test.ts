import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspacePreferencesRepository, lockLearningPreferences, readLearningPreferences, setCourseLearningPreferences } from "@aistudy/database";
import { createAuthRuntime, type AuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { GET as getWorkspacePreferences, PUT as putWorkspacePreferences } from "../../apps/web/src/app/api/workspace/preferences/route";
import { GET as getCoursePreferences, PUT as putCoursePreferences } from "../../apps/web/src/app/api/opening/courses/[id]/preferences/route";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

describe("opening learning preferences", () => {
  let fixture: OpeningFixture;
  let courseId: string;
  let otherCourseId: string;
  let authRuntime: AuthRuntime;

  beforeAll(async () => {
    fixture = await createOpeningFixture();
    courseId = randomUUID();
    otherCourseId = randomUUID();
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES
      (${courseId},${fixture.scope.workspaceId},'Own',${courseId}),
      (${otherCourseId},${fixture.otherScope.workspaceId},'Other',${otherCourseId})`;
    authRuntime = createAuthRuntime({
      databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
      authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
      sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session",
    });
    setAuthRuntimeForTests(authRuntime);
  });
  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await authRuntime.close();
    await fixture.close();
  });

  it("defaults to disabled without an explicit choice and keeps default entry separate", async () => {
    const preferences = createWorkspacePreferencesRepository(fixture.sql);
    expect(await readLearningPreferences(fixture.sql, fixture.scope, courseId)).toEqual({ autoGradeOnSave: true,
      assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false,
    });
    await preferences.setLearningPreferences(fixture.scope, {
      assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true,
    });
    expect(await preferences.getDefaultEntry(fixture.scope.workspaceId)).toBeNull();
    expect(await readLearningPreferences(fixture.sql, fixture.scope, courseId)).toEqual({ autoGradeOnSave: true,
      assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true,
    });
  });

  it("rejects a foreign owner or course and applies course closure and archive", async () => {
    await expect(readLearningPreferences(fixture.sql, fixture.scope, otherCourseId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readLearningPreferences(fixture.sql, {
      ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId,
    }, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setCourseLearningPreferences(fixture.sql, fixture.scope, otherCourseId,
      { assessmentEnabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId,
      { retestSuggestionsEnabled: false });
    expect((await readLearningPreferences(fixture.sql, fixture.scope, courseId)).retestSuggestionsEnabled).toBe(false);
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId,
      { automaticRemindersEnabled: false });
    expect(await readLearningPreferences(fixture.sql, fixture.scope, courseId)).toEqual({ autoGradeOnSave: true,
      assessmentEnabled: true, retestSuggestionsEnabled: false, automaticRemindersEnabled: false,
    });
    await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    expect(await readLearningPreferences(fixture.sql, fixture.scope, courseId)).toEqual({ autoGradeOnSave: true,
      assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false,
    });
    await fixture.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`;
    expect(await readLearningPreferences(fixture.sql, fixture.scope, courseId)).toEqual({ autoGradeOnSave: true,
      assessmentEnabled: true, retestSuggestionsEnabled: false, automaticRemindersEnabled: false,
    });
  });

  it("persists workspace auto grading OFF through authenticated updates and course changes", async () => {
    const headers = { cookie: fixture.cookie, "content-type": "application/json" };
    // PUT replaces the full preference document; do not invent PATCH semantics.
    for (const learningPreferences of [
      { autoGradeOnSave: false, assessmentEnabled: true, retestSuggestionsEnabled: false, automaticRemindersEnabled: false },
      { autoGradeOnSave: false, assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false },
      { autoGradeOnSave: false, assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false },
    ]) {
      const response = await putWorkspacePreferences(new Request("http://localhost/api/workspace/preferences", {
        method: "PUT", headers, body: JSON.stringify({ learningPreferences }),
      }));
      expect(response.status).toBe(200);
      const read = await getWorkspacePreferences(new Request("http://localhost/api/workspace/preferences", { headers }));
      expect((await read.json()).learningPreferences.autoGradeOnSave).toBe(false);
    }
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { assessmentEnabled: false });
    expect((await readLearningPreferences(fixture.sql, fixture.scope, courseId)).autoGradeOnSave).toBe(false);
    // Old HTTP clients send all original fields, but know nothing of the new switch.
    const legacy = { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true };
    const response = await putWorkspacePreferences(new Request("http://localhost/api/workspace/preferences", {
      method: "PUT", headers, body: JSON.stringify({ learningPreferences: legacy }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).learningPreferences).toEqual({ ...legacy, autoGradeOnSave: false });
    const reread = await getWorkspacePreferences(new Request("http://localhost/api/workspace/preferences", { headers }));
    expect((await reread.json()).learningPreferences).toEqual({ ...legacy, autoGradeOnSave: false });
    const preferences = createWorkspacePreferencesRepository(fixture.sql);
    await preferences.setLearningPreferences(fixture.scope, { ...await preferences.getLearningPreferences(fixture.scope), autoGradeOnSave: true });
  });

  it("serializes a consumer lock with a later account shutdown", async () => {
    const preferences = createWorkspacePreferencesRepository(fixture.sql);
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { locked = resolve; });
    const consumer = fixture.sql.begin(async (tx) => {
      await lockLearningPreferences(tx, fixture.scope, courseId);
      locked();
      await hold;
    });
    await entered;
    let saved = false;
    const writer = preferences.setLearningPreferences(fixture.scope, {
      assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false,
    }).then(() => { saved = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saved).toBe(false);
    release();
    await Promise.all([consumer, writer]);
    expect(saved).toBe(true);
  });

  it("serves authenticated account and course updates without crossing workspaces", async () => {
    const headers = { cookie: fixture.cookie, "content-type": "application/json" };
    const account = await putWorkspacePreferences(new Request("http://localhost/api/workspace/preferences", {
      method: "PUT", headers, body: JSON.stringify({ learningPreferences: {
        assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true,
      } }),
    }));
    expect(account.status).toBe(200);
    expect((await (await getWorkspacePreferences(new Request("http://localhost/api/workspace/preferences", { headers }))).json()).learningPreferences)
      .toEqual({ autoGradeOnSave: true, assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true });

    const courseContext = { params: Promise.resolve({ id: courseId }) };
    const course = await putCoursePreferences(new Request(`http://localhost/api/opening/courses/${courseId}/preferences`, {
      method: "PUT", headers, body: JSON.stringify({ assessmentEnabled: false }),
    }), courseContext);
    expect(course.status).toBe(200);
    expect((await course.json()).learningPreferences).toEqual({ autoGradeOnSave: true,
      assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false,
    });
    const foreign = await getCoursePreferences(new Request(`http://localhost/api/opening/courses/${otherCourseId}/preferences`, { headers }),
      { params: Promise.resolve({ id: otherCourseId }) });
    expect(foreign.status).toBe(403);
  });
});
