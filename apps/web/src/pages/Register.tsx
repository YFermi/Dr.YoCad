import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

export function RegisterPage() {
  const navigate = useNavigate();
  const { register, isLoading } = useAuthStore();
  const [name, setName] = React.useState('');
  const [organizationName, setOrganizationName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    try {
      await register({
        name: name.trim(),
        email: email.trim(),
        password,
        ...(organizationName.trim()
          ? { organizationName: organizationName.trim() }
          : {}),
      });
      toast({
        title: 'Workspace created',
        description: 'Your account is ready.',
        variant: 'success',
      });
      navigate('/projects', { replace: true });
    } catch (err) {
      const message =
        err instanceof ApiClientError || err instanceof Error
          ? err.message
          : 'Registration failed';
      setError(message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Layers className="h-5 w-5" />
          </div>
          <span className="font-display text-xl font-bold tracking-tight text-foreground">
            Cadline
          </span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Create your engineering workspace</CardTitle>
            <CardDescription>
              Start organizing CAD assemblies, revisions, and stakeholder reviews.
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
                  htmlFor="register-name"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Full name
                </label>
                <Input
                  id="register-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jordan Rivera"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="register-org"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Organization name (optional)
                </label>
                <Input
                  id="register-org"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Apex Robotics"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="register-email"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Work email
                </label>
                <Input
                  id="register-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jordan@apexrobotics.io"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="register-password"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Password (min 8 characters)
                </label>
                <Input
                  id="register-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Create a strong password"
                />
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Creating workspace...' : 'Create account'}
              </Button>
            </form>
          </CardContent>

          <CardFooter className="justify-center border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Already have an account?{' '}
              <Link to="/login" className="font-medium text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
