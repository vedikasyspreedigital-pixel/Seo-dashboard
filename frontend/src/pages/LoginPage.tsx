import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { InlineError } from '../components/ui/InlineError';
import { TextInput } from '../components/ui/TextInput';
import { useSession } from '../context/SessionContext';

export function LoginPage() {
  const { user, loading, login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already logged in (e.g. navigated here directly) -- go straight in,
  // back to wherever RequireAuth redirected from if it did.
  if (!loading && user) {
    const from = (location.state as { from?: Location })?.from;
    return <Navigate to={from?.pathname ?? '/overview'} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      const from = (location.state as { from?: Location })?.from;
      navigate(from?.pathname ?? '/overview', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="app-backdrop flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm p-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-ink)]">Sign in</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">SERP Console</p>

        <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Username</label>
            <TextInput
              type="text"
              required
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-ink-muted)]">Password</label>
            <TextInput type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          <InlineError message={error} />

          <Button type="submit" disabled={submitting} className="mt-2 justify-center">
            {submitting && <Spinner />}
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
