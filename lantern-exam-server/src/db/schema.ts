import { pgTable, text, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core';

export const tests = pgTable('tests', {
  test_id: text('test_id').primaryKey(),
  event_name: text('event_name').notNull(),
  duration: integer('duration').notNull(),
  active: boolean('active').default(false).notNull(),
  questions: jsonb('questions').default('[]').notNull(),
  instructions: text('instructions'),
  grades_published: boolean('grades_published').default(false).notNull(),
});

export const students = pgTable('students', {
  student_id: text('student_id').primaryKey(),
  student_name: text('student_name').notNull(),
  assigned_tests: jsonb('assigned_tests').default('[]').notNull(),
  email: text('email'),
});

export const sessions = pgTable('sessions', {
  session_id: text('session_id').primaryKey(),
  student_id: text('student_id').notNull().references(() => students.student_id),
  test_id: text('test_id').notNull().references(() => tests.test_id),
  started_at: timestamp('started_at').notNull(),
  expires_at: timestamp('expires_at').notNull(),
  submitted_at: timestamp('submitted_at'),
  status: text('status').notNull(), // 'in_progress', 'submitted', 'auto_submitted', 'expired'
  session_token: text('session_token').notNull(),
  answers: jsonb('answers').default('{}').notNull(),
  infraction_count: integer('infraction_count').default(0),
});

export const results = pgTable('results', {
  id: text('id').primaryKey(), // We can use session_id as PK, or just session_id
  student_id: text('student_id').notNull().references(() => students.student_id),
  test_id: text('test_id').notNull().references(() => tests.test_id),
  session_id: text('session_id').notNull().references(() => sessions.session_id).unique(),
  submitted_at: timestamp('submitted_at').notNull(),
  mc_score: integer('mc_score').notNull(),
  mc_total: integer('mc_total').notNull(),
  frq_grades: jsonb('frq_grades').default('{}').notNull(),
  frq_score: integer('frq_score').notNull(),
  frq_total: integer('frq_total').notNull(),
  total_score: integer('total_score').notNull(),
  total_possible: integer('total_possible').notNull(),
  infraction_count: integer('infraction_count').default(0),
});

// For admin config like gemini usage and secret keys
export const config = pgTable('config', {
  id: integer('id').primaryKey().default(1),
  gemini_api_key: text('gemini_api_key'),
  groq_api_key: text('groq_api_key'),
  openrouter_api_key: text('openrouter_api_key'),
  preferred_ai_provider: text('preferred_ai_provider'),
  admin_hash: text('admin_hash'),
  admin_salt: text('admin_salt'),
  jwt_secret: text('jwt_secret'),
});

export const gemini_usage = pgTable('gemini_usage', {
  id: integer('id').primaryKey().default(1),
  quota_limit: integer('quota_limit').notNull().default(15000000),
  used_count: integer('used_count').notNull().default(0),
  last_reset_date: text('last_reset_date').notNull(),
});
