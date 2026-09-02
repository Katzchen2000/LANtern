import { db } from "./src/db";
import { config, gemini_usage, students, tests, sessions, results as dbResults } from "./src/db/schema";
import { eq, and } from "drizzle-orm";
import fs from 'fs/promises';
import path from 'path';

async function writeDiskFallback<T = any>(filePath: string, data: T): Promise<void> {
  try {
    const parentDir = path.dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    console.error(`Failed to write fallback to disk for ${filePath}:`, err);
  }
}

async function readDiskFallback<T = any>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (e) {
    return defaultValue;
  }
}

async function tryDbWithTimeout<T>(fn: () => Promise<T>, timeoutMs = 2000): Promise<T | null> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('DB operation timed out')), timeoutMs)
      ),
    ]);
    return result;
  } catch (err) {
    // Log concisely without throwing
    return null;
  }
}

export async function readJsonSafe_pg<T = any>(filePath: string, defaultValue: T): Promise<T> {
  // First attempt to read from Database if configured
  if (process.env.SQL_HOST) {
    if (filePath === 'data/config.json') {
      const diskData = await readDiskFallback<any>(filePath, {});
      const res = await tryDbWithTimeout(() => db.select().from(config).where(eq(config.id, 1)));
      if (res && res.length > 0) {
        return {
          ...diskData,
          ...res[0]
        } as unknown as T;
      }
      return diskData as unknown as T;
    } else if (filePath === 'data/gemini-usage.json') {
      const res = await tryDbWithTimeout(() => db.select().from(gemini_usage).where(eq(gemini_usage.id, 1)));
      if (res && res.length > 0) return res[0] as unknown as T;
    } else if (filePath === 'data/roster.json') {
      const res = await tryDbWithTimeout(() => db.select().from(students));
      if (res && res.length > 0) return { students: res } as unknown as T;
    } else if (filePath.startsWith('tests/')) {
      const testId = filePath.split('/').pop()?.replace('.json', '');
      if (testId) {
        const res = await tryDbWithTimeout(() => db.select().from(tests).where(eq(tests.test_id, testId)));
        if (res && res.length > 0) return res[0] as unknown as T;
      }
    } else if (filePath.startsWith('data/sessions/')) {
      const sessionId = filePath.split('/').pop()?.replace('.json', '');
      if (sessionId) {
        const res = await tryDbWithTimeout(() => db.select().from(sessions).where(eq(sessions.session_id, sessionId)));
        if (res && res.length > 0) {
          const sess = res[0];
          return {
            ...sess,
            started_at: sess.started_at.toISOString(),
            expires_at: sess.expires_at.toISOString(),
            submitted_at: sess.submitted_at?.toISOString() || null,
          } as unknown as T;
        }
      }
    } else if (filePath.startsWith('data/results/')) {
      const parts = filePath.split('/');
      const studentId = parts.pop()?.replace('.json', '');
      const testId = parts.pop();
      if (studentId && testId) {
        const res = await tryDbWithTimeout(() => db.select().from(dbResults).where(
          and(eq(dbResults.student_id, studentId), eq(dbResults.test_id, testId))
        ));
        if (res && res.length > 0) {
          const r = res[0];
          return {
            ...r,
            submitted_at: r.submitted_at.toISOString(),
          } as unknown as T;
        }
      }
    }
  }

  // Fallback to reading from container disk storage
  return await readDiskFallback<T>(filePath, defaultValue);
}

export async function writeJsonAtomic_pg<T = any>(filePath: string, data: T): Promise<void> {
  // Always persist to local disk immediately for zero-loss durability
  await writeDiskFallback<T>(filePath, data);

  // Then best-effort synchronize with Cloud SQL database if configured
  if (!process.env.SQL_HOST) return;

  try {
    if (filePath === 'data/config.json') {
      const d = data as any;
      await tryDbWithTimeout(() => db.insert(config).values({
        id: 1,
        gemini_api_key: d.gemini_api_key ?? null,
        groq_api_key: d.groq_api_key ?? null,
        openrouter_api_key: d.openrouter_api_key ?? null,
        preferred_ai_provider: d.preferred_ai_provider ?? null,
        admin_hash: d.admin_hash ?? '',
        admin_salt: d.admin_salt ?? '',
        jwt_secret: d.jwt_secret ?? ''
      }).onConflictDoUpdate({
        target: config.id,
        set: {
          gemini_api_key: d.gemini_api_key ?? null,
          groq_api_key: d.groq_api_key ?? null,
          openrouter_api_key: d.openrouter_api_key ?? null,
          preferred_ai_provider: d.preferred_ai_provider ?? null,
          admin_hash: d.admin_hash ?? '',
          admin_salt: d.admin_salt ?? '',
          jwt_secret: d.jwt_secret ?? ''
        }
      }));
    } else if (filePath === 'data/gemini-usage.json') {
      const d = data as any;
      await tryDbWithTimeout(() => db.insert(gemini_usage).values({
        id: 1,
        quota_limit: d.quota_limit,
        used_count: d.used_count,
        last_reset_date: d.last_reset_date
      }).onConflictDoUpdate({
        target: gemini_usage.id,
        set: {
          quota_limit: d.quota_limit,
          used_count: d.used_count,
          last_reset_date: d.last_reset_date
        }
      }));
    } else if (filePath === 'data/roster.json') {
      const d = data as { students: any[] };
      if (Array.isArray(d.students)) {
        for (const st of d.students) {
          await tryDbWithTimeout(() => db.insert(students).values({
            student_id: st.student_id,
            student_name: st.student_name,
            assigned_tests: st.assigned_tests || [],
            email: st.email
          }).onConflictDoUpdate({
            target: students.student_id,
            set: {
              student_name: st.student_name,
              assigned_tests: st.assigned_tests || [],
              email: st.email
            }
          }));
        }
      }
    } else if (filePath.startsWith('tests/')) {
      const t = data as any;
      await tryDbWithTimeout(() => db.insert(tests).values({
        test_id: t.test_id,
        event_name: t.event_name,
        duration: t.duration,
        active: t.active,
        questions: t.questions || [],
        instructions: t.instructions,
        grades_published: t.grades_published || false
      }).onConflictDoUpdate({
        target: tests.test_id,
        set: {
          event_name: t.event_name,
          duration: t.duration,
          active: t.active,
          questions: t.questions || [],
          instructions: t.instructions,
          grades_published: t.grades_published || false
        }
      }));
    } else if (filePath.startsWith('data/sessions/')) {
      const d = data as any;
      await tryDbWithTimeout(() => db.insert(sessions).values({
        session_id: d.session_id,
        student_id: d.student_id,
        test_id: d.test_id,
        started_at: new Date(d.started_at),
        expires_at: new Date(d.expires_at),
        submitted_at: d.submitted_at ? new Date(d.submitted_at) : null,
        status: d.status,
        session_token: d.session_token,
        answers: d.answers || {},
        infraction_count: d.infraction_count || 0
      }).onConflictDoUpdate({
        target: sessions.session_id,
        set: {
          expires_at: new Date(d.expires_at),
          submitted_at: d.submitted_at ? new Date(d.submitted_at) : null,
          status: d.status,
          answers: d.answers || {},
          infraction_count: d.infraction_count || 0
        }
      }));
    } else if (filePath.startsWith('data/results/')) {
      const d = data as any;
      await tryDbWithTimeout(() => db.insert(dbResults).values({
        id: d.session_id,
        student_id: d.student_id,
        test_id: d.test_id,
        session_id: d.session_id,
        submitted_at: new Date(d.submitted_at),
        mc_score: d.mc_score,
        mc_total: d.mc_total,
        frq_grades: d.frq_grades || {},
        frq_score: d.frq_score,
        frq_total: d.frq_total,
        total_score: d.total_score,
        total_possible: d.total_possible,
        infraction_count: d.infraction_count || 0
      }).onConflictDoUpdate({
        target: dbResults.session_id,
        set: {
          frq_grades: d.frq_grades || {},
          frq_score: d.frq_score,
          total_score: d.total_score,
          infraction_count: d.infraction_count || 0
        }
      }));
    }
  } catch (err) {
    // Non-fatal database sync error
  }
}

export async function updateJsonSafe_pg<T = any>(filePath: string, updateFn: (data: T) => T | Promise<T>, defaultValue: T): Promise<void> {
  const currentData = await readJsonSafe_pg<T>(filePath, defaultValue);
  const updatedData = await updateFn(currentData);
  await writeJsonAtomic_pg<T>(filePath, updatedData);
}