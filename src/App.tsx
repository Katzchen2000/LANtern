import React, { useState, useEffect } from 'react';
import { ShieldCheck, LogIn, Lock, GraduationCap, ArrowRight, Server, Clock } from 'lucide-react';
import StudentRunner from './components/StudentRunner';
import AdminPanel from './components/AdminPanel';

export default function App() {
  // Navigation Routing Hash
  const [route, setRoute] = useState(() => window.location.hash || '#student');
  
  // Setup and Auth Cache States
  const [isAdminSetup, setIsAdminSetup] = useState<boolean | null>(null);
  const [isAdminAuth, setIsAdminAuth] = useState(false);
  const [isStudentAuth, setIsStudentAuth] = useState(false);
  
  // Logged-in metadata summaries
  const [studentProfile, setStudentProfile] = useState<{ id: string; name: string } | null>(null);

  // Form Inputs
  const [studentIdInput, setStudentIdInput] = useState('');
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [setupPasswordInput, setSetupPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');

  // Routing Hash Monitor
  useEffect(() => {
    const handleHashChange = () => {
      setRoute(window.location.hash || '#student');
      setLoginError('');
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Auth & Setup checkers on load
  const verifyAuth = async () => {
    // 1. Check Admin Setup Completed on Host
    try {
      const setupRes = await fetch('/api/admin/setup-status');
      if (setupRes.ok) {
        const out = await setupRes.json();
        setIsAdminSetup(out.isSetup);
      }
    } catch (e) {
      console.error(e);
    }

    // 2. Check Admin Cookie Authorized
    try {
      const adminRes = await fetch('/api/admin/me');
      setIsAdminAuth(adminRes.ok);
    } catch (e) {}

    // 3. Check Student Session Cookie Authorized
    try {
      const studentRes = await fetch('/api/student/me');
      if (studentRes.ok) {
        const out = await studentRes.json();
        setStudentProfile({ id: out.student_id, name: out.student_name });
        setIsStudentAuth(true);
      } else {
        setIsStudentAuth(false);
        setStudentProfile(null);
      }
    } catch (e) {}
  };

  useEffect(() => {
    verifyAuth();
  }, [route]);

  const navigateTo = (hash: string) => {
    window.location.hash = hash;
  };

  // ACTIONS: Login and setups
  const handleAdminSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    if (!setupPasswordInput || setupPasswordInput.length < 4) {
      setLoginError('Setup password must be at least 4 characters long.');
      return;
    }
    try {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: setupPasswordInput })
      });
      if (res.ok) {
        alert('Server setup successfully configured! You can now log in.');
        setIsAdminSetup(true);
        setSetupPasswordInput('');
      } else {
        const errors = await res.json();
        setLoginError(errors.error || 'Setup failed.');
      }
    } catch (err) {
      setLoginError('Error connecting to Server.');
    }
  };

  const handleAdminLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPasswordInput })
      });
      if (res.ok) {
        setIsAdminAuth(true);
        setAdminPasswordInput('');
        navigateTo('#admin/dashboard');
      } else {
        const errors = await res.json();
        setLoginError(errors.error || 'Validation failed.');
      }
    } catch (err) {
      setLoginError('Error contacting host server.');
    }
  };

  const handleStudentLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    if (!studentIdInput.trim()) {
      setLoginError('Please type a valid Student ID.');
      return;
    }
    try {
      const res = await fetch('/api/student/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id: studentIdInput })
      });
      if (res.ok) {
        const out = await res.json();
        setStudentProfile({ id: out.student_id, name: out.student_name });
        setIsStudentAuth(true);
        setStudentIdInput('');
        navigateTo('#student/select');
      } else {
        const errors = await res.json();
        setLoginError(errors.error || 'ID lookup failed.');
      }
    } catch (err) {
      setLoginError('Connection to host offline.');
    }
  };

  const handleAdminLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
      setIsAdminAuth(false);
      navigateTo('#student');
    } catch (e) {}
  };

  const handleStudentLogout = async () => {
    try {
      await fetch('/api/student/logout', { method: 'POST' });
      setIsStudentAuth(false);
      setStudentProfile(null);
      navigateTo('#student');
    } catch (e) {}
  };

  // RENDER SELECTION LOGIC
  const isAdminRoute = route.startsWith('#admin');

  // --- RENDERING ROUTE: ADMIN VIEWS ---
  if (isAdminRoute) {
    // 1. Show setup wizard if config.json does not have dynamic admin hash registered yet
    if (isAdminSetup === false) {
      return (
        <div className="min-h-screen bg-[#09090B] text-[#FAFAFA] flex flex-col items-center justify-center p-6 select-none font-sans relative">
          <div className="absolute top-6 left-6 text-[13px] font-bold text-[#71717A]">
            LANtern test software
          </div>
          <div className="max-w-[420px] w-full text-center space-y-8">
            <div className="space-y-3">
              <h1 className="text-4xl md:text-[45px] font-bold tracking-tight text-white">Setup</h1>
              <p className="text-[16px] text-[#A1A1AA] leading-normal max-w-[280px] md:max-w-xs mx-auto">
                Configure your server Master passcode to protect testing analytics.
              </p>
            </div>

            <form onSubmit={handleAdminSetupSubmit} className="space-y-4">
              <div className="relative">
                <input 
                  type="password"
                  placeholder="Master passcode"
                  value={setupPasswordInput}
                  onChange={(e) => setSetupPasswordInput(e.target.value)}
                  className="w-full text-[15px] border border-[#27272A] bg-[#09090B] focus:border-[#A1A1AA] text-white rounded-full px-6 py-4 outline-none text-center transition-all placeholder-[#52525B]"
                />
              </div>

              {loginError && (
                <p className="text-xs text-[#EF4444] font-semibold text-center bg-red-950/20 border border-red-900/30 px-4 py-2.5 rounded-full">
                  {loginError}
                </p>
              )}

              <button 
                type="submit"
                className="w-full py-4 bg-[#FAFAFA] hover:bg-neutral-200 text-[#09090B] font-bold rounded-full text-[15px] transition-all flex items-center justify-center shadow-md select-none"
              >
                Configure Server Setup
              </button>
            </form>
          </div>
        </div>
      );
    }

    // 2. Show Login box if not authenticated
    if (!isAdminAuth) {
      return (
        <div className="min-h-screen bg-[#09090B] text-[#FAFAFA] flex flex-col items-center justify-center p-6 select-none font-sans relative">
          <div className="absolute top-6 left-6 flex items-center gap-3">
            <button 
              onClick={() => navigateTo('#student')}
              className="text-[13px] text-[#A1A1AA] hover:text-[#FAFAFA] font-medium transition-colors"
            >
              ← Go to Student App
            </button>
            <span className="text-[#3F3F46]">|</span>
            <span className="text-[13px] font-bold text-[#71717A]">LANtern test software</span>
          </div>

          <div className="max-w-[420px] w-full text-center space-y-8">
            <div className="space-y-3">
              <h1 className="text-4xl md:text-[45px] font-bold tracking-tight text-white">Supervisor</h1>
              <p className="text-[16px] text-[#A1A1AA] leading-normal max-w-[280px] md:max-w-xs mx-auto">
                Access local analytics, grading queues, and roster tools.
              </p>
            </div>

            <form onSubmit={handleAdminLoginSubmit} className="space-y-4">
              <div className="relative">
                <input 
                  type="password"
                  placeholder="Supervisor Password"
                  value={adminPasswordInput}
                  onChange={(e) => setAdminPasswordInput(e.target.value)}
                  className="w-full text-[15px] border border-[#27272A] bg-[#09090B] focus:border-[#A1A1AA] text-white rounded-full px-6 py-4 outline-none text-center transition-all placeholder-[#52525B]"
                />
              </div>

              {loginError && (
                <p className="text-xs text-[#EF4444] font-semibold text-center bg-red-950/20 border border-red-900/30 px-4 py-2.5 rounded-full">
                  {loginError}
                </p>
              )}

              <button 
                type="submit"
                className="w-full py-4 bg-[#FAFAFA] hover:bg-neutral-200 text-[#09090B] font-bold rounded-full text-[15px] transition-all flex items-center justify-center shadow-md select-none"
              >
                Continue as Supervisor
              </button>
            </form>
          </div>
        </div>
      );
    }

    // 3. Render Admin Console panel
    return <AdminPanel onLogout={handleAdminLogout} />;
  }

  // --- RENDERING ROUTE: STUDENT RUNNER FLOWS ---
  if (isStudentAuth && studentProfile) {
    return (
      <StudentRunner 
        studentId={studentProfile.id} 
        studentName={studentProfile.name} 
        onLogout={handleStudentLogout} 
      />
    );
  }

  // Render Student ID Entry Form
  return (
    <div className="min-h-screen bg-[#09090B] text-[#FAFAFA] flex flex-col items-center justify-center p-6 select-none font-sans relative">
      <div className="absolute top-6 left-6 text-[13px] font-bold text-[#71717A]">
        LANtern test software
      </div>
      <div className="absolute top-6 right-6">
        <button 
          onClick={() => navigateTo('#admin/dashboard')}
          className="text-[13px] text-[#A1A1AA] hover:text-[#FAFAFA] font-medium transition-colors"
        >
          Supervisor Login
        </button>
      </div>

      <div className="max-w-[420px] w-full text-center space-y-8">
        <div className="space-y-3">
          <h1 className="text-4xl md:text-[45px] font-bold tracking-tight text-white">Sign in</h1>
        </div>

        <form onSubmit={handleStudentLoginSubmit} className="space-y-4">
          <div className="relative">
            <input 
              type="text"
              placeholder="student-001"
              value={studentIdInput}
              onChange={(e) => setStudentIdInput(e.target.value)}
              className="w-full text-[15px] border border-[#27272A] bg-[#09090B] focus:border-[#A1A1AA] text-white rounded-full px-6 py-4 outline-none text-center transition-all placeholder-[#52525B]"
            />
          </div>

          {loginError && (
            <p className="text-xs text-[#EF4444] font-semibold text-center bg-red-950/20 border border-red-900/30 px-4 py-2.5 rounded-full">
              {loginError}
            </p>
          )}

          <button 
            type="submit"
            className="w-full py-4 bg-[#FAFAFA] hover:bg-neutral-200 text-[#09090B] font-bold rounded-full text-[15px] transition-all flex items-center justify-center shadow-md select-none"
          >
            Continue with Student ID
          </button>
        </form>
      </div>
    </div>
  );
}
