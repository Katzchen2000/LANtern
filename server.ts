import express from 'express';
import compression from 'compression';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import os from 'os';
import AdmZip from 'adm-zip';
import nodemailer from 'nodemailer';

// In-process Async Mutex per file to prevent concurrent-write races
class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const release = () => {
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          if (next) next();
        } else {
          this.locked = false;
        }
      };

      if (this.locked) {
        this.queue.push(() => resolve(release));
      } else {
        this.locked = true;
        resolve(release);
      }
    });
  }
}

const fileMutexes: Record<string, Mutex> = {};
const onlineStudents = new Map<string, { lastSeen: number; state: 'testing' | 'dashboard'; test_id?: string }>();

function getFileMutex(filePath: string): Mutex {
  const resolvedPath = path.resolve(filePath);
  if (!fileMutexes[resolvedPath]) {
    fileMutexes[resolvedPath] = new Mutex();
  }
  return fileMutexes[resolvedPath];
}

// Atomic file writing helper
async function writeJsonAtomic(filePath: string, data: any): Promise<void> {
  const mutex = getFileMutex(filePath);
  const release = await mutex.acquire();
  try {
    const parentDir = path.dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  } finally {
    release();
  }
}

// Read JSON safe helper
async function readJsonSafe<T = any>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (e) {
    return defaultValue;
  }
}

// Atomic read-modify-write JSON helper using mutex locks
async function updateJsonSafe<T = any>(filePath: string, updateFn: (data: T) => T | Promise<T>, defaultValue: T): Promise<void> {
  const mutex = getFileMutex(filePath);
  const release = await mutex.acquire();
  try {
    const currentData = await readJsonSafe<T>(filePath, defaultValue);
    const updatedData = await updateFn(currentData);
    const parentDir = path.dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(updatedData, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  } finally {
    release();
  }
}

// Crypto password hashing
function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  const testHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return testHash === hash;
}

// Gemini API Quota Usage and Tracking Helpers
function estimateFrqTokens(item: { prompt?: string; rubric_guide?: string; student_response?: string }) {
  const promptWords = (item.prompt || '').trim().split(/\s+/).filter(Boolean).length;
  const rubricWords = (item.rubric_guide || '').trim().split(/\s+/).filter(Boolean).length;
  const responseWords = (item.student_response || '').trim().split(/\s+/).filter(Boolean).length;
  
  const totalWords = promptWords + rubricWords + responseWords;
  
  // Standard scholastic rubric prompt boilerplate + system instruction overhead in tokens
  const estimatedInputTokens = Math.ceil(totalWords * 1.35) + 600;
  
  // Typical output Qualitative commentary + score JSON structure in tokens
  const estimatedOutputTokens = 300;
  
  return Math.max(800, estimatedInputTokens + estimatedOutputTokens);
}

async function getGeminiUsageStats() {
  const todayStr = new Date().toLocaleDateString('en-US'); // Day-based safe reset comparison
  const usage = await readJsonSafe<any>('data/gemini-usage.json', { quota_limit: 1500000, used_count: 0, last_reset_date: todayStr });
  let quota_limit = usage.quota_limit || 1500000;
  let used_count = usage.used_count || 0;
  
  // Daily reset check
  if (usage.last_reset_date !== todayStr) {
    used_count = 0;
    usage.used_count = 0;
    usage.last_reset_date = todayStr;
    await writeJsonAtomic('data/gemini-usage.json', usage).catch(() => {});
  }
  
  // Backwards-compatibility check: migrate old smaller quotas to 1.5M tokens
  if (quota_limit <= 150000) {
    quota_limit = 1500000;
    used_count = used_count === 0 ? 0 : Math.min(used_count * 10, 1490000);
    usage.quota_limit = quota_limit;
    usage.used_count = used_count;
    await writeJsonAtomic('data/gemini-usage.json', usage).catch(() => {});
  }
  
  const left = Math.max(0, quota_limit - used_count);
  return {
    quota_limit,
    used_count,
    left,
    estimated_frqs_left: Math.floor(left / 1500) // Assume 1,500 tokens / FRQ on average
  };
}

async function recordGeminiUsage(count = 1500) {
  try {
    const todayStr = new Date().toLocaleDateString('en-US');
    const usage = await readJsonSafe<any>('data/gemini-usage.json', { quota_limit: 1500000, used_count: 0, last_reset_date: todayStr });
    let quota_limit = usage.quota_limit || 1500000;
    let used_count = usage.used_count || 0;

    // Daily reset check on write
    if (usage.last_reset_date !== todayStr) {
      used_count = 0;
      usage.last_reset_date = todayStr;
    }

    if (quota_limit <= 150000) {
      quota_limit = 1500000;
      used_count = used_count === 0 ? 0 : Math.min(used_count * 10, 1490000);
      usage.quota_limit = quota_limit;
    }
    usage.used_count = used_count + count;
    await writeJsonAtomic('data/gemini-usage.json', usage);
  } catch (e) {
    console.error('Error recording gemini usage:', e);
  }
}

// JWT-like simple tokens using crypto HMAC
function signToken(payload: any, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${signature}`;
}

function verifyToken(token: string, secret: string): any | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, data, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', secret).update(`${header}.${data}`).digest('base64url');
  if (signature !== expectedSignature) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
  } catch (e) {
    return null;
  }
}

// LAN IP Getter
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const SERVER_START_TIME = new Date();

// Define data structures
interface Question {
  id: string;
  number: number;
  type: 'MC' | 'FRQ';
  prompt: string;
  points: number;
  options?: Record<string, string>; // MC options (A, B, C, D)
  correct_mc?: string;              // MC correct option (hidden from student)
  rubric_guide?: string;            // FRQ grading instructions (hidden from student)

  // Compatibility fields for alternative formats
  question_number?: number;
  question_type?: 'MC' | 'FRQ';
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  correct_frq_guide?: string | null;
}

interface Test {
  test_id: string;
  event_name: string;
  duration: number; // in minutes
  active: boolean;
  questions: Question[];
  instructions?: string;
}

interface Student {
  student_id: string;
  student_name: string;
  assigned_tests: string[];
  email?: string;
}

interface Roster {
  students: Student[];
}

interface SessionAnswer {
  selected_mc?: string;
  eliminated?: string[];
  flagged?: boolean;
  frq_text?: string;
}

interface Session {
  session_id: string;
  student_id: string;
  test_id: string;
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
  status: 'in_progress' | 'submitted' | 'auto_submitted' | 'expired';
  session_token: string;
  answers: Record<string, SessionAnswer>;
  infraction_count?: number;
}

interface FrqGrading {
  score: number;
  notes: string;
}

interface Result {
  student_id: string;
  test_id: string;
  session_id: string;
  submitted_at: string;
  mc_score: number;
  mc_total: number;
  frq_grades: Record<string, FrqGrading>;
  frq_score: number;
  frq_total: number;
  total_score: number;
  total_possible: number;
  infraction_count?: number;
}

// Normalized format helper to handle both original and custom uploaded JSON formats seamlessly
function normalizeTest(input: any): Test {
  const test_id = String(input.test_id || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const event_name = String(input.event_name || 'Untitled Event').trim();
  const duration = Number(input.duration) || 30;
  const active = input.active !== false;

  let questions: Question[] = [];
  if (input.questions && Array.isArray(input.questions)) {
    questions = input.questions.map((q: any, idx: number) => {
      const number = Number(q.question_number ?? q.number ?? (idx + 1));
      const id = String(q.id ?? q.question_id ?? number);
      const type = (String(q.question_type ?? q.type ?? 'MC').toUpperCase() === 'FRQ') ? 'FRQ' : 'MC';
      const prompt = String(q.prompt ?? '').trim();
      const points = Number(q.points) || 1;

      // Extract options record
      let options: Record<string, string> = q.options ? { ...q.options } : {};
      
      // Standardize user option keys
      if (q.option_a !== undefined && q.option_a !== null) options['A'] = String(q.option_a);
      if (q.option_b !== undefined && q.option_b !== null) options['B'] = String(q.option_b);
      if (q.option_c !== undefined && q.option_c !== null) options['C'] = String(q.option_c);
      if (q.option_d !== undefined && q.option_d !== null) options['D'] = String(q.option_d);
      
      if (q.option_A !== undefined && q.option_A !== null) options['A'] = String(q.option_A);
      if (q.option_B !== undefined && q.option_B !== null) options['B'] = String(q.option_B);
      if (q.option_C !== undefined && q.option_C !== null) options['C'] = String(q.option_C);
      if (q.option_D !== undefined && q.option_D !== null) options['D'] = String(q.option_D);

      const correct_mc = q.correct_mc !== undefined && q.correct_mc !== null ? String(q.correct_mc).toUpperCase().trim() : undefined;
      const rubric_guide = q.correct_frq_guide !== undefined && q.correct_frq_guide !== null ? String(q.correct_frq_guide).trim() : (q.rubric_guide ? String(q.rubric_guide).trim() : undefined);

      return {
        id,
        number,
        type,
        prompt,
        points,
        options: type === 'MC' ? options : undefined,
        correct_mc,
        rubric_guide,

        // Store legacy/upload keys for backward compatibility
        question_number: number,
        question_type: type,
        option_a: options['A'] || null,
        option_b: options['B'] || null,
        option_c: options['C'] || null,
        option_d: options['D'] || null,
        correct_frq_guide: rubric_guide || null
      };
    });
  }

  return {
    test_id,
    event_name,
    duration,
    active,
    questions
  };
}

// Bootstrapping Seed Data
async function bootstrapDirsAndFiles() {
  await fs.mkdir('tests', { recursive: true });
  await fs.mkdir('data', { recursive: true });
  await fs.mkdir('data/sessions', { recursive: true });
  await fs.mkdir('data/results', { recursive: true });
  await fs.mkdir('data/exports', { recursive: true });

  // Seed default admin config if missing
  const configPath = 'data/config.json';
  try {
    await fs.access(configPath);
  } catch (e) {
    const defaultSecret = crypto.randomBytes(32).toString('hex');
    await writeJsonAtomic(configPath, {
      admin_hash: '', // Admin registers on setup page
      admin_salt: '',
      jwt_secret: defaultSecret,
      server_settings: {
        created_at: new Date().toISOString(),
      },
    });
    console.log('Seeded data/config.json');
  }

  // Load saved gemini_api_key into memory environment if exists
  try {
    const config = await readJsonSafe<any>('data/config.json', {});
    if (config && config.gemini_api_key && !process.env.GEMINI_API_KEY) {
      process.env.GEMINI_API_KEY = config.gemini_api_key;
      console.log('Successfully initialized process.env.GEMINI_API_KEY from config.json.');
    }
  } catch (e) {}

  // Seed standard roster.json if missing
  const rosterPath = 'data/roster.json';
  try {
    await fs.access(rosterPath);
  } catch (e) {
    const initialRoster: Roster = {
      students: [
        { student_id: "S001", student_name: "Alice Smith", assigned_tests: ["TEST_1", "TEST_2"] },
        { student_id: "S002", student_name: "Bob Jones", assigned_tests: ["TEST_1"] },
        { student_id: "S003", student_name: "Charlie Brown", assigned_tests: ["TEST_2"] }
      ]
    };
    await writeJsonAtomic(rosterPath, initialRoster);
    console.log('Seeded data/roster.json');
  }

  // Seed TEST_1.json if missing
  const test1Path = 'tests/TEST_1.json';
  try {
    await fs.access(test1Path);
  } catch (e) {
    const test1: Test = {
      test_id: "TEST_1",
      event_name: "Algebra Midterm A",
      duration: 30,
      active: true,
      questions: [
        {
          id: "1",
          number: 1,
          type: "MC",
          prompt: "Solve for x: 3x - 7 = 14.",
          points: 5,
          options: {
            "A": "x = 5",
            "B": "x = 7",
            "C": "x = 8",
            "D": "x = 10"
          },
          correct_mc: "B"
        },
        {
          id: "2",
          number: 2,
          type: "MC",
          prompt: "Which of the following lines has a slope of -2?",
          points: 5,
          options: {
            "A": "y = 2x - 3",
            "B": "y = -2x + 5",
            "C": "2y = x + 4",
            "D": "y = -0.5x + 1"
          },
          correct_mc: "B"
        },
        {
          id: "3",
          number: 3,
          type: "FRQ",
          prompt: "A student states that the system of equations y = 2x + 1 and y = 2x - 3 has exactly one solution because they have the same slope. Critique the student's statement and explain the actual number of solutions to this system.",
          points: 10,
          rubric_guide: "Max 10 pts. 5 pts for identifying the student's error (same slope means parallel, not intersecting). 5 pts for clearly stating that there are 0 solutions in parallel systems."
        }
      ]
    };
    await writeJsonAtomic(test1Path, test1);
    console.log('Seeded tests/TEST_1.json');
  }

  // Seed TEST_2.json if missing
  const test2Path = 'tests/TEST_2.json';
  try {
    await fs.access(test2Path);
  } catch (e) {
    const test2: Test = {
      test_id: "TEST_2",
      event_name: "Cell Physiology Exam",
      duration: 30,
      active: true,
      questions: [
        {
          id: "1",
          number: 1,
          type: "MC",
          prompt: "Which organelle is primarily responsible for ATP production through cellular respiration?",
          points: 5,
          options: {
            "A": "Lysosome",
            "B": "Golgi Apparatus",
            "C": "Mitochondrion",
            "D": "Ribosome"
          },
          correct_mc: "C"
        },
        {
          id: "2",
          number: 2,
          type: "MC",
          prompt: "What is the primary macromolecule component of the cell membrane bilayer?",
          points: 5,
          options: {
            "A": "Phospholipids",
            "B": "Glycoproteins",
            "C": "Triglycerides",
            "D": "Polypeptides"
          },
          correct_mc: "A"
        },
        {
          id: "3",
          number: 3,
          type: "FRQ",
          prompt: "Describe the process of active transport across a cell membrane, and contrast it with facilitated diffusion.",
          points: 15,
          rubric_guide: "Max 15 pts. 5 pts for defining active transport (moves solutes against concentration gradient using ATP). 5 pts for facilitated diffusion definition (moves down gradient via transport proteins without ATP). 5 pts for clear contrast sentence."
        }
      ]
    };
    await writeJsonAtomic(test2Path, test2);
    console.log('Seeded tests/TEST_2.json');
  }
}

async function startServer() {
  await bootstrapDirsAndFiles();

  const app = express();
  app.use(compression());
  app.use(express.json({ limit: '100mb' }));

  // Dynamic config.json reader for JWT Secret and Password
  async function retrieveConfig() {
    return await readJsonSafe<any>('data/config.json', { admin_hash: '', admin_salt: '', jwt_secret: 'fallback' });
  }

  // Parse Cookie middleware helper
  function parseCookies(req: express.Request): Record<string, string> {
    const raw = req.headers.cookie;
    if (!raw) return {};
    const cookies: Record<string, string> = {};
    raw.split(';').forEach(c => {
      const parts = c.split('=');
      const key = parts[0]?.trim();
      const val = parts.slice(1).join('=')?.trim();
      if (key) cookies[key] = val;
    });
    return cookies;
  }

  // Auth Middlewares
  async function adminAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const cookies = parseCookies(req);
    const token = cookies['admin_token'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    const config = await retrieveConfig();
    const payload = verifyToken(token, config.jwt_secret);
    if (!payload || !payload.admin) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    (req as any).admin = payload;
    next();
  }

  async function studentAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const cookies = parseCookies(req);
    const token = cookies['student_token'];
    if (!token) {
      return res.status(401).json({ error: 'Student login required' });
    }
    const config = await retrieveConfig();
    const payload = verifyToken(token, config.jwt_secret);
    if (!payload || !payload.student_id) {
      return res.status(401).json({ error: 'Student auth is expired or invalid' });
    }
    (req as any).student_id = payload.student_id;
    next();
  }

  // --- ADMIN PUBLIC ENDPOINTS ---

  // Check setup status
  app.get('/api/admin/setup-status', async (req, res) => {
    const config = await retrieveConfig();
    const isSetup = !!config.admin_hash;
    res.json({ isSetup });
  });

  // Admin Setup
  app.post('/api/admin/setup', async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters long' });
    }
    const config = await retrieveConfig();
    if (config.admin_hash) {
      return res.status(400).json({ error: 'Admin setup already completed' });
    }
    const { hash, salt } = hashPassword(password);
    config.admin_hash = hash;
    config.admin_salt = salt;
    await writeJsonAtomic('data/config.json', config);
    res.json({ success: true });
  });

  // Admin Login
  app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    const config = await retrieveConfig();
    if (!config.admin_hash) {
      return res.status(400).json({ error: 'Admin has not been set up yet. Please visit /admin/setup' });
    }
    const isValid = verifyPassword(password, config.admin_hash, config.admin_salt);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid admin password' });
    }
    const token = signToken({ admin: true }, config.jwt_secret);
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    res.json({ success: true });
  });

  // Admin Logout
  app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.json({ success: true });
  });

  // Check me (auth check)
  app.get('/api/admin/me', adminAuthMiddleware, (req, res) => {
    res.json({ ok: true, admin: true });
  });

  // --- ADMIN PRIVATE ENDPOINTS ---

  // Get Server Metadata
  app.get('/api/admin/info', adminAuthMiddleware, async (req, res) => {
    try {
      const testsDir = await fs.readdir('tests');
      let testCount = testsDir.filter(f => f.endsWith('.json')).length;

      let sessionCount = 0;
      try {
        const sessionsDir = await fs.readdir('data/sessions');
        sessionCount = sessionsDir.filter(f => f.endsWith('.json')).length;
      } catch (e) {}

      let resultsCount = 0;
      try {
        const resultSubdirs = await fs.readdir('data/results');
        for (const subdir of resultSubdirs) {
          const stats = await fs.stat(path.join('data/results', subdir));
          if (stats.isDirectory()) {
            const rFiles = await fs.readdir(path.join('data/results', subdir));
            resultsCount += rFiles.filter(f => f.endsWith('.json')).length;
          }
        }
      } catch (e) {}

      res.json({
        lan_ip: getLocalIP(),
        port: 3000,
        uptime_seconds: Math.floor((Date.now() - SERVER_START_TIME.getTime()) / 1000),
        test_count: testCount,
        session_count: sessionCount,
        results_count: resultsCount,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Change Admin Password
  app.post('/api/admin/change-password', adminAuthMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters long' });
    }
    const config = await retrieveConfig();
    const isValid = verifyPassword(currentPassword, config.admin_hash, config.admin_salt);
    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect current password' });
    }
    const { hash, salt } = hashPassword(newPassword);
    config.admin_hash = hash;
    config.admin_salt = salt;
    await writeJsonAtomic('data/config.json', config);
    res.json({ success: true });
  });

  // Tests Operations
  app.get('/api/admin/tests', adminAuthMiddleware, async (req, res) => {
    try {
      const files = await fs.readdir('tests');
      const testsList: any[] = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const test = await readJsonSafe(`tests/${file}`, null);
          if (test) {
            const mcCount = test.questions ? test.questions.filter((q: any) => q.type === 'MC').length : 0;
            const frqCount = test.questions ? test.questions.filter((q: any) => q.type === 'FRQ').length : 0;
            testsList.push({
              test_id: test.test_id,
              event_name: test.event_name,
              duration: test.duration || 30,
              active: test.active ?? true,
              mc_count: mcCount,
              frq_count: frqCount,
              total_questions: test.questions ? test.questions.length : 0
            });
          }
        }
      }
      res.json({ tests: testsList });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/admin/tests/:id', adminAuthMiddleware, async (req, res) => {
    const test = await readJsonSafe(`tests/${req.params.id}.json`, null);
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }
    res.json(test);
  });

  app.post('/api/admin/tests', adminAuthMiddleware, async (req, res) => {
    const testData = req.body;
    if (!testData.test_id || !testData.event_name) {
      return res.status(400).json({ error: 'Missing required parameters test_id or event_name' });
    }

    const normalized = normalizeTest(testData);
    await writeJsonAtomic(`tests/${normalized.test_id}.json`, normalized);
    res.json({ success: true, test: normalized });
  });

  // Regrade student MC answers based on updated test key definitions
  app.post('/api/admin/tests/:id/regrade', adminAuthMiddleware, async (req, res) => {
    const testId = req.params.id;
    const test = await readJsonSafe<any>(`tests/${testId}.json`, null);
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    let regradedCount = 0;
    try {
      const sFiles = await fs.readdir('data/sessions');
      for (const sf of sFiles) {
        if (sf.endsWith('.json')) {
          const session = await readJsonSafe<any>(`data/sessions/${sf}`, null);
          if (session && session.test_id === testId && session.status !== 'in_progress') {
            await evaluateAndSaveResult(session);
            regradedCount++;
          }
        }
      }
      res.json({ success: true, message: `Successfully regraded ${regradedCount} student session(s) based on the updated MC answer keys.` });
    } catch (e: any) {
      res.status(500).json({ error: 'Failed to regrade: ' + e.message });
    }
  });

  app.delete('/api/admin/tests/:id', adminAuthMiddleware, async (req, res) => {
    const testId = req.params.id;
    const testPath = `tests/${testId}.json`;
    try {
      await fs.unlink(testPath);
      
      // Cascade delete sessions
      try {
        const sDir = await fs.readdir('data/sessions');
        for (const sFile of sDir) {
          if (sFile.endsWith('.json')) {
            const session = await readJsonSafe(`data/sessions/${sFile}`, null);
            if (session && session.test_id === testId) {
              await fs.unlink(`data/sessions/${sFile}`);
            }
          }
        }
      } catch (err) {}

      // Delete results safely
      try {
        const rPath = `data/results/${testId}`;
        const files = await fs.readdir(rPath);
        for (const file of files) {
          await fs.unlink(path.join(rPath, file));
        }
        await fs.rmdir(rPath);
      } catch (err) {}

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Import JSON Master Test
  app.post('/api/admin/tests/import', adminAuthMiddleware, async (req, res) => {
    try {
      const { testJson } = req.body;
      const parsed = typeof testJson === 'string' ? JSON.parse(testJson) : testJson;
      if (!parsed.test_id || !parsed.event_name) {
        return res.status(400).json({ error: 'Invalid test master JSON shape: needs test_id and event_name' });
      }
      
      const normalized = normalizeTest(parsed);
      await writeJsonAtomic(`tests/${normalized.test_id}.json`, normalized);
      res.json({ success: true, test_id: normalized.test_id });
    } catch (error: any) {
      res.status(400).json({ error: 'Failed to process JSON content: ' + error.message });
    }
  });

  // Roster list
  app.get('/api/admin/roster', adminAuthMiddleware, async (req, res) => {
    const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
    res.json(roster);
  });

  // Save full roster
  app.post('/api/admin/roster', adminAuthMiddleware, async (req, res) => {
    const roster: Roster = req.body;
    if (!roster || !Array.isArray(roster.students)) {
      return res.status(400).json({ error: 'Roster must contain an array of students' });
    }
    await writeJsonAtomic('data/roster.json', roster);
    res.json({ success: true });
  });

  // Roster Student bulk updates
  app.post('/api/admin/roster/student', adminAuthMiddleware, async (req, res) => {
    const { student_id, student_name, assigned_tests, email, old_id } = req.body;
    if (!student_id || !student_name) {
      return res.status(400).json({ error: 'Missing student_id or student_name' });
    }
    const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
    const student: Student = {
      student_id: student_id.trim().toUpperCase(),
      student_name: student_name.trim(),
      assigned_tests: assigned_tests || [],
      email: email ? email.trim() : undefined
    };

    if (old_id) {
      const idx = roster.students.findIndex(s => s.student_id === old_id.trim().toUpperCase());
      if (idx >= 0) {
        roster.students[idx] = student;
      } else {
        roster.students.push(student);
      }
    } else {
      const idx = roster.students.findIndex(s => s.student_id === student.student_id);
      if (idx >= 0) {
        roster.students[idx] = { ...roster.students[idx], ...student };
      } else {
        roster.students.push(student);
      }
    }
    await writeJsonAtomic('data/roster.json', roster);
    res.json({ success: true });
  });

  app.delete('/api/admin/roster/student/:id', adminAuthMiddleware, async (req, res) => {
    const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
    roster.students = roster.students.filter(s => s.student_id !== req.params.id);
    await writeJsonAtomic('data/roster.json', roster);
    res.json({ success: true });
  });

  // Get Secrets status
  app.get('/api/admin/secrets-status', adminAuthMiddleware, async (req, res) => {
    try {
      const config = await readJsonSafe<any>('data/config.json', {});
      const key = process.env.GEMINI_API_KEY || config.gemini_api_key || '';
      const isConfigured = !!key;
      let masked = '';
      if (isConfigured) {
        masked = key.length > 8 ? `${key.substring(0, 4)}••••••••${key.substring(key.length - 4)}` : '••••••••';
      }
      const stats = await getGeminiUsageStats();
      res.json({
        is_configured: isConfigured,
        masked_key: masked,
        gemini_usage_left: stats.left,
        gemini_quota_limit: stats.quota_limit,
        estimated_frqs_left: stats.estimated_frqs_left
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Save/Update GEMINI_API_KEY secret
  app.post('/api/admin/secrets', adminAuthMiddleware, async (req, res) => {
    try {
      const { gemini_api_key } = req.body;
      if (!gemini_api_key || !gemini_api_key.trim()) {
        return res.status(400).json({ error: 'Key cannot be empty.' });
      }
      const trimmedKey = gemini_api_key.trim();
      const config = await readJsonSafe<any>('data/config.json', { admin_hash: '', admin_salt: '', jwt_secret: 'fallback' });
      config.gemini_api_key = trimmedKey;
      await writeJsonAtomic('data/config.json', config);
      process.env.GEMINI_API_KEY = trimmedKey;
      console.log('Successfully updated GEMINI_API_KEY in memory and config.json');
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get SMTP Configuration (safe output - masks password)
  app.get('/api/admin/smtp-config', adminAuthMiddleware, async (req, res) => {
    try {
      const config = await readJsonSafe<any>('data/config.json', {});
      res.json({
        smtp_host: config.smtp_host || '',
        smtp_port: String(config.smtp_port || '465'),
        smtp_user: config.smtp_user || '',
        smtp_from: config.smtp_from || '',
        smtp_secure: config.smtp_secure !== false,
        has_password: !!config.smtp_password
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Save/Update SMTP configuration
  app.post('/api/admin/smtp-config', adminAuthMiddleware, async (req, res) => {
    try {
      const { smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure, smtp_from } = req.body;
      const config = await readJsonSafe<any>('data/config.json', { admin_hash: '', admin_salt: '', jwt_secret: 'fallback' });
      
      config.smtp_host = (smtp_host || '').trim();
      config.smtp_port = Number(smtp_port) || 465;
      config.smtp_user = (smtp_user || '').trim();
      config.smtp_secure = smtp_secure !== false;
      config.smtp_from = (smtp_from || '').trim();
      
      if (smtp_password && smtp_password !== '__UNCHANGED__') {
        config.smtp_password = smtp_password;
      }
      
      await writeJsonAtomic('data/config.json', config);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  async function performStressCleanup() {
    try {
      // 1. Clean up from data/sessions/
      const sessionFiles = await fs.readdir('data/sessions').catch(() => []);
      for (const sf of sessionFiles) {
        if (sf.startsWith('stress_') || sf.endsWith('.tmp')) {
          await fs.unlink(path.join('data/sessions', sf)).catch(() => {});
        }
      }

      // 2. Clean up from data/results/
      const resultDirs = await fs.readdir('data/results').catch(() => []);
      for (const dir of resultDirs) {
        const dirPath = path.join('data/results', dir);
        const stats = await fs.stat(dirPath).catch(() => null);
        if (stats && stats.isDirectory()) {
          const files = await fs.readdir(dirPath).catch(() => []);
          for (const file of files) {
            if (file.startsWith('stress_') || file.endsWith('.tmp')) {
              await fs.unlink(path.join(dirPath, file)).catch(() => {});
            }
          }
          
          // If the directory of the test became empty, delete it
          const remaining = await fs.readdir(dirPath).catch(() => []);
          if (remaining.length === 0) {
            await fs.rmdir(dirPath).catch(() => {});
          }
        }
      }

      // 3. Clean up from tests if stress_test_blueprint was created
      await fs.unlink('tests/stress_test_blueprint.json').catch(() => {});
    } catch (err) {
      console.error('Error during stress cleanup:', err);
    }
  }

  // Concurrent stress simulator endpoint simulating concurrent student saves and submits
  app.post('/api/admin/simulate-stress', adminAuthMiddleware, async (req, res) => {
    try {
      const { students_count = 200, concurrency_limit = 20 } = req.body;
      
      const count = Math.min(Math.max(1, Number(students_count) || 200), 500); // Dynamic sanity limits
      const limit = Math.min(Math.max(1, Number(concurrency_limit) || 20), 50);

      // Clean up any old stress runs before starting
      await performStressCleanup();

      const testFiles = await fs.readdir('tests').catch(() => []);
      const jsonTests = testFiles.filter(f => f.endsWith('.json'));
      
      let testId = 'stress_test_blueprint';
      let testObj: any = null;
      
      if (jsonTests.length > 0) {
        testId = jsonTests[0].replace('.json', '');
        testObj = await readJsonSafe<any>(`tests/${testId}.json`, null);
      }
      
      // Bootstrap template if none exists
      if (!testObj) {
        testId = 'stress_test_blueprint';
        testObj = {
          test_id: testId,
          event_name: 'Concurrent Stress Testing Event',
          time_limit: 50,
          points: 10,
          questions: [
            { id: 'q1', type: 'MC', text: 'Select correct options:', points: 5, correct_mc: 'A' },
            { id: 'q2', type: 'FR', text: 'State the solution:', points: 5, rubric_guide: 'Expected key response' }
          ]
        };
        await writeJsonAtomic(`tests/${testId}.json`, testObj);
      }

      const startTime = Date.now();
      const studentIds = Array.from({ length: count }, (_, i) => `stress_student_${i + 1}`);
      const sessionsCreated: string[] = [];
      
      // Step 1: Create active mock session data concurrently
      const sessionCreationStart = Date.now();
      for (let i = 0; i < studentIds.length; i += limit) {
        const chunk = studentIds.slice(i, i + limit);
        await Promise.all(chunk.map(async (studentId) => {
          const sessionId = `stress_sess_${studentId}`;
          const sessionFile = `data/sessions/${sessionId}.json`;
          const sessionData: any = {
            session_id: sessionId,
            student_id: studentId,
            test_id: testId,
            status: 'in_progress',
            ip_address: '127.0.0.1',
            infraction_count: 0,
            started_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 50 * 60000).toISOString(),
            answers: {}
          };
          await writeJsonAtomic(sessionFile, sessionData);
          sessionsCreated.push(sessionId);
        }));
      }
      const sessionCreationTime = Date.now() - sessionCreationStart;

      // Step 2: Concurrently simulate real student random MC & FR answers
      const savesStart = Date.now();
      let saveCount = 0;
      let saveErrors = 0;
      
      for (let i = 0; i < sessionsCreated.length; i += limit) {
        const chunk = sessionsCreated.slice(i, i + limit);
        await Promise.all(chunk.map(async (sessionId) => {
          try {
            const sessionFile = `data/sessions/${sessionId}.json`;
            const answers: Record<string, any> = {};
            
            if (testObj.questions) {
              testObj.questions.forEach((q: any) => {
                if (q.type === 'MC') {
                  answers[q.id] = ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)];
                } else {
                  answers[q.id] = 'Simulation response generated programmatically.';
                }
              });
            }
            
            await updateJsonSafe<any>(sessionFile, (sess) => {
              if (sess) {
                sess.answers = answers;
                sess.infraction_count = Math.random() > 0.9 ? 1 : 0;
              }
              return sess;
            }, null);
            saveCount++;
          } catch (err) {
            saveErrors++;
          }
        }));
      }
      const savesTime = Date.now() - savesStart;

      // Step 3: Concurrently submit and run scoring evaluation
      const submitStart = Date.now();
      let submitCount = 0;
      let submitErrors = 0;
      
      for (let i = 0; i < sessionsCreated.length; i += limit) {
        const chunk = sessionsCreated.slice(i, i + limit);
        await Promise.all(chunk.map(async (sessionId) => {
          try {
            const sessionFile = `data/sessions/${sessionId}.json`;
            const session = await readJsonSafe<any>(sessionFile, null);
            if (session) {
              session.status = 'submitted';
              session.submitted_at = new Date().toISOString();
              await writeJsonAtomic(sessionFile, session);
              await evaluateAndSaveResult(session);
              submitCount++;
            } else {
              submitErrors++;
            }
          } catch (err) {
            submitErrors++;
          }
        }));
      }
      const submitTime = Date.now() - submitStart;
      const totalDuration = Date.now() - startTime;

      // Cleanup files immediately using the comprehensive cleanup helper
      await performStressCleanup();

      const stats = await getGeminiUsageStats();

      res.json({
        success: true,
        report: {
          students_simulated: count,
          concurrency_limit: limit,
          test_id_used: testId,
          session_creation_duration_ms: sessionCreationTime,
          saves_duration_ms: savesTime,
          submits_duration_ms: submitTime,
          total_duration_ms: totalDuration,
          saves_successful: saveCount,
          saves_failed: saveErrors,
          submits_successful: submitCount,
          submits_failed: submitErrors,
          throughput_req_per_sec: Math.round((count * 3) / (totalDuration / 1000 || 1)),
          responses_graded_per_sec: parseFloat((submitCount / (submitTime / 1000 || 1)).toFixed(2)),
          gemini_usage_left: stats.left,
          gemini_quota_limit: stats.quota_limit,
          estimated_frqs_left: stats.estimated_frqs_left
        }
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get simulated emails in simulator outbox queue
  app.get('/api/admin/outbound-emails', adminAuthMiddleware, async (req, res) => {
    try {
      const queue = await readJsonSafe<any[]>('data/outbound-emails.json', []);
      res.json(queue);
    } catch (e: any) {
      res.json([]);
    }
  });

  // Clear simulated emails queue list
  app.delete('/api/admin/outbound-emails', adminAuthMiddleware, async (req, res) => {
    try {
      await writeJsonAtomic('data/outbound-emails.json', []);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Bulk email results
  app.post('/api/admin/email-results-bulk', adminAuthMiddleware, async (req, res) => {
    try {
      const { test_id } = req.body;
      if (!test_id) {
        return res.status(400).json({ error: 'Missing test_id' });
      }

      const test = await readJsonSafe<Test>(`tests/${test_id}.json`, null);
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }

      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      let successCount = 0;
      let simulatedCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      // Find all students assigned who have finished submissions
      for (const s of roster.students) {
        if (!s.email) {
          skippedCount++;
          continue;
        }

        // Try to load their graded result file
        const resultPath = `data/results/${test_id}/${s.student_id}.json`;
        const result = await readJsonSafe<Result>(resultPath, null);
        if (!result) {
          skippedCount++; // No result compiled yet (they didn't take/finish)
          continue;
        }

        // Load corresponding session answer file
        const session = await readJsonSafe<Session>(`data/sessions/${result.session_id}.json`, null);
        if (!session) {
          skippedCount++;
          continue;
        }

        const mailRes = await sendStudentGradeEmail(s, test, session, result);
        if (mailRes.success) {
          if (mailRes.simulated) {
            simulatedCount++;
          } else {
            successCount++;
          }
        } else {
          errors.push(`Student ${s.student_name} (${s.student_id}): ${mailRes.error}`);
        }
      }

      res.json({
        success: true,
        successCount,
        simulatedCount,
        skippedCount,
        errors
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Email a single student result
  app.post('/api/admin/email-result', adminAuthMiddleware, async (req, res) => {
    try {
      const { test_id, student_id } = req.body;
      if (!test_id || !student_id) {
        return res.status(400).json({ error: 'Missing test_id or student_id' });
      }

      const test = await readJsonSafe<Test>(`tests/${test_id}.json`, null);
      if (!test) {
        return res.status(404).json({ error: 'Test blueprint not found' });
      }

      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      const student = roster.students.find(s => s.student_id === student_id);
      if (!student) {
        return res.status(404).json({ error: 'Student not found in active roster' });
      }

      if (!student.email) {
        return res.status(400).json({ error: `Student ${student.student_name} has no email address configured in the roster.` });
      }

      const resultPath = `data/results/${test_id}/${student_id}.json`;
      const result = await readJsonSafe<Result>(resultPath, null);
      if (!result) {
        return res.status(400).json({ error: 'No graded result is parsed/saved on host for this student yet.' });
      }

      const session = await readJsonSafe<Session>(`data/sessions/${result.session_id}.json`, null);
      if (!session) {
        return res.status(400).json({ error: 'Student test session responses file not found on host.' });
      }

      const mailRes = await sendStudentGradeEmail(student, test, session, result);
      if (mailRes.success) {
        res.json({
          success: true,
          simulated: mailRes.simulated,
          message: mailRes.simulated 
            ? `SMTP is not configured yet. Grade report safely generated in outbound queue simulator for inspection!`
            : `Grade report successfully dispatched via SMTP directly to ${student.email}!`
        });
      } else {
        res.status(500).json({ error: mailRes.error });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get session details and corresponding test questions
  app.get('/api/admin/sessions/:id', adminAuthMiddleware, async (req, res) => {
    try {
      const sessionId = req.params.id;
      const session = await readJsonSafe<Session>(`data/sessions/${sessionId}.json`, null);
      if (!session) {
        return res.status(404).json({ error: 'Session not found on server disk.' });
      }
      const test = await readJsonSafe<Test>(`tests/${session.test_id}.json`, null);
      const resultObj = await readJsonSafe<Result>(`data/results/${session.test_id}/${session.student_id}.json`, null);
      
      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      const studentName = roster.students.find(s => s.student_id === session.student_id)?.student_name || 'Unknown Student';

      const responses: any = {};
      const answersMap = session.answers || {};
      
      const questionsWithGrades = (test?.questions || []).map(q => {
        let grade_points;
        let grade_notes;
        
        const ans = answersMap[q.id];
        if (q.type === 'MC') {
          responses[q.id] = ans?.selected_mc || '';
        } else {
          responses[q.id] = ans?.frq_text || '';
          if (resultObj && resultObj.frq_grades && resultObj.frq_grades[q.id]) {
            grade_points = resultObj.frq_grades[q.id].score;
            grade_notes = resultObj.frq_grades[q.id].notes;
          }
        }
        
        return {
          ...q,
          grade_points,
          grade_notes
        };
      });

      res.json({
        student_id: session.student_id,
        student_name: studentName,
        event_name: test?.event_name || 'Unknown Blueprint',
        total_score: resultObj?.total_score || 0,
        total_possible: resultObj?.total_possible || test?.questions?.reduce((acc, q) => acc + q.points, 0) || 0,
        submitted_at: session.submitted_at || session.expires_at,
        infraction_count: session.infraction_count || 0,
        questions: questionsWithGrades,
        responses: responses
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Roster CSV import (merges or replaces)
  app.post('/api/admin/roster/csv', adminAuthMiddleware, async (req, res) => {
    try {
      const { csvText, mode } = req.body; // mode = 'merge' or 'replace'
      if (!csvText) {
        return res.status(400).json({ error: 'No CSV data provided' });
      }

      // Parse csv rows safely (taking care of double quotes in CSV fields)
      const parseCSVLine = (line: string): string[] => {
        const result: string[] = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(cur.trim());
            cur = '';
          } else {
            cur += char;
          }
        }
        result.push(cur.trim());
        return result;
      };

      const lines = csvText.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l.length > 0);
      if (lines.length < 2) {
        return res.status(400).json({ error: 'CSV must contain at least a header and one student row' });
      }

      const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim().replace(/["']/g, ''));
      const idIdx = headers.findIndex(h => h.includes('id') || h.includes('student_id'));
      const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('student_name'));
      const assignedIdx = headers.findIndex(h => h.includes('assigned') || h.includes('tests') || h.includes('assigned_tests'));
      const emailIdx = headers.findIndex(h => h.includes('email') || h.includes('mail') || h.includes('address'));

      if (idIdx === -1 || nameIdx === -1) {
        return res.status(400).json({ error: 'CSV requires columns like "student_id" and "student_name" (headers mismatch)' });
      }

      const newStudents: Student[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cells = parseCSVLine(lines[i]);
        if (cells.length < Math.max(idIdx, nameIdx) + 1) continue;
        const studentId = cells[idIdx].replace(/["']/g, '');
        const studentName = cells[nameIdx].replace(/["']/g, '');
        if (!studentId || !studentName) continue;

        let assigned: string[] = [];
        if (assignedIdx !== -1 && cells[assignedIdx]) {
          assigned = cells[assignedIdx]
            .replace(/["']/g, '')
            .split(';')
            .map((t: string) => t.trim().toUpperCase())
            .filter((t: string) => t.length > 0);
        }

        let email: string | undefined = undefined;
        if (emailIdx !== -1 && cells[emailIdx]) {
          email = cells[emailIdx].replace(/["']/g, '').trim();
        }

        newStudents.push({
          student_id: studentId,
          student_name: studentName,
          assigned_tests: assigned,
          email: email || undefined
        });
      }

      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      if (mode === 'replace') {
        roster.students = newStudents;
      } else {
        // Merge mode (overwrite same student_ids, append new ones)
        for (const s of newStudents) {
          const existingIdx = roster.students.findIndex(ex => ex.student_id === s.student_id);
          if (existingIdx >= 0) {
            roster.students[existingIdx] = s;
          } else {
            roster.students.push(s);
          }
        }
      }

      await writeJsonAtomic('data/roster.json', roster);
      res.json({ success: true, count: newStudents.length });
    } catch (e: any) {
      res.status(500).json({ error: 'Failed to parse CSV: ' + e.message });
    }
  });

  // Bulk-assign tests
  app.post('/api/admin/roster/assign', adminAuthMiddleware, async (req, res) => {
    const { studentIds, testIds } = req.body;
    if (!studentIds || !testIds || !Array.isArray(studentIds) || !Array.isArray(testIds)) {
      return res.status(400).json({ error: 'Missing studentIds or testIds arrays' });
    }
    const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
    for (const studentId of studentIds) {
      const student = roster.students.find(s => s.student_id === studentId);
      if (student) {
        const mergedSet = new Set([...student.assigned_tests, ...testIds.map(t => t.toUpperCase())]);
        student.assigned_tests = Array.from(mergedSet);
      }
    }
    await writeJsonAtomic('data/roster.json', roster);
    res.json({ success: true });
  });

  // Get Live Sessions (polled every 2s in Admin Console)
  app.get('/api/admin/live-sessions', adminAuthMiddleware, async (req, res) => {
    try {
      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      const testFiles = await fs.readdir('tests').catch(() => []);
      const testsMap = new Map<string, string>();
      for (const tf of testFiles) {
        if (tf.endsWith('.json')) {
          const tId = tf.replace('.json', '');
          const tObj = await readJsonSafe<Test>(`tests/${tf}`, null);
          if (tObj) {
            testsMap.set(tId, tObj.event_name);
          }
        }
      }

      // Check for active sessions on disk to associate session IDs with force submit commands
      const sessionsOnDisk: Record<string, { session_id: string; infraction_count: number; expires_at?: string }> = {}; // studentId -> { session_id, infraction_count, expires_at }
      try {
        const sFiles = await fs.readdir('data/sessions');
        for (const sf of sFiles) {
          if (sf.endsWith('.json')) {
            const sess = await readJsonSafe<Session>(`data/sessions/${sf}`, null);
            if (sess && sess.status === 'in_progress') {
              const hasExp = new Date() > new Date(sess.expires_at);
              if (hasExp) {
                // Auto-submit stale expired session on the fly
                sess.status = 'auto_submitted';
                sess.submitted_at = new Date().toISOString();
                await writeJsonAtomic(`data/sessions/${sess.session_id}.json`, sess);
                await evaluateAndSaveResult(sess);
              } else {
                sessionsOnDisk[sess.student_id] = {
                  session_id: sess.session_id,
                  infraction_count: sess.infraction_count || 0,
                  expires_at: sess.expires_at
                };
              }
            }
          }
        }
      } catch (e) {}

      const sessionsList: any[] = [];
      const threshold = 12000; // 12 seconds heartbeat window
      const now = Date.now();

      for (const student of roster.students) {
        const sId = student.student_id;
        const hb = onlineStudents.get(sId);
        
        // Is actively connected?
        const isOnline = hb && (now - hb.lastSeen < threshold);
        let statusState: 'testing' | 'dashboard' | 'offline' = 'offline';
        let activeTestId = '';
        let activeTestName = '';

        if (isOnline) {
          if (hb.state === 'testing') {
            statusState = 'testing';
            activeTestId = hb.test_id || '';
            activeTestName = testsMap.get(activeTestId) || activeTestId;
          } else {
            statusState = 'dashboard';
          }
        }

        const diskInfo = sessionsOnDisk[sId];
        sessionsList.push({
          session_id: diskInfo ? diskInfo.session_id : `${sId}-temp-session`,
          student_id: sId,
          student_name: student.student_name,
          test_id: activeTestId,
          event_name: activeTestName,
          status: statusState, // 'testing', 'dashboard', 'offline'
          infraction_count: diskInfo ? diskInfo.infraction_count : 0,
          expires_at: diskInfo ? diskInfo.expires_at : undefined
        });
      }

      // Sort online first, then alphabetical
      sessionsList.sort((a, b) => {
        if (a.status !== 'offline' && b.status === 'offline') return -1;
        if (a.status === 'offline' && b.status !== 'offline') return 1;
        return a.student_id.localeCompare(b.student_id);
      });

      res.json({ sessions: sessionsList });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Force Session Submit
  app.post('/api/admin/sessions/:id/force-submit', adminAuthMiddleware, async (req, res) => {
    const sessionId = req.params.id;
    const session = await readJsonSafe<Session>(`data/sessions/${sessionId}.json`, null);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    session.status = 'submitted';
    session.submitted_at = new Date().toISOString();
    await writeJsonAtomic(`data/sessions/${sessionId}.json`, session);
    
    // Grade and lock
    await evaluateAndSaveResult(session);
    res.json({ success: true });
  });

  // Extend Session +5m
  app.post('/api/admin/sessions/:id/extend', adminAuthMiddleware, async (req, res) => {
    const sessionId = req.params.id;
    const session = await readJsonSafe<Session>(`data/sessions/${sessionId}.json`, null);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const currentExp = new Date(session.expires_at);
    // Add 5 minutes (offset the baseline)
    const expandedExp = new Date(currentExp.getTime() + 5 * 60 * 1000);
    session.expires_at = expandedExp.toISOString();
    if (session.status === 'expired' || session.status === 'auto_submitted') {
      session.status = 'in_progress';
      session.submitted_at = null;
    }
    await writeJsonAtomic(`data/sessions/${sessionId}.json`, session);
    res.json({ success: true, expires_at: session.expires_at });
  });

  // Reset Session
  app.post('/api/admin/sessions/:id/reset', adminAuthMiddleware, async (req, res) => {
    const sessionId = req.params.id;
    const { test_id, student_id } = req.body || {};
    
    // Read the session details if possible
    let session: Session | null = null;
    if (sessionId && sessionId !== 'undefined') {
      session = await readJsonSafe<Session>(`data/sessions/${sessionId}.json`, null);
    }
    
    // Determine target test and student
    let deleteTestId = session?.test_id || test_id;
    let deleteStudentId = session?.student_id || student_id;

    // If we still don't have student/test ID, but we do have a sessionId, try to find it by scanning existing sessions
    if ((!deleteTestId || !deleteStudentId) && sessionId && sessionId !== 'undefined') {
      try {
        const sFiles = await fs.readdir('data/sessions').catch(() => []);
        for (const sf of sFiles) {
          if (sf.endsWith('.json')) {
            const tempSess = await readJsonSafe<Session>(`data/sessions/${sf}`, null);
            if (tempSess && tempSess.session_id === sessionId) {
              deleteTestId = tempSess.test_id;
              deleteStudentId = tempSess.student_id;
              break;
            }
          }
        }
      } catch (e) {}
    }

    // Now, delete the specific sessionId file if it is specified
    if (sessionId && sessionId !== 'undefined') {
      try {
        await fs.unlink(`data/sessions/${sessionId}.json`).catch(() => {});
      } catch (e) {}
    }

    // If we have test_id and student_id, search data/sessions/ and delete ANY session files matching this student and test
    if (deleteTestId && deleteStudentId) {
      try {
        const sFiles = await fs.readdir('data/sessions').catch(() => []);
        for (const sf of sFiles) {
          if (sf.endsWith('.json')) {
            const tempSess = await readJsonSafe<Session>(`data/sessions/${sf}`, null);
            if (tempSess && tempSess.student_id === deleteStudentId && tempSess.test_id === deleteTestId) {
              await fs.unlink(`data/sessions/${sf}`).catch(() => {});
            }
          }
        }
      } catch (e) {}

      // Delete results file
      try {
        await fs.unlink(`data/results/${deleteTestId}/${deleteStudentId}.json`).catch(() => {});
      } catch (e) {}
    } else if (sessionId && sessionId !== 'undefined') {
      // Fallback: If we only have session_id but couldn't resolve test/student IDs, scan results folders to find result with matching session_id
      try {
        const testDirs = await fs.readdir('data/results').catch(() => []);
        for (const tid of testDirs) {
          const files = await fs.readdir(`data/results/${tid}`).catch(() => []);
          for (const f of files) {
            const r = await readJsonSafe<Result>(`data/results/${tid}/${f}`, null);
            if (r && r.session_id === sessionId) {
              await fs.unlink(`data/results/${tid}/${f}`).catch(() => {});
            }
          }
        }
      } catch (e) {}
    }

    res.json({ success: true });
  });

  // Grading endpoints: FRQ queue & MC stats
  app.get('/api/admin/grading/results', adminAuthMiddleware, async (req, res) => {
    try {
      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      const studentsMap = new Map(roster.students.map(s => [s.student_id, s.student_name]));

      const resultsList: any[] = [];
      const testDirs = await fs.readdir('data/results');
      for (const testId of testDirs) {
        const stats = await fs.stat(path.join('data/results', testId));
        if (stats.isDirectory()) {
          const files = await fs.readdir(`data/results/${testId}`);
          for (const file of files) {
            if (file.endsWith('.json')) {
              const resObj = await readJsonSafe<Result>(`data/results/${testId}/${file}`, null);
              if (resObj) {
                // Get general info of test
                const test = await readJsonSafe(`tests/${testId}.json`, null);
                // Count FRQs left to grade
                const totalFrqCount = test?.questions ? test.questions.filter((q: any) => q.type === 'FRQ').length : 0;
                const gradedFrqCount = Object.keys(resObj.frq_grades || {}).length;
                const needsGrading = totalFrqCount > gradedFrqCount;

                resultsList.push({
                  ...resObj,
                  student_name: studentsMap.get(resObj.student_id) || 'Unknown Student',
                  event_name: test?.event_name || testId,
                  needs_grading: needsGrading,
                  total_frq_questions: totalFrqCount,
                  graded_frqs: gradedFrqCount,
                });
              }
            }
          }
        }
      }
      res.json({ results: resultsList });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // FRQ Queue (Ungraded or graded FRQ responses)
  app.get('/api/admin/grading/frqs', adminAuthMiddleware, async (req, res) => {
    try {
      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      const studentsMap = new Map(roster.students.map(s => [s.student_id, s.student_name]));

      const queue: any[] = [];
      // Loop over tests and read their structures
      const testFiles = await fs.readdir('tests');
      for (const tf of testFiles) {
        if (!tf.endsWith('.json')) continue;
        const testId = tf.replace('.json', '');
        const test = await readJsonSafe<Test>(`tests/${tf}`, null);
        if (!test) continue;

        const frqQuestions = test.questions ? test.questions.filter(q => q.type === 'FRQ') : [];
        if (frqQuestions.length === 0) continue;

        // Loop over the results directory for this test
        try {
          const rFiles = await fs.readdir(`data/results/${testId}`);
          for (const rf of rFiles) {
            if (!rf.endsWith('.json')) continue;
            const resObj = await readJsonSafe<Result>(`data/results/${testId}/${rf}`, null);
            if (!resObj) continue;

            // Load the corresponding student saves to extract active student typed response!
            const session = await readJsonSafe<Session>(`data/sessions/${resObj.session_id}.json`, null);
            
            for (const q of frqQuestions) {
              const currentGrade = resObj.frq_grades[q.id];
              const studentResponse = session?.answers[q.id]?.frq_text || '';

              queue.push({
                test_id: testId,
                event_name: test.event_name,
                student_id: resObj.student_id,
                student_name: studentsMap.get(resObj.student_id) || 'Unknown Student',
                session_id: resObj.session_id,
                q_id: q.id,
                number: q.number,
                prompt: q.prompt,
                points: q.points,
                rubric_guide: q.rubric_guide || 'No rubric grading criteria provided.',
                student_response: studentResponse,
                grade: currentGrade || null // Contains { score, notes } or null
              });
            }
          }
        } catch (e) {}
      }
      res.json({ queue });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Submit FRQ Grade
  app.post('/api/admin/grading/grade', adminAuthMiddleware, async (req, res) => {
    const { test_id, student_id, q_id, score, notes } = req.body;
    if (!test_id || !student_id || !q_id || score === undefined) {
      return res.status(400).json({ error: 'Missing required grading parameters' });
    }
    const resultPath = `data/results/${test_id}/${student_id}.json`;
    const resObj = await readJsonSafe<Result>(resultPath, null);
    if (!resObj) {
      return res.status(404).json({ error: 'Student test results not found' });
    }

    // Set structure
    resObj.frq_grades = resObj.frq_grades || {};
    resObj.frq_grades[q_id] = {
      score: Number(score),
      notes: notes || ''
    };

    // Recalculate FRQ total score
    let frqScoreSum = 0;
    Object.values(resObj.frq_grades).forEach(f => {
      frqScoreSum += f.score;
    });

    resObj.frq_score = frqScoreSum;
    resObj.total_score = resObj.mc_score + frqScoreSum;

    await writeJsonAtomic(resultPath, resObj);

    res.json({ success: true, result: resObj });
  });

  // AI Autograde Pending FRQs
  app.post('/api/admin/grading/autograde', adminAuthMiddleware, async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(400).json({ error: 'GEMINI_API_KEY environment variable is not configured. Please add it under Settings > Secrets panel.' });
      }

      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      const studentsMap = new Map(roster.students.map(s => [s.student_id, s.student_name]));

      const pendingItems: any[] = [];
      const testFiles = await fs.readdir('tests');
      for (const tf of testFiles) {
        if (!tf.endsWith('.json')) continue;
        const testId = tf.replace('.json', '');
        const test = await readJsonSafe<Test>(`tests/${tf}`, null);
        if (!test) continue;

        const frqQuestions = test.questions ? test.questions.filter(q => q.type === 'FRQ') : [];
        if (frqQuestions.length === 0) continue;

        try {
          const rFiles = await fs.readdir(`data/results/${testId}`);
          for (const rf of rFiles) {
            if (!rf.endsWith('.json')) continue;
            const resObj = await readJsonSafe<Result>(`data/results/${testId}/${rf}`, null);
            if (!resObj) continue;

            const session = await readJsonSafe<Session>(`data/sessions/${resObj.session_id}.json`, null);

            for (const q of frqQuestions) {
              const currentGrade = resObj.frq_grades ? resObj.frq_grades[q.id] : null;
              // Only grade if not already graded
              if (!currentGrade) {
                const studentResponse = session?.answers[q.id]?.frq_text || '';
                pendingItems.push({
                  testId,
                  studentId: resObj.student_id,
                  qId: q.id,
                  prompt: q.prompt,
                  points: q.points,
                  rubric_guide: q.rubric_guide || 'No grading criteria provided.',
                  student_response: studentResponse,
                  resObj,
                  resultPath: `data/results/${testId}/${rf}`
                });
              }
            }
          }
        } catch (e) {}
      }

      if (pendingItems.length === 0) {
        return res.json({ success: true, graded_count: 0, message: 'All pending essay responses are already graded.' });
      }

      let stats = await getGeminiUsageStats();
      if (stats.left <= 0) {
        return res.status(400).json({ error: `Your simulated Gemini daily token budget is fully depleted (0 tokens left). Grading paused. Under simulation guidelines, this budget resets automatically tomorrow. Alternatively, you can override the limits.` });
      }

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      let gradedCount = 0;
      let limitHitMessage = '';
      
      // Control concurrency to avoid hitting Gemini rate limits (429) when grading bulk submissions
      const chunkSize = 4;
      for (let i = 0; i < pendingItems.length; i += chunkSize) {
        const statsNow = await getGeminiUsageStats();
        if (statsNow.left <= 0) {
          limitHitMessage = 'Daily simulated token limit reached. Remaining items were paused.';
          break;
        }

        const batch = pendingItems.slice(i, i + chunkSize);
        await Promise.all(batch.map(async (item) => {
          try {
            const checkStats = await getGeminiUsageStats();
            const tokenEstimate = estimateFrqTokens(item);
            if (checkStats.left < tokenEstimate) {
              limitHitMessage = `Simulated daily token quota reached (${checkStats.left.toLocaleString()} left, required ~${tokenEstimate.toLocaleString()}). Evaluation paused.`;
              return;
            }

            const response = await ai.models.generateContent({
              model: "gemini-3.5-flash",
              contents: `
                Core Essay Prompt: "${item.prompt}"
                Rubric Guide Criteria: "${item.rubric_guide}"
                Max Points Possible: ${item.points}

                Student Response Draft:
                """
                ${item.student_response}
                """
              `,
              config: {
                systemInstruction: "You are a professional AI test grader. Evaluate the student response against the rubric, scoring from 0 up to max points. Provide a short helpful qualitative note of feedback. Output strictly valid JSON.",
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    score: {
                      type: Type.NUMBER,
                      description: "Awarded points score. Must be between 0 and max points."
                    },
                    notes: {
                      type: Type.STRING,
                      description: "Feedback critique or reason."
                    }
                  },
                  required: ["score", "notes"]
                }
              }
            });

            const rawText = response.text ? response.text.trim() : '';
            if (rawText) {
              let cleanText = rawText;
              if (cleanText.startsWith('```')) {
                cleanText = cleanText.replace(/^```json\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');
              }
              const aiResult = JSON.parse(cleanText);
              let score = Math.max(0, Math.min(item.points, Number(aiResult.score || 0)));
              let notes = aiResult.notes || 'Graded by AI.';

              // Safely write the grade using atomic read-modify-write updater
              await updateJsonSafe<Result>(item.resultPath, (resObj) => {
                if (resObj) {
                  resObj.frq_grades = resObj.frq_grades || {};
                  resObj.frq_grades[item.qId] = {
                    score,
                    notes: `[AI Autograde] ${notes}`
                  };

                  // Recalculate sums
                  let frqScoreSum = 0;
                  Object.values(resObj.frq_grades).forEach((f: any) => {
                    frqScoreSum += f.score;
                  });

                  resObj.frq_score = frqScoreSum;
                  resObj.total_score = resObj.mc_score + frqScoreSum;
                }
                return resObj;
              }, null as any);
              
              const tokensForThisFrq = estimateFrqTokens(item);
              await recordGeminiUsage(tokensForThisFrq);
              gradedCount++;
            }
          } catch (err) {
            console.error('Error autograding item:', err);
          }
        }));

        if (limitHitMessage) {
          break;
        }

        // Give a breath period between batches for rate safety
        if (i + chunkSize < pendingItems.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      const finalStats = await getGeminiUsageStats();
      res.json({
        success: true,
        graded_count: gradedCount,
        message: limitHitMessage || `Successfully evaluated ${gradedCount} short essay response(s) with Gemini AI.`,
        gemini_usage_left: finalStats.left,
        gemini_quota_limit: finalStats.quota_limit,
        estimated_frqs_left: finalStats.estimated_frqs_left
      });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Export Results to CSV: writes 3 CSVs inside data/results/ on disk and downloads as ZIP
  app.get('/api/admin/export/results', adminAuthMiddleware, async (req, res) => {
    try {
      const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
      const studentsMap = new Map(roster.students.map(s => [s.student_id, s.student_name]));
      const allStudentsList = roster.students.map(s => ({ id: s.student_id, name: s.student_name }));

      const allResults: any[] = [];
      const testDirs = await fs.readdir('data/results').catch(() => []);
      const allTestsSet = new Set<string>();

      for (const testId of testDirs) {
        try {
          const stats = await fs.stat(path.join('data/results', testId));
          if (stats.isDirectory()) {
            allTestsSet.add(testId);
            const rFiles = await fs.readdir(`data/results/${testId}`);
            for (const file of rFiles) {
              if (file.endsWith('.json')) {
                const resObj = await readJsonSafe<Result>(`data/results/${testId}/${file}`, null);
                if (resObj) {
                  const test = await readJsonSafe<Test>(`tests/${testId}.json`, null);
                  const session = await readJsonSafe<Session>(`data/sessions/${resObj.session_id}.json`, null);
                  allResults.push({
                    testId,
                    testName: test?.event_name || testId,
                    studentId: resObj.student_id,
                    studentName: studentsMap.get(resObj.student_id) || 'Unknown Student',
                    submittedAt: resObj.submitted_at || '',
                    mcScore: resObj.mc_score,
                    mcTotal: resObj.mc_total,
                    frqScore: resObj.frq_score,
                    frqTotal: resObj.frq_total,
                    totalScore: resObj.total_score,
                    totalPossible: resObj.total_possible,
                    answers: session?.answers || {}
                  });
                }
              }
            }
          }
        } catch (e) {}
      }

      // --- CSV 1: Response Feed ---
      const csv1Rows: string[] = [];
      csv1Rows.push('Student ID,Student Name,Test ID,Test Name,MC Responses,FRQ Responses,Submitted At');
      for (const r of allResults) {
        const mcParts: string[] = [];
        const frqParts: string[] = [];
        Object.entries(r.answers).forEach(([qId, ansObj]: [string, any]) => {
          if (ansObj.selected_mc) {
            mcParts.push(`${qId}:${ansObj.selected_mc}`);
          }
          if (ansObj.frq_text) {
            const cleanText = ansObj.frq_text.replace(/"/g, '""').replace(/\n/g, ' ');
            frqParts.push(`${qId}:${cleanText}`);
          }
        });

        const sName = r.studentName.replace(/"/g, '""');
        const tName = r.testName.replace(/"/g, '""');

        csv1Rows.push([
          r.studentId,
          `"${sName}"`,
          r.testId,
          `"${tName}"`,
          `"${mcParts.join(' | ')}"`,
          `"${frqParts.join(' | ')}"`,
          r.submittedAt
        ].join(','));
      }
      const csv1Content = csv1Rows.join('\n');

      // --- CSV 2: Graded Scores ---
      const csv2Rows: string[] = [];
      csv2Rows.push('Student ID,Student Name,Test ID,Test Name,MC Graded Score,FRQ Graded Score,Total Graded Score,Max Possible Score,Submitted At');
      for (const r of allResults) {
        const sName = r.studentName.replace(/"/g, '""');
        const tName = r.testName.replace(/"/g, '""');
        csv2Rows.push([
          r.studentId,
          `"${sName}"`,
          r.testId,
          `"${tName}"`,
          r.mcScore,
          r.frqScore,
          r.totalScore,
          r.totalPossible,
          r.submittedAt
        ].join(','));
      }
      const csv2Content = csv2Rows.join('\n');

      // --- CSV 3: Analytical Pivot Matrix ---
      const csv3Rows: string[] = [];

      // Get all active tests and their event names
      const testList: { id: string; name: string }[] = [];
      for (const tId of allTestsSet) {
        const testObj = await readJsonSafe<any>(`tests/${tId}.json`, null);
        const tName = testObj?.event_name || tId;
        testList.push({ id: tId, name: tName });
      }

      // Sort tests alphabetically by event name
      testList.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      // Create headers: person, then for each test: [Name] (MC), [Name] (FRQ)
      const headerParts = ['person'];
      for (const t of testList) {
        headerParts.push(`"${t.name.replace(/"/g, '""')} (MC)"`);
        headerParts.push(`"${t.name.replace(/"/g, '""')} (FRQ)"`);
      }
      csv3Rows.push(headerParts.join(','));

      // Sort students alphabetically by name
      const sortedStudents = [...allStudentsList].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      for (const s of sortedStudents) {
        const rowParts = [`"${s.name.replace(/"/g, '""')}"`];
        for (const t of testList) {
          const matchingResult = allResults.find(r => r.testId === t.id && r.studentId === s.id);
          if (matchingResult) {
            const mcScoreStr = (matchingResult.mcScore !== undefined && matchingResult.mcScore !== null) ? String(matchingResult.mcScore) : '';
            const frqScoreStr = (matchingResult.frqScore !== undefined && matchingResult.frqScore !== null) ? String(matchingResult.frqScore) : '';
            rowParts.push(mcScoreStr);
            rowParts.push(frqScoreStr);
          } else {
            rowParts.push('');
            rowParts.push('');
          }
        }
        csv3Rows.push(rowParts.join(','));
      }
      const csv3Content = csv3Rows.join('\n');

      // Write on disk directly into data/results as requested
      await fs.mkdir('data/results', { recursive: true }).catch(() => {});
      await fs.writeFile('data/results/1_student_responses.csv', csv1Content, 'utf-8');
      await fs.writeFile('data/results/2_graded_points.csv', csv2Content, 'utf-8');
      await fs.writeFile('data/results/3_analytical_matrix.csv', csv3Content, 'utf-8');

      // Pack into ZIP to deliver all three cleanly
      const zip = new AdmZip();
      zip.addFile('1_student_responses.csv', Buffer.from(csv1Content, 'utf8'));
      zip.addFile('2_graded_points.csv', Buffer.from(csv2Content, 'utf8'));
      zip.addFile('3_analytical_matrix.csv', Buffer.from(csv3Content, 'utf8'));
      const zipBuffer = zip.toBuffer();

      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="lantern_results_analytics.zip"',
        'Content-Length': zipBuffer.length
      });
      res.send(zipBuffer);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Package Student JSON (strips answers / rubrics for secure package)
  app.get('/api/admin/export/student-package/:testId', adminAuthMiddleware, async (req, res) => {
    try {
      const testId = req.params.testId;
      const test = await readJsonSafe<Test>(`tests/${testId}.json`, null);
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }

      // Strips correct answers and rubric helper guides
      const strippedQuestions = test.questions ? test.questions.map(q => {
        const { correct_mc, rubric_guide, ...rest } = q;
        return rest;
      }) : [];

      const securePackage = {
        ...test,
        questions: strippedQuestions
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="STUDENT_${testId}.json"`);
      res.send(JSON.stringify(securePackage, null, 2));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Backup data/ + tests/ as ZIP Archive download
  app.get('/api/admin/backup', adminAuthMiddleware, async (req, res) => {
    try {
      const zip = new AdmZip();
      
      // Load all test files under tests/
      try {
        const testFiles = await fs.readdir('tests');
        for (const f of testFiles) {
          if (f.endsWith('.json')) {
            const content = await fs.readFile(path.join('tests', f));
            zip.addFile(`tests/${f}`, content);
          }
        }
      } catch (e) {}

      // Add data/ files recursively
      async function addFolderToZip(dir: string, zipPrefix: string) {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const zPath = `${zipPrefix}/${entry.name}`;
            if (entry.isDirectory()) {
              await addFolderToZip(fullPath, zPath);
            } else {
              // skip active temp writes or existing zip back templates
              if (!entry.name.endsWith('.tmp') && !entry.name.endsWith('.zip')) {
                const fContent = await fs.readFile(fullPath);
                zip.addFile(zPath, fContent);
              }
            }
          }
        } catch (e) {}
      }

      await addFolderToZip('data', 'data');

      const zipBuf = zip.toBuffer();
      const backupName = `lan_test_server_backup_${Date.now()}.zip`;
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${backupName}"`,
        'Content-Length': zipBuf.length
      });
      res.send(zipBuf);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Safe RESTORE package upload ZIP as base64 post payload
  app.post('/api/admin/restore', adminAuthMiddleware, async (req, res) => {
    try {
      const { zipBase64 } = req.body;
      if (!zipBase64) {
        return res.status(400).json({ error: 'Missing zip base64 content' });
      }
      const buffer = Buffer.from(zipBase64, 'base64');
      const zip = new AdmZip(buffer);
      
      // Simply extract all to root (will recreate 'tests/' and 'data/' and overwrite)
      zip.extractAllTo('.', true);

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to restore: ' + error.message });
    }
  });


  // --- STUDENT ENDPOINTS ---

  // Student Login ID Check
  app.post('/api/student/login', async (req, res) => {
    const { student_id } = req.body;
    if (!student_id) {
      return res.status(400).json({ error: 'Please enter a Student ID to continue.' });
    }
    const cleanId = student_id.trim();
    const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
    const sObj = roster.students.find(s => s.student_id.toLowerCase() === cleanId.toLowerCase());
    if (!sObj) {
      return res.status(404).json({ error: `Student ID "${cleanId}" not found in current roster.` });
    }

    const config = await retrieveConfig();
    const studentToken = signToken({ student_id: sObj.student_id }, config.jwt_secret);

    res.cookie('student_token', studentToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 4 * 60 * 60 * 1000 // 4 hours
    });

    res.json({ success: true, student_id: sObj.student_id, student_name: sObj.student_name });
  });

  app.post('/api/student/logout', (req, res) => {
    res.clearCookie('student_token');
    res.clearCookie('student_session_token');
    res.json({ success: true });
  });

  // Keep student heartbeat online
  app.post('/api/student/heartbeat', studentAuthMiddleware, (req, res) => {
    const sId = (req as any).student_id;
    const { state, test_id } = req.body;
    onlineStudents.set(sId, {
      lastSeen: Date.now(),
      state: state || 'dashboard',
      test_id: test_id || undefined
    });
    res.json({ success: true });
  });

  // Get current logged-in student assignments and completions
  app.get('/api/student/me', studentAuthMiddleware, async (req, res) => {
    const sId = (req as any).student_id;
    onlineStudents.set(sId, { lastSeen: Date.now(), state: 'dashboard' });
    const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
    const sObj = roster.students.find(s => s.student_id === sId);
    if (!sObj) {
      return res.status(404).json({ error: 'Student profile missing' });
    }

    // Check completed exams
    const activeAssignments: any[] = [];
    for (const testId of sObj.assigned_tests || []) {
      // Is test active?
      const test = await readJsonSafe<Test>(`tests/${testId}.json`, null);
      if (test && test.active) {
        // Is already graded/completed?
        const resultFile = `data/results/${testId}/${sId}.json`;
        let isCompleted = false;
        try {
          await fs.access(resultFile);
          isCompleted = true;
        } catch (e) {}

        // Has active run in-progress session?
        let inProgressSessionId: string | null = null;
        try {
          const files = await fs.readdir('data/sessions');
          for (const rawFile of files) {
            if (rawFile.endsWith('.json')) {
              const sess = await readJsonSafe<Session>(`data/sessions/${rawFile}`, null);
              if (sess && sess.student_id === sId && sess.test_id === testId) {
                if (sess.status === 'in_progress') {
                  const hasExp = new Date() > new Date(sess.expires_at);
                  if (hasExp) {
                    // Auto-submit stale expired session on the fly
                    sess.status = 'auto_submitted';
                    sess.submitted_at = new Date().toISOString();
                    await writeJsonAtomic(`data/sessions/${sess.session_id}.json`, sess);
                    await evaluateAndSaveResult(sess);
                    isCompleted = true; // Since the results file is now generated on disk!
                  } else {
                    inProgressSessionId = sess.session_id;
                  }
                }
                break;
              }
            }
          }
        } catch (e) {}

        activeAssignments.push({
          test_id: testId,
          event_name: test.event_name,
          duration: test.duration,
          is_completed: isCompleted,
          in_progress_session_id: inProgressSessionId,
          instructions: test.instructions || ""
        });
      }
    }

    res.json({
      student_id: sObj.student_id,
      student_name: sObj.student_name,
      lan_ip: getLocalIP(),
      assignments: activeAssignments
    });
  });

  // Create or resume Test Session
  app.post('/api/student/session', studentAuthMiddleware, async (req, res) => {
    const sId = (req as any).student_id;
    const { test_id } = req.body;
    if (!test_id) {
      return res.status(400).json({ error: 'Missing test_id' });
    }

    const roster = await readJsonSafe<Roster>('data/roster.json', { students: [] });
    const isAssigned = roster.students.some(s => s.student_id === sId && (s.assigned_tests || []).includes(test_id));
    if (!isAssigned) {
      return res.status(403).json({ error: 'You are not assigned to take this test.' });
    }

    const test = await readJsonSafe<Test>(`tests/${test_id}.json`, null);
    if (!test || !test.active) {
      return res.status(404).json({ error: 'Assigned test is not actively broadcast.' });
    }

    // Check if result already submitted
    const isCompleted = await fs.access(`data/results/${test_id}/${sId}.json`).then(() => true).catch(() => false);
    if (isCompleted) {
      return res.status(400).json({ error: 'You have already submitted this test.' });
    }

    // Check if session already exists for student + test
    let existingSession: Session | null = null;
    try {
      const sFiles = await fs.readdir('data/sessions');
      for (const sf of sFiles) {
        if (sf.endsWith('.json')) {
          const sess = await readJsonSafe<Session>(`data/sessions/${sf}`, null);
          if (sess && sess.student_id === sId && sess.test_id === test_id) {
            existingSession = sess;
            break;
          }
        }
      }
    } catch(e) {}

    let sessionObj: Session;
    if (existingSession) {
      sessionObj = existingSession;
    } else {
      // Create new session
      const sessId = crypto.randomUUID();
      const started = new Date();
      const durationMs = (test.duration || 30) * 60 * 1000;
      const expires = new Date(started.getTime() + durationMs);

      sessionObj = {
        session_id: sessId,
        student_id: sId,
        test_id: test_id,
        started_at: started.toISOString(),
        expires_at: expires.toISOString(),
        submitted_at: null,
        status: 'in_progress',
        session_token: crypto.randomBytes(16).toString('hex'),
        answers: {}
      };

      await writeJsonAtomic(`data/sessions/${sessId}.json`, sessionObj);
    }

    const config = await retrieveConfig();
    const sessionCookieToken = signToken({ session_id: sessionObj.session_id, student_id: sId }, config.jwt_secret);

    res.cookie('student_session_token', sessionCookieToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 4 * 60 * 60 * 1000 // 4 hours
    });

    res.json({ success: true, session_id: sessionObj.session_id });
  });

  // Get student test session contents (Strips correct_mc & rubric_guide)
  app.get('/api/student/session/:id', async (req, res) => {
    const sessionId = req.params.id;
    const session = await readJsonSafe<Session>(`data/sessions/${sessionId}.json`, null);
    if (!session) {
      return res.status(404).json({ error: 'Session not found. Please log in again.' });
    }

    // Verify ownership via session cookie or allow admin
    const cookies = parseCookies(req);
    const config = await retrieveConfig();
    let isAuthorized = false;

    // Is admin?
    const adminToken = cookies['admin_token'];
    if (adminToken) {
      const aPl = verifyToken(adminToken, config.jwt_secret);
      if (aPl && aPl.admin) isAuthorized = true;
    }

    // Is matching student session cookie?
    const studentSessToken = cookies['student_session_token'];
    if (!isAuthorized && studentSessToken) {
      const sPl = verifyToken(studentSessToken, config.jwt_secret);
      if (sPl && sPl.session_id === sessionId) isAuthorized = true;
    }

    if (!isAuthorized) {
      return res.status(403).json({ error: 'Access denied: Browser secure session hijacked or invalid.' });
    }

    // Handle expiration automatically on-the-fly
    const hasExp = new Date() > new Date(session.expires_at);
    if (session.status === 'in_progress' && hasExp) {
      session.status = 'auto_submitted';
      session.submitted_at = new Date().toISOString();
      await writeJsonAtomic(`data/sessions/${sessionId}.json`, session);
      // Evaluates and locks
      await evaluateAndSaveResult(session);
    }

    // Fetch test questions, STRIPPING confidential properties (correct answers and guides)
    const test = await readJsonSafe<Test>(`tests/${session.test_id}.json`, null);
    if (!test) {
      return res.status(404).json({ error: 'Original test blueprint could not be found.' });
    }

    const strippedQuestions = test.questions ? test.questions.map(q => {
      const { correct_mc, rubric_guide, ...rest } = q;
      return rest;
    }) : [];

    res.json({
      session,
      test: {
        ...test,
        questions: strippedQuestions
      }
    });
  });

  // Student Autosave route
  app.post('/api/student/session/:id/save', async (req, res) => {
    const sessionId = req.params.id;
    const { answers, infraction_count } = req.body;

    const cookies = parseCookies(req);
    const config = await retrieveConfig();

    const studentSessToken = cookies['student_session_token'];
    if (!studentSessToken) {
      return res.status(401).json({ error: 'Authentication missing.' });
    }
    const sPl = verifyToken(studentSessToken, config.jwt_secret);
    if (!sPl || sPl.session_id !== sessionId) {
      return res.status(403).json({ error: 'Action denied. Session hijacked.' });
    }

    const session = await readJsonSafe<Session>(`data/sessions/${sessionId}.json`, null);
    if (!session) {
      return res.status(404).json({ error: 'Session not found on host.' });
    }

    if (session.status !== 'in_progress') {
      return res.status(400).json({ error: 'Test is locked. No longer editing in-progress answers.' });
    }

    const hasExpired = new Date() > new Date(session.expires_at);
    if (hasExpired) {
      session.status = 'auto_submitted';
      session.submitted_at = new Date().toISOString();
      await writeJsonAtomic(`data/sessions/${sessionId}.json`, session);
      await evaluateAndSaveResult(session);
      return res.status(400).json({ error: 'Time has expired. Test closed and auto-submitted.' });
    }

    // Save answers
    session.answers = answers || {};
    if (typeof infraction_count === 'number') {
      session.infraction_count = infraction_count;
    }
    await writeJsonAtomic(`data/sessions/${sessionId}.json`, session);
    res.json({ ok: true });
  });

  // Student Infraction logging route
  app.post('/api/student/session/:id/infraction', async (req, res) => {
    const sessionId = req.params.id;
    const { count } = req.body;

    const cookies = parseCookies(req);
    const config = await retrieveConfig();

    const studentSessToken = cookies['student_session_token'];
    if (!studentSessToken) {
      return res.status(401).json({ error: 'Auth credentials missing.' });
    }
    const sPl = verifyToken(studentSessToken, config.jwt_secret);
    if (!sPl || sPl.session_id !== sessionId) {
      return res.status(403).json({ error: 'Action denied.' });
    }

    await updateJsonSafe<Session>(`data/sessions/${sessionId}.json`, (sess) => {
      if (sess && sess.status === 'in_progress') {
        sess.infraction_count = count;
      }
      return sess;
    }, null as any);

    res.json({ ok: true });
  });

  // Student Manual Submission
  app.post('/api/student/session/:id/submit', async (req, res) => {
    try {
      const sessionId = req.params.id;
      const cookies = parseCookies(req);
      const config = await retrieveConfig();

      const studentSessToken = cookies['student_session_token'];
      if (!studentSessToken) {
        console.error('Manual submit failed: missing student_session_token cookie');
        return res.status(401).json({ error: 'Auth credentials missing. Please refresh and try again.' });
      }
      
      const sPl = verifyToken(studentSessToken, config.jwt_secret);
      if (!sPl || sPl.session_id !== sessionId) {
        console.error(`Manual submit failed: session payload verification failed or mismatched for ${sessionId}`);
        return res.status(403).json({ error: 'Action denied. Invalid identity payload.' });
      }

      const session = await readJsonSafe<Session>(`data/sessions/${sessionId}.json`, null);
      if (!session) {
        console.error(`Manual submit failed: session file data/sessions/${sessionId}.json not found`);
        return res.status(404).json({ error: 'Session not found on disk. Please contact your test supervisor.' });
      }

      if (session.status !== 'in_progress') {
        console.warn(`Manual submit: session ${sessionId} is already in status '${session.status}'`);
        // If it's already submitted or completed, we consider that a success to prevent blocking the interface
        res.clearCookie('student_session_token');
        return res.json({ success: true, message: 'Test already submitted previously.' });
      }

      const hasExpired = new Date() > new Date(session.expires_at);
      session.status = hasExpired ? 'auto_submitted' : 'submitted';
      session.submitted_at = new Date().toISOString();

      await writeJsonAtomic(`data/sessions/${sessionId}.json`, session);

      // Eval and save results state
      await evaluateAndSaveResult(session);

      // Clear submission session cookie
      res.clearCookie('student_session_token');
      res.json({ success: true });
    } catch (err: any) {
      console.error('Core manual submit endpoint error:', err);
      res.status(500).json({ error: err.message || 'An error occurred during submission.' });
    }
  });

  // Email notifications are now dispatched strictly on manual supervisor actions.

  // Helper evaluator & scoring engine
  async function evaluateAndSaveResult(session: Session) {
    try {
      const test = await readJsonSafe<Test>(`tests/${session.test_id}.json`, null);
      if (!test) {
        console.error(`Scoring evaluation failed: test ${session.test_id} not found`);
        return;
      }

      let mcScore = 0;
      let mcTotal = 0;
      let frqTotal = 0;

      const questions = test.questions || [];
      const answersObj = session.answers || {};
      for (const q of questions) {
        if (q.type === 'MC') {
          mcTotal += q.points;
          const studentAns = answersObj[q.id]?.selected_mc;
          if (studentAns && q.correct_mc && studentAns.trim().toUpperCase() === q.correct_mc.trim().toUpperCase()) {
            mcScore += q.points;
          }
        } else {
          frqTotal += q.points;
        }
      }

      // Preserve existing grades if we are re-submitting or overriding
      const resultPath = `data/results/${session.test_id}/${session.student_id}.json`;
      const existingResult = await readJsonSafe<Result>(resultPath, null);
      const frqGrades = existingResult?.frq_grades || {};
      let frqScore = 0;
      Object.values(frqGrades).forEach(g => {
        frqScore += g.score;
      });

      const result: Result = {
        student_id: session.student_id,
        test_id: session.test_id,
        session_id: session.session_id,
        submitted_at: session.submitted_at || new Date().toISOString(),
        mc_score: mcScore,
        mc_total: mcTotal,
        frq_grades: frqGrades,
        frq_score: frqScore,
        frq_total: frqTotal,
        total_score: mcScore + frqScore,
        total_possible: mcTotal + frqTotal,
        infraction_count: session.infraction_count || 0
      };

      await fs.mkdir(`data/results/${session.test_id}`, { recursive: true }).catch(() => {});
      await writeJsonAtomic(resultPath, result);
      console.log(`Saved graded result successfully for Student ${session.student_id}, Test ${session.test_id}`);
    } catch (err) {
      console.error('Error in evaluateAndSaveResult execution:', err);
      throw err;
    }
  }

  // Trigger auto submission for stale expired sessions
  async function triggerAutoSubmission(session: Session) {
    session.status = 'auto_submitted';
    session.submitted_at = new Date().toISOString();
    await writeJsonAtomic(`data/sessions/${session.session_id}.json`, session);
    await evaluateAndSaveResult(session);
  }


  // --- FRONTEND ROUTING INTEGRATION (Vite middleware or SPA Host) ---

  app.get('/testwriter.html', (req, res) => {
    res.sendFile(path.resolve('testwriter.html'));
  });

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist'), {
      maxAge: '1y',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    
    app.use(vite.middlewares);
    
    app.get('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = await fs.readFile(path.resolve('index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  }

  const port = 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`===============================================`);
    console.log(`LAN OFFLINE TEST SERVER running globally!`);
    console.log(`Local Access (Host): http://localhost:${port}`);
    console.log(`Wi-Fi LAN IP Access: http://${getLocalIP()}:${port}`);
    console.log(`===============================================`);
  });
}

async function sendStudentGradeEmail(
  student: Student,
  test: Test,
  session: Session,
  result: Result
): Promise<{ success: boolean; simulated: boolean; info?: string; error?: string }> {
  try {
    const config = await readJsonSafe<any>('data/config.json', {});
    const host = config.smtp_host || '';
    const port = Number(config.smtp_port) || 0;
    const user = config.smtp_user || '';
    const pass = config.smtp_password || '';
    const from = config.smtp_from || '';
    const secure = !!config.smtp_secure;

    const questions = test.questions || [];
    let questionsHtml = '';

    questions.forEach((q, idx) => {
      const ans = session.answers[q.id];
      let studentAnsText = '';
      let correctKeyText = '';
      let statusBg = '';
      let statusText = '';
      let gradePoints = 0;

      if (q.type === 'MC') {
        const isCorrect = q.correct_mc && ans?.selected_mc && q.correct_mc.trim().toUpperCase() === ans.selected_mc.trim().toUpperCase();
        studentAnsText = ans?.selected_mc ? `${ans.selected_mc}. ${q.options?.[ans.selected_mc] || ''}` : 'No Answer Selected';
        correctKeyText = q.correct_mc ? `${q.correct_mc}. ${q.options?.[q.correct_mc] || ''}` : 'N/A';
        gradePoints = isCorrect ? q.points : 0;
        statusBg = isCorrect ? '#ECFDF5' : '#FEF2F2';
        statusText = isCorrect ? 'Correct' : 'Incorrect';
      } else {
        studentAnsText = ans?.frq_text || 'No response';
        correctKeyText = q.rubric_guide || 'N/A';
        if (result.frq_grades?.[q.id]) {
          gradePoints = result.frq_grades[q.id].score;
          statusBg = gradePoints === q.points ? '#ECFDF5' : gradePoints > 0 ? '#FEF3C7' : '#FEF2F2';
          statusText = `Points: ${gradePoints} / ${q.points}`;
        } else {
          gradePoints = 0;
          statusBg = '#F3F4F6';
          statusText = 'Unscored';
        }
      }

      const notes = q.type === 'MC'
        ? (q.correct_mc === ans?.selected_mc ? 'Full Credit Awarded.' : `Incorrect response. Correct Key: ${q.correct_mc}`)
        : (result.frq_grades?.[q.id]?.notes || 'No comments left.');

      questionsHtml += `
        <div style="border: 1px solid #E5E7EB; border-radius: 12px; padding: 16px; margin-bottom: 16px; background-color: #FFFFFF;">
          <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
            <span style="font-weight: bold; font-size: 13px; color: #4B5563; text-transform: uppercase;">Question ${idx + 1} (${q.points} pt${q.points > 1 ? 's' : ''})</span>
            <span style="background-color: ${statusBg}; border: 1px solid #E5E7EB; border-radius: 6px; padding: 2px 8px; font-size: 11px; font-weight: bold; color: #1F2937;">${statusText}</span>
          </div>
          <p style="font-size: 14px; font-weight: bold; color: #111827; margin: 0 0 12px 0;">${q.prompt.replace(/\n/g, '<br/>')}</p>
          <div style="background-color: #F9FAFB; padding: 12px; border-radius: 8px; margin-bottom: 8px;">
            <strong style="font-size: 11px; color: #4B5563; display: block; text-transform: uppercase;">Student response:</strong>
            <p style="font-size: 13px; color: #1F2937; margin: 4px 0 0 0; font-family: monospace;">${studentAnsText.replace(/\n/g, '<br/>')}</p>
          </div>
          <div style="background-color: #FAF5FF; padding: 12px; border-radius: 8px; margin-bottom: 8px;">
            <strong style="font-size: 11px; color: #6B21A8; display: block; text-transform: uppercase;">Answer Key / Grading Rubric:</strong>
            <p style="font-size: 13px; color: #581C87; margin: 4px 0 0 0; font-family: monospace;">${correctKeyText.replace(/\n/g, '<br/>')}</p>
          </div>
          ${notes ? `
          <div style="padding-top: 4px;">
            <strong style="font-size: 11px; color: #4B5563; text-transform: uppercase;">Grader Comments:</strong>
            <p style="font-size: 12px; color: #6B7280; font-style: italic; margin: 2px 0 0 0;">${notes.replace(/\n/g, '<br/>')}</p>
          </div>
          ` : ''}
        </div>
      `;
    });

    const totalScore = result.total_score;
    const totalPossible = result.total_possible;
    const percent = totalPossible > 0 ? Math.round((totalScore / totalPossible) * 100) : 0;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Grade Report for ${test.event_name}</title>
      </head>
      <body style="background-color: #F3F4F6; padding: 40px 16px; margin: 0; font-family: sans-serif; color: #1F2937;">
        <div style="max-width: 650px; margin: 0 auto; background-color: #FFFFFF; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          <div style="background-color: #18181b; padding: 32px 24px; text-align: center; border-bottom: 4px solid #6750A4;">
            <h1 style="color: #FFFFFF; font-size: 20px; font-weight: bold; text-transform: uppercase; margin: 0 0 4px 0; letter-spacing: 1px;">LANtern</h1>
            <span style="color: #A1A1AA; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Science Olympiad Tryouts Exam Portal</span>
          </div>

          <div style="padding: 24px;">
            <div style="text-align: center; margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid #E5E7EB;">
              <p style="font-size: 11px; font-weight: bold; color: #71717A; text-transform: uppercase; margin: 0 0 8px 0; letter-spacing: 1px;">Individual Grade Report</p>
              <h2 style="font-size: 22px; font-weight: bold; color: #18181b; margin: 0 0 4px 0;">${test.event_name}</h2>
              <div style="margin: 16px 0;">
                <span style="display: inline-block; background-color: #F4F4F5; border: 1px solid #E4E4E7; border-radius: 12px; padding: 12px 24px;">
                  <span style="font-size: 40px; font-weight: bold; color: #6750A4; line-height: 1;">${totalScore}</span>
                  <span style="font-size: 18px; font-weight: bold; color: #71717A;">/ ${totalPossible}</span>
                  <span style="display: block; font-size: 11px; font-weight: bold; color: #10B981; margin-top: 4px; text-transform: uppercase;">Score: ${percent}%</span>
                </span>
              </div>
              <p style="font-size: 13px; color: #52525B; margin: 0;">Student: <strong>${student.student_name}</strong> &nbsp;|&nbsp; ID: <strong>${student.student_id}</strong></p>
              ${result.infraction_count && result.infraction_count > 0 ? `
                <p style="font-size: 11px; font-weight: bold; color: #EF4444; margin-top: 8px; text-transform: uppercase;">⚠️ Note: Student departed test window ${result.infraction_count} times during this examination.</p>
              ` : ''}
            </div>

            <h3 style="font-size: 12px; font-weight: bold; color: #71717A; margin: 0 0 16px 0; text-transform: uppercase; letter-spacing: 1px;">Detailed Question Breakdown</h3>
            <div>
              ${questionsHtml}
            </div>

            <div style="background-color: #F4F4F5; border-radius: 12px; padding: 16px; text-align: center; margin-top: 24px; font-size: 11px; color: #71717A; border: 1px dashed #E4E4E7;">
              <p style="margin: 0 0 4px 0;">This email is automatically generated by the LANtern assessment manager.</p>
              <p style="margin: 0;">Scores and rubrics are confidential property of the Tryout coordinators.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    if (!host || !user || !from) {
      // In simulation mode (offline / nonconfigured), write to a local simulation file
      const outboundPath = 'data/outbound-emails.json';
      const queue = await readJsonSafe<any[]>(outboundPath, []);
      queue.push({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        student_id: student.student_id,
        student_name: student.student_name,
        to_email: student.email || `${student.student_id}@example.com`,
        test_id: test.test_id,
        test_name: test.event_name,
        subject: `[LANtern Report] Graded Score: ${test.event_name} - ${student.student_name}`,
        score: `${totalScore}/${totalPossible}`,
        percent: `${percent}%`,
        html: htmlContent
      });
      await writeJsonAtomic(outboundPath, queue);
      return { success: true, simulated: true, info: outboundPath };
    } else {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user,
          pass
        }
      });
      await transporter.sendMail({
        from: `"${test.event_name} Tryouts Room" <${from}>`,
        to: student.email || `${student.student_id}@example.com`,
        subject: `[LANtern] ${test.event_name} Grade Report - ${student.student_name}`,
        html: htmlContent
      });
      return { success: true, simulated: false };
    }
  } catch (err: any) {
    return { success: false, simulated: false, error: err.message || String(err) };
  }
}

startServer();
