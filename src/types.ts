export interface Question {
  id: string;
  number: number;
  type: 'MC' | 'FRQ';
  prompt: string;
  points: number;
  options?: Record<string, string>;
  correct_mc?: string;
  rubric_guide?: string;

  // Compatibility fields for alternative import/upload formats
  question_number?: number;
  question_type?: 'MC' | 'FRQ';
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  correct_frq_guide?: string | null;
  image_url?: string;
}

export interface Test {
  test_id: string;
  event_name: string;
  duration: number;
  active: boolean;
  questions: Question[];
  instructions?: string;
}

export interface Student {
  student_id: string;
  student_name: string;
  assigned_tests: string[];
  email?: string;
}

export interface Roster {
  students: Student[];
}

export interface SessionAnswer {
  selected_mc?: string;
  eliminated?: string[];
  flagged?: boolean;
  frq_text?: string;
}

export interface Session {
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

export interface FrqGrading {
  score: number;
  notes: string;
}

export interface Result {
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
