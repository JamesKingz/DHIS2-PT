import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthApiError, loginApi, PERMISSION_NAMES, resendOtpApi, verifyOtpApi } from '.././services/authApi';
import type { OtpChallenge } from '.././services/authApi';
import { hasPermission } from '../auth/authorization';
import { useAuth } from '../auth/AuthContext';
import { TransitionOverlay } from '../TransitionOverlay/TransitionOverlay';
import './LoginPage.css';

interface LoginCredentials {
  email: string;
  password: string;
  rememberMe: boolean;
}

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { status, user: authenticatedUser, setAuthenticatedUser } = useAuth();

  const [formData, setFormData] = useState<LoginCredentials>({
    email: '',
    password: '',
    rememberMe: false,
  });

  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [otpChallenge, setOtpChallenge] = useState<OtpChallenge | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [resendInSeconds, setResendInSeconds] = useState(0);
  const [showAuthTransition, setShowAuthTransition] = useState(false);

  // Paused state after the server-side rate limit (5 login attempts) is hit.
  // lockoutUntil is an epoch-ms timestamp; while in the future the Sign in
  // button is disabled so further clicks can't be sent.
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(() => {
    try {
      const stored = window.localStorage.getItem('login_lockout_until');
      const parsed = stored ? Number(stored) : NaN;
      return Number.isFinite(parsed) && parsed > Date.now() ? parsed : null;
    } catch {
      return null;
    }
  });
  const [lockoutRemaining, setLockoutRemaining] = useState<number>(() => {
    try {
      const stored = window.localStorage.getItem('login_lockout_until');
      const parsed = stored ? Number(stored) : NaN;
      if (Number.isFinite(parsed) && parsed > Date.now()) {
        return Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
      }
    } catch {
      // ignore — defaults to 0 below  
    }
    return 0;
  });
  const isLocked = lockoutUntil !== null && lockoutRemaining > 0;

  const formatLockout = (totalSeconds: number): string => {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  };

  const enterLockout = (retryAfterSeconds?: number) => {
    const fallbackSeconds = 15 * 60;
    const seconds =
      typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.ceil(retryAfterSeconds)
        : fallbackSeconds;
    const until = Date.now() + seconds * 1000;
    setLockoutUntil(until);
    setLockoutRemaining(seconds);
    try {
      window.localStorage.setItem('login_lockout_until', String(until));
    } catch {
      // Storage unavailable (private mode etc.) — in-memory lockout still applies.
    }
  };

  const clearLockout = () => {
    setLockoutUntil(null);
    setLockoutRemaining(0);
    setFailedAttempts(0);
    try {
      window.localStorage.removeItem('login_lockout_until');
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!showAuthTransition && status === 'authenticated' && authenticatedUser) {
      navigate(hasPermission(authenticatedUser, PERMISSION_NAMES.USER_MANAGE) ? '/admin' : '/dashboard');
    }
  }, [authenticatedUser, navigate, showAuthTransition, status]);

  useEffect(() => {
    if (!otpChallenge) return undefined;
    const updateCountdown = () => {
      setResendInSeconds(Math.max(0, Math.ceil((new Date(otpChallenge.resendAvailableAt).getTime() - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [otpChallenge]);

  useEffect(() => {
    if (!lockoutUntil) {
      setLockoutRemaining(0);
      return undefined;
    }
    const updateLockoutCountdown = () => {
      const remaining = Math.max(0, Math.ceil((lockoutUntil - Date.now()) / 1000));
      setLockoutRemaining(remaining);
      if (remaining <= 0) {
        setLockoutUntil(null);
        setFailedAttempts(0);
        try {
          window.localStorage.removeItem('login_lockout_until');
        } catch {
          // ignore
        }
      }
    };
    updateLockoutCountdown();
    const timer = window.setInterval(updateLockoutCountdown, 1000);
    return () => window.clearInterval(timer);
    // clearLockout intentionally inlined here to keep this effect dependent only on lockoutUntil.
    /// eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockoutUntil]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const validateForm = (): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!formData.email.trim()) {
      setErrorMessage('Please enter your institutional email address.');
      return false;
    }

    if (!emailRegex.test(formData.email.trim())) {
      setErrorMessage('Please enter a valid email address (e.g., name@moh.go.tz).');
      return false;
    }

    if (!formData.password) {
      setErrorMessage('Please enter your password.');
      return false;
    }

    if (formData.password.length < 6) {
      setErrorMessage('Password must be at least 6 characters long.');
      return false;
    }

    return true;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isLocked) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!validateForm()) return;

    setLoading(true);

    try {
      const challenge = await loginApi(formData.email, formData.password, formData.rememberMe);
      setFailedAttempts(0);
      setOtpChallenge(challenge);
      setOtpCode('');
      setSuccessMessage('A verification code was sent to your email.');
      setLoading(false);
    } catch (err: unknown) {
      if (err instanceof AuthApiError && err.status === 429) {
        enterLockout(err.retryAfterSeconds);
        setErrorMessage(
          `Too many sign-in attempts. The Sign in button is paused. Try again in ${formatLockout(
            err.retryAfterSeconds && Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds > 0
              ? Math.ceil(err.retryAfterSeconds)
              : 15 * 60,
          )}.`,
        );
      } else {
        const nextFailed = failedAttempts + 1;
        setFailedAttempts(nextFailed);
        if (err instanceof Error) {
          setErrorMessage(err.message);
        } else {
          setErrorMessage('An unexpected error occurred during authentication.');
        }
      }
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isLocked) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!/^\d{6}$/.test(otpCode)) {
      setErrorMessage('Enter the six-digit verification code.');
      return;
    }

    setLoading(true);
    const transitionStartedAt = Date.now();
    setShowAuthTransition(true);
    try {
      const user = await verifyOtpApi(otpChallenge!.challengeId, otpCode, formData.rememberMe);
      clearLockout();
      setAuthenticatedUser(user);
      setSuccessMessage('Login successful!');
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, 900 - (Date.now() - transitionStartedAt))));
      navigate(hasPermission(user, PERMISSION_NAMES.USER_MANAGE) ? '/admin' : '/dashboard');
    } catch (err: unknown) {
      setShowAuthTransition(false);
      if (err instanceof AuthApiError && err.status === 429) {
        enterLockout(err.retryAfterSeconds);
        setErrorMessage('Too many verification attempts. Buttons are paused. Please wait before trying again.');
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Verification failed.');
      }
      setLoading(false);
    }
    finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!otpChallenge || resendInSeconds > 0 || loading || isLocked) return;
    setErrorMessage(null);
    setLoading(true);
    try {
      const challenge = await resendOtpApi(otpChallenge.challengeId);
      setOtpChallenge(challenge);
      setOtpCode('');
      setSuccessMessage('A new verification code was sent.');
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Unable to resend the verification code.');
    } finally {
      setLoading(false);
    }
  };

  const restartLogin = () => {
    setOtpChallenge(null);
    setOtpCode('');
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  return (
    <div className="login-container">
      {showAuthTransition && <TransitionOverlay message="Signing you in..." detail="Preparing your workspace." />}
      <div className="left-pane">
        <div className="brand-header">
          <div className="brand-icon" />
          <div>
            <h2 className="brand-title">PMS V1.0</h2>
            <p className="brand-subtitle">Project Management Software</p>
          </div>
        </div>

        <div className="hero-content">
          <h1 className="hero-title">
            Manage projects,<br />
            deliver with confidence.
          </h1>
          <p className="hero-description">
            Organise project work, share documents with the right people, and monitor progress from planning through completion. All in one secure workspace.
          </p>
        </div>
      </div>

      <div className="right-pane">
        <div className="form-container">
          <h2 className="form-title">Log in</h2>
          <p className="form-subtitle">Use your institutional account.</p>

          {errorMessage && <div className="error-box">{errorMessage}</div>}
          {successMessage && <div className="success-box">{successMessage}</div>}

          {otpChallenge ? (
            <form onSubmit={handleVerifyOtp} className="login-form" noValidate>
              <p className="login-redirect">
                Enter the six-digit code sent to <strong>{formData.email}</strong>.
              </p>
              <div className="input-group">
                <label className="input-label" htmlFor="otpCode">Verification code</label>
                <input
                  id="otpCode"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="form-input"
                  autoFocus
                />
                <span className="otp-help">
                  Code expires in {Math.max(0, Math.ceil((new Date(otpChallenge.expiresAt).getTime() - Date.now()) / 60000))} minutes.
                </span>
              </div>
              <button
                type="submit"
                disabled={loading || isLocked}
                className={`submit-button${isLocked ? ' is-paused' : ''}`}
                title={isLocked ? `Paused. Try again in ${formatLockout(lockoutRemaining)}` : undefined}
              >
                {isLocked ? `Paused. Try again in ${formatLockout(lockoutRemaining)}` : loading ? 'Verifying...' : 'Verify and sign in'}
              </button>
              <button type="button" disabled={loading || isLocked || resendInSeconds > 0} className="secondary-button" onClick={handleResendOtp}>
                {resendInSeconds > 0 ? `Resend code in ${resendInSeconds}s` : 'Resend code'}
              </button>
              <button type="button" disabled={loading} className="back-button" onClick={restartLogin}>
                Use a different account
              </button>
            </form>
          ) : (
          <form onSubmit={handleSubmit} className="login-form" noValidate>
            <p className="login-redirect">
              Don&apos;t have an account?{' '}
              <button type="button" onClick={() => navigate('/register')} className="register-link">
                Register
              </button>
            </p>

            <div className="input-group">
              <label className="input-label" htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="peter.salum@moh.go.tz"
                className="form-input"
                disabled={loading || isLocked}
              />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="password">Password</label>
              <div className="password-input-wrapper">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  placeholder="••••••••••••"
                  className="form-input password-input"
                  disabled={loading || isLocked}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <div className="options-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="rememberMe"
                  checked={formData.rememberMe}
                  onChange={handleChange}
                  className="checkbox-input"
                />
                Keep me signed in
              </label>
              <a href="/forgot-password" className="forgot-link">Forgot password</a>
            </div>

            <button
              type="submit"
              disabled={loading || isLocked}
              className={`submit-button${isLocked ? ' is-paused' : ''}`}
              title={isLocked ? `Paused. Try again in ${formatLockout(lockoutRemaining)}` : undefined}
            >
              {isLocked ? `Paused. Try again in ${formatLockout(lockoutRemaining)}` : loading ? 'Signing in...' : 'Sign in'}
            </button>
            {failedAttempts > 0 && !isLocked && (
              <span className="otp-help" role="status">
                {failedAttempts >= 5
                  ? 'Limit reached. The next attempt may pause Sign in.'
                  : `${5 - failedAttempts} of 5 attempts remaining before Sign in pauses.`}
              </span>
            )}
          </form>
          )}

          <p className="footer-note">Two-factor verification is required for every sign-in</p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
