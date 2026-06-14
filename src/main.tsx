import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Global Fetch Interceptor to bypass third-party cookie blocking inside iframe sandboxes
const originalFetch = window.fetch;
const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' 
    ? input 
    : (input instanceof URL ? input.href : (input as Request).url || '');
  
  const newInit: RequestInit = init ? { ...init } : {};
  let headersObj: Headers;
  if (newInit.headers) {
    headersObj = new Headers(newInit.headers);
  } else {
    headersObj = new Headers();
  }
  
  const adminToken = localStorage.getItem('admin_token');
  const studentToken = localStorage.getItem('student_token');
  const studentSessToken = localStorage.getItem('student_session_token');

  if (adminToken) {
    headersObj.set('Authorization-Admin', adminToken);
  }
  if (studentToken) {
    headersObj.set('Authorization-Student', studentToken);
  }
  if (studentSessToken) {
    headersObj.set('Authorization-Student-Session', studentSessToken);
  }
  
  if (adminToken && !headersObj.has('Authorization')) {
    headersObj.set('Authorization', `Bearer ${adminToken}`);
  } else if (studentToken && !headersObj.has('Authorization')) {
    headersObj.set('Authorization', `Bearer ${studentToken}`);
  }

  newInit.headers = headersObj;
  const response = await originalFetch(input, newInit);

  if (response.ok) {
    if (
      url.includes('/api/admin/login') ||
      url.includes('/api/admin/setup') ||
      url.includes('/api/student/login') ||
      url.includes('/api/student/session') ||
      url.includes('/api/admin/logout') ||
      url.includes('/api/student/logout')
    ) {
      try {
        const clonedRes = response.clone();
        const data = await clonedRes.json();
        
        if (url.includes('/api/admin/login') || url.includes('/api/admin/setup')) {
          if (data && data.token) {
            localStorage.setItem('admin_token', data.token);
          }
        } else if (url.includes('/api/student/login')) {
          if (data && data.token) {
            localStorage.setItem('student_token', data.token);
          }
        } else if (url.includes('/api/student/session') && !url.includes('/api/student/session/')) {
          if (data && data.token) {
            localStorage.setItem('student_session_token', data.token);
          }
        } else if (url.includes('/api/admin/logout')) {
          localStorage.removeItem('admin_token');
        } else if (url.includes('/api/student/logout')) {
          localStorage.removeItem('student_token');
          localStorage.removeItem('student_session_token');
        }
      } catch (e) {
        console.error('Failed to intercept fetch auth response:', e);
      }
    }
  }

  return response;
};

// Safely override window.fetch using Object.defineProperty to handle read-only/getter-only constraints
try {
  Object.defineProperty(window, 'fetch', {
    value: customFetch,
    writable: true,
    configurable: true
  });
} catch (e) {
  try {
    // Fallback to direct assignment
    window.fetch = customFetch;
  } catch (e2) {
    try {
      // Fallback 2: Prototype definition
      Object.defineProperty(Window.prototype, 'fetch', {
        value: customFetch,
        writable: true,
        configurable: true
      });
    } catch (e3) {
      console.error('Failed to globally override fetch:', e3);
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
