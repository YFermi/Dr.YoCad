import * as React from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/auth';
import { AppShell } from '@/components/layout/AppShell';
import { Toaster } from '@/components/ui/toast';
import { LoginPage } from '@/pages/Login';
import { RegisterPage } from '@/pages/Register';
import { ProjectsPage } from '@/pages/Projects';
import { ProjectDetailPage } from '@/pages/ProjectDetail';
import { FileViewerPage } from '@/pages/FileViewer';
import { ShareViewPage } from '@/pages/ShareView';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
});

function ProtectedRoute({
  children,
  useLayoutShell = false,
  fullBleed = false,
}: {
  children: React.ReactNode;
  useLayoutShell?: boolean;
  fullBleed?: boolean;
}) {
  const location = useLocation();
  const { user, isHydrated } = useAuthStore();

  if (!isHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading workspace...
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  if (useLayoutShell) {
    return <AppShell fullBleed={fullBleed}>{children}</AppShell>;
  }

  return <>{children}</>;
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, isHydrated } = useAuthStore();
  if (!isHydrated) return null;
  if (user) return <Navigate to="/projects" replace />;
  return <>{children}</>;
}

export default function App() {
  const hydrate = useAuthStore((s) => s.hydrate);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route
            path="/login"
            element={
              <PublicOnlyRoute>
                <LoginPage />
              </PublicOnlyRoute>
            }
          />
          <Route
            path="/register"
            element={
              <PublicOnlyRoute>
                <RegisterPage />
              </PublicOnlyRoute>
            }
          />
          <Route
            path="/projects"
            element={
              <ProtectedRoute useLayoutShell>
                <ProjectsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <ProtectedRoute>
                <ProjectDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/files/:id"
            element={
              <ProtectedRoute useLayoutShell fullBleed>
                <FileViewerPage />
              </ProtectedRoute>
            }
          />
          <Route path="/share/:token" element={<ShareViewPage />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
