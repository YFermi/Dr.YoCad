import * as React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { useAuthStore } from '@/lib/auth';
import { ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isLoading } = useAuthStore();
  const [email, setEmail] = React.useState('admin@demo.local');
  const [password, setPassword] = React.useState('Password123!');
  const [error, setError] = React.useState<string | null>(null);

  const redirectTo =
    (location.state as { from?: string } | null)?.from ?? '/projects';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await login(email.trim(), password);
      toast({ title: 'Signed in', variant: 'success' });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const message =
        err instanceof ApiClientError || err instanceof Error
          ? err.message
          : 'Unable to sign in';
      setError(message);
    }
  };

  const handleOAuthStub = (provider: 'Google' | 'Microsoft') => {
    toast({
      title: `${provider} SSO is stubbed`,
      description: 'OAuth interfaces are wired in Session 1; configure client keys in a later session.',
      variant: 'default',
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Layers className="h-5 w-5" />
          </div>
          <span className="font-display text-xl font-bold tracking-tight text-foreground">
            Dr.Yo CAD
          </span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in to your workspace</CardTitle>
            <CardDescription>
              Access 2D/3D engineering assemblies, revisions, and design reviews.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {error}
                </div>
              )}

              <div className="space-y-1.5">
                <label
                  htmlFor="login-email"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Work email
                </label>
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@demo.local"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="login-password"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Password
                </label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                />
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Signing in...' : 'Sign in'}
              </Button>
            </form>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or continue with</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOAuthStub('Google')}
              >
                Google
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOAuthStub('Microsoft')}
              >
                Microsoft
              </Button>
            </div>
          </CardContent>

          <CardFooter className="flex flex-col items-stretch gap-3 border-t border-border pt-4">
            <p className="text-center text-xs text-muted-foreground">
              Demo credentials:{' '}
              <span className="font-mono text-foreground">admin@demo.local</span> /{' '}
              <span className="font-mono text-foreground">Password123!</span>
            </p>
            <p className="text-center text-xs text-muted-foreground">
              Need an account?{' '}
              <Link
                to="/register"
                className="font-medium text-primary hover:underline"
              >
                Create workspace
              </Link>
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
