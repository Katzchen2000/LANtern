import React, { useState, useEffect, useRef } from 'react';
import { 
  ChevronLeft, ChevronRight, Flag, HelpCircle, Calculator, FileText, Info,
  Check, Volume2, ZoomIn, ZoomOut, ChevronUp, ChevronDown, CheckCircle2, 
  Clock, LogOut, ArrowRight, BookOpen, X, RotateCcw, AlertTriangle, HelpCircle as HelpIcon,
  Play
} from 'lucide-react';
import { Test, Question, Session, SessionAnswer } from '../types';
import { LatexRenderer } from './LatexRenderer';
import { getDirectImageUrl } from '../imageUtils';

interface StudentRunnerProps {
  studentId: string;
  studentName: string;
  onLogout: () => void;
}

type TextSize = 'normal' | 'large' | 'extra';

export default function StudentRunner({ studentId, studentName, onLogout }: StudentRunnerProps) {
  const [assignments, setAssignments] = useState<any[]>([]);
  const [lanIp, setLanIp] = useState<string>('...');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<Session | null>(null);
  const [testData, setTestData] = useState<Test | null>(null);
  const [curQIndex, setCurQIndex] = useState<number>(0);
  const [isReviewScreen, setIsReviewScreen] = useState(false);
  const [isDoneScreen, setIsDoneScreen] = useState(false);
  
  // Timer states
  const [timeLeftStr, setTimeLeftStr] = useState('30:00');
  const [timeUrgent, setTimeUrgent] = useState(false);
  const [isTimerHidden, setIsTimerHidden] = useState(false);
  
  // Accessibility Font Zoom states
  const [textSize, setTextSize] = useState<TextSize>('normal');
  
  // Dialog panel triggers
  const [isReferencesOpen, setIsReferencesOpen] = useState(false);
  const [isCalculatorOpen, setIsCalculatorOpen] = useState(false);
  const [isDirectionsOpen, setIsDirectionsOpen] = useState(false);
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  
  // Calculator States
  const [calcInput, setCalcInput] = useState('');
  const [calcDisplay, setCalcDisplay] = useState('');
  
  // Reference tab state
  const [activeRefTab, setActiveRefTab] = useState<'rules' | 'math' | 'physics' | 'chemistry'>('rules');

  // FRQ Save Status
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  
  // Anti-Cheat / Lockdown States
  const [cheatWarningCount, setCheatWarningCount] = useState(0);
  const [isCheatWarningVisible, setIsCheatWarningVisible] = useState(false);

  // Instruction lobby screen state
  const [selectedInstructionTest, setSelectedInstructionTest] = useState<any | null>(null);

  // Local answers cache for smooth instant edits + debounced save
  const [localAnswers, setLocalAnswers] = useState<Record<string, SessionAnswer>>({});
  const saveTimerRef = useRef<any>(null);

  // Fetch student assignments on enter
  const fetchStudentData = async () => {
    try {
      const res = await fetch('/api/student/me');
      if (res.ok) {
        console.log("[LANtern] Submission success 200 OK");
        const data = await res.json();
        setAssignments(data.assignments || []);
        if (data.lan_ip) {
          setLanIp(data.lan_ip);
        } else {
          setLanIp(window.location.hostname);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchStudentData();

    const runHeartbeat = async () => {
      try {
        await fetch('/api/student/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: (sessionData && !isDoneScreen) ? 'testing' : 'dashboard',
            test_id: (sessionData && !isDoneScreen) ? sessionData.test_id : undefined
          })
        });
      } catch (err) {}
    };

    runHeartbeat();
    const intervalId = setInterval(runHeartbeat, 4000);
    return () => clearInterval(intervalId);
  }, [sessionData, isDoneScreen]);

  // Sync Timer Countdown
  useEffect(() => {
    if (!sessionData || isDoneScreen) return;
    
    // Lockdown Events
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        const sId = sessionData.session_id;
        setCheatWarningCount(prev => {
          const nextVal = prev + 1;
          fetch(`/api/student/session/${sId}/infraction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: nextVal })
          }).catch(() => {});
          return nextVal;
        });
        setIsCheatWarningVisible(true);
      }
    };
    const handleBlur = () => {
      const sId = sessionData.session_id;
      setCheatWarningCount(prev => {
        const nextVal = prev + 1;
        fetch(`/api/student/session/${sId}/infraction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: nextVal })
        }).catch(() => {});
        return nextVal;
      });
      setIsCheatWarningVisible(true);
    };
    const handleContextMenu = (e: MouseEvent) => e.preventDefault();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("contextmenu", handleContextMenu);
    
    const interval = setInterval(() => {
      const expires = new Date(sessionData.expires_at).getTime();
      const now = Date.now();
      const diff = expires - now;
      
      if (diff <= 0) {
        clearInterval(interval);
        setTimeLeftStr('00:00');
        setTimeUrgent(true);
        setIsTimerHidden(false); // force show when expired
        handleAutoSubmit();
      } else {
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        const minsStr = String(mins).padStart(2, '0');
        const secsStr = String(secs).padStart(2, '0');
        setTimeLeftStr(`${minsStr}:${secsStr}`);
        
        const urgent = mins < 5;
        setTimeUrgent(urgent);
        if (urgent && isTimerHidden) {
          setIsTimerHidden(false); // force display if timer runs low
        }
      }
    }, 1000);
    
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [sessionData, isDoneScreen]);

  // Load Session if started
  const handleStartTest = async (testId: string) => {
    try {
      const res = await fetch('/api/student/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_id: testId })
      });
      if (res.ok) {
        const data = await res.json();
        launchSession(data.session_id);
      } else {
        const errorData = await res.json();
        setErrorMessage(errorData.error || 'Failed to initialize session.');
      }
    } catch (e) {
      setErrorMessage('Error connecting to Server.');
    }
  };

  const launchSession = async (sessId: string) => {
    try {
      const res = await fetch(`/api/student/session/${sessId}`);
      if (res.ok) {
        const data = await res.json();
        setSessionData(data.session);
        setTestData(data.test);
        
        let initialAnswers = data.session.answers || {};
        try {
          const localBackupStr = localStorage.getItem(`backup_session_${sessId}`);
          if (localBackupStr) {
            const localBackup = JSON.parse(localBackupStr);
            // Merge local storage answers backup in case of connection losses
            initialAnswers = { ...initialAnswers, ...localBackup };
          }
        } catch (e) {
          console.error("Local answers backup loading error:", e);
        }

        setLocalAnswers(initialAnswers);
        setCheatWarningCount(data.session.infraction_count || 0);
        setActiveSessionId(sessId);
        setCurQIndex(0);
        setIsReviewScreen(false);
        setIsDoneScreen(data.session.status !== 'in_progress');
      }
    } catch (e) {
      setErrorMessage('Failed to load session content.');
    }
  };

  // Debounced Save Answers to Server
  const queueSave = (newAnswers: Record<string, SessionAnswer>) => {
    setSaveStatus('saving');

    // Backup answers synchronously inside localStorage so students never lose progress mid-test
    if (activeSessionId) {
      localStorage.setItem(`backup_session_${activeSessionId}`, JSON.stringify(newAnswers));
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    
    saveTimerRef.current = setTimeout(async () => {
      if (!activeSessionId) return;
      try {
        const res = await fetch(`/api/student/session/${activeSessionId}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: newAnswers })
        });
        if (res.ok) {
          setSaveStatus('saved');
        } else {
          setSaveStatus('error');
        }
      } catch (e) {
        setSaveStatus('error');
      }
    }, 1000);
  };

  const handleSelectMC = (qId: string, choice: string) => {
    const qAns = localAnswers[qId] || {};
    // If choice was crossed out/eliminated, clear it on selecting
    const activeEliminated = (qAns.eliminated || []).filter(c => c !== choice);
    
    const updatedAnswers = {
      ...localAnswers,
      [qId]: { ...qAns, selected_mc: choice, eliminated: activeEliminated }
    };
    setLocalAnswers(updatedAnswers);
    queueSave(updatedAnswers);
  };

  // Click explicit Cross-out icon to strike options
  const handleToggleEliminate = (e: React.MouseEvent, qId: string, choice: string) => {
    e.stopPropagation(); // prevent option selection click
    const qAns = localAnswers[qId] || {};
    const currentElim = qAns.eliminated || [];
    
    let updatedElim;
    if (currentElim.includes(choice)) {
      updatedElim = currentElim.filter(c => c !== choice);
    } else {
      updatedElim = [...currentElim, choice];
    }
    
    // If striking out currently selected answer, clear the select option too
    const nextSelected = qAns.selected_mc === choice ? undefined : qAns.selected_mc;
    
    const updatedAnswers = {
      ...localAnswers,
      [qId]: { ...qAns, selected_mc: nextSelected, eliminated: updatedElim }
    };
    setLocalAnswers(updatedAnswers);
    queueSave(updatedAnswers);
  };

  const handleFRQChange = (qId: string, text: string) => {
    const qAns = localAnswers[qId] || {};
    const updatedAnswers = {
      ...localAnswers,
      [qId]: { ...qAns, frq_text: text }
    };
    setLocalAnswers(updatedAnswers);
    queueSave(updatedAnswers);
  };

  const handleToggleFlag = (qId: string) => {
    const qAns = localAnswers[qId] || {};
    const updatedAnswers = {
      ...localAnswers,
      [qId]: { ...qAns, flagged: !qAns.flagged }
    };
    setLocalAnswers(updatedAnswers);
    queueSave(updatedAnswers);
  };

  const handleAutoSubmit = async () => {
    if (!activeSessionId) return;
    try {
      await fetch(`/api/student/session/${activeSessionId}/submit`, { method: 'POST' });
      localStorage.removeItem(`backup_session_${activeSessionId}`);
      setIsDoneScreen(true);
      setSessionData(null);
      setTestData(null);
      setActiveSessionId(null);
    } catch (e) {
      console.error(e);
    }
  };

  
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const performSubmit = async () => {
    console.log("[LANtern] Attempting performSubmit... for session:", activeSessionId);
    if (!activeSessionId) return;
    
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    
    try {
      const res = await fetch(`/api/student/session/${activeSessionId}/submit`, {
        method: 'POST'
      });
      if (res.ok) {
        localStorage.removeItem(`backup_session_${activeSessionId}`);
        setIsDoneScreen(true);
        setIsNavDrawerOpen(false);
        setShowSubmitConfirm(false);
      } else {
        const errorData = await res.json().catch(() => ({}));
        setErrorMessage(errorData.error ? `Failed to submit: ${errorData.error}` : 'Failed to submit, please contact your test supervisor.');
        setShowSubmitConfirm(false);
      }
    } catch (e) {
      setErrorMessage('Error contacting server during submission.');
      setShowSubmitConfirm(false);
    }
  };

  const renderModals = () => (
    <>
      {showSubmitConfirm && (
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-[#18181B] border border-solid border-[var(--color-outline-variant)] rounded-sm p-6 w-full max-w-sm">
            <h3 className="text-white font-bold text-lg mb-2">Confirm Submission</h3>
            <p className="text-[#A1A1AA] text-sm mb-6">Are you absolutely sure you want to finish and submit your test now? This action cannot be undone.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowSubmitConfirm(false)} className="px-4 py-2 font-semibold text-[#A1A1AA] hover:bg-white/5 rounded-sm text-sm">Cancel</button>
              <button onClick={performSubmit} className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-on-primary-container)] font-semibold text-[var(--color-on-primary)] rounded-sm text-sm">Yes, Submit Test</button>
            </div>
          </div>
        </div>
      )}
      {errorMessage && (
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-[#18181B] border border-solid border-red-900/50 rounded-sm p-6 w-full max-w-sm">
            <h3 className="text-red-400 font-bold text-lg mb-2">System Error</h3>
            <p className="text-[#A1A1AA] text-sm mb-6">{errorMessage}</p>
            <div className="flex justify-end">
              <button onClick={() => setErrorMessage(null)} className="px-4 py-2 bg-red-900/20 hover:bg-red-900/40 text-red-400 font-semibold rounded-sm text-sm">Dismiss</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  const handleManualSubmit = () => {
    setShowSubmitConfirm(true);
  };

  // Calculator input handlers
  const handleCalcBtn = (val: string) => {
    if (val === 'C') {
      setCalcInput('');
      setCalcDisplay('');
    } else if (val === 'del') {
      setCalcInput(prev => prev.slice(0, -1));
    } else if (val === '=') {
      try {
        // Safe evaluation
        let sanitized = calcInput
          .replace(/sin\(/g, 'Math.sin(')
          .replace(/cos\(/g, 'Math.cos(')
          .replace(/tan\(/g, 'Math.tan(')
          .replace(/sqrt\(/g, 'Math.sqrt(')
          .replace(/pi/g, 'Math.PI')
          .replace(/log\(/g, 'Math.log10(')
          .replace(/ln\(/g, 'Math.log(');
        
        // Count unclosed parenthesis
        const openP = (sanitized.match(/\(/g) || []).length;
        const closeP = (sanitized.match(/\)/g) || []).length;
        if (openP > closeP) {
          sanitized += ')'.repeat(openP - closeP);
        }

        const res = Function(`"use strict"; return (${sanitized})`)();
        if (res !== undefined && !isNaN(res)) {
          setCalcDisplay(String(Number(res.toFixed(6))));
        } else {
          setCalcDisplay('Error');
        }
      } catch (err) {
        setCalcDisplay('Error');
      }
    } else {
      setCalcInput(prev => prev + val);
    }
  };

  // Determine prompt font sizing style
  const getPromptFontSize = () => {
    if (textSize === 'large') return 'text-xl leading-relaxed md:text-2xl';
    if (textSize === 'extra') return 'text-2xl leading-loose md:text-3xl';
    return 'text-base md:text-lg leading-relaxed';
  };

  const getOptionFontSize = () => {
    if (textSize === 'large') return 'text-lg';
    if (textSize === 'extra') return 'text-xl';
    return 'text-sm md:text-base';
  };

  const getStartIcon = (iconName?: string) => {
    const formatted = String(iconName || '').trim().toLowerCase();
    switch (formatted) {
      case 'arrow':
      case 'arrowright':
      case 'arrow-right':
        return <ArrowRight size={16} />;
      case 'check':
        return <Check size={16} />;
      case 'checkcircle2':
      case 'check-circle':
        return <CheckCircle2 size={16} />;
      case 'book':
      case 'bookopen':
      case 'book-open':
        return <BookOpen size={16} />;
      case 'info':
        return <Info size={16} />;
      case 'play':
      case 'playcircle':
      default:
        return <Play size={16} className="fill-current" />;
    }
  };

  const currentQuestion: Question | undefined = testData?.questions?.[curQIndex];

  // --- VIEW 1: HOME PLATFORM EXAM BOARD ---
  if (!activeSessionId && !isDoneScreen) {
    return (
      <div id="student-homepage" className="min-h-screen bg-[#09090B] text-[#FAFAFA] flex flex-col font-sans">
        <header className="bg-[#18181B] text-[#FAFAFA] h-[64px] px-6 flex items-center justify-between border-b border-solid border-[var(--color-outline-variant)] select-none">
          <div className="flex items-center gap-3">
            <div>
              <span className="font-extrabold text-base tracking-tight text-white uppercase">LANtern test software</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <span className="text-[10px] text-[#A1A1AA] block font-semibold uppercase tracking-wider">Server IP Address</span>
              <span className="text-sm font-bold text-[var(--color-primary)] font-mono">{lanIp}</span>
            </div>
            <div className="w-[1px] h-6 bg-[#27272A] hidden sm:block" />
            <button 
              onClick={onLogout}
              className="px-3.5 py-1.5 bg-[#27272A] hover:bg-neutral-800 text-white rounded-sm text-xs font-semibold transition-all border border-[#3F3F46]"
            >
              Logout
            </button>
          </div>
        </header>

        {/* Central main lobby body */}
        <main className="flex-1 max-w-4xl w-full mx-auto p-6 md:p-8 space-y-8">
          {selectedInstructionTest ? (
            <div className="space-y-6 max-w-2xl mx-auto">
              {/* Back / Navigation button */}
              <button
                onClick={() => setSelectedInstructionTest(null)}
                className="flex items-center gap-1.5 text-xs font-semibold text-stone-400 hover:text-white transition-colors cursor-pointer"
                id="btn-back-to-tests"
              >
                <ChevronLeft size={14} /> Back to Assigned Sheets
              </button>

              <div className="bg-[#18181B] rounded-sm border border-solid border-[var(--color-outline-variant)] p-6 md:p-8 space-y-6 relative overflow-hidden">
                <div className="space-y-2">
                  <h1 className="text-xl md:text-2xl font-black tracking-tight text-white">
                    {selectedInstructionTest.event_name}
                  </h1>
                  <p className="text-xs text-[#A1A1AA] font-mono">
                    Sheet Code: <span className="font-semibold text-[var(--color-primary)] font-mono">{selectedInstructionTest.test_id}</span>
                  </p>
                </div>

                {/* Instructions section - custom instructions only */}
                {selectedInstructionTest.instructions && selectedInstructionTest.instructions.trim() !== "" && (
                  <div className="space-y-2 pt-4 border-t border-solid border-[var(--color-outline-variant)]/70">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-[#A1A1AA] flex items-center gap-1.5">
                      <FileText size={12} className="text-[var(--color-primary)]" />
                      <span>Instructions & Guidance</span>
                    </h2>
                    <div className="text-xs md:text-sm text-stone-300 leading-relaxed font-sans whitespace-pre-line bg-[#09090B] rounded-sm border border-solid border-[var(--color-outline-variant)] p-4">
                      {selectedInstructionTest.instructions}
                    </div>
                  </div>
                )}

                {/* Bottom Launch Actions */}
                <div className="flex flex-col sm:flex-row items-center justify-end gap-3 pt-4 border-t border-solid border-[var(--color-outline-variant)]">
                  <button
                    onClick={() => setSelectedInstructionTest(null)}
                    className="w-full sm:w-auto px-5 py-2 bg-zinc-900 hover:bg-neutral-805 hover:bg-neutral-800 border border-zinc-800 text-stone-400 hover:text-white rounded-sm font-semibold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                    id="btn-cancel-instructions"
                  >
                    Cancel
                  </button>

                  <button
                    onClick={() => {
                      const testId = selectedInstructionTest.test_id;
                      setSelectedInstructionTest(null);
                      handleStartTest(testId);
                    }}
                    className="w-full sm:w-auto px-6 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary)] text-[var(--color-on-primary)] font-bold rounded-sm text-xs transition-all shadow-md hover:shadow-[var(--color-primary)]/30 hover:-translate-y-0.5 active:translate-y-0 flex items-center justify-center gap-1.5 cursor-pointer"
                    id="btn-start-instructions"
                  >
                    {getStartIcon(selectedInstructionTest.start_icon)}
                    <span>
                      {selectedInstructionTest.in_progress_session_id ? 'Resume Test' : 'Start Test'}
                    </span>
                  </button>
                </div>

              </div>
            </div>
          ) : (
            <>
              <div className="bg-[#18181B] rounded-sm border border-solid border-[var(--color-outline-variant)] p-6 shadow-none">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-black tracking-tight text-white">Welcome back, {studentName}</h1>
                  </div>
                  <div className="bg-[#09090B] px-3.5 py-2 rounded-sm border border-solid border-[var(--color-outline-variant)] self-start sm:self-auto">
                    <p className="text-[9px] font-bold text-[#A1A1AA] uppercase tracking-wider">Candidate Reference</p>
                    <p className="font-mono text-xs font-bold text-[var(--color-primary)] mt-0.5">{studentId}</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                  <BookOpen size={16} className="text-[var(--color-primary)]" />
                  <span>Assigned Question Sheets</span>
                </h2>

                <div className="grid md:grid-cols-2 gap-4">
                  {assignments.length === 0 ? (
                    <div className="col-span-2 bg-[#18181B] rounded-sm border border-solid border-[var(--color-outline-variant)] p-12 text-center flex flex-col items-center">
                      <BookOpen size={40} className="text-[#3F3F46] mb-3" />
                      <h3 className="font-bold text-sm text-white">No active assignments</h3>
                      <p className="text-xs text-[#A1A1AA] max-w-xs mt-1 leading-relaxed">
                        There are currently no assigned tests registered under your ID code.
                      </p>
                      <button 
                        onClick={fetchStudentData} 
                        className="mt-4 px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-on-primary-container)] bg-[var(--color-primary)] text-[var(--color-on-primary)] font-bold rounded-sm text-xs flex items-center gap-1.5 transition-colors"
                      >
                        <RotateCcw size={12} /> Refresh Tests List
                      </button>
                    </div>
                  ) : (
                    assignments.map((test) => (
                      <div 
                        key={test.test_id} 
                        className="bg-[#18181B] rounded-sm border border-solid border-[var(--color-outline-variant)] p-5 shadow-none flex flex-col justify-between hover:border-[#3F3F46] transition-all relative overflow-hidden group"
                      >
                        <div>
                          <div className="flex items-start justify-between mb-3">
                            <span className="font-mono text-[10px] font-bold text-[var(--color-primary)] bg-violet-950/35 px-2.5 py-1 rounded border border-[var(--color-primary)]/40">
                              {test.test_id}
                            </span>
                            {test.is_completed ? (
                              <span className="bg-[#10B981]/10 text-[#10B981] text-[10px] font-bold uppercase py-0.5 px-2.5 rounded-sm border border-[#10B981]/20">
                                Completed
                              </span>
                            ) : test.in_progress_session_id ? (
                              <span className="bg-amber-500/10 text-amber-500 text-[10px] font-bold uppercase py-0.5 px-2.5 rounded-sm animate-pulse border border-amber-500/20">
                                In Progress
                              </span>
                            ) : (
                              <span className="bg-[var(--color-primary)]/10 text-[var(--color-primary)] text-[10px] font-bold uppercase py-0.5 px-2.5 rounded-sm border border-[var(--color-primary)]/20">
                                Available
                              </span>
                            )}
                          </div>
                          
                          <h3 className="font-bold text-white text-base leading-snug mb-1 mt-2">{test.event_name}</h3>
                          <p className="text-xs text-[#A1A1AA] flex items-center gap-1.5 mb-5 font-medium">
                            <Clock size={12} className="text-[#52525B]" /> {test.duration} mins allocation
                          </p>
                        </div>

                        <div className="pt-2">
                          {test.is_completed ? (
                            <button 
                              disabled
                              className="w-full py-2.5 bg-neutral-900 text-neutral-600 rounded-sm font-bold text-[13px] cursor-not-allowed flex items-center justify-center gap-2 border border-neutral-800"
                            >
                              <CheckCircle2 size={14} /> Exam Sealed
                            </button>
                          ) : test.in_progress_session_id ? (
                            <button 
                              onClick={() => setSelectedInstructionTest(test)}
                              className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 text-black rounded-sm font-bold text-[13px] transition-all flex items-center justify-center gap-1.5"
                            >
                              Resume Assessment <ChevronRight size={14} />
                            </button>
                          ) : (
                            <button 
                              onClick={() => setSelectedInstructionTest(test)}
                              className="w-full py-2.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded-sm font-bold text-[13px] transition-all flex items-center justify-center gap-1.5 shadow-md shadow-[var(--color-primary)]/25"
                            >
                              Start Test <ArrowRight size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    );
  }

  // --- VIEW 2: POST SUBMISSION LOGICAL SEALED VIEW ---
  if (isDoneScreen) {
    return (
      <div id="student-submit-done" className="min-h-screen bg-[#09090B] text-white flex flex-col items-center justify-center p-6 text-center font-sans">
        <div className="bg-[#18181B] max-w-md w-full rounded-sm border border-solid border-[var(--color-outline-variant)] p-8 md:p-10 shadow-none flex flex-col items-center space-y-6">
          <div className="w-16 h-16 bg-[#10B981]/15 text-[#10B981] rounded-sm flex items-center justify-center border border-[#10B981]/30">
            <CheckCircle2 size={36} />
          </div>
          
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-white">Submitted!</h1>
            <p className="text-sm text-[#A1A1AA] leading-relaxed max-w-xs mx-auto">
              Your assessment answers and timers were synchronized and recorded successfully.
            </p>
          </div>
          
          <button 
            onClick={async () => {
              await fetchStudentData();
              setIsDoneScreen(false);
              setActiveSessionId(null);
              setSessionData(null);
              setTestData(null);
            }}
            className="w-full py-3.5 bg-white hover:bg-neutral-200 text-black rounded-sm font-bold text-[14px] transition-all"
          >
            Return to Selector
          </button>
        </div>
      </div>
    );
  }

  // --- VIEW 3: AUTHENTICATED BLUEBOOK TESTING SHEET ENGINE ---
  if (testData && sessionData && currentQuestion) {
    const totalQCount = testData.questions.length;
    const qAnswer = localAnswers[currentQuestion.id] || {};
    const isFlagged = !!qAnswer.flagged;

    // A. Review Module Overlay Screen
    if (isReviewScreen) {
      return (
        <div id="student-review-page" className="min-h-screen bg-[#09090B] text-white flex flex-col font-sans select-none animate-fadeIn">
          {renderModals()}
          {/* Top Review Header */}
          <header className="h-[60px] bg-[#18181B] text-[#FAFAFA] px-6 flex items-center justify-between border-b border-solid border-[var(--color-outline-variant)] select-none shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold text-[var(--color-primary)] text-xs uppercase tracking-wider">Review Mode</span>
              <span className="text-white/20 font-bold">|</span>
              <span className="font-bold text-xs font-mono truncate max-w-[200px] md:max-w-xs">{testData.event_name}</span>
            </div>
            
            <div className={`px-4 py-1 rounded-sm font-mono font-bold flex items-center gap-1.5 border leading-none text-xs ${timeUrgent ? 'bg-red-500/10 text-red-405 text-red-400 border-red-500/20 animate-pulse' : 'bg-[#27272A] text-white border-transparent'}`}>
              <Clock size={12} />
              <span>{timeLeftStr}</span>
            </div>

            <div className="text-right text-xs">
              <span className="text-[#A1A1AA] font-mono">{studentId}</span>
            </div>
          </header>

          {/* Review items grid table */}
          <main className="flex-1 max-w-3xl w-full mx-auto p-4 md:p-8 overflow-y-auto space-y-6">
            <div className="bg-[#18181B] rounded-sm border border-solid border-[var(--color-outline-variant)] p-6 shadow-none relative overflow-hidden">
              <div className="mb-6">
                <h2 className="text-xl font-bold text-white tracking-tight animate-slideDown">Review Your Responses</h2>
                <p className="text-xs text-[#A1A1AA] mt-1">Make sure you have answered all available questions before submitting the exam.</p>
              </div>

              {/* Legendary indicators card */}
              <div className="bg-[#09090B] p-4 rounded-sm mb-6 grid grid-cols-3 gap-2 border border-solid border-[var(--color-outline-variant)] text-[11px] text-[#A1A1AA] font-semibold">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-[var(--color-primary)] text-[var(--color-on-primary)] font-bold text-xs flex items-center justify-center">✓</div>
                  <span>Answered</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-[#27272A] text-[#71717A] text-xs flex items-center justify-center border border-[#3F3F46]">•</div>
                  <span>Empty</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-amber-500/10 border border-amber-500/35 text-amber-550 text-amber-500 text-xs flex items-center justify-center">★</div>
                  <span>Flagged</span>
                </div>
              </div>

              {/* Scrollable list map */}
              <div className="border border-solid border-[var(--color-outline-variant)] rounded-sm overflow-hidden bg-[#09090B]">
                <div className="grid grid-cols-12 gap-2 text-[10px] font-bold uppercase text-[#71717A] px-4 py-3 border-b border-solid border-[var(--color-outline-variant)] tracking-wider">
                  <div className="col-span-2 text-center">No.</div>
                  <div className="col-span-2 text-center">Type</div>
                  <div className="col-span-5">Response Status</div>
                  <div className="col-span-3 text-center">Action</div>
                </div>

                <div className="divide-y divide-[#27272A] max-h-96 overflow-y-auto">
                  {testData.questions.map((q, idx) => {
                    const ans = localAnswers[q.id] || {};
                    let statusLabel = <span className="text-red-400 font-medium">Unanswered</span>;
                    let hasAnswerVal = false;
                    
                    if (q.type === 'MC' && ans.selected_mc) {
                      statusLabel = <span className="text-white font-medium">Selected ( {ans.selected_mc} )</span>;
                      hasAnswerVal = true;
                    } else if (q.type === 'FRQ' && ans.frq_text && ans.frq_text.trim().length > 0) {
                      statusLabel = <span className="text-[var(--color-primary)] font-medium truncate">Saved Draft ({ans.frq_text.length} chars)</span>;
                      hasAnswerVal = true;
                    }

                    return (
                      <div key={q.id} className="grid grid-cols-12 gap-2 px-4 py-3 items-center hover:bg-[#18181B]/30 transition-colors select-none text-xs">
                        <div className="col-span-2 text-center">
                          <span className={`w-7 h-7 rounded font-bold inline-flex items-center justify-center relative ${hasAnswerVal ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)]' : 'bg-[#18181B] text-[#71717A] border border-solid border-[var(--color-outline-variant)]'}`}>
                            {q.number}
                            {ans.flagged && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-amber-500 rounded-sm" />}
                          </span>
                        </div>
                        <div className="col-span-2 text-center font-mono font-bold tracking-wider text-[10px] text-zinc-500 uppercase">{q.type}</div>
                        <div className="col-span-5 flex items-center gap-2">
                          {ans.flagged && <Flag size={10} className="text-amber-500 fill-amber-500 shrink-0" />}
                          <span className="font-semibold block truncate max-w-[280px]">{statusLabel}</span>
                        </div>
                        <div className="col-span-3 text-center">
                          <button 
                            onClick={() => {
                              setCurQIndex(idx);
                              setIsReviewScreen(false);
                            }}
                            className="bg-[#27272A] text-white hover:bg-[#3F3F46] font-bold text-xs px-3 py-1 rounded-sm transition-all"
                          >
                            Jump
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Bottom Review command controls */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <button 
                onClick={() => {
                  setCurQIndex(totalQCount - 1);
                  setIsReviewScreen(false);
                }}
                className="w-full sm:w-auto px-5 py-2.5 bg-[#18181B] text-white hover:bg-[#27272A] border border-solid border-[var(--color-outline-variant)] rounded-sm text-xs font-bold transition-all"
              >
                Back To Questions
              </button>

              <button 
                onClick={handleManualSubmit}
                className="w-full sm:w-auto px-6 py-2.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary)] text-[var(--color-on-primary)] font-bold rounded-sm text-xs shadow-none transition-all flex items-center justify-center gap-1.5"
              >
                <CheckCircle2 size={14} /> Submit Final Answers
              </button>
            </div>
          </main>

          {/* --- NON-BLOCKING CHEAT TOAST --- */}
          {isCheatWarningVisible && (
            <div className="fixed bottom-6 right-6 z-50 max-w-sm w-full bg-[#1C1917]/95 border border-amber-600/50 rounded-sm p-4 shadow-none animate-slideUp text-white flex gap-3 items-start select-none">
              <div className="bg-amber-600/10 p-2 rounded-sm text-amber-500 shrink-0 mt-0.5">
                <AlertTriangle size={18} />
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                  <span>Security Flagged</span>
                  <span className="text-[10px] bg-amber-600/20 text-amber-400 px-1.5 py-0.5 rounded font-mono">Count: {cheatWarningCount}</span>
                </h4>
                <p className="text-xs text-stone-300 leading-relaxed">
                  Navigating away from the exam window has been flagged on your proctor's console. Please focus on your exam.
                </p>
                <div className="pt-2">
                  <button 
                    onClick={() => setIsCheatWarningVisible(false)}
                    className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white font-bold text-[10px] rounded-sm transition-all"
                  >
                    Acknowledge
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }    return (
      <div id={`student-test-${activeSessionId}`} className="min-h-screen bg-[var(--color-background)] text-[var(--color-on-background)] flex flex-col select-text font-sans selection:bg-[var(--color-primary-container)] selection:text-[var(--color-on-primary-container)]">
        {renderModals()}
        
        {/* TOP HEADER: Minimal Luminous Dark Header */}
        <header className="h-[60px] bg-[var(--color-surface)] text-[var(--color-on-surface)] px-6 flex items-center justify-between shrink-0 select-none border-b border-[var(--color-surface-container-highest)] shadow-none z-25">
          <div className="flex items-center gap-4">
            <span className="font-mono text-xs font-black tracking-widest text-[var(--color-primary)] uppercase hidden md:inline">LANtern test software</span>
            <div className="h-4 w-[1px] bg-[var(--color-surface-container-highest)] hidden md:inline" />
            <button 
              onClick={() => handleToggleFlag(currentQuestion.id)}
              className={`px-3.5 py-1.5 rounded-[1rem] text-[13px] font-semibold transition-all flex items-center gap-2 select-none border ${isFlagged ? 'bg-[var(--color-secondary-container)] text-[var(--color-on-secondary-container)] border-transparent' : 'bg-transparent hover:bg-[var(--color-surface-container-high)] text-[var(--color-on-surface)] border-[var(--color-outline-variant)]'}`}
              title="Mark for Review"
            >
              <span className="mb-[1px]">Mark for Review</span>
              <Flag size={14} className={isFlagged ? 'fill-current' : ''} />
            </button>
          </div>

          <div className="absolute left-1/2 transform -translate-x-1/2 top-2 flex flex-col items-center">
            {isTimerHidden ? (
               <button 
                onClick={() => setIsTimerHidden(false)}
                className="py-1 px-4 rounded-[1rem] text-[13px] font-bold text-[var(--color-on-surface)] flex items-center gap-2 hover:bg-[var(--color-surface-container-high)] transition-all bg-[var(--color-surface-container)]"
              >
                <Clock size={14} />
                <span>Show Timer</span>
              </button>
            ) : (
              <div className="flex flex-col items-center justify-center">
                <span className={`font-mono text-lg font-bold leading-none ${timeUrgent ? 'text-[var(--color-error)] animate-pulse' : 'text-[var(--color-on-surface)]'}`}>
                  {timeLeftStr}
                </span>
                <div className="flex items-center gap-3 mt-1 text-[11px] font-medium text-[var(--color-on-surface-variant)]">
                  <button onClick={() => {
                    if (timeUrgent) {
                      setErrorMessage('Timer cannot be hidden during the final 5 minutes.');
                      return;
                    }
                    setIsTimerHidden(true);
                  }} className="hover:text-[var(--color-on-surface)]">Hide</button>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 text-[var(--color-on-surface-variant)]">
            <button onClick={() => setIsReviewScreen(true)} className="p-1.5 bg-[#27272A] hover:bg-neutral-800 text-white rounded-sm text-xs font-semibold border border-[#3F3F46]" title="Review All Questions">
              Review List
            </button>
          </div>
        </header>

        {/* DOUBLE WORKSPACE FOR TEST (SPLIT SCREEN) */}
        <div className="flex-1 flex overflow-hidden relative border-b border-[var(--color-surface-container-highest)]">
          
          {/* Left Side: Context / Reading / Prompt */}
          <div className="w-1/2 h-full overflow-y-auto px-8 md:px-12 py-8 border-r border-[#353534] border-solid">
            <div className="text-[16px] leading-[32px] text-[var(--color-on-surface)] font-medium tracking-wide whitespace-pre-wrap select-text mt-1">
              <LatexRenderer text={currentQuestion.prompt} />
            </div>
            {currentQuestion.image_url && (
              <div className="mt-8 flex justify-center border border-[#49454F]/20 rounded-sm overflow-hidden bg-black/10 p-2.5 max-w-full">
                <img 
                  src={getDirectImageUrl(currentQuestion.image_url)} 
                  alt="Question contextual illustration reference" 
                  className="max-h-80 w-auto rounded-sm object-contain shadow-sm"
                  referrerPolicy="no-referrer"
                />
              </div>
            )}
          </div>

          {/* Right Side: Question & Options */}
          <div className="w-1/2 h-full overflow-y-auto px-8 md:px-12 py-8 flex flex-col">
            <div className="text-[15px] font-medium leading-[28px] text-[var(--color-on-surface)] mb-8">
              {currentQuestion.type === 'MC' ? 'Which choice completes the text with the most logical and precise word or phrase?' : 'Provide your response to the prompt below:'}
            </div>

            {/* Multiple choice interactive buttons */}
            {currentQuestion.type === 'MC' && currentQuestion.options && (
              <div className="space-y-4 flex-1">
                {Object.entries(currentQuestion.options).map(([optKey, optText]) => {
                  const isSelected = qAnswer.selected_mc === optKey;
                  const isEliminated = qAnswer.eliminated?.includes(optKey);
                  
                  return (
                    <div 
                      key={optKey}
                      onClick={() => {
                        if (isEliminated) return;
                        handleSelectMC(currentQuestion.id, optKey);
                      }}
                      className={`group rounded-[0.5rem] p-4 flex items-center gap-5 cursor-pointer transition-all border ${isEliminated ? 'opacity-40 border-[var(--color-surface-container-highest)] bg-[var(--color-surface-container-low)] line-through' : isSelected ? 'border-[var(--color-primary)] bg-[var(--color-surface-container-high)]' : 'border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-container)] hover:border-[var(--color-outline)]'}`}
                    >
                      {/* Circle selection badge option A B C D */}
                      <div className={`w-8 h-8 rounded-sm border flex items-center justify-center font-semibold text-[13px] shrink-0 transition-colors select-none ${isSelected ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-[var(--color-on-primary)]' : 'bg-transparent border-[var(--color-outline)] text-[var(--color-on-surface)]'}`}>
                        {optKey}
                      </div>
                      
                      {/* Option description */}
                      <div className={`font-normal select-none flex-1 leading-snug text-[15px] ${isEliminated ? 'text-[var(--color-on-surface-variant)] line-through' : 'text-[var(--color-on-surface)]'}`}>
                        <LatexRenderer text={optText} />
                      </div>

                      {/* Eliminator (strike) icon hover */}
                      <button
                        type="button"
                        onClick={(e) => handleToggleEliminate(e, currentQuestion.id, optKey)}
                        className={`p-1 rounded-sm text-[11px] font-bold transition-all shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-variant)]`}
                        title="Cross out this option"
                      >
                        <s>abc</s>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Essay input area */}
            {currentQuestion.type === 'FRQ' && (
              <div className="flex-1 select-none flex flex-col">
                <textarea
                  value={qAnswer.frq_text || ''}
                  onChange={(e) => handleFRQChange(currentQuestion.id, e.target.value)}
                  placeholder="Type your response here..."
                  className="w-full h-full min-h-[300px] border border-[var(--color-outline-variant)] rounded-[0.5rem] bg-[var(--color-surface-container-low)] p-5 text-[15px] text-[var(--color-on-surface)] focus:outline-none focus:border-[var(--color-primary)] placeholder-[var(--color-on-surface-variant)] resize-y"
                />
              </div>
            )}
          </div>
        </div>

        {/* BOTTOM HEADER BAR */}
        <footer className="h-[72px] bg-[var(--color-surface)] px-6 md:px-8 flex items-center justify-between shrink-0 select-none pb-2 pt-2">
          
          {/* Question Nav Drawer Trigger */}
          <div className="relative">
            <button 
              onClick={() => setIsNavDrawerOpen(!isNavDrawerOpen)}
              className="px-2 py-2 text-[var(--color-on-surface)] font-bold tracking-wide rounded-[0.5rem] text-[15px] flex items-center gap-2 select-none hover:bg-[var(--color-surface-container)] transition-colors"
            >
              <span>Question {currentQuestion.number}</span>
              {isNavDrawerOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
            </button>

            {/* EXPANDED QUESTIONS GRID OVERLAY DRAWER */}
            {isNavDrawerOpen && (
              <div className="absolute bottom-[60px] left-0 w-[300px] bg-[var(--color-surface-container)] border border-[var(--color-outline-variant)] rounded-[1rem] p-4 shadow-none z-40 select-none">
                <div className="flex items-center justify-between mb-3 pb-2">
                  <span className="text-[13px] font-semibold text-[var(--color-on-surface)]">Navigate</span>
                  <button onClick={() => setIsNavDrawerOpen(false)} className="text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]">
                    <X size={16} />
                  </button>
                </div>
                {/* Buttons list Map */}
                <div className="grid grid-cols-5 gap-2 max-h-48 overflow-y-auto pr-1">
                  {testData.questions.map((q, idx) => {
                    const ans = localAnswers[q.id] || {};
                    const isCur = curQIndex === idx;
                    const hasAns = q.type === 'MC' ? !!ans.selected_mc : (ans.frq_text && ans.frq_text.trim().length > 0);
                    const isFl = !!ans.flagged;

                    return (
                      <button
                        key={q.id}
                        onClick={() => {
                          setCurQIndex(idx);
                          setIsNavDrawerOpen(false);
                          setIsReviewScreen(false);
                        }}
                        className={`w-9 h-9 rounded-sm text-[13px] font-bold flex items-center justify-center relative transition-all ${isCur ? 'bg-[var(--color-on-surface)] text-[var(--color-surface)]' : hasAns ? 'bg-[var(--color-primary-container)] text-[var(--color-on-primary-container)]' : 'bg-[var(--color-surface-container-high)] text-[var(--color-on-surface)] hover:bg-[var(--color-surface-variant)]'}`}
                      >
                        {q.number}
                        {isFl && (
                          <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-[var(--color-error)] rounded-sm border-2 border-[var(--color-surface-container)]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
             <button 
              disabled={curQIndex === 0}
              onClick={() => setCurQIndex(curQIndex - 1)}
              className={`px-8 py-2.5 rounded-[1.5rem] font-bold transition-all text-[15px] select-none ${curQIndex === 0 ? 'opacity-0 cursor-not-allowed pointer-events-none' : 'bg-transparent text-[var(--color-on-surface)] hover:bg-[var(--color-surface-container-high)] '}`}
            >
              Back
            </button>
            {curQIndex < totalQCount - 1 ? (
              <button 
                onClick={() => setCurQIndex(curQIndex + 1)}
                className="px-8 py-2.5 bg-[var(--color-on-surface)] hover:bg-[var(--color-inverse-surface)] text-[var(--color-surface)] rounded-[1.5rem] font-bold transition-all text-[15px] select-none"
              >
                Next
              </button>
            ) : (
              <button 
                onClick={() => setIsReviewScreen(true)}
                className="px-6 py-2.5 bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-on-primary)] rounded-[1.5rem] text-[15px] font-bold transition-all select-none"
              >
                Review
              </button>
            )}
          </div>
        </footer>

        {/* --- NON-BLOCKING CHEAT TOAST --- */}
        {isCheatWarningVisible && (
          <div className="fixed bottom-6 right-6 z-50 max-w-sm w-full bg-[#1C1917]/95 border border-amber-600/50 rounded-sm p-4 shadow-none animate-slideUp text-white flex gap-3 items-start select-none">
            <div className="bg-amber-600/10 p-2 rounded-sm text-amber-500 shrink-0 mt-0.5">
              <AlertTriangle size={18} />
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                <span>Security Flagged</span>
                <span className="text-[10px] bg-amber-600/20 text-indigo-400 px-1.5 py-0.5 rounded font-mono">Count: {cheatWarningCount}</span>
              </h4>
              <p className="text-xs text-stone-350 leading-relaxed">
                Navigating away from the exam window has been flagged on your proctor's console. Please focus on your exam.
              </p>
              <div className="pt-2">
                <button 
                  onClick={() => setIsCheatWarningVisible(false)}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white font-bold text-[10px] rounded-sm transition-all"
                >
                  Acknowledge
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-8 text-center bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm m-8">
      <p className="font-bold text-[var(--color-error)] mb-2">Runner Error</p>
      <p className="text-sm text-[var(--color-on-surface-variant)]">Wait, blueprint states have loaded incorrectly.</p>
    </div>
  );
}
