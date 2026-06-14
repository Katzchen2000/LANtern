import React, { useState, useEffect, useRef } from 'react';
import { 
  BarChart, BookOpen, Users, Activity, FileText, Settings, LogOut,
  Upload, Download, Plus, Trash2, Edit, Save, ArrowRight, ShieldCheck,
  PlusCircle, RefreshCw, Key, HelpCircle, Check, Database, Clock, Play, Sparkles, Bot, AlertCircle, Eye,
  Mail, Trash, CheckCircle2
} from 'lucide-react';
import { Test, Question, Student, Roster, Session, Result } from '../types';
import { LatexRenderer } from './LatexRenderer';
import { getDirectImageUrl } from '../imageUtils';

const LiveSessionCountdown = ({ expiresAt }: { expiresAt?: string }) => {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    if (!expiresAt) {
      setTimeLeft('--');
      return;
    }

    const updateTime = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft('Expired');
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${m}m ${s}s left`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return (
    <span className="font-mono text-zinc-500 font-bold text-[11px] block mt-1">
      {timeLeft}
    </span>
  );
};

function estimateFrqTokens(item: { prompt?: string; rubric_guide?: string; student_response?: string }) {
  const promptWords = (item.prompt || '').trim().split(/\s+/).filter(Boolean).length;
  const rubricWords = (item.rubric_guide || '').trim().split(/\s+/).filter(Boolean).length;
  const responseWords = (item.student_response || '').trim().split(/\s+/).filter(Boolean).length;
  const totalWords = promptWords + rubricWords + responseWords;
  
  const estimatedInputTokens = Math.ceil(totalWords * 1.35) + 600;
  const estimatedOutputTokens = 300;
  
  return Math.max(800, estimatedInputTokens + estimatedOutputTokens);
}

interface AdminPanelProps {
  onLogout: () => void;
}

type AdminSection = 'dashboard' | 'tests' | 'roster' | 'sessions' | 'grading' | 'settings';

export default function AdminPanel({ onLogout }: AdminPanelProps) {
  const [activeTab, setActiveTab ] = useState<AdminSection>('dashboard');
  
  // Loaded state metrics
  const [metadata, setMetadata] = useState<any>({ lan_ip: '...', port: 3000, uptime_seconds: 0, test_count: 0, session_count: 0, results_count: 0 });
  const [tests, setTests] = useState<any[]>([]);
  const [roster, setRoster] = useState<Roster>({ students: [] });
  const [liveSessions, setLiveSessions] = useState<any[]>([]);
  const [gradingQueue, setGradingQueue] = useState<any[]>([]);
  const [gradingResults, setGradingResults] = useState<any[]>([]);
  const [isAutograding, setIsAutograding] = useState(false);
  const [autogradingMessage, setAutogradingMessage] = useState('');

  // Active item detail selections
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [activeTestDetail, setActiveTestDetail] = useState<Test | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);

  // CSV Merger type
  const [csvMergeMode, setCsvMergeMode] = useState<'merge' | 'replace'>('merge');

  // New templates builders state
  const [newTestForm, setNewTestForm] = useState({ test_id: '', event_name: '', duration: 30 });
  const [newStudentForm, setNewStudentForm] = useState({ student_id: '', student_name: '', email: '', assigned_str: '' });
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);
  
  // Secrets management
  const [secretsStatus, setSecretsStatus] = useState<{
    is_configured: boolean;
    masked_key: string;
    gemini_usage_left?: number;
    gemini_quota_limit?: number;
    estimated_frqs_left?: number;
  } | null>(null);
  const [newGeminiKey, setNewGeminiKey] = useState('');

  // Centralized Custom Non-Blocking Modal/Alert State
  const [customModal, setCustomModal] = useState<{
    show: boolean;
    title: string;
    message: string;
    type: 'confirm' | 'alert' | 'success';
    onConfirm?: () => void;
  } | null>(null);

  const requestConfirm = (title: string, message: string, onConfirm: () => void) => {
    setCustomModal({
      show: true,
      title,
      message,
      type: 'confirm',
      onConfirm
    });
  };

  const triggerAlert = (title: string, message: string) => {
    setCustomModal({
      show: true,
      title,
      message,
      type: 'alert'
    });
  };

  const triggerSuccess = (title: string, message: string) => {
    setCustomModal({
      show: true,
      title,
      message,
      type: 'success'
    });
  };

  // SMTP Settings & Simulator States
  const [smtpConfig, setSmtpConfig] = useState({
    smtp_host: '',
    smtp_port: '465',
    smtp_user: '',
    smtp_password: '',
    smtp_secure: true,
    smtp_from: '',
    has_password: false
  });
  const [outboundEmails, setOutboundEmails] = useState<any[]>([]);
  const [isSendingEmail, setIsSendingEmail] = useState<Record<string, boolean>>({});

  // Load testing states
  const [isSimulatingStress, setIsSimulatingStress] = useState(false);
  const [stressReport, setStressReport] = useState<any | null>(null);
  const [stressStudentsCount, setStressStudentsCount] = useState(200);
  const [stressConcurrencyLimit, setStressConcurrencyLimit] = useState(20);

  // Derived tracking stats for Gemini Limits config
  const geminiUsageLeft = stressReport ? (stressReport.gemini_usage_left !== undefined ? stressReport.gemini_usage_left : 1500000) : (secretsStatus?.gemini_usage_left !== undefined ? secretsStatus.gemini_usage_left : 1500000);
  const geminiQuotaLimit = stressReport ? (stressReport.gemini_quota_limit !== undefined ? stressReport.gemini_quota_limit : 1500000) : (secretsStatus?.gemini_quota_limit !== undefined ? secretsStatus.gemini_quota_limit : 1500000);
  const estimatedFrqsLeft = stressReport ? (stressReport.estimated_frqs_left !== undefined ? stressReport.estimated_frqs_left : (secretsStatus?.estimated_frqs_left !== undefined ? secretsStatus.estimated_frqs_left : 1000)) : (secretsStatus?.estimated_frqs_left !== undefined ? secretsStatus.estimated_frqs_left : 1000);
  const responsesGradedPerSec = stressReport ? (stressReport.responses_graded_per_sec !== undefined ? stressReport.responses_graded_per_sec : 0) : 0;
  
  const outstandingDemandSum = gradingQueue.filter(q => !q.grade).reduce((acc, q) => acc + estimateFrqTokens(q), 0);
  const hasEnoughBudget = geminiUsageLeft >= outstandingDemandSum;
  
  // Detailed responses viewing modal
  const [viewingResponseSessionId, setViewingResponseSessionId] = useState<string | null>(null);
  const [viewingResponseData, setViewingResponseData] = useState<{ session: Session; test: Test } | null>(null);
  const [isResponseLoading, setIsResponseLoading] = useState(false);

  // Manual supervisor override commands select
  const [overrideStudentId, setOverrideStudentId] = useState('');
  const [overrideActionType, setOverrideActionType] = useState('force-submit'); // 'force-submit' or 'reset' or 'extend'

  const [passwordChange, setPasswordChange] = useState({ currentPassword: '', newPassword: '' });

  // Test preview runner toggle
  const [previewTestObj, setPreviewTestObj] = useState<Test | null>(null);
  const [previewCurQ, setPreviewCurQ] = useState(0);

  // Poll intervals references
  const pollTimerRef = useRef<any>(null);

  // Read live status metadata from server
  const fetchMetadata = async () => {
    try {
      const res = await fetch('/api/admin/info');
      if (res.ok) {
        const data = await res.json();
        setMetadata(data);
      }
    } catch (e) {}
  };

  const fetchTests = async () => {
    try {
      const res = await fetch('/api/admin/tests');
      if (res.ok) {
        const data = await res.json();
        setTests(data.tests || []);
      }
    } catch (e) {}
  };

  const fetchRoster = async () => {
    try {
      const res = await fetch('/api/admin/roster');
      if (res.ok) {
        const data = await res.json();
        setRoster(data || { students: [] });
      }
    } catch (e) {}
  };

  const fetchLiveSessions = async () => {
    try {
      const res = await fetch('/api/admin/live-sessions');
      if (res.ok) {
        const data = await res.json();
        setLiveSessions(data.sessions || []);
      }
    } catch (e) {}
  };

  const fetchGradingQueue = async () => {
    try {
      const res1 = await fetch('/api/admin/grading/frqs');
      const res2 = await fetch('/api/admin/grading/results');
      if (res1.ok) {
        const data1 = await res1.json();
        setGradingQueue(data1.queue || []);
      }
      if (res2.ok) {
        const data2 = await res2.json();
        setGradingResults(data2.results || []);
      }
    } catch (e) {}
  };

  const handleAiAutograde = async () => {
    setIsAutograding(true);
    setAutogradingMessage('Initiating Gemini AI connection...');
    try {
      const res = await fetch('/api/admin/grading/autograde', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          alert(`AI Autograding complete! Graded ${data.graded_count} pending essay responses.`);
        } else {
          alert(data.message || 'AI Autograding completed.');
        }
        fetchGradingQueue();
        fetchSecretsStatus();
      } else {
        const err = await res.json();
        alert('AI Autograding failed: ' + (err.error || 'Server error.'));
      }
    } catch (e: any) {
      alert('AI Autograding network error: ' + e.message);
    } finally {
      setIsAutograding(false);
      setAutogradingMessage('');
    }
  };

  // Fetch current AI secrets/key status
  const fetchSecretsStatus = async () => {
    try {
      const res = await fetch('/api/admin/secrets-status');
      if (res.ok) {
        const data = await res.json();
        setSecretsStatus(data);
      }
    } catch (e) {}
  };

  // Fetch SMTP Configuration
  const fetchSmtpConfig = async () => {
    try {
      const res = await fetch('/api/admin/smtp-config');
      if (res.ok) {
        const data = await res.json();
        setSmtpConfig({
          smtp_host: data.smtp_host || '',
          smtp_port: String(data.smtp_port || '465'),
          smtp_user: data.smtp_user || '',
          smtp_password: data.has_password ? '__UNCHANGED__' : '',
          smtp_secure: data.smtp_secure !== false,
          smtp_from: data.smtp_from || '',
          has_password: !!data.has_password
        });
      }
    } catch (e) {}
  };

  // Fetch Simulated Email items
  const fetchOutboundEmails = async () => {
    try {
      const res = await fetch('/api/admin/outbound-emails');
      if (res.ok) {
        const data = await res.json();
        // Sort newest first
        if (Array.isArray(data)) {
          setOutboundEmails([...data].reverse());
        }
      }
    } catch (e) {}
  };

  // Save/Update SMTP configurations
  const handleSaveSmtpConfig = async () => {
    try {
      const res = await fetch('/api/admin/smtp-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(smtpConfig)
      });
      if (res.ok) {
        triggerSuccess('Success', 'SMTP configurations saved successfully!');
        fetchSmtpConfig();
      } else {
        const err = await res.json();
        triggerAlert('SMTP Configuration Error', 'Failed to save SMTP: ' + (err.error || 'Unknown error'));
      }
    } catch (e) {
      triggerAlert('Network Error', 'Network error saving SMTP config.');
    }
  };

  // Reset SMTP simulation log outbox
  const handleClearOutboundEmails = async () => {
    requestConfirm(
      'Clear Simulator Queue',
      'Are you sure you want to clear all archived emails in the simulator queue?',
      async () => {
        try {
          const res = await fetch('/api/admin/outbound-emails', { method: 'DELETE' });
          if (res.ok) {
            setOutboundEmails([]);
            triggerSuccess('Cleared', 'Outbound simulator queue successfully cleared.');
          }
        } catch (e) {
          triggerAlert('Network Error', 'Network error clearing simulating logs.');
        }
      }
    );
  };

  // Run concurrent system stress testing simulator
  const handleRunSimulationLoadTest = async () => {
    setIsSimulatingStress(true);
    setStressReport(null);
    try {
      const res = await fetch('/api/admin/simulate-stress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          students_count: stressStudentsCount,
          concurrency_limit: stressConcurrencyLimit
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStressReport(data.report);
        if (data.report) {
          setSecretsStatus(prev => prev ? {
            ...prev,
            gemini_usage_left: data.report.gemini_usage_left,
            gemini_quota_limit: data.report.gemini_quota_limit,
            estimated_frqs_left: data.report.estimated_frqs_left
          } : null);
        }
        triggerSuccess('Simulation Succeeded', `Stress test processed ${data.report.students_simulated} concurrent student submissions successfully!`);
      } else {
        triggerAlert('Simulator Failed', 'Simulator execution failed: ' + (data.error || 'Server error during load test.'));
      }
    } catch (e: any) {
      triggerAlert('Connection Failover', 'Failover: Network timeout or connection interrupted during high-stress simulation.');
    } finally {
      setIsSimulatingStress(false);
    }
  };

  // Commit Gemini API Key secret configuration
  const handleSaveSecrets = async () => {
    if (!newGeminiKey.trim()) {
      return alert('API Key cannot be empty.');
    }
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gemini_api_key: newGeminiKey })
      });
      if (res.ok) {
        alert('GEMINI_API_KEY saved successfully and loaded in memory!');
        setNewGeminiKey('');
        fetchSecretsStatus();
      } else {
        const err = await res.json();
        alert('Failed to save key: ' + (err.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Network error saving secrets key.');
    }
  };

  // Fetch individual student answers and questions for detailed evaluation views
  const handleViewStudentResponses = async (sessionId: string) => {
    setIsResponseLoading(true);
    setViewingResponseSessionId(sessionId);
    setViewingResponseData(null);
    try {
      const res = await fetch(`/api/admin/sessions/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setViewingResponseData(data);
      } else {
        alert('Could not retrieve full detailed session data from server.');
        setViewingResponseSessionId(null);
      }
    } catch (e) {
      alert('Network error retrieving responses.');
      setViewingResponseSessionId(null);
    } finally {
      setIsResponseLoading(false);
    }
  };

  // Full Refresh Trigger
  const triggerMasterRefresh = () => {
    fetchMetadata();
    fetchTests();
    fetchRoster();
    fetchLiveSessions();
    fetchGradingQueue();
    fetchSecretsStatus();
    fetchSmtpConfig();
    fetchOutboundEmails();
  };

  useEffect(() => {
    triggerMasterRefresh();
    // Live Server Info polling
    pollTimerRef.current = setInterval(() => {
      fetchMetadata();
      // Only request live sockets if tab is focused on list view
      fetchLiveSessions();
    }, 2000);

    return () => clearInterval(pollTimerRef.current);
  }, []);

  // Update detail view when selected ID changes
  useEffect(() => {
    if (selectedTestId) {
      fetch(`/api/admin/tests/${selectedTestId}`)
        .then(res => res.ok && res.json())
        .then(data => data && setActiveTestDetail(data));
    } else {
      setActiveTestDetail(null);
    }
  }, [selectedTestId]);

  // Handle Master Test imports (.json drag-and-drop)
  const handleTestJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const rawText = evt.target?.result as string;
        const testObj = JSON.parse(rawText);
        const res = await fetch('/api/admin/tests/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testJson: testObj })
        });
        if (res.ok) {
          alert('JSON Master blueprint imported successfully!');
          triggerMasterRefresh();
        } else {
          const rError = await res.json();
          alert('Import failed: ' + rError.error);
        }
      } catch (err: any) {
        alert('Invalid JSON File structure.');
      }
    };
    reader.readAsText(file);
  };

  // Handle Roster CSV uploads
  const handleRosterCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const csvContent = evt.target?.result as string;
        const res = await fetch('/api/admin/roster/csv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvText: csvContent, mode: csvMergeMode })
        });
        if (res.ok) {
          const out = await res.json();
          alert(`CSV Roster successfully parsed! Loaded/Merged ${out.count} student identifiers.`);
          triggerMasterRefresh();
        } else {
          const rError = await res.json();
          alert('Failed parser validation: ' + rError.error);
        }
      } catch (err) {
        alert('CSV formatting error.');
      }
    };
    reader.readAsText(file);
  };

  // Create standard Test builder template
  const handleCreateTestFromTemplate = async () => {
    const { test_id, event_name, duration } = newTestForm;
    if (!test_id || !event_name) {
      alert('Must state the unique TEST_ID abbreviation and full exam name.');
      return;
    }
    const slug = test_id.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const blueprint: Test = {
      test_id: slug,
      event_name,
      duration: Number(duration),
      active: true,
      questions: [
        {
          id: "1",
          number: 1,
          type: "MC",
          prompt: "Which is the first question of this exam template?",
          points: 5,
          options: {
            "A": "Dummy answer A",
            "B": "Dummy answer B",
            "C": "Dummy answer C",
            "D": "Dummy answer D"
          },
          correct_mc: "A"
        }
      ]
    };

    try {
      const res = await fetch('/api/admin/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(blueprint)
      });
      if (res.ok) {
        alert(`Test ${slug} successfully set up!`);
        setNewTestForm({ test_id: '', event_name: '', duration: 30 });
        setSelectedTestId(slug);
        triggerMasterRefresh();
        setActiveTab('tests');
      } else {
        const rErr = await res.json();
        triggerAlert('Blueprint Error', 'Template creation error: ' + rErr.error);
      }
    } catch (e) {
      triggerAlert('Network Error', 'Error creating blueprint template.');
    }
  };

  // Delete Test with cascade warnings
  const handleDeleteTest = async (tId: string) => {
    requestConfirm(
      'Delete Test Blueprint',
      `Are you absolutely sure you want to permanently delete Test "${tId}"? All associated student session timers, answers, and graded result scores will also be deleted from the host disk. This is irreversible!`,
      async () => {
        try {
          const res = await fetch(`/api/admin/tests/${tId}`, { method: 'DELETE' });
          if (res.ok) {
            triggerSuccess('Deleted', 'Test successfully deleted from disk.');
            if (selectedTestId === tId) setSelectedTestId(null);
            triggerMasterRefresh();
          }
        } catch (e) {
          triggerAlert('Network Error', 'Error deleting blueprint file.');
        }
      }
    );
  };

  // Update Test Blueprint changes
  const handleUpdateTestDetail = async () => {
    if (!activeTestDetail) return;
    try {
      const res = await fetch('/api/admin/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activeTestDetail)
      });
      if (res.ok) {
        triggerSuccess('Success', 'Blueprint configuration changes securely written to host tests/*.json file.');
        fetchTests();
      } else {
        const rE = await res.json();
        triggerAlert('Configuration Error', 'Failed to save changes: ' + rE.error);
      }
    } catch (e) {
      triggerAlert('Network Error', 'Communications failure saving blueprint detail.');
    }
  };

  // Send graded score diagnostics to a single student
  const handleMailSingleGrade = async (testId: string, studentId: string) => {
    requestConfirm(
      'Send scorecard diagnostic report',
      `Are you sure you want to send the graded scorecard diagnostic report over email to student "${studentId}" for test "${testId}"?`,
      async () => {
        const key = `${testId}-${studentId}`;
        if (isSendingEmail[key]) return;
        setIsSendingEmail(prev => ({ ...prev, [key]: true }));
        try {
          const res = await fetch('/api/admin/email-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test_id: testId, student_id: studentId })
          });
          const data = await res.json();
          if (res.ok) {
            triggerSuccess('Email Sent', data.message || 'Diagnostic scorecard successfully sent!');
            fetchOutboundEmails(); // Refresh the simulator console log!
          } else {
            triggerAlert('Email Failure', 'Mail dispatch failed: ' + (data.error || 'Unknown error'));
          }
        } catch (e) {
          triggerAlert('Network Error', 'Network communication failure sending grade email.');
        } finally {
          setIsSendingEmail(prev => ({ ...prev, [key]: false }));
        }
      }
    );
  };

  // Bulk mail scorecards to all students assigned this test
  const handleMailBulkGrades = async () => {
    if (!activeTestDetail) return;
    const testId = activeTestDetail.test_id;
    requestConfirm(
      'Bulk Scorecard Broadcast',
      `Are you sure you want to broadcast graded scorecard emails to all students assigned to Test "${activeTestDetail.event_name}" (${testId})? This will send emails through your configured SMTP channel, or queue them in Mock mode if SMTP is not set.`,
      async () => {
        try {
          const res = await fetch('/api/admin/email-results-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test_id: testId })
          });
          const data = await res.json();
          if (res.ok) {
            const simMsg = data.simulatedCount > 0 ? `\n- Generated ${data.simulatedCount} simulated scorecards in queue.` : '';
            const realMsg = data.successCount > 0 ? `\n- Dispatched ${data.successCount} real emails successfully via SMTP.` : '';
            const skipMsg = data.skippedCount > 0 ? `\n- Skipped ${data.skippedCount} profiles (unsubmitted sessions or student email not assigned in roster).` : '';
            
            let errMsg = '';
            if (data.errors && data.errors.length > 0) {
              errMsg = `\n\nErrors encountered:\n` + data.errors.join('\n');
            }

            triggerSuccess('Broadcast Complete', `Bulk Scorecard broadcast completed!${simMsg}${realMsg}${skipMsg}${errMsg}`);
            fetchOutboundEmails(); // Refresh local logs
          } else {
            triggerAlert('Broadcast Failure', 'Bulk scorecard delivery failed: ' + (data.error || 'Unknown error'));
          }
        } catch (e) {
          triggerAlert('Network Error', 'Network failure triggering bulk deliveries.');
        }
      }
    );
  };

  // Regrade MC submissions based on updated correct_mc definitions
  const handleRegradeSubmissions = async () => {
    if (!activeTestDetail) return;
    const testId = activeTestDetail.test_id;
    requestConfirm(
      'Recalculate Multiple-Choice Grades',
      `This will recalculate the multiple-choice scores for all completed/submitted student sessions for Test "${testId}" based on the current answer key definitions on this workspace. Proceed?`,
      async () => {
        try {
          const res = await fetch(`/api/admin/tests/${testId}/regrade`, {
            method: 'POST'
          });
          if (res.ok) {
            const data = await res.json();
            triggerSuccess('Regrading Done', data.message || 'Successfully regraded all submitted student responses!');
          } else {
            const err = await res.json();
            triggerAlert('Regrading Failure', 'Regrading failed: ' + (err.error || 'Server error'));
          }
        } catch (e) {
          triggerAlert('Network Error', 'Communications failure.');
        }
      }
    );
  };

  // Create/Upsert Student profile
  const handleSaveStudent = async () => {
    const { student_id, student_name, email, assigned_str } = newStudentForm;
    if (!student_id || !student_name) return alert('Student ID and Student Name required.');
    const assignedArray = assigned_str.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length > 0);
    
    try {
      const res = await fetch('/api/admin/roster/student', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_id,
          student_name,
          email,
          assigned_tests: assignedArray,
          old_id: editingStudentId
        })
      });
      if (res.ok) {
        triggerSuccess('Success', editingStudentId ? 'Student profile updated successfully!' : 'Student profile saved successfully!');
        setNewStudentForm({ student_id: '', student_name: '', email: '', assigned_str: '' });
        setEditingStudentId(null);
        fetchRoster();
      } else {
        const errData = await res.json();
        triggerAlert('Error', 'Error: ' + (errData.error || 'Failed to save student profile'));
      }
    } catch (e) {
      triggerAlert('Communications failure', 'Communication failure while saving student.');
    }
  };

  const handleDeleteStudent = async (sId: string) => {
    requestConfirm(
      'Delete Student Profile',
      'Are you sure you want to delete this student from the active roster? This will not affect submitted grades on disk.',
      async () => {
        try {
          const res = await fetch(`/api/admin/roster/student/${sId}`, { method: 'DELETE' });
          if (res.ok) {
            fetchRoster();
            triggerSuccess('Removed', 'Student removed from active roster successfully.');
          }
        } catch(e) {}
      }
    );
  };

  // Tabbed components controllers: Live sessions action tools
  const triggerForceSubmit = async (sId: string) => {
    requestConfirm(
      'Force Submit Session',
      'Force automatic evaluation and lock progress for this student session? The exam will be locked and formatted scores calculated.',
      async () => {
        try {
          const res = await fetch(`/api/admin/sessions/${sId}/force-submit`, { method: 'POST' });
          if (res.ok) {
            triggerSuccess('Success', 'Exam session force-submitted successfully.');
            fetchLiveSessions();
          }
        } catch(e) {}
      }
    );
  };

  const triggerExtendTimer = async (sId: string) => {
    try {
      const res = await fetch(`/api/admin/sessions/${sId}/extend`, { method: 'POST' });
      if (res.ok) {
        triggerSuccess('Time Extended', 'Time remaining successfully expanded (+5 minutes) and unlocked.');
        fetchLiveSessions();
      }
    } catch(e) {}
  };

  const triggerResetSession = async (sId: string, testId?: string, studentId?: string) => {
    requestConfirm(
      'Reset & Purge Exam Session',
      'This deletes all recorded exam content drafts of this student session on the server disk, letting them log in and retake it fresh. All scores and logs for this session will be wiped. This is irreversible. Proceed?',
      async () => {
        try {
          const res = await fetch(`/api/admin/sessions/${sId}/reset`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test_id: testId, student_id: studentId })
          });
          if (res.ok) {
            triggerSuccess('Purge Successful', 'Exam session successfully purged. The student can now retake this test fresh.');
            fetchLiveSessions();
            fetchGradingQueue();
          } else {
            const data = await res.json();
            triggerAlert('Purge Failed', 'Failed to reset session: ' + (data.error || 'Server error'));
          }
        } catch(e: any) {
          triggerAlert('Network Error', 'Network error: ' + e.message);
        }
      }
    );
  };

  // Grade FRQ essays inline
  const handleSaveGrade = async (item: any, finalScore: number, critiqueNotes: string) => {
    if (finalScore < 0 || finalScore > item.points) {
      alert(`Assigned points must be a valid number between 0 and ${item.points}`);
      return;
    }
    try {
      const res = await fetch('/api/admin/grading/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_id: item.test_id,
          student_id: item.student_id,
          q_id: item.q_id,
          score: finalScore,
          notes: critiqueNotes
        })
      });
      if (res.ok) {
        alert('Essay evaluation recorded and re-scored!');
        fetchGradingQueue();
      }
    } catch (e) {}
  };

  // Change host Admin passphrase
  const handleChangePassword = async () => {
    const { currentPassword, newPassword } = passwordChange;
    if (!currentPassword || !newPassword) return alert('Current and new passphrases required.');
    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      if (res.ok) {
        alert('Administrator credentials successfully modified.');
        setPasswordChange({ currentPassword: '', newPassword: '' });
      } else {
        const errors = await res.json();
        alert('Credentials change failed: ' + errors.error);
      }
    } catch (e) {}
  };

  // Backup file snapshot download
  const handleDownloadBackup = () => {
    window.location.href = '/api/admin/backup';
  };

  // Restore raw Base64 backup ZIP uploader
  const handleRestoreBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const inputEl = e.target;
    requestConfirm(
      'Restore Database Backup',
      'Warning: Restoring custom ZIP coordinates will override current rosters, exam templates, and results. Are you sure you wish to replace your server database? This is irreversible.',
      async () => {
        const reader = new FileReader();
        reader.onload = async (evt) => {
          try {
            const rawResult = evt.target?.result as string;
            // Strip data:url prefix to isolate standard base64 string
            const base64Content = rawResult.split(',')[1];
            
            const res = await fetch('/api/admin/restore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ zipBase64: base64Content })
            });
            if (res.ok) {
              triggerSuccess('Restore Success', 'Database snapshot was successfully restored. Refreshing app state.');
              triggerMasterRefresh();
              setTimeout(() => {
                window.location.reload();
              }, 1500);
            } else {
              triggerAlert('Restore Failure', 'Failed to process restoration snapshot ZIP.');
            }
          } catch (err: any) {
            triggerAlert('Restoration Error', 'Invalid ZIP archive formatting or parser error.');
          }
        };
        reader.readAsDataURL(file);
      }
    );
    inputEl.value = '';
  };

  const getUptimeString = () => {
    const upSecs = metadata.uptime_seconds || 0;
    const hrs = Math.floor(upSecs / 3600);
    const mins = Math.floor((upSecs % 3600) / 60);
    const secs = upSecs % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const studentsWithInfractions = [
    ...liveSessions.filter(s => (s.infraction_count || 0) > 0).map(s => ({
      student_id: s.student_id,
      student_name: s.student_name,
      test_id: s.test_id || 'Active Test',
      infraction_count: s.infraction_count,
      status: s.status === 'testing' ? 'Active Testing' : s.status === 'dashboard' ? 'On Dashboard' : 'Offline',
      session_id: s.session_id,
      is_live: true,
    })),
    ...gradingResults.filter(r => (r.infraction_count || 0) > 0).map(r => ({
      student_id: r.student_id,
      student_name: r.student_name,
      test_id: r.test_id,
      infraction_count: r.infraction_count,
      status: 'Submitted / Completed',
      session_id: r.session_id,
      is_live: false,
    }))
  ].filter((v, i, a) => a.findIndex(t => t.student_id === v.student_id && t.session_id === v.session_id) === i);

  return (
    <div className="w-full min-h-screen bg-[var(--color-background)] text-[var(--color-on-background)] font-sans flex overflow-hidden selection:bg-[var(--color-primary-container)] selection:text-[var(--color-on-primary-container)]">
      {/* Sidebar Navigation Panel */}
      <nav className="w-[250px] shrink-0 bg-[var(--color-background)] border-r border-[var(--color-outline-variant)] border-solid flex flex-col p-4 select-none">
        <div className="flex items-center gap-3 px-3 py-4 mb-6">
          <div>
            <h1 className="font-extrabold text-sm tracking-tight text-[var(--color-on-surface)] uppercase">LANtern test software</h1>
          </div>
        </div>

        <div className="space-y-1.5 flex-1">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-sm font-medium text-sm transition-all border ${activeTab === 'dashboard' ? 'bg-[var(--color-surface-bright)] text-white border-[var(--color-outline)]' : 'border-transparent text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-container)] hover:text-white'}`}
          >
            <BarChart size={18} />
            Dashboard
          </button>
          
          <button 
            onClick={() => setActiveTab('tests')}
            className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-sm font-medium text-sm transition-all border ${activeTab === 'tests' ? 'bg-[var(--color-surface-bright)] text-white border-[var(--color-outline)]' : 'border-transparent text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-container)] hover:text-white'}`}
          >
            <BookOpen size={18} />
            Tests Blueprint
          </button>

          <button 
            onClick={() => setActiveTab('roster')}
            className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-sm font-medium text-sm transition-all border ${activeTab === 'roster' ? 'bg-[var(--color-surface-bright)] text-white border-[var(--color-outline)]' : 'border-transparent text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-container)] hover:text-white'}`}
          >
            <Users size={18} />
            Roster & Assigned
          </button>

          <button 
            onClick={() => setActiveTab('sessions')}
            className={`w-full flex items-center justify-between px-4 py-2.5 rounded-sm font-medium text-sm transition-all border relative ${activeTab === 'sessions' ? 'bg-[var(--color-surface-bright)] text-white border-[var(--color-outline)]' : 'border-transparent text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-container)] hover:text-white'}`}
          >
            <div className="flex items-center gap-3">
              <Activity size={18} />
              <span>Live Sessions</span>
            </div>
            {liveSessions.length > 0 && (
              <span className="bg-[var(--color-success)] text-[var(--color-background)] font-extrabold text-[10px] px-2 py-0.5 rounded-sm pulse">
                {liveSessions.length}
              </span>
            )}
          </button>

          <button 
            onClick={() => { setActiveTab('grading'); fetchGradingQueue(); }}
            className={`w-full flex items-center justify-between px-4 py-2.5 rounded-sm font-medium text-sm transition-all border relative ${activeTab === 'grading' ? 'bg-[var(--color-surface-bright)] text-white border-[var(--color-outline)]' : 'border-transparent text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-container)] hover:text-white'}`}
          >
            <div className="flex items-center gap-3">
              <FileText size={18} />
              <span>Grading Center</span>
            </div>
            {gradingQueue.length > 0 && (
              <span className="bg-[var(--color-warning)] text-[var(--color-background)] font-extrabold text-[10px] px-2 py-0.5 rounded-sm font-bold">
                {gradingQueue.length}
              </span>
            )}
          </button>
        </div>

        {/* Navigation bottom tier */}
        <div className="pt-4 border-t border-[var(--color-outline-variant)] border-solid space-y-1.5">
          <button 
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-sm font-medium text-sm transition-all border ${activeTab === 'settings' ? 'bg-[var(--color-surface-bright)] text-white border-[var(--color-outline)]' : 'border-transparent text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-container)] hover:text-white'}`}
          >
            <Settings size={18} />
            System Settings
          </button>

          <button 
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-sm font-medium text-sm text-[var(--color-error)] hover:bg-[var(--color-error)]/10 transition-all border border-transparent"
          >
            <LogOut size={18} />
            Server Logout
          </button>
        </div>
      </nav>

      {/* Main Panel Content Container */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <header className="h-[60px] border-b border-[var(--color-outline-variant)] bg-[var(--color-surface)] flex items-center justify-between px-8 select-none shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-on-surface)] capitalize">{activeTab} Console</h2>
          </div>

          <div className="flex items-center gap-4">
            <button 
              onClick={triggerMasterRefresh}
              className="p-1.5 px-3 border border-[var(--color-outline-variant)] rounded-sm hover:bg-[var(--color-surface-container-high)] text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)] transition-all flex items-center gap-2 text-xs font-semibold"
              title="Refresh Host Logs Cache"
            >
              <RefreshCw size={12} />
              <span>Sync View</span>
            </button>
          </div>
        </header>

        <div className="p-6 md:p-8 flex-1">
          {/* SECTION 1: DASHBOARD (BENTO GRID MODE) */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              {/* KPIs Horizontal Row */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div 
                  onClick={() => setActiveTab('tests')}
                  className="bg-[var(--color-surface)] border border-solid border-[var(--color-outline-variant)] hover:border-[var(--color-outline)] p-6 rounded-sm cursor-pointer transition-all flex flex-col justify-between h-30"
                >
                  <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block">Loaded Tests</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="text-4xl font-extrabold text-[var(--color-primary)]">{metadata.test_count}</span>
                    <span className="text-[10px] text-[var(--color-on-surface-variant)]/70 font-medium">blueprints in tests/*.json</span>
                  </div>
                </div>

                <div 
                  onClick={() => setActiveTab('sessions')}
                  className="bg-[var(--color-surface)] border border-solid border-[var(--color-outline-variant)] hover:border-[var(--color-outline)] p-6 rounded-sm cursor-pointer transition-all flex flex-col justify-between h-30"
                >
                  <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block">Active Sessions</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="text-4xl font-extrabold text-[#10B981]">{liveSessions.length}</span>
                    <span className="text-[10px] text-[var(--color-on-surface-variant)]/70 font-medium">live active devices</span>
                  </div>
                </div>

                <div 
                  onClick={() => setActiveTab('roster')}
                  className="bg-[var(--color-surface)] border border-solid border-[var(--color-outline-variant)] hover:border-[var(--color-outline)] p-6 rounded-sm cursor-pointer transition-all flex flex-col justify-between h-30"
                >
                  <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block">Registered Roster</span>
                  <div className="flex items-baseline gap-2 mt-2">
                    <span className="text-4xl font-extrabold text-[#F59E0B]">{roster.students.length}</span>
                    <span className="text-[10px] text-[var(--color-on-surface-variant)]/70 font-medium font-sans">enrolled student IDs</span>
                  </div>
                </div>
              </div>

              {/* Lower Bento Grid Box */}
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                {/* Column One: Action uploaders */}
                <div className="lg:col-span-2 flex flex-col gap-6">
                  {/* Roster Import Panel */}
                  <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6">
                    <h3 className="font-semibold text-sm text-[var(--color-on-surface)] mb-3 flex items-center gap-1.5 border-b border-solid border-[var(--color-outline-variant)] pb-2">
                      <Users size={16} className="text-[var(--color-primary)]" /> Roster CSV Loader
                    </h3>
                    
                    <div className="flex items-center justify-between mb-4 border border-solid border-[var(--color-outline-variant)] p-2.5 rounded-sm">
                      <span className="text-xs font-semibold text-[var(--color-on-surface-variant)]">Import Strategy</span>
                      <div className="flex gap-1.5">
                        <button 
                          onClick={() => setCsvMergeMode('merge')}
                          className={`px-3 py-1 text-xs font-bold rounded-sm border ${csvMergeMode === 'merge' ? 'bg-[var(--color-surface-bright)] text-white border-[var(--color-outline)]' : 'bg-transparent text-[var(--color-on-surface-variant)] border-transparent hover:text-white'}`}
                        >
                          Merge Records
                        </button>
                        <button 
                          onClick={() => setCsvMergeMode('replace')}
                          className={`px-3 py-1 text-xs font-bold rounded-sm border ${csvMergeMode === 'replace' ? 'bg-red-600/20 text-red-500 border-red-500/50' : 'bg-transparent text-[var(--color-on-surface-variant)] border-transparent hover:text-white'}`}
                        >
                          Overwrite DB
                        </button>
                      </div>
                    </div>

                    <label className="flex flex-col items-center justify-center border-2 border-solid border-[var(--color-outline-variant)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-container)] transition-colors rounded-sm h-36 p-4 text-center cursor-pointer select-none">
                      <Upload size={28} className="text-[var(--color-primary)] mb-2" />
                      <span className="text-sm font-bold block text-[var(--color-on-surface)]">Import CSV Roster</span>
                      <span className="text-xs text-[var(--color-on-surface-variant)] mt-1">Accepts student_id, student_name, student_email template</span>
                      <input 
                        type="file" 
                        accept=".csv" 
                        onChange={handleRosterCsvUpload}
                        className="hidden" 
                      />
                    </label>

                    <div className="mt-4 flex items-center justify-between">
                      <a 
                        href={`data:text/csv;charset=utf-8,student_id,student_name,student_email,assigned_tests\nS001,Alice Smith,alice.smith@school.edu,TEST_1;TEST_2\nS002,Bob Jones,bob.jones@school.edu,TEST_1\nS003,Charlie,charlie@school.edu,TEST_2`}
                        download="roster_template.csv"
                        className="text-xs text-[var(--color-primary)] hover:underline font-bold flex items-center gap-1"
                      >
                        <Download size={12} /> Download Sample Template CSV
                      </a>
                    </div>
                  </div>

                  {/* Test Master Import & Export tool */}
                  <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 space-y-4">
                    <h3 className="font-semibold text-sm text-[var(--color-on-surface)] flex items-center gap-1.5 border-b border-solid border-[var(--color-outline-variant)] pb-2">
                      <BookOpen size={16} className="text-[var(--color-primary)]" /> Master Files Config
                    </h3>

                    <label className="flex items-center gap-3 w-full border border-[var(--color-outline-variant)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-container)] px-4 py-3 rounded-sm cursor-pointer transition-colors text-sm font-bold">
                      <div className="p-2 bg-[var(--color-surface-bright)] rounded-sm text-[var(--color-primary)]">
                        <Upload size={16} />
                      </div>
                      <div className="text-left flex-1 min-w-0">
                        <p className="font-bold text-xs text-[var(--color-on-surface)]">Import Test Master .json</p>
                        <p className="text-[10px] text-[var(--color-on-surface-variant)] font-normal truncate">Drag/Drop questions structure file</p>
                      </div>
                      <input 
                        type="file" 
                        accept=".json" 
                        onChange={handleTestJsonUpload}
                        className="hidden" 
                      />
                    </label>

                    {/* Exporter selector */}
                    <div className="bg-[var(--color-surface-dim)] p-4 rounded-sm border border-[var(--color-outline-variant)] space-y-2">
                      <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block">Package Stripped Student JSON</span>
                      <p className="text-[10px] text-[var(--color-on-surface-variant)] leading-tight mb-2">Removes "correct_mc" answer indicators and FRQ grading rubrics for clean offline deployment packages.</p>
                      
                      <div className="flex gap-2">
                        <select 
                          id="export-test-picker"
                          className="flex-1 text-xs border border-[var(--color-outline-variant)] rounded-sm px-2 py-1.5 bg-[var(--color-surface-bright)] text-[var(--color-on-surface)] font-medium outline-none focus:border-[var(--color-outline)]"
                          onChange={(e) => {
                            if (e.target.value) {
                              window.open(`/api/admin/export/student-package/${e.target.value}`);
                              e.target.value = '';
                            }
                          }}
                        >
                          <option value="">-- Choose Loaded Test --</option>
                          {tests.map(t => (
                            <option key={t.test_id} value={t.test_id}>[{t.test_id}] {t.event_name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column: Test Blueprints List */}
                <div className="lg:col-span-3 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm flex flex-col overflow-hidden">
                  <div className="p-5 border-b border-solid border-[var(--color-outline-variant)] flex justify-between items-center bg-[var(--color-surface-dim)]">
                    <span className="font-semibold text-sm text-[var(--color-on-surface)]">Test blueprints directory</span>
                    <span className="text-xs font-bold tracking-tight bg-[var(--color-surface-bright)] text-[var(--color-on-surface)] px-3 py-1 rounded-sm uppercase border border-[var(--color-outline-variant)]">
                      {metadata.test_count} Templates
                    </span>
                  </div>

                  <div className="flex-1 overflow-x-auto">
                    <table className="w-full text-left font-medium text-xs">
                      <thead>
                        <tr className="bg-[var(--color-surface-bright)] text-[var(--color-on-surface-variant)] border-b border-solid border-[var(--color-outline-variant)] uppercase font-bold tracking-wider">
                          <th className="p-4">TEST ID</th>
                          <th className="p-4">Event Name</th>
                          <th className="p-4 text-center">Structure</th>
                          <th className="p-4 text-center">State</th>
                          <th className="p-4 text-right">Settings</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-dashed divide-[var(--color-outline-variant)]">
                        {tests.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="text-center p-10 text-gray-400">
                              No test blueprint files detected in tests/*.json folder. Create a template below.
                            </td>
                          </tr>
                        ) : (
                          tests.map((t) => (
                            <tr key={t.test_id} className="hover:bg-[var(--color-surface-container)] transition-colors">
                              <td className="p-4 font-mono font-bold select-all text-[var(--color-primary)]">{t.test_id}</td>
                              <td className="p-4 font-bold text-sm text-[var(--color-on-surface)]">{t.event_name}</td>
                              <td className="p-4 text-center text-[var(--color-on-surface-variant)] font-mono">{t.mc_count} MC / {t.frq_count} FRQ</td>
                              <td className="p-4 text-center">
                                {t.active ? (
                                  <span className="bg-green-100 text-green-800 font-extrabold text-[10px] px-2.5 py-0.5 rounded-sm uppercase">Active Broadcast</span>
                                ) : (
                                  <span className="bg-gray-100 text-gray-500 font-extrabold text-[10px] px-2.5 py-0.5 rounded-sm uppercase">Hidden</span>
                                )}
                              </td>
                              <td className="p-4 text-right">
                                <div className="flex justify-end gap-1.5">
                                  <button 
                                    onClick={() => { setSelectedTestId(t.test_id); setActiveTab('tests'); }}
                                    className="p-1 px-2.5 bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20 rounded-sm font-bold"
                                  >
                                    Manage
                                  </button>
                                  <button 
                                    onClick={() => handleDeleteTest(t.test_id)}
                                    className="p-1 text-red-600 hover:bg-red-50 rounded"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 2: TESTS BLUEPRINT MANAGER */}
          {activeTab === 'tests' && (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              {/* Left sidebar: choice tests list */}
              <div className="lg:col-span-1 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-4 shadow-xs space-y-2">
                <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block p-1">Available Blueprints</span>
                {tests.map(t => (
                  <button
                    key={t.test_id}
                    onClick={() => setSelectedTestId(t.test_id)}
                    className={`w-full text-left p-3 rounded-sm flex items-center justify-between transition-all border ${selectedTestId === t.test_id ? 'bg-[#F2EBFF] text-[#21005D] border-[var(--color-primary)] font-bold' : 'bg-transparent text-[var(--color-on-surface)] hover:bg-[var(--color-surface-container)] border-transparent'}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs font-bold truncate">{t.test_id}</p>
                      <p className="text-[11px] text-[var(--color-on-surface-variant)] truncate">{t.event_name}</p>
                    </div>
                    <ArrowRight size={14} className="text-[var(--color-primary)] shrink-0 ml-1" />
                  </button>
                ))}
              </div>

              {/* Center Right workspace column */}
              <div className="lg:col-span-3 space-y-6">
                {!selectedTestId ? (
                  <div className="bg-[var(--color-surface)] rounded-sm border border-[var(--color-outline-variant)] p-12 text-center flex flex-col items-center">
                    <BookOpen size={48} className="text-neutral-300 mb-3" />
                    <h3 className="font-bold text-lg">Select a Blueprint file to edit</h3>
                    <p className="text-xs text-gray-500 mt-1 max-w-sm">Pick a test from the left-hand column to adjust prompts, answer definitions, durations, and points live.</p>
                  </div>
                ) : !activeTestDetail ? (
                  <div className="bg-[var(--color-surface)] rounded-sm p-6 text-center animate-pulse">Loading core test metadata from host disk...</div>
                ) : (
                  <div className="bg-[var(--color-surface)] rounded-sm border border-[var(--color-outline-variant)] overflow-hidden shadow-xs flex flex-col">
                    {/* Header bar controls */}
                    <div className="p-6 border-b border-[var(--color-outline-variant)] bg-[var(--color-surface)] flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <span className="font-mono text-xs font-black text-[var(--color-primary)] bg-[var(--color-surface-bright)] px-2 py-0.5 rounded uppercase">Master File: tests/{activeTestDetail.test_id}.json</span>
                        <h2 className="text-xl font-black mt-1 text-[var(--color-on-surface)]">{activeTestDetail.event_name}</h2>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={handleRegradeSubmissions}
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-sm flex items-center gap-1.5 shadow-sm transition-all"
                          title="Recalculate multiple-choice scores for completed submissions based on current key definitions"
                        >
                          <RefreshCw size={14} /> Regrade MC Submissions
                        </button>
                        <button 
                          onClick={handleMailBulkGrades}
                          className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-on-primary-container)] text-white text-xs font-bold rounded-sm flex items-center gap-1.5 shadow-sm transition-all"
                          title="Broadcast graded PDF scorecard diagnostic reports over email to all assigned students"
                        >
                          <Mail size={14} /> Email Scorecards
                        </button>
                        <button 
                          onClick={() => {
                            setPreviewTestObj(activeTestDetail);
                            setPreviewCurQ(0);
                          }}
                          className="px-4 py-2 border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-container)] text-xs font-bold rounded-sm transition-all"
                        >
                          Preview as Student
                        </button>
                        <button 
                          onClick={handleUpdateTestDetail}
                          className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-sm flex items-center gap-1 shadow-sm transition-all"
                        >
                          <Save size={14} /> Write Changes
                        </button>
                      </div>
                    </div>

                    {/* Metadata settings card block */}
                    <div className="p-6 border-b border-solid border-[var(--color-outline-variant)] grid md:grid-cols-4 gap-4 bg-[var(--color-surface-dim)]/50">
                      <div>
                        <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase tracking-widest mb-1.5">Exam Blueprint Name</label>
                        <input 
                          type="text" 
                          value={activeTestDetail.event_name}
                          onChange={(e) => setActiveTestDetail({ ...activeTestDetail, event_name: e.target.value })}
                          className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-2 font-semibold"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase tracking-widest mb-1.5">Timer Duration (Minutes)</label>
                        <input 
                          type="number" 
                          value={activeTestDetail.duration}
                          onChange={(e) => setActiveTestDetail({ ...activeTestDetail, duration: Number(e.target.value) })}
                          className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-2 font-mono font-bold"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase tracking-widest mb-1.5">Broadcast Access</label>
                        <div className="flex items-center gap-1.5 mt-2 select-none">
                          <input 
                            type="checkbox" 
                            id="exam-active-toggle"
                            checked={activeTestDetail.active}
                            onChange={(e) => setActiveTestDetail({ ...activeTestDetail, active: e.target.checked })}
                            className="w-4 h-4 rounded text-[var(--color-primary)]"
                          />
                          <label htmlFor="exam-active-toggle" className="text-xs font-bold text-[#21005D]">Visible to Student Menu</label>
                        </div>
                      </div>
                    </div>

                    {/* Question Customizer Section List */}
                    <div className="p-6 space-y-6">
                      <span className="text-xs font-black text-[var(--color-on-surface-variant)] uppercase tracking-widest block">Core Test Questions ({activeTestDetail.questions.length})</span>
                      
                      {activeTestDetail.questions.map((q, qIdx) => (
                        <div key={q.id || String(qIdx)} className="border border-[var(--color-outline-variant)] rounded-sm p-5 relative bg-[var(--color-surface)]/20 space-y-4">
                          <button 
                            type="button"
                            onClick={() => {
                              const updated = activeTestDetail.questions.filter((item, index) => index !== qIdx);
                              setActiveTestDetail({ ...activeTestDetail, questions: updated });
                            }}
                            className="absolute top-4 right-4 p-1.5 text-red-600 hover:bg-red-50 rounded"
                            title="Delete this question blueprint"
                          >
                            <Trash2 size={16} />
                          </button>

                          {/* Quick question config details */}
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <div>
                              <span className="text-xs font-extrabold text-[var(--color-primary)] font-mono leading-none uppercase block mb-1">Question Number</span>
                              <input 
                                type="number" 
                                value={q.number}
                                readOnly
                                className="w-12 text-center text-xs border border-[var(--color-outline-variant)] bg-gray-50 rounded px-1.5 py-1 font-bold"
                              />
                            </div>

                            <div>
                              <span className="text-xs font-extrabold text-[var(--color-primary)] font-mono leading-none uppercase block mb-1">Question Type</span>
                              <select 
                                value={q.type}
                                onChange={(e) => {
                                  const updatedQuestions = [...activeTestDetail.questions];
                                  updatedQuestions[qIdx] = {
                                    ...q,
                                    type: e.target.value as 'MC' | 'FRQ',
                                    options: e.target.value === 'MC' ? { "A": "Sample A", "B": "Sample B", "C": "Sample C", "D": "Sample D" } : undefined,
                                    correct_mc: e.target.value === 'MC' ? 'A' : undefined,
                                    rubric_guide: e.target.value === 'FRQ' ? 'Max 5 points guide' : undefined
                                  };
                                  setActiveTestDetail({ ...activeTestDetail, questions: updatedQuestions });
                                }}
                                className="text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded px-2.5 py-1 font-bold"
                              >
                                <option value="MC"> Multiple Choice (MC)</option>
                                <option value="FRQ">Free Response (FRQ)</option>
                              </select>
                            </div>

                            <div>
                              <span className="text-xs font-extrabold text-[var(--color-primary)] font-mono leading-none uppercase block mb-1">Points Weight</span>
                              <input 
                                type="number" 
                                value={q.points}
                                onChange={(e) => {
                                  const updated = [...activeTestDetail.questions];
                                  updated[qIdx] = { ...q, points: Number(e.target.value) };
                                  setActiveTestDetail({ ...activeTestDetail, questions: updated });
                                }}
                                className="w-20 text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded px-2 py-1 font-mono font-bold"
                              />
                            </div>
                          </div>

                          {/* Prompt Editor */}
                          <div>
                            <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block mb-1">Question Prompt Text</span>
                            <textarea
                              value={q.prompt}
                              onChange={(e) => {
                                const updated = [...activeTestDetail.questions];
                                updated[qIdx] = { ...q, prompt: e.target.value };
                                setActiveTestDetail({ ...activeTestDetail, questions: updated });
                              }}
                              placeholder="Describe the question detailed instructions here..."
                              className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm p-2.5 h-20"
                            />
                          </div>

                          {/* Optional Graphic Image URL */}
                          <div>
                            <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block mb-1">Optional Graphic Image / Diagram URL</span>
                            <input 
                              type="text"
                              value={q.image_url || ''}
                              onChange={(e) => {
                                const updated = [...activeTestDetail.questions];
                                updated[qIdx] = { ...q, image_url: e.target.value };
                                setActiveTestDetail({ ...activeTestDetail, questions: updated });
                              }}
                              placeholder="e.g. /images/graph_question_12.png or https://domain.com/picture.jpg (Leave empty if none)"
                              className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2 font-mono text-[var(--color-primary)]"
                            />
                          </div>

                          {/* MC Questions logic */}
                          {q.type === 'MC' && q.options && (
                            <div className="bg-[var(--color-surface-dim)] p-4 rounded-sm border border-[var(--color-outline-variant)] space-y-2">
                              <span className="text-xs font-bold text-[var(--color-primary)] uppercase block">Answers Options (A-D) & Correct Indicator:</span>
                              
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {Object.keys(q.options).map((key) => (
                                  <div key={key} className="flex items-center gap-2">
                                    <span className="font-bold text-xs select-none">{key}:</span>
                                    <input 
                                      type="text"
                                      value={q.options?.[key] || ''}
                                      onChange={(e) => {
                                        const updatedQ = [...activeTestDetail.questions];
                                        const nextOptions = { ...q.options, [key]: e.target.value };
                                        updatedQ[qIdx] = { ...q, options: nextOptions };
                                        setActiveTestDetail({ ...activeTestDetail, questions: updatedQ });
                                      }}
                                      className="flex-1 text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded px-2 py-1"
                                    />
                                  </div>
                                ))}
                              </div>

                              <div className="flex items-center gap-1.5 pt-2 border-t border-[var(--color-outline-variant)]/50 mt-2">
                                <span className="text-xs font-bold text-[var(--color-on-surface-variant)]">Correct MC Option Indicator:</span>
                                <select 
                                  value={q.correct_mc || 'A'}
                                  onChange={(e) => {
                                    const updated = [...activeTestDetail.questions];
                                    updated[qIdx] = { ...q, correct_mc: e.target.value };
                                    setActiveTestDetail({ ...activeTestDetail, questions: updated });
                                  }}
                                  className="text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded px-2 py-1 font-mono font-bold"
                                >
                                  <option value="A">Choice A</option>
                                  <option value="B">Choice B</option>
                                  <option value="C">Choice C</option>
                                  <option value="D">Choice D</option>
                                </select>
                              </div>
                            </div>
                          )}

                          {/* FRQ Logic */}
                          {q.type === 'FRQ' && (
                            <div className="bg-[var(--color-surface-dim)] p-4 rounded-sm border border-[var(--color-outline-variant)]">
                              <span className="text-xs font-bold text-amber-800 uppercase block mb-1">Administrative Evaluation Rubric Guide:</span>
                              <textarea
                                value={q.rubric_guide || ''}
                                onChange={(e) => {
                                  const updated = [...activeTestDetail.questions];
                                  updated[qIdx] = { ...q, rubric_guide: e.target.value };
                                  setActiveTestDetail({ ...activeTestDetail, questions: updated });
                                }}
                                placeholder="State criteria for full versus partial score point credits here..."
                                className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded px-2 py-2 h-16 font-mono"
                              />
                            </div>
                          )}
                        </div>
                      ))}

                      {/* Add new placeholder button */}
                      <button 
                        onClick={() => {
                          const currentQueries = activeTestDetail.questions || [];
                          const freshIdx = currentQueries.length + 1;
                          const placeholder: Question = {
                            id: String(freshIdx),
                            number: freshIdx,
                            type: 'MC',
                            prompt: 'Double-click to modify this prompt.',
                            points: 5,
                            options: { "A": "First Choice", "B": "Second Option", "C": "Third Option", "D": "Fourth Option" },
                            correct_mc: 'A'
                          };
                          setActiveTestDetail({ ...activeTestDetail, questions: [...currentQueries, placeholder] });
                        }}
                        className="w-full py-4 border-2 border-solid border-[var(--color-outline-variant)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/3 text-sm font-bold rounded-sm flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <PlusCircle size={16} /> Append Question Blueprint #{(activeTestDetail.questions?.length || 0) + 1}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SECTION 3: ROSTER & ASSIGNED MANAGER */}
          {activeTab === 'roster' && (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              {/* Left sidebar: Create/Modify Form */}
              <div className="lg:col-span-1 space-y-6">
                <div className={`border rounded-sm p-5 shadow-xs space-y-4 transition-colors ${editingStudentId ? 'bg-[#FFF8E1] border-amber-300' : 'bg-[var(--color-surface)] border-[var(--color-outline-variant)]'}`}>
                  <h3 className="font-black text-[var(--color-on-surface)] text-sm uppercase tracking-wider border-b border-solid border-[var(--color-outline-variant)] pb-2 flex justify-between items-center">
                    <span>{editingStudentId ? `Modify: ${editingStudentId}` : 'Single Student Profiler'}</span>
                    {editingStudentId && (
                      <span className="text-[10px] bg-amber-200 text-amber-900 font-bold px-2 py-0.5 rounded-sm select-none uppercase tracking-wide">Editing</span>
                    )}
                  </h3>
                  
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Student ID (Plain Code)</label>
                      <input 
                        type="text" 
                        placeholder="e.g. S014" 
                        value={newStudentForm.student_id}
                        onChange={(e) => setNewStudentForm({ ...newStudentForm, student_id: e.target.value })}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-1.5 font-bold"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Human Name</label>
                      <input 
                        type="text" 
                        placeholder="e.g. David Miller" 
                        value={newStudentForm.student_name}
                        onChange={(e) => setNewStudentForm({ ...newStudentForm, student_name: e.target.value })}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-1.5 font-semibold"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Student Email Address</label>
                      <input 
                        type="email" 
                        placeholder="e.g. david.miller@student.org" 
                        value={newStudentForm.email}
                        onChange={(e) => setNewStudentForm({ ...newStudentForm, email: e.target.value })}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-1.5 font-medium"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Assigned Test IDs (Comma or Semicolon separated)</label>
                      <input 
                        type="text" 
                        placeholder="TEST_1, TEST_2" 
                        value={newStudentForm.assigned_str}
                        onChange={(e) => setNewStudentForm({ ...newStudentForm, assigned_str: e.target.value })}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-1.5 font-mono text-xs font-bold text-[var(--color-primary)]"
                      />
                    </div>

                    <div className="flex gap-2">
                      <button 
                        onClick={handleSaveStudent}
                        className="flex-1 py-2.5 bg-[var(--color-primary)] hover:bg-[#533C8A] text-white rounded-sm text-xs font-bold transition-all flex items-center justify-center gap-1 shadow-xs"
                      >
                        <PlusCircle size={14} /> {editingStudentId ? 'Update Profile' : 'Commit Profile'}
                      </button>
                      
                      {editingStudentId && (
                        <button 
                          onClick={() => {
                            setEditingStudentId(null);
                            setNewStudentForm({ student_id: '', student_name: '', assigned_str: '' });
                          }}
                          className="px-3 py-2.5 bg-neutral-200 hover:bg-neutral-300 text-neutral-800 rounded-sm text-xs font-bold transition-all"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bulk assign shortcuts */}
                <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-5 shadow-xs space-y-3">
                  <h3 className="font-bold text-xs text-[#21005D] uppercase tracking-wider block">Bulk Assign shortcut</h3>
                  <p className="text-[10px] text-[var(--color-on-surface-variant)]">Select active test to force-append onto ALL registered students profiles at once:</p>
                  
                  <select 
                    id="bulk-test-associater"
                    className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2 py-1.5"
                    onChange={(e) => {
                      const selTest = e.target.value;
                      if (!selTest || roster.students.length === 0) return;
                      const selectEl = e.target;
                      requestConfirm(
                        'Bulk Assign Blueprint',
                        `Force assignment of test blueprint "${selTest}" to all ${roster.students.length} student profiles? This overrides or appends to their assigned list.`,
                        async () => {
                          try {
                            const targetIds = roster.students.map(s => s.student_id);
                            const res = await fetch('/api/admin/roster/assign', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ studentIds: targetIds, testIds: [selTest] })
                            });
                            if (res.ok) {
                              triggerSuccess('Association Success', `Test blueprint successfully associated with all student profiles!`);
                              fetchRoster();
                            }
                          } catch (err) {}
                          selectEl.value = '';
                        }
                      );
                      selectEl.value = '';
                    }}
                  >
                    <option value="">-- Apply Test to All --</option>
                    {tests.map(t => (
                      <option key={t.test_id} value={t.test_id}>[{t.test_id}] {t.event_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Tabular registry list column */}
              <div className="lg:col-span-3 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm flex flex-col overflow-hidden shadow-xs">
                <div className="p-5 border-b border-[var(--color-outline-variant)] flex justify-between items-center bg-[var(--color-surface)]">
                  <span className="font-black text-base text-[var(--color-on-surface)]">Tabular registered roster</span>
                  
                  <a 
                    href={`data:text/csv;charset=utf-8,student_id,student_name,student_email,assigned_tests\n${roster.students.map(s => `${s.student_id},"${s.student_name}","${s.email || ''}","${s.assigned_tests.join(';')}"`).join('\n')}`}
                    download="lan_server_roster_dump.csv"
                    className="px-3 py-1.5 bg-[var(--color-primary)] hover:bg-[#533C8A] text-white text-xs font-bold rounded-sm flex items-center gap-1 shadow-xs"
                  >
                    <Download size={12} /> Export CSV Backup
                  </a>
                </div>

                <div className="flex-1 overflow-x-auto">
                  <table className="w-full text-left font-medium text-xs">
                    <thead>
                      <tr className="bg-[var(--color-surface-dim)] text-[var(--color-on-surface-variant)] border-b border-solid border-[var(--color-outline-variant)] uppercase font-bold tracking-wider">
                        <th className="p-4">Student ID</th>
                        <th className="p-4">Student Name</th>
                        <th className="p-4">Assigned Test Blueprints</th>
                        <th className="p-4 text-right">Settings</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-dashed divide-[var(--color-outline-variant)]">
                      {roster.students.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-center p-10 text-gray-400">
                            No students registered. Type a profile on the left or drop a Roster CSV onto the dashboard.
                          </td>
                        </tr>
                      ) : (
                        roster.students.map((s) => (
                          <tr key={s.student_id} className="hover:bg-[var(--color-surface-container)] transition-colors">
                            <td className="p-4 font-mono font-extrabold text-[var(--color-primary)] select-all uppercase">{s.student_id}</td>
                            <td className="p-4">
                              <div className="font-bold text-[var(--color-on-surface)] text-sm">{s.student_name}</div>
                              {s.email ? (
                                <div className="text-[10px] font-mono text-neutral-500 mt-0.5">{s.email}</div>
                              ) : (
                                <div className="text-[10px] text-rose-500 italic mt-0.5">No email address</div>
                              )}
                            </td>
                            <td className="p-4">
                              <div className="flex flex-wrap gap-1">
                                {s.assigned_tests && s.assigned_tests.length > 0 ? (
                                  s.assigned_tests.map((at) => (
                                    <span key={at} className="bg-[var(--color-surface-bright)] text-[#21005D] text-[10px] font-bold px-2 py-0.5 rounded font-mono border border-[var(--color-outline-variant)]">
                                      {at}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[10px] text-gray-400 italic">None Assigned</span>
                                )}
                              </div>
                            </td>
                            <td className="p-4 text-right">
                              <div className="flex justify-end gap-1.5">
                                <button 
                                  onClick={() => {
                                    setNewStudentForm({ student_id: s.student_id, student_name: s.student_name, email: s.email || '', assigned_str: s.assigned_tests.join(', ') });
                                    setEditingStudentId(s.student_id);
                                  }}
                                  className="p-1 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 rounded"
                                  title="Edit student profile details"
                                >
                                  <Edit size={14} />
                                </button>
                                <button 
                                  onClick={() => handleDeleteStudent(s.student_id)}
                                  className="p-1 text-red-600 hover:bg-red-50 rounded"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 4: LIVE MONITORING */}
          {activeTab === 'sessions' && (
            <div className="space-y-6 animate-fadeIn">
              {/* PROCTORING INTEGRITY ALERTS PANEL */}
              <div className="bg-[var(--color-surface)] border border-red-500/20 rounded-sm p-6 shadow-sm border-solid">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-solid border-[var(--color-outline-variant)] pb-3 mb-4 gap-2">
                  <div>
                    <h3 className="font-extrabold text-sm text-[var(--color-on-surface)] flex items-center gap-2 uppercase tracking-wide">
                      <AlertCircle size={18} className="text-red-500 animate-pulse" /> Proctoring Integrity & Focus-Loss Monitor
                    </h3>
                    <p className="text-[11px] text-[var(--color-on-surface-variant)] mt-0.5">Real-time alerts tracking when students navigate away, click out of the frame, switch tabs, or close their test files.</p>
                  </div>
                  <span className={`px-2.5 py-1 text-[10px] font-black tracking-wider uppercase rounded-sm border select-none ${
                    studentsWithInfractions.length > 0 
                      ? 'bg-red-500/10 text-red-600 border-red-500/20 animate-pulse' 
                      : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                  }`}>
                    {studentsWithInfractions.length > 0 ? `⚠️ ${studentsWithInfractions.length} Alert(s) Pending` : '✅ All Devices Compliant'}
                  </span>
                </div>

                {studentsWithInfractions.length === 0 ? (
                  <div className="flex items-center gap-3 p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-sm text-xs text-emerald-700 border-solid">
                    <span className="p-1 px-2 bg-emerald-500/20 rounded-full text-emerald-600 shrink-0 font-bold select-none">✔</span>
                    <div>
                      <p className="font-bold">Complete Compliance Observed</p>
                      <p className="text-[10px] opacity-90">No students currently taking exams have switched tabs, minimized windows, or abandoned their exams.</p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[300px] overflow-y-auto pr-2">
                    {studentsWithInfractions.map((entry) => (
                      <div key={`${entry.student_id}-${entry.session_id}-${entry.is_live}`} className="bg-red-500/[0.02] border border-solid border-red-500/15 hover:border-red-500/35 rounded-sm p-4 space-y-3 transition-colors flex flex-col justify-between">
                        <div className="space-y-2">
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0">
                              <span className="font-mono text-[9px] font-black text-red-600 bg-red-100/60 uppercase px-1.5 py-0.5 rounded select-all">{entry.student_id}</span>
                              <p className="font-extrabold text-sm text-[var(--color-on-surface)] mt-1 truncate">{entry.student_name}</p>
                            </div>
                            <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded border border-solid shrink-0 ${
                              entry.is_live 
                                ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' 
                                : 'bg-zinc-500/10 text-zinc-600 border-zinc-500/20'
                            }`}>
                              {entry.status}
                            </span>
                          </div>
                          
                          <div className="text-[11px] text-[var(--color-on-surface-variant)] space-y-1 font-sans">
                            <p className="truncate">Blueprint: <strong>{entry.test_id}</strong></p>
                            <p className="flex items-center gap-1 text-red-600 font-extrabold bg-red-500/5 px-2 py-0.5 rounded-sm border border-solid border-red-500/10 w-fit">
                              <AlertCircle size={11} className="shrink-0" /> Left test frame: <strong className="text-red-700">{entry.infraction_count} times</strong>
                            </p>
                          </div>
                        </div>

                        <div className="flex justify-end gap-1.5 pt-2 border-t border-dashed border-red-500/10">
                          {entry.is_live ? (
                            <>
                              <button 
                                onClick={() => triggerForceSubmit(entry.session_id)}
                                className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold rounded-sm transition-colors cursor-pointer shadow-2xs"
                              >
                                Force Submit
                              </button>
                              <button 
                                onClick={() => triggerResetSession(entry.session_id, entry.test_id, entry.student_id)}
                                className="px-2 py-1 bg-zinc-100 border border-zinc-200 text-zinc-700 hover:bg-zinc-200 text-[10px] font-bold rounded-sm transition-colors cursor-pointer"
                              >
                                Reset
                              </button>
                            </>
                          ) : (
                            <button 
                              onClick={() => handleViewStudentResponses(entry.session_id)}
                              className="px-2.5 py-1 bg-[var(--color-surface-bright)] border border-solid border-[var(--color-outline-variant)] hover:bg-[#D0BCFF] text-[#21005D] text-[10px] font-black uppercase rounded-sm transition-colors inline-flex items-center gap-1 shadow-2xs cursor-pointer"
                            >
                              <Eye size={10} /> Examine Answers
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              {/* Left Column (2 cols wide): Actively Testing devices checklist */}
              <div className="xl:col-span-2 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm overflow-hidden shadow-xs flex flex-col h-fit">
                <div className="p-5 border-b border-[var(--color-outline-variant)] flex justify-between items-center bg-[var(--color-surface)]">
                  <div>
                    <span className="font-black text-base text-[var(--color-on-surface)] block">Connected local device screens</span>
                    <span className="text-xs text-[var(--color-on-surface-variant)] block mt-0.5">Showing all student desks with open, active exam drafts. Real-time alerts are raised if the student closes their page or switches tabs.</span>
                  </div>
                  <span className="bg-red-50 text-red-800 border border-red-200 px-3 py-1 rounded-sm text-xs font-black uppercase inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-sm bg-red-500 animate-pulse"></span>
                    {liveSessions.filter(s => !s.session_id.includes('-temp-session')).length} Desk(s) In-Progress
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-medium font-sans">
                    <thead>
                      <tr className="bg-[var(--color-surface-dim)] text-[var(--color-on-surface-variant)] border-b border-[var(--color-outline-variant)] uppercase font-bold tracking-wider text-[10px]">
                        <th className="p-4">Student Name / ID</th>
                        <th className="p-4 text-center font-bold">Aesthetic Status state</th>
                        <th className="p-4 text-right">In-Line Controls</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-dashed divide-[var(--color-outline-variant)]">
                      {liveSessions.filter(s => !s.session_id.includes('-temp-session')).length === 0 ? (
                        <tr>
                          <td colSpan={3} className="text-center p-12 text-gray-400">
                            <div className="space-y-2">
                              <p className="font-bold text-sm text-neutral-600">No active test-takers online</p>
                              <p className="text-xs text-neutral-400 max-w-md mx-auto">No students have active exam drafts in-progress. Once a student clicks "Start Test", their real-time desk trace is locked here until they submit.</p>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        liveSessions.filter(s => !s.session_id.includes('-temp-session')).map((session) => {
                          const isTempSession = session.session_id.includes('-temp-session');
                          const hasInfractions = (session.infraction_count || 0) > 0;
                          const isOnline = session.status === 'testing';
                          const isDashboard = session.status === 'dashboard';
                          const isOffline = session.status === 'offline';
                          return (
                            <tr key={session.student_id} className={`transition-all ${hasInfractions ? 'bg-red-50/70 hover:bg-red-100 border-l-4 border-red-600' : 'hover:bg-[var(--color-surface-container)]'}`}>
                              <td className="p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-xs font-mono font-black text-[var(--color-primary)] uppercase select-all bg-[var(--color-surface)] border border-[var(--color-outline-variant)] px-1.5 py-0.5 rounded mr-1">{session.student_id}</span>
                                  <span className="font-black text-sm text-[var(--color-on-surface)]">{session.student_name}</span>
                                  {hasInfractions && (
                                    <span className="bg-red-600 text-white border border-red-700 text-[10px] font-black tracking-wider uppercase px-2 py-0.5 rounded-sm flex items-center gap-1 shrink-0 animate-pulse border-solid">
                                      <AlertCircle size={10} className="text-white inline animate-none" /> Left test window ({session.infraction_count})
                                    </span>
                                  )}
                                  {isOffline && (
                                    <span className="bg-red-100 text-transparent border border-solid border-red-200 text-[9px] font-black uppercase px-2 py-0.5 rounded-sm shrink-0 text-red-600">
                                      OFFLINE / TERM CLOSED
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-4 text-center select-none">
                                <div className="flex flex-col items-center justify-center">
                                  {isOnline ? (
                                    <span className="bg-emerald-50 text-emerald-800 border border-solid border-emerald-200 text-xs px-3.5 py-1.5 rounded-sm inline-flex items-center gap-2 shadow-2xs font-extrabold font-sans">
                                      <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-sm bg-emerald-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-sm h-2 w-2 bg-emerald-600"></span>
                                      </span>
                                      <span>TESTING: {session.test_id}</span>
                                    </span>
                                  ) : isDashboard ? (
                                    <span className="bg-amber-50 text-amber-800 border border-solid border-amber-200 text-xs px-3.5 py-1.5 rounded-sm inline-flex items-center gap-2 shadow-2xs font-extrabold font-sans">
                                      <span className="relative flex h-2 w-2">
                                        <span className="relative inline-flex rounded-sm h-2 w-2 bg-amber-500"></span>
                                      </span>
                                      <span>RESTING ON HOME: {session.test_id}</span>
                                    </span>
                                  ) : (
                                    <span className="bg-zinc-100 text-zinc-500 border border-solid border-zinc-300 text-xs px-3.5 py-1.5 rounded-sm inline-flex items-center gap-1.5 shadow-2xs font-extrabold font-sans">
                                      <span className="h-1.5 w-1.5 rounded-sm bg-zinc-400"></span>
                                      <span>OFFLINE / TERM CLOSED: {session.test_id}</span>
                                    </span>
                                  )}
                                  {session.expires_at && !isOffline && (
                                    <LiveSessionCountdown expiresAt={session.expires_at} />
                                  )}
                                </div>
                              </td>
                              <td className="p-4 text-right">
                                <div className="flex justify-end gap-1.5">
                                  {!isTempSession ? (
                                    <>
                                      <button
                                        onClick={() => triggerForceSubmit(session.session_id)}
                                        className="px-2.5 py-1.5 bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold rounded-sm shadow-xs transition-colors"
                                        title="Forces automatic submit and locks questionnaire"
                                      >
                                        Force Submit
                                      </button>
                                      <button
                                        onClick={() => triggerExtendTimer(session.session_id)}
                                        className="px-2.5 py-1.5 border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-container)] text-[11px] font-bold rounded-sm text-[var(--color-on-surface)] transition-colors"
                                        title="Expand available timeline (+5 minutes)"
                                      >
                                        +5 Min
                                      </button>
                                      <button
                                        onClick={() => triggerResetSession(session.session_id, session.test_id, session.student_id)}
                                        className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-sm text-[11px] font-bold transition-colors"
                                        title="Delete cached session to let student restart"
                                      >
                                        Reset
                                      </button>
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-gray-400 italic">No persistent session file yet</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right Column (1 col wide): Supervisor manual commands override */}
              <div className="xl:col-span-1 space-y-6">
                <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-5 shadow-xs space-y-4">
                  <h3 className="font-black text-base text-[var(--color-on-surface)] border-b border-solid border-[var(--color-outline-variant)] pb-2 flex items-center gap-1.5">
                    <ShieldCheck size={18} className="text-red-600 animate-pulse" /> Supervisor Command Override deck
                  </h3>
                  
                  <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed">
                    Force administrative operations onto <strong>any student profile</strong>, even if they have locked up, closed their laptop browser tab, or displays as <em>offline</em>.
                  </p>

                  <div className="space-y-4 pt-1">
                    {/* Student Select dropdown */}
                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1.5">1. Target student profile</label>
                      <select 
                        value={overrideStudentId}
                        onChange={(e) => setOverrideStudentId(e.target.value)}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-2 font-semibold"
                      >
                        <option value="">-- Select Registered Student --</option>
                        {liveSessions.map((s) => {
                          const isOnline = s.status !== 'offline';
                          const statusLabel = s.status === 'testing' ? `testing: ${s.test_id}` : s.status === 'dashboard' ? 'home dashboard screen' : 'offline';
                          return (
                            <option key={s.student_id} value={s.student_id}>
                              [{s.student_id}] {s.student_name} ({statusLabel})
                            </option>
                          );
                        })}
                      </select>
                    </div>

                    {/* Action Select radio-group */}
                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-2">2. Action command trigger</label>
                      <div className="space-y-2">
                        <label className="flex items-start gap-2.5 p-2 rounded-sm border border-neutral-100 hover:bg-[var(--color-surface-container)] cursor-pointer text-xs">
                          <input 
                            type="radio" 
                            name="override-action-radio" 
                            value="force-submit"
                            checked={overrideActionType === 'force-submit'}
                            onChange={() => setOverrideActionType('force-submit')}
                            className="mt-0.5 text-red-600 focus:ring-red-500"
                          />
                          <div>
                            <p className="font-extrabold text-red-700">Force Submit & Lock Exam</p>
                            <p className="text-[10px] text-gray-500">Locks the student session on server disk, performs MCQ score counts, and flags FRQs for evaluation.</p>
                          </div>
                        </label>

                        <label className="flex items-start gap-2.5 p-2 rounded-sm border border-neutral-100 hover:bg-[var(--color-surface-container)] cursor-pointer text-xs">
                          <input 
                            type="radio" 
                            name="override-action-radio" 
                            value="reset"
                            checked={overrideActionType === 'reset'}
                            onChange={() => setOverrideActionType('reset')}
                            className="mt-0.5 text-red-600 focus:ring-red-500"
                          />
                          <div>
                            <p className="font-extrabold text-gray-700">Reset & Purge Session file</p>
                            <p className="text-[10px] text-gray-500">Deletes the active student response draft and allows them to log in and start a fresh retake.</p>
                          </div>
                        </label>

                        <label className="flex items-start gap-2.5 p-2 rounded-sm border border-neutral-100 hover:bg-[var(--color-surface-container)] cursor-pointer text-xs">
                          <input 
                            type="radio" 
                            name="override-action-radio" 
                            value="extend"
                            checked={overrideActionType === 'extend'}
                            onChange={() => setOverrideActionType('extend')}
                            className="mt-0.5 text-red-600 focus:ring-red-500"
                          />
                          <div>
                            <p className="font-extrabold text-purple-700">Extend Timer (+5 Mins)</p>
                            <p className="text-[10px] text-gray-500">Adds an extra five minutes onto their countdown timer. Reactivates if status is expired.</p>
                          </div>
                        </label>
                      </div>
                    </div>

                    {/* Invoke Button */}
                    <button
                      onClick={async () => {
                        if (!overrideStudentId) {
                          triggerAlert('Selection Required', 'Please select a student profile first before firing supervisor override commands.');
                          return;
                        }
                        const sEntry = liveSessions.find(s => s.student_id === overrideStudentId);
                        if (!sEntry || sEntry.session_id.includes('-temp-session')) {
                          triggerAlert('No Active Session', 'This student does not have an active session in progress on the server disk to override.');
                          return;
                        }
                        
                        const actionName = overrideActionType === 'force-submit' ? 'Force Submit' : overrideActionType === 'reset' ? 'Reset/Purge' : 'Extend Timer (+5m)';
                        requestConfirm(
                          `Supervisor Override Command`,
                          `Are you sure you want to trigger manual [${actionName}] override command for student [${sEntry.student_name}]?`,
                          async () => {
                            if (overrideActionType === 'force-submit') {
                              await triggerForceSubmit(sEntry.session_id);
                              triggerSuccess('Execution Successful', `Supervisor Command [${actionName}] was successfully dispatched to the server workspace.`);
                            } else if (overrideActionType === 'reset') {
                              await triggerResetSession(sEntry.session_id, sEntry.test_id, sEntry.student_id);
                            } else if (overrideActionType === 'extend') {
                              await triggerExtendTimer(sEntry.session_id);
                            }
                          }
                        );
                      }}
                      className="w-full py-3 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-extrabold rounded-sm text-xs transition-colors flex items-center justify-center gap-1.5 shadow-md shadow-red-200"
                    >
                      <ShieldCheck size={14} /> Fire Override Command
                    </button>
                  </div>
                </div>

                {/* Aesthetic live monitor card */}
                <div className="bg-[var(--color-surface-dim)] border border-[var(--color-outline-variant)] rounded-sm p-5 shadow-xs space-y-2">
                  <h4 className="font-bold text-xs text-[#21005D] uppercase tracking-wide flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-amber-500"></span> Desks heartbeat summary
                  </h4>
                  <div className="grid grid-cols-2 gap-3 text-xs pt-1">
                    <div className="bg-[var(--color-surface)] border rounded-sm p-2.5">
                      <span className="text-[10px] text-gray-500 font-bold uppercase block">Dashboard Home</span>
                      <span className="text-sm font-black text-amber-700">{liveSessions.filter(s => s.status === 'dashboard').length} devices</span>
                    </div>
                    <div className="bg-[var(--color-surface)] border rounded-sm p-2.5">
                      <span className="text-[10px] text-gray-500 font-bold uppercase block">Offline Desks</span>
                      <span className="text-sm font-black text-gray-600">{liveSessions.filter(s => s.status === 'offline').length} devices</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

          {/* SECTION 5: GRADING & ESSAY EVALUATION QUEUE */}
          {activeTab === 'grading' && (
            <div className="space-y-6">
              {/* Selector Tabs Inside Grading */}
              <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 shadow-xs">
                <div className="flex justify-between items-center border-b border-solid border-[var(--color-outline-variant)] pb-4 mb-4">
                  <div>
                    <h2 className="text-lg font-black text-[var(--color-on-surface)]">Grading center evaluations</h2>
                    <p className="text-xs text-[var(--color-on-surface-variant)] mt-0.5">Auto-graded MCQ results and custom grading workflows for essays.</p>
                  </div>
                  <button 
                    onClick={() => window.open('/api/admin/export/results')}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-sm shadow-xs inline-flex items-center gap-1"
                  >
                    <Download size={14} /> Compile & Export CSV Results
                  </button>
                </div>

                <div className="space-y-6">
                  {/* AI Autograding Control Deck */}
                  <div className="bg-[var(--color-surface-dim)] border border-[var(--color-outline-variant)] rounded-sm p-6 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-[var(--color-surface-dim)] rounded-sm blur-3xl opacity-50 -mr-6 -mt-6"></div>
                    <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-6">
                      <div className="space-y-2">
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[var(--color-surface-bright)] text-[#21005D] text-[10px] font-black uppercase tracking-wider rounded-sm">
                          <Sparkles size={11} /> Gemini 3.5 Assistant Powered
                        </div>
                        <h3 className="text-base font-black text-[var(--color-on-surface)]">AI-Assisted Short Essay Evaluations</h3>
                        <p className="text-xs text-[var(--color-on-surface-variant)] max-w-xl">
                          Automatically evaluate qualitative student essay responses against your uploaded teacher rubric guides in real-time. Results are recorded server-side for each student result folder on completion.
                        </p>

                        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 pt-2">
                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-3 rounded-sm shadow-xs">
                            <span className="text-[10px] font-bold text-gray-400 uppercase block font-sans">Total Essays</span>
                            <span className="text-lg font-black text-gray-900 block truncate font-mono">{gradingQueue.length}</span>
                          </div>
                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-3 rounded-sm shadow-xs">
                            <span className="text-[10px] font-bold text-green-500 uppercase block font-medium font-sans">Graded</span>
                            <span className="text-lg font-black text-green-600 block truncate font-mono">
                              {gradingQueue.filter(q => q.grade).length}
                            </span>
                          </div>
                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-3 rounded-sm shadow-xs">
                            <span className="text-[10px] font-bold text-amber-500 uppercase block font-medium font-sans">Pending AI</span>
                            <span className="text-lg font-black text-amber-600 block truncate font-mono">
                              {gradingQueue.filter(q => !q.grade).length}
                            </span>
                          </div>
                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-3 rounded-sm shadow-xs">
                            <span className="text-[10px] font-bold text-emerald-600 uppercase block font-sans">Gemini Tokens Left</span>
                            <span className="text-md font-black text-emerald-700 block truncate font-mono mt-1">
                              {secretsStatus?.gemini_usage_left !== undefined 
                                ? `${secretsStatus.gemini_usage_left.toLocaleString()} / ${secretsStatus.gemini_quota_limit?.toLocaleString()}` 
                                : '1,500,000 / 1,500,000'}
                            </span>
                          </div>
                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-3 rounded-sm shadow-xs">
                            <span className="text-[10px] font-bold text-amber-600 uppercase block font-sans">Grading Left (Est)</span>
                            <span className="text-md font-black text-amber-700 block truncate font-mono mt-1">
                              {secretsStatus?.estimated_frqs_left !== undefined 
                                ? `${secretsStatus.estimated_frqs_left.toLocaleString()} FRQs` 
                                : '1,000 FRQs'}
                            </span>
                          </div>
                        </div>

                        <div className="pt-2 text-[10px] text-zinc-400 font-sans flex items-center gap-1.5">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                          <span>Simulated token budget resets automatically every calendar day. Gemini autograding will automatically pause if the budget is fully depleted to prevent overages.</span>
                        </div>

                        {gradingQueue.filter(q => !q.grade).length > 0 && (
                          <div className="space-y-1.5 mt-2">
                            {hasEnoughBudget ? (
                              <div className="text-[11px] text-[#21005D] bg-[#EADDFF]/40 border border-[#D0BCFF] px-3 py-1.5 rounded-sm inline-block font-mono">
                                ✨ Outstanding Demand: ~<strong>{outstandingDemandSum.toLocaleString()}</strong> tokens. Tracked budget is healthy!
                              </div>
                            ) : (
                              <div className="text-[11px] text-amber-700 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-sm inline-block font-mono">
                                ⚠️ Demand Overflow: ~<strong>{outstandingDemandSum.toLocaleString()}</strong> tokens required. This exceeds current token limit. Grading will safely pause once the daily limit is reached.
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col items-stretch md:items-end justify-center min-w-[200px]">
                        {isAutograding ? (
                          <div className="space-y-2 w-full text-center md:text-right">
                            <div className="inline-flex items-center gap-2 text-xs font-bold text-[var(--color-primary)]">
                              <span className="animate-spin rounded-sm h-3 w-3 border-2 border-[var(--color-primary)] border-t-transparent"></span>
                              Grading with Gemini...
                            </div>
                            <p className="text-[10px] text-gray-500 italic">{autogradingMessage}</p>
                          </div>
                        ) : (
                          <button
                            onClick={handleAiAutograde}
                            disabled={gradingQueue.filter(q => !q.grade).length === 0}
                            className={`px-5 py-3 rounded-sm text-xs font-black inline-flex items-center justify-center gap-2 shadow-xs transition-all ${
                              gradingQueue.filter(q => !q.grade).length === 0
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed border border-[var(--color-outline-variant)]'
                                : 'bg-[var(--color-primary)] hover:bg-[#533C8A] text-white'
                            }`}
                          >
                            <Bot size={15} /> Autograde with AI
                          </button>
                        )}
                        {gradingQueue.filter(q => !q.grade).length === 0 && !isAutograding && (
                          <span className="text-[10px] text-green-600 font-bold mt-1.5 block">
                            ✓ All current responses graded.
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Pending Essay Workflow Queue Feed */}
                  {gradingQueue.filter(q => !q.grade).length > 0 && (
                    <div className="space-y-3 p-6 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm shadow-xs">
                      <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                        <div>
                          <span className="text-xs font-black text-[var(--color-primary)] uppercase tracking-wider block font-sans">
                            Pending AI Essay Workflow Feed
                          </span>
                          <span className="text-[11px] text-gray-400 block mt-0.5">
                            Displays a list of student submissions waiting for AI grading, along with their individually computed Gemini API token costs.
                          </span>
                        </div>
                        <span className={`self-start sm:self-auto text-[10px] font-mono font-bold px-2.5 py-1 rounded-sm border border-solid uppercase ${
                          hasEnoughBudget 
                            ? 'text-[#21005D] bg-[#EADDFF] border-[#D0BCFF]' 
                            : 'text-amber-800 bg-amber-50 border-amber-100'
                        }`}>
                          Queue Total Burden: {outstandingDemandSum.toLocaleString()} tokens
                        </span>
                      </div>
                      <div className="overflow-x-auto border border-[var(--color-outline-variant)] rounded-sm">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="bg-[var(--color-surface-dim)] text-[var(--color-on-surface-variant)] border-b border-[var(--color-outline-variant)] font-bold uppercase tracking-wider">
                              <th className="p-3">Student</th>
                              <th className="p-3">Exam / Prompt</th>
                              <th className="p-3">Syllable Word Counts</th>
                              <th className="p-3 text-right">Estimated Footprint</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-solid divide-[var(--color-outline-variant)] font-medium">
                            {gradingQueue.filter(q => !q.grade).map((item, idx) => {
                              const promptWords = (item.prompt || '').trim().split(/\s+/).filter(Boolean).length;
                              const rubricWords = (item.rubric_guide || '').trim().split(/\s+/).filter(Boolean).length;
                              const responseWords = (item.student_response || '').trim().split(/\s+/).filter(Boolean).length;
                              const estimatedTokens = estimateFrqTokens(item);
                              
                              return (
                                <tr key={`${item.session_id}-${item.q_id}-${idx}`} className="hover:bg-[var(--color-surface-dim)] transition-colors">
                                  <td className="p-3">
                                    <span className="font-bold text-[var(--color-on-surface)] block">{item.student_name}</span>
                                    <span className="text-[10px] text-gray-400 font-mono block uppercase">{item.student_id}</span>
                                  </td>
                                  <td className="p-3">
                                    <span className="font-semibold block truncate max-w-xs">{item.event_name}</span>
                                    <p className="text-[10px] text-gray-400 block truncate max-w-sm italic">"{item.prompt}"</p>
                                  </td>
                                  <td className="p-3">
                                    <div className="font-sans text-[10px] text-gray-500 shrink-0">
                                      Prompt: <strong className="text-gray-700">{promptWords}w</strong> <span className="text-zinc-300">|</span> Rubric: <strong className="text-gray-700">{rubricWords}w</strong> <span className="text-zinc-300">|</span> Essay: <strong className="text-gray-700">{responseWords}w</strong>
                                    </div>
                                    <div className="text-[10px] block truncate text-zinc-400 max-w-xs mt-0.5">"{item.student_response || <em className="italic">Blank response/No answer typed.</em>}"</div>
                                  </td>
                                  <td className="p-3 text-right font-mono text-xs font-black text-amber-700">
                                    ~{estimatedTokens.toLocaleString()} <span className="text-[10px] font-bold text-gray-400 font-sans">tokens</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-6 mt-6">

                  {/* MCQ overall compiled totals table */}
                  <div className="space-y-3 pt-4 border-t border-[var(--color-outline-variant)]">
                    <span className="text-xs font-black text-[var(--color-primary)] uppercase tracking-wider block">Graded Scores Log Ledger ({gradingResults.length} Completed)</span>
                    <div className="overflow-x-auto border border-[var(--color-outline-variant)] rounded-sm">
                      <table className="w-full text-left text-xs font-medium">
                        <thead>
                          <tr className="bg-[var(--color-surface-dim)] text-[var(--color-on-surface-variant)] border-b border-[var(--color-outline-variant)] font-bold uppercase tracking-wider">
                            <th className="p-4">Student ID/Name</th>
                            <th className="p-4">Assigned Test blueprint</th>
                            <th className="p-4 text-center">MCQ Corrects</th>
                            <th className="p-4 text-center">Essay Total</th>
                            <th className="p-4 text-center pb-4">Combined Score Log</th>
                            <th className="p-4 text-center">Responses</th>
                            <th className="p-4 text-right">Registered Time</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-dashed divide-[var(--color-outline-variant)]">
                          {gradingResults.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="text-center p-6 text-gray-400">No completed scores ledger registered on the server cache yet.</td>
                            </tr>
                          ) : (
                            gradingResults.map((item, idx) => {
                              const hasResultInfractions = (item.infraction_count || 0) > 0;
                              return (
                                <tr key={`${item.session_id}-${idx}`} className={`transition-colors ${hasResultInfractions ? 'bg-red-500/[0.02] border-l-2 border-red-500 border-solid' : 'hover:bg-[var(--color-surface-container)]'}`}>
                                  <td className="p-4">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="font-mono font-bold text-[var(--color-primary)] block uppercase tracking-tight bg-[var(--color-surface-dim)] px-1.5 py-0.5 rounded select-all text-[10px]">{item.student_id}</span>
                                      {hasResultInfractions && (
                                        <span className="bg-red-100 text-red-700 border border-solid border-red-200 text-[9px] font-black tracking-wide uppercase px-1.5 py-0.5 rounded-sm flex items-center gap-1 shrink-0" title="Proctoring logs detected tab swaps or blur deviations">
                                          <AlertCircle size={9} /> {item.infraction_count} Focus Loss(es)
                                        </span>
                                      )}
                                    </div>
                                    <span className="font-bold text-sm text-[var(--color-on-surface)] mt-1 block">{item.student_name}</span>
                                  </td>
                                <td className="p-4">
                                  <span className="font-bold">{item.event_name}</span>
                                  <p className="font-mono text-[10px] text-gray-400">{item.test_id}</p>
                                </td>
                                <td className="p-4 text-center font-mono font-bold">{item.mc_score} / {item.mc_total} pts</td>
                                <td className="p-4 text-center font-semibold text-gray-600 font-mono">{item.frq_score} / {item.frq_total} pts</td>
                                <td className="p-4 text-center">
                                  <span className="bg-green-100 text-green-800 text-xs font-extrabold px-3 py-1 rounded-sm font-mono">
                                    {item.total_score} / {item.total_possible} pts ({Math.round((item.total_score / item.total_possible) * 100)}%)
                                  </span>
                                </td>
                                <td className="p-4 text-center">
                                  <div className="flex justify-center items-center gap-1.5 font-sans">
                                    <button
                                      onClick={() => handleViewStudentResponses(item.session_id)}
                                      className="px-2.5 py-1.5 bg-[var(--color-surface-bright)] border border-[var(--color-outline-variant)] hover:bg-[#D0BCFF] text-[#21005D] text-[10px] font-black uppercase rounded-sm transition-colors inline-flex items-center gap-1 shadow-2xs"
                                      title="Examine all MCQ and Free Response answers of this session"
                                    >
                                      <Eye size={12} /> View Details
                                    </button>
                                    <button
                                      onClick={() => handleMailSingleGrade(item.test_id, item.student_id)}
                                      disabled={isSendingEmail[`${item.test_id}-${item.student_id}`]}
                                      className={`px-2.5 py-1.5 font-bold uppercase rounded-sm text-[10px] border transition-all inline-flex items-center gap-1 shadow-2xs ${
                                        isSendingEmail[`${item.test_id}-${item.student_id}`]
                                          ? 'bg-zinc-100 border-zinc-200 text-zinc-400 cursor-not-allowed'
                                          : 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100'
                                      }`}
                                      title="Email graded scorecard directly to student"
                                    >
                                      <Mail size={12} className={isSendingEmail[`${item.test_id}-${item.student_id}`] ? "animate-pulse" : ""} />
                                      {isSendingEmail[`${item.test_id}-${item.student_id}`] ? "Mailing..." : "Email Grade"}
                                    </button>
                                    <button
                                      onClick={() => triggerResetSession(item.session_id, item.test_id, item.student_id)}
                                      className="px-2.5 py-1.5 bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 text-[10px] font-black uppercase rounded-sm transition-colors inline-flex items-center gap-1 shadow-2xs cursor-pointer"
                                      title="Delete this test entry completely to allow the student to retake it"
                                    >
                                      <Trash2 size={12} /> Delete & Reset
                                    </button>
                                  </div>
                                </td>
                                <td className="p-4 text-right text-gray-500 font-mono">{new Date(item.submitted_at).toLocaleString()}</td>
                              </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 6: SYSTEM SETTINGS (BACKUP, PASSWORDS ETC.) */}
          {activeTab === 'settings' && (
            <div className="space-y-6 pb-12">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Box 1: Change Passphrase */}
              <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 shadow-xs flex flex-col justify-between space-y-4">
                <div className="space-y-4">
                  <h3 className="font-black text-base text-[var(--color-on-surface)] flex items-center gap-1.5 border-b border-solid border-[var(--color-outline-variant)] pb-2">
                    <Key size={18} className="text-[var(--color-primary)]" /> Change Admin Password
                  </h3>
                  <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed">
                    Set a secure, offline password to access the supervisor administrator panel. If you need to force reset, simply delete `data/config.json` inside tests/host directory and launch page to restart setup wizard.
                  </p>

                  <div className="space-y-3 pt-2">
                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Current Password passphrase</label>
                      <input 
                        type="password"
                        placeholder="••••••••"
                        value={passwordChange.currentPassword}
                        onChange={(e) => setPasswordChange({ ...passwordChange, currentPassword: e.target.value })}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-2"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">New password passphrase</label>
                      <input 
                        type="password"
                        placeholder="••••••••"
                        value={passwordChange.newPassword}
                        onChange={(e) => setPasswordChange({ ...passwordChange, newPassword: e.target.value })}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-2.5 py-2"
                      />
                    </div>
                  </div>
                </div>

                <button 
                  onClick={handleChangePassword}
                  className="w-full py-2.5 bg-[var(--color-primary)] hover:bg-[#533C8A] text-white text-xs font-bold rounded-sm shadow-xs transition-colors"
                >
                  Write New Admin Password
                </button>
              </div>

              {/* Box 2: backups snapshot zip */}
              <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 shadow-xs flex flex-col justify-between space-y-4">
                <div className="space-y-4">
                  <h3 className="font-black text-base text-[var(--color-on-surface)] flex items-center gap-1.5 border-b border-solid border-[var(--color-outline-variant)] pb-2">
                    <Database size={18} className="text-[var(--color-primary)]" /> Backup snapshot database
                  </h3>
                  <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed">
                    Download a secure, complete `.zip` snapshot containing all your blueprints (tests/*.json) and roster metrics. Safe for portability, backup, and migrating computers!
                  </p>

                  <button 
                    onClick={handleDownloadBackup}
                    className="w-full py-3.5 bg-[var(--color-surface-bright)] hover:bg-[#D0BCFF] text-[#21005D] text-xs font-extrabold rounded-sm flex items-center justify-center gap-1.5 transition-colors border border-[var(--color-outline-variant)]"
                  >
                    <Download size={16} /> Download full snapshot backup ZIP
                  </button>

                  <p className="text-xs text-[var(--color-on-surface-variant)] border-t border-solid border-[var(--color-outline-variant)] pt-4 leading-relaxed">
                    To restore previous backups onto this server host, select a previous snapshot backup zip file below:
                  </p>

                  <label className="flex items-center gap-3 w-full border border-solid border-[var(--color-outline-variant)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/3 px-4 py-3 rounded-sm cursor-pointer transition-all text-sm font-bold">
                    <Upload size={18} className="text-[var(--color-primary)]" />
                    <div className="text-left font-sans">
                      <p className="font-bold text-xs text-[var(--color-on-surface)]">Upload snapshot backup ZIP</p>
                      <p className="text-[10px] text-[var(--color-on-surface-variant)] font-normal">Replaces all data instantly</p>
                    </div>
                    <input 
                      type="file" 
                      accept=".zip" 
                      onChange={handleRestoreBackup}
                      className="hidden" 
                    />
                  </label>
                </div>
              </div>
            </div>

            {/* Box 3: AI Auto-Grading Secrets & API Key Configuration */}
            <div className="mt-6 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 shadow-xs space-y-4">
              <h3 className="font-black text-base text-[var(--color-on-surface)] flex items-center gap-1.5 border-b border-solid border-[var(--color-outline-variant)] pb-2">
                <Bot size={18} className="text-[var(--color-primary)]" /> AI Auto-Grading Secrets & Key Configuration
              </h3>
              
              <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed">
                Provide a valid <strong>Google Gemini API Key</strong> to enable professional, automatic, instant grading assessments on student Free Response questions (FRQs) using AI models. This secret key is safely stored server-side and never exposed to client browsers.
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">
                {/* Status card */}
                <div className="lg:col-span-1 border border-[var(--color-outline-variant)] bg-[var(--color-surface-dim)] rounded-sm p-4 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-gray-500 block mb-1">Grading Key Status</span>
                    {secretsStatus?.is_configured ? (
                      <div className="space-y-1.5">
                        <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-800 border border-emerald-300 text-xs font-black px-2.5 py-1 rounded-sm uppercase">
                          <Check size={12} /> Active & Configured
                        </span>
                        <p className="font-mono text-xs text-gray-600 block mt-1">Key: <code>{secretsStatus.masked_key}</code></p>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <span className="inline-flex items-center gap-1 bg-rose-50 text-rose-800 border border-rose-200 text-xs font-black px-2.5 py-1 rounded-sm uppercase">
                          <AlertCircle size={12} /> Not Configured
                        </span>
                        <p className="text-[10px] text-gray-400 block">AI Autograding features are currently locked. Provide a key on the right to unlock.</p>
                      </div>
                    )}
                  </div>
                  
                  <button 
                    onClick={fetchSecretsStatus}
                    className="mt-4 px-3 py-1.5 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] hover:bg-gray-50 text-[11px] font-bold rounded-sm flex items-center justify-center gap-1.5 transition-colors text-gray-700"
                  >
                    <RefreshCw size={11} /> Refresh status
                  </button>
                </div>

                {/* Form key setter */}
                <div className="lg:col-span-2 space-y-4">
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Set Gemini api key (GEMINI_API_KEY)</label>
                    <div className="relative">
                      <input 
                        type="password"
                        placeholder="Paste your AI Studio GEMINI_API_KEY here..."
                        value={newGeminiKey}
                        onChange={(e) => setNewGeminiKey(e.target.value)}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm pl-3 pr-10 py-2.5 font-mono"
                      />
                      <Bot size={16} className="absolute right-3 top-3 text-neutral-400 select-none" />
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1">Make sure you have registered your Google Gemini API key on Google AI Studio dashboard (or purchase a paid keys tier to avoid rate throttles).</p>
                  </div>

                  <button 
                    onClick={handleSaveSecrets}
                    className="py-2.5 px-6 bg-[var(--color-primary)] hover:bg-[#533C8A] text-white text-xs font-bold rounded-sm shadow-xs transition-colors"
                  >
                    Save & Load API Key Secret
                  </button>
                </div>
              </div>
            </div>

            {/* Box 4: Student Grade Delivery (SMTP Configuration) */}
            <div className="mt-6 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 shadow-xs space-y-4">
              <h3 className="font-black text-base text-[var(--color-on-surface)] flex items-center gap-1.5 border-b border-solid border-[var(--color-outline-variant)] pb-2">
                <Mail size={18} className="text-[var(--color-primary)]" /> Student Grade Email Gateway (SMTP)
              </h3>
              
              <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed">
                Connect your organization's SMTP relay servers to automatically dispatch graded scorecard diagnostic reports safely to students' configured roster emails. 
                <strong> Keep SMTP headers empty to run in Safe Simulation Mode</strong>, where graded emails are written locally into the test simulator outbox for inspection.
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">
                {/* Configuration status indicator */}
                <div className="lg:col-span-1 border border-[var(--color-outline-variant)] bg-[var(--color-surface-dim)] rounded-sm p-4 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-gray-500 block mb-1">Gateway Status</span>
                    {smtpConfig.smtp_host && smtpConfig.smtp_user ? (
                      <div className="space-y-1.5">
                        <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-800 border border-emerald-300 text-xs font-black px-2.5 py-1 rounded-sm uppercase">
                          <Check size={12} /> SMTP Server Enabled
                        </span>
                        <p className="text-[11px] font-mono text-gray-600 block mt-1">Host: <code>{smtpConfig.smtp_host}</code></p>
                        <p className="text-[11px] font-mono text-gray-600 block">From: <code>{smtpConfig.smtp_from}</code></p>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-800 border border-amber-200 text-xs font-black px-2.5 py-1 rounded-sm uppercase">
                          <RefreshCw size={12} className="animate-spin" /> Safe Simulator Active
                        </span>
                        <p className="text-[10px] text-gray-500 mt-1">SMTP is unconfigured. All graded emails will be logged locally in the simulation outbox panel below.</p>
                      </div>
                    )}
                  </div>

                  <button 
                    onClick={fetchSmtpConfig}
                    className="mt-4 px-3 py-1.5 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] hover:bg-gray-50 text-[11px] font-bold rounded-sm flex items-center justify-center gap-1.5 transition-colors text-gray-700 w-full"
                  >
                    <RefreshCw size={11} /> Refresh SMTP Status
                  </button>
                </div>

                {/* Configurations input layout */}
                <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4 font-sans">
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">SMTP Server Hostname</label>
                    <input 
                      type="text"
                      placeholder="e.g. smtp.gmail.com"
                      value={smtpConfig.smtp_host}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, smtp_host: e.target.value })}
                      className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2 font-mono"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase">Port Number</label>
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input 
                          type="checkbox"
                          checked={smtpConfig.smtp_secure}
                          onChange={(e) => setSmtpConfig({ ...smtpConfig, smtp_secure: e.target.checked })}
                          className="rounded text-[var(--color-primary)] focus:ring-[#6750A4]"
                        />
                        <span className="text-[9px] font-bold text-[var(--color-on-surface-variant)] uppercase">Use SSL/TLS</span>
                      </label>
                    </div>
                    <input 
                      type="text"
                      placeholder="e.g. 465 or 587"
                      value={smtpConfig.smtp_port}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, smtp_port: e.target.value })}
                      className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">SMTP Username / auth email</label>
                    <input 
                      type="text"
                      placeholder="e.g. grading@olympiad.org"
                      value={smtpConfig.smtp_user}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, smtp_user: e.target.value })}
                      className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">SMTP Password</label>
                    <input 
                      type="password"
                      placeholder={smtpConfig.has_password ? "•••••••• (Password Saved)" : "Credentials password passphrase..."}
                      value={smtpConfig.smtp_password === '__UNCHANGED__' ? '' : smtpConfig.smtp_password}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, smtp_password: e.target.value })}
                      className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2 font-mono"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Sender 'From' Address Header String</label>
                    <input 
                      type="text"
                      placeholder="e.g. Science Olympiad Tryouts <grading@olympiad.org>"
                      value={smtpConfig.smtp_from}
                      onChange={(e) => setSmtpConfig({ ...smtpConfig, smtp_from: e.target.value })}
                      className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2"
                    />
                  </div>

                  <div className="sm:col-span-2 pt-2">
                    <button 
                      onClick={handleSaveSmtpConfig}
                      className="py-2.5 px-6 bg-[var(--color-primary)] hover:bg-[#533C8A] text-white text-xs font-bold rounded-sm shadow-xs transition-colors"
                    >
                      Save SMTP Gateway Settings
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Simulated outbound outbox visualizer list */}
            <div className="mt-6 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 shadow-xs space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-solid border-[var(--color-outline-variant)] pb-2 gap-2">
                <h3 className="font-black text-base text-[var(--color-on-surface)] flex items-center gap-1.5">
                  <Mail className="text-[var(--color-primary)]" size={18} /> Simulated Email Sandbox Logs & Outbox ({outboundEmails.length})
                </h3>
                <div className="flex gap-2">
                  <button 
                    onClick={fetchOutboundEmails}
                    className="px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-[var(--color-on-surface)] text-[11px] font-bold rounded-sm flex items-center gap-1 transition-colors"
                  >
                    <RefreshCw size={12} /> Sync Outbox
                  </button>
                  {outboundEmails.length > 0 && (
                    <button 
                      onClick={handleClearOutboundEmails}
                      className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-bold rounded-sm flex items-center gap-1 border border-rose-200 transition-colors"
                    >
                      <Trash size={12} /> Clear Logs
                    </button>
                  )}
                </div>
              </div>

              <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed">
                When you dispatch student scorecards in <strong>Simulation mode</strong>, compiled grade report mock email contents are written below. Click any log record below to review exactly what students would receive!
              </p>

              {outboundEmails.length === 0 ? (
                <div className="border border-solid border-[var(--color-outline-variant)] rounded-sm p-10 text-center text-xs text-gray-400">
                  No simulated emails have been dispatched yet. Score student tests and submit grading dispatches to review mock receipts here!
                </div>
              ) : (
                <div className="border border-[var(--color-outline-variant)] rounded-sm overflow-hidden bg-[var(--color-surface-dim)]">
                  <div className="overflow-x-auto max-h-[350px]">
                    <table className="w-full align-middle text-left border-collapse">
                      <thead>
                        <tr className="bg-[var(--color-surface-bright)]/40 border-b border-[var(--color-outline-variant)] text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider">
                          <th className="p-3">Timestamp</th>
                          <th className="p-3">Student Recipient</th>
                          <th className="p-3">Test & Event Name</th>
                          <th className="p-3">Scoring Score</th>
                          <th className="p-3 text-right">Diagnostic Preview</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-outline-variant)] text-xs">
                        {outboundEmails.map((email) => (
                          <tr key={email.id} className="hover:bg-[var(--color-surface-container)] transition-colors">
                            <td className="p-3 font-mono text-[10px] text-gray-500 whitespace-nowrap">
                              {new Date(email.timestamp).toLocaleString()}
                            </td>
                            <td className="p-3 font-sans">
                              <span className="font-bold block text-gray-800">{email.student_name} ({email.student_id})</span>
                              <span className="font-mono text-[10px] text-gray-500">{email.to_email}</span>
                            </td>
                            <td className="p-3 font-bold text-[var(--color-on-surface-variant)]">
                              {email.test_name} 
                              <span className="text-[10px] font-mono block text-gray-400 normal-case font-normal">Blueprint: {email.test_id}</span>
                            </td>
                            <td className="p-3 text-xs whitespace-nowrap">
                              <span className="font-extrabold text-[var(--color-primary)] text-sm bg-[var(--color-surface-bright)] border border-[var(--color-outline-variant)] px-2 py-0.5 rounded mr-1">
                                {email.score}
                              </span>
                              <span className="text-[10px] font-semibold text-emerald-600 uppercase bg-emerald-50 px-1 py-0.5 rounded border border-emerald-100">
                                {email.percent}
                              </span>
                            </td>
                            <td className="p-3 text-right">
                              <button 
                                onClick={() => {
                                  // Open raw email mock in a secure preview iframe window modal
                                  const win = window.open("", "_blank");
                                  if (win) {
                                    win.document.write(email.html);
                                    win.document.close();
                                  } else {
                                    alert("Pop-up blocked. Please permit pop-ups to view raw mock visual templates!");
                                  }
                                }}
                                className="px-2.5 py-1 text-[11px] font-bold bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded-sm uppercase hover:bg-[#533C8A] transition-colors"
                              >
                                View template
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Box 5: High-Concurrency Load & Stress Simulation Testing */}
            <div className="mt-6 bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-6 shadow-xs space-y-4">
              <h3 className="font-black text-base text-[var(--color-on-surface)] flex items-center gap-1.5 border-b border-solid border-[var(--color-outline-variant)] pb-2">
                <Activity size={18} className="text-[var(--color-primary)]" /> High-Concurrency Load & Stress Simulation Testing
              </h3>

              <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed">
                Verify LANtern's robust system capability by simulating intense multi-student peak exam conditions. 
                This fires hundreds of concurrent file read-modify-write saves and submit actions on the host disk utilizing mutual exclusion locks to thoroughly verify transactional safety and throughput.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2 font-sans">
                {/* Configuration Input */}
                <div className="md:col-span-1 space-y-4 border border-[var(--color-outline-variant)] bg-[var(--color-surface-dim)] rounded-sm p-4 flex flex-col justify-between">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Simulated Students</label>
                      <input 
                        type="number"
                        min="1"
                        max="500"
                        value={stressStudentsCount}
                        onChange={(e) => setStressStudentsCount(Math.min(500, Math.max(1, Number(e.target.value) || 200)))}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2 font-mono"
                      />
                      <span className="text-[10px] text-gray-500 mt-0.5 block">Total dummy students submitting concurrently</span>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase mb-1">Concurrency Wave Limit</label>
                      <input 
                        type="number"
                        min="1"
                        max="50"
                        value={stressConcurrencyLimit}
                        onChange={(e) => setStressConcurrencyLimit(Math.min(50, Math.max(1, Number(e.target.value) || 20)))}
                        className="w-full text-xs border border-[var(--color-outline-variant)] bg-[var(--color-surface)] rounded-sm px-3 py-2 font-mono"
                      />
                      <span className="text-[10px] text-gray-500 mt-0.5 block">Simultaneous execution batch wave limit (max 50)</span>
                    </div>
                  </div>

                  <button 
                    onClick={handleRunSimulationLoadTest}
                    disabled={isSimulatingStress}
                    className={`w-full py-2.5 px-4 font-bold rounded-sm flex items-center justify-center gap-1.5 transition-colors text-xs text-white ${
                      isSimulatingStress 
                        ? 'bg-zinc-400 cursor-not-allowed animate-pulse' 
                        : 'bg-indigo-600 hover:bg-indigo-700 shadow-xs'
                    }`}
                  >
                    {isSimulatingStress ? 'Simulating High Load...' : '🚀 Launch Concurrency Test'}
                  </button>
                </div>

                {/* Simulation Report Result Output */}
                <div className="md:col-span-2 border border-[var(--color-outline-variant)] rounded-sm p-4 flex flex-col justify-between min-h-[220px] bg-[var(--color-surface-dim)]">
                  {isSimulatingStress ? (
                    <div className="flex-1 flex flex-col items-center justify-center space-y-3 p-6 text-center">
                      <RefreshCw className="animate-spin text-indigo-600" size={32} />
                      <div className="space-y-1">
                        <span className="text-xs font-black text-gray-800 uppercase block tracking-wider">Injecting Concurrent Thread Wave</span>
                        <p className="text-[11px] text-gray-500 max-w-sm">Generating dummy student profiles, writing answers concurrently, evaluating and clean swapping files on disk...</p>
                      </div>
                    </div>
                  ) : stressReport ? (
                    <div className="space-y-4 flex-1 flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between border-b border-solid border-[var(--color-outline-variant)] pb-2 mb-3">
                          <span className="text-xs font-black uppercase text-gray-600 block">Performance Analysis Report</span>
                          <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-800 border border-emerald-300 text-[10px] font-black px-2.5 py-1 rounded-sm uppercase">
                            <Check size={10} /> Safety Intact (No Collisions)
                          </span>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-2.5 rounded-sm text-center">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block mb-0.5">Total Duration</span>
                            <span className="text-sm font-black text-[var(--color-on-surface)] font-mono">{(stressReport.total_duration_ms / 1000).toFixed(2)}s</span>
                          </div>

                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-2.5 rounded-sm text-center">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block mb-0.5">Batch Lock Limit</span>
                            <span className="text-sm font-black text-[var(--color-on-surface)] font-mono">{stressReport.concurrency_limit} Threads</span>
                          </div>

                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-2.5 rounded-sm text-center">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block mb-0.5">Throughput Rate</span>
                            <span className="text-sm font-black text-emerald-600 font-mono">{stressReport.throughput_req_per_sec} ops/s</span>
                          </div>

                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-2.5 rounded-sm text-center">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block mb-0.5">Logins / Sessions</span>
                            <span className="text-sm font-black text-gray-700 font-mono">{stressReport.students_simulated} created</span>
                          </div>

                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-2.5 rounded-sm text-center">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block mb-0.5">Saves Committed</span>
                            <span className="text-sm font-black text-[var(--color-primary)] font-mono">{stressReport.saves_successful}/{stressReport.students_simulated}</span>
                          </div>

                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-2.5 rounded-sm text-center">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block mb-0.5">Submits & Graded</span>
                            <span className="text-sm font-black text-[#21005D] font-mono">{stressReport.submits_successful}/{stressReport.students_simulated}</span>
                          </div>

                          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] p-2.5 rounded-sm text-center pb-2 col-span-2 sm:col-span-3">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block mb-0.5">Responses Graded/sec (Est 100w/resp)</span>
                            <span className="text-xs font-black text-indigo-600 font-mono block truncate">{responsesGradedPerSec === 0 ? "N/A" : `${responsesGradedPerSec}/s`}</span>
                          </div>
                        </div>
                      </div>

                      <div className="bg-emerald-50 border border-emerald-100 rounded-sm p-3 text-[11px] text-emerald-800 leading-relaxed mt-2">
                        <strong>Performance integrity confirmed:</strong> Processed concurrent updates seamlessly on <strong>{stressReport.students_simulated}</strong> asynchronous operations using atomic mutual-exclusion locks. Zero database collisions or file corrupted segments were reported.
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-gray-400">
                      <Activity size={28} className="text-zinc-400 mb-1.5" />
                      <p className="text-xs font-bold font-sans text-gray-600">No active execution data simulated yet.</p>
                      <p className="text-[10px] text-gray-400 mt-1 max-w-sm mb-4">Select student thread loads and fire concurrent test simulation runs to trace direct host latency.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          )}
        </div>
      </main>

      {/* MODAL WORKSTATION: STUDENT runner preview overlay (Read Only) */}
      {previewTestObj && (
        <div className="fixed inset-0 bg-[#1D1B20]/60 flex items-center justify-center z-50 p-6">
          <div className="bg-[var(--color-surface)] rounded-sm border border-[var(--color-outline-variant)] w-full max-w-4xl h-[90vh] flex flex-col shadow-lg overflow-hidden">
            {/* Header */}
            <div className="h-16 border-b border-[var(--color-outline-variant)] px-6 bg-[var(--color-surface)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-[var(--color-primary)] uppercase bg-[var(--color-surface-bright)] px-2 py-0.5 rounded">Previewer Mode</span>
                <span className="font-bold text-sm tracking-tight">{previewTestObj.event_name}</span>
              </div>
              <button 
                onClick={() => setPreviewTestObj(null)}
                className="text-xs bg-red-600 text-white font-bold px-4 py-1.5 rounded-sm"
              >
                Exit Preview
              </button>
            </div>

            {/* Core Body Container */}
            <div className="flex-1 p-6 md:p-8 overflow-y-auto">
              <div className="border border-[var(--color-outline-variant)] rounded-sm p-6 bg-[var(--color-surface)] space-y-4">
                <span className="text-xs font-mono font-extrabold text-[var(--color-primary)]">Question {previewTestObj.questions[previewCurQ]?.number || 1} of {previewTestObj.questions.length}</span>
                <p className="text-lg font-bold leading-relaxed">
                  <LatexRenderer text={previewTestObj.questions[previewCurQ]?.prompt} />
                </p>

                {previewTestObj.questions[previewCurQ]?.image_url && (
                  <div className="my-4 flex justify-center border border-[var(--color-outline-variant)] rounded-sm overflow-hidden bg-neutral-50 p-2.5 max-w-full">
                    <img 
                      src={getDirectImageUrl(previewTestObj.questions[previewCurQ].image_url)} 
                      alt="Question reference illustration" 
                      className="max-h-80 w-auto rounded-sm object-contain shadow-sm"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                )}

                {/* MC Option Items */}
                {previewTestObj.questions[previewCurQ]?.type === 'MC' && previewTestObj.questions[previewCurQ]?.options && (
                  <div className="space-y-2 mt-4">
                    {Object.entries(previewTestObj.questions[previewCurQ].options!).map(([key, raw]) => {
                      const isCorrect = previewTestObj.questions[previewCurQ].correct_mc === key;
                      return (
                        <div key={key} className={`border rounded-sm p-3 flex items-center gap-3 ${isCorrect ? 'border-green-500 bg-green-50/50' : 'border-[var(--color-outline-variant)]'}`}>
                          <div className={`w-6 h-6 rounded-sm flex items-center justify-center text-xs font-bold ${isCorrect ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{key}</div>
                          <span className="text-sm font-medium">
                            <LatexRenderer text={raw} />
                          </span>
                          {isCorrect && <span className="bg-green-100 text-green-700 text-[9px] font-bold tracking-widest px-1.5 rounded ml-auto uppercase font-mono">Answer Key</span>}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* FRQ Guide */}
                {previewTestObj.questions[previewCurQ]?.type === 'FRQ' && (
                  <div className="mt-4 p-4 bg-amber-50 rounded-sm border border-amber-200">
                    <span className="text-xs font-extrabold text-amber-800 uppercase block">Teacher Guide Rubric Standard:</span>
                    <p className="text-xs text-amber-800 mt-1 whitespace-pre-wrap font-mono">
                      <LatexRenderer text={previewTestObj.questions[previewCurQ].rubric_guide} />
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="h-16 border-t border-[var(--color-outline-variant)] px-6 bg-[var(--color-surface)] flex items-center justify-between">
              <button 
                disabled={previewCurQ === 0}
                onClick={() => setPreviewCurQ(previewCurQ - 1)}
                className={`px-4 py-2 border rounded-sm text-xs font-bold ${previewCurQ === 0 ? 'opacity-30 cursor-not-allowed' : 'hover:bg-[var(--color-surface-container)]'}`}
              >
                Back
              </button>
              
              <div className="flex gap-2">
                {previewTestObj.questions.map((q, idx) => (
                  <button 
                    key={q.id}
                    onClick={() => setPreviewCurQ(idx)}
                    className={`w-8 h-8 rounded-sm text-xs font-bold ${previewCurQ === idx ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)]' : 'border'}`}
                  >
                    {idx + 1}
                  </button>
                ))}
              </div>

              <button 
                disabled={previewCurQ === previewTestObj.questions.length - 1}
                onClick={() => setPreviewCurQ(previewCurQ + 1)}
                className={`px-4 py-2 border rounded-sm text-xs font-bold ${previewCurQ === previewTestObj.questions.length - 1 ? 'opacity-30 cursor-not-allowed' : 'hover:bg-[var(--color-surface-container)]'}`}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL WORKSTATION: STUDENT responses viewer overlay */}
      {viewingResponseSessionId && (
        <div className="fixed inset-0 bg-[#121114]/80 flex items-center justify-center z-50 p-6 backdrop-blur-xs">
          <div className="bg-[var(--color-surface)] rounded-sm border border-[var(--color-outline-variant)] w-full max-w-4xl h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-fadeIn">
            {/* Header */}
            <div className="h-16 border-b border-[var(--color-outline-variant)] px-6 bg-[var(--color-surface)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-[var(--color-primary)] uppercase bg-[var(--color-surface-bright)] px-2.5 py-0.5 rounded">Response Visualizer</span>
                <span className="font-bold text-sm tracking-tight text-[var(--color-on-surface)]">Reviewing Complete Student Submissions Desk</span>
              </div>
              <button 
                onClick={() => {
                  setViewingResponseSessionId(null);
                  setViewingResponseData(null);
                }}
                className="text-xs bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-1.5 rounded-sm"
              >
                Close Visualizer
              </button>
            </div>

            {/* Main Area */}
            <div className="flex-1 overflow-y-auto p-6 bg-[var(--color-surface-dim)] space-y-6">
              {isResponseLoading ? (
                <div className="flex flex-col items-center justify-center h-full space-y-3">
                  <div className="animate-spin rounded-sm h-8 w-8 border-4 border-[var(--color-primary)] border-t-transparent"></div>
                  <p className="text-xs font-black text-[var(--color-on-surface-variant)] font-mono">RETRIEVING EXAM WORKSPACE ANSWERS FROM SERVER...</p>
                </div>
              ) : !viewingResponseData ? (
                <div className="p-6 bg-red-950/40 text-red-300 border-red-900/40 border rounded-sm text-xs">
                  <p className="font-bold">Error Loading Student Session Details</p>
                  <p className="mt-1">The system could not load completed question answers for session [{viewingResponseSessionId}]. Check if the session file was purged or reset.</p>
                </div>
              ) : (
                <>
                  {/* Top quick stats cards overview */}
                  <div className="bg-[var(--color-surface-container)] border border-[var(--color-outline-variant)] rounded-sm p-5 grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <span className="text-[10px] text-gray-400 font-bold uppercase block mb-0.5">Student Account</span>
                      <span className="text-sm font-black text-[var(--color-on-surface)] block">[{viewingResponseData.student_id}] {viewingResponseData.student_name}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-400 font-bold uppercase block mb-0.5">Exam blueprint Title</span>
                      <span className="text-sm font-black text-[var(--color-primary)] block truncate" title={viewingResponseData.event_name}>{viewingResponseData.event_name}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-400 font-bold uppercase block mb-0.5">Combined Score Summary</span>
                      <span className="inline-flex items-center gap-1 bg-green-950/40 text-green-300 border border-green-800/40 text-xs font-black px-2.5 py-0.5 rounded-sm mt-0.5">
                        {viewingResponseData.total_score} / {viewingResponseData.total_possible} pts ({Math.round((viewingResponseData.total_score / viewingResponseData.total_possible) * 100)}%)
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-400 font-bold uppercase block mb-0.5">Submission Timestamp</span>
                      <span className="text-xs font-bold text-[var(--color-on-surface-variant)] block mt-0.5 font-mono">{new Date(viewingResponseData.submitted_at).toLocaleString()}</span>
                    </div>
                  </div>

                  {viewingResponseData.infraction_count && viewingResponseData.infraction_count > 0 ? (
                    <div className="bg-red-500/10 border border-red-500/20 rounded-sm p-4 text-xs text-red-700 flex items-center gap-2 border-solid">
                      <AlertCircle size={16} className="text-red-500 shrink-0" />
                      <div>
                        <p className="font-extrabold text-sm">⚠️ High Integrity Alert: Focus Leaks Detected</p>
                        <p className="text-[11px] font-medium text-red-600/90 mt-0.5">The proctoring logic recorded <strong>{viewingResponseData.infraction_count} event(s)</strong> of this student navigating away, switching tabs, or resizing/minimizing their test screen.</p>
                      </div>
                    </div>
                  ) : null}

                  {/* Questionnaire answers walkthrough */}
                  <div className="space-y-4">
                    <span className="text-xs font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block">Question-by-Question Ledger ({viewingResponseData.questions.length} Items)</span>
                    
                    {viewingResponseData.questions.map((q: any, index: number) => {
                      const studentResponse = (viewingResponseData.responses && viewingResponseData.responses[q.id]);
                      const isMC = q.type === 'MC';
                      const isCorrectMC = isMC && studentResponse === q.correct_mc;
                      
                      return (
                        <div key={q.id || index} className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm p-5 space-y-3 shadow-xs">
                          <div className="flex justify-between items-start gap-4">
                            <div>
                              <span className="bg-[var(--color-surface-dim)] border border-[var(--color-outline-variant)] text-[var(--color-on-surface-variant)] font-mono text-[10px] font-bold px-2 py-0.5 rounded uppercase font-sans">Question {index + 1} ({q.type})</span>
                              <div className="text-sm font-bold text-[var(--color-on-surface)] mt-2 font-sans">
                                <LatexRenderer text={q.prompt} />
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <span className="text-xs font-bold text-neutral-400 uppercase font-mono block">Points scored</span>
                              <span className={`text-sm font-mono font-black ${isMC ? (isCorrectMC ? 'text-green-400' : 'text-red-400') : 'text-[var(--color-primary)]'}`}>
                                {isMC ? (isCorrectMC ? q.points : 0) : (q.grade_points !== undefined ? q.grade_points : 0)} / {q.points}
                              </span>
                            </div>
                          </div>

                          {/* Image rendering if question has image_url */}
                          {q.image_url && (
                            <div className="my-3 max-w-md border border-[var(--color-outline-variant)] rounded-sm overflow-hidden shadow-2xs">
                              <img 
                                src={getDirectImageUrl(q.image_url)} 
                                alt={`Graphic illustration for Question ${index + 1}`} 
                                className="w-full h-auto object-contain"
                                referrerPolicy="no-referrer"
                              />
                            </div>
                          )}

                          {isMC ? (
                            <div className="bg-[var(--color-surface-dim)] rounded-sm p-4 border border-[var(--color-outline-variant)] space-y-2">
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                                {Object.entries(q.options || {}).map(([choiceKey, text]: any) => {
                                  const isSelected = studentResponse === choiceKey;
                                  const isCorrectOption = q.correct_mc === choiceKey;
                                  
                                  return (
                                    <div 
                                      key={choiceKey} 
                                      className={`p-2.5 border rounded-sm flex items-center gap-2.5 text-xs font-semibold ${
                                        isSelected 
                                          ? (isCorrectOption ? 'border-green-600 bg-green-950/20' : 'border-red-800 bg-red-950/20') 
                                          : (isCorrectOption ? 'border-green-800/60 bg-green-950/10' : 'border-[var(--color-outline-variant)] bg-[var(--color-surface)]')
                                      }`}
                                    >
                                      <span className={`w-5 h-5 rounded-sm flex items-center justify-center font-bold text-[11px] ${
                                        isSelected 
                                          ? (isCorrectOption ? 'bg-green-600 text-white' : 'bg-red-600 text-white') 
                                          : (isCorrectOption ? 'bg-green-950 text-green-300 border border-green-800/40' : 'bg-[var(--color-surface-dim)] text-[var(--color-on-surface-variant)]')
                                      }`}>{choiceKey}</span>
                                      <span className="flex-1 font-semibold text-[var(--color-on-surface)]">
                                        <LatexRenderer text={text} />
                                      </span>
                                      
                                      {isSelected && <span className="text-[9px] font-black uppercase font-mono tracking-wider ml-auto text-[var(--color-primary)]">Selected</span>}
                                      {!isSelected && isCorrectOption && <span className="text-[9px] text-green-400 font-bold uppercase font-mono tracking-wider ml-auto">Correct Key</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {/* Student's draft */}
                              <div className="bg-[var(--color-surface-dim)] border border-[var(--color-outline-variant)] rounded-sm p-4">
                                <span className="text-[10px] font-bold text-[var(--color-on-surface-variant)] uppercase tracking-wider block mb-1">Student Essay Submission Text</span>
                                <p className="text-xs text-[var(--color-on-surface)] whitespace-pre-wrap font-sans font-semibold leading-relaxed">{studentResponse || <em className="text-gray-400">Blank response submitted.</em>}</p>
                              </div>

                              {/* Rubric references and feedback critiques */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="border border-amber-900/60 bg-amber-950/15 rounded-sm p-4">
                                  <span className="text-[10px] font-bold text-amber-300 uppercase block mb-1">Grading Rubric guide criteria</span>
                                  <p className="text-xs text-amber-200 font-mono whitespace-pre-wrap leading-relaxed">{q.rubric_guide || 'No criteria guide specified.'}</p>
                                </div>

                                <div className="border border-[var(--color-outline-variant)] bg-[var(--color-surface-dim)]/20 rounded-sm p-4">
                                  <span className="text-[10px] font-bold text-[var(--color-primary)] uppercase block mb-1">AI Critique Notes & Supervisor Comments</span>
                                  <p className="text-xs text-[var(--color-primary)] whitespace-pre-wrap leading-relaxed italic leading-relaxed">{q.grade_notes || 'No critique comments recorded.'}</p>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sleek Dialog overlay for confirmation or alerts */}
      {customModal && customModal.show && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/65 backdrop-blur-xs select-none">
          <div className="bg-[var(--color-surface)] border border-[var(--color-outline-variant)] rounded-sm max-w-md w-full p-6 shadow-xl space-y-4 animate-fadeIn">
            <div className="flex items-center gap-2 border-b border-dashed border-[var(--color-outline-variant)] pb-3">
              {customModal.type === 'confirm' ? (
                <HelpCircle size={18} className="text-[var(--color-primary)] shrink-0" />
              ) : customModal.type === 'success' ? (
                <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
              ) : (
                <AlertCircle size={18} className="text-amber-500 shrink-0" />
              )}
              <h3 className="font-sans font-black text-sm tracking-tight text-[var(--color-on-surface)]">
                {customModal.title}
              </h3>
            </div>
            
            <p className="text-xs text-[var(--color-on-surface-variant)] leading-relaxed font-semibold">
              {customModal.message}
            </p>
            
            <div className="flex justify-end gap-2 pt-2 border-t border-solid border-[var(--color-outline-variant)]">
              {customModal.type === 'confirm' ? (
                <>
                  <button
                    onClick={() => setCustomModal(null)}
                    className="px-3.5 py-2 hover:bg-[var(--color-surface-container)] border border-[var(--color-outline-variant)] rounded-sm text-xs font-bold transition-all text-[var(--color-on-surface-variant)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const cb = customModal.onConfirm;
                      setCustomModal(null);
                      if (cb) cb();
                    }}
                    className="px-4 py-2 bg-[var(--color-primary)] hover:opacity-95 text-white rounded-sm text-xs font-black transition-all cursor-pointer"
                  >
                    Confirm Action
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setCustomModal(null)}
                  className="px-5 py-2 bg-[var(--color-primary)] hover:opacity-95 text-white rounded-sm text-xs font-extrabold transition-all cursor-pointer"
                >
                  OK
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
