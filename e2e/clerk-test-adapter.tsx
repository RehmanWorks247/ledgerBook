// Test-only browser identity adapter, resolved only by e2e/server.ts.
// Application authorization still uses real local sessions and the real API.
import type { ReactNode } from 'react';
import { fixtureSession, useFixtureUser, useFixtureReverification } from './account-clerk-fixture';

const email = localStorage.getItem('e2e-email');
const session = fixtureSession;
const clerk = {
  session,
  signOut: async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Protection': '1' } });
    localStorage.removeItem('e2e-email');
    location.assign('/login');
  },
};
export function ClerkProvider({ children }: { children: ReactNode }) { return children; }
export function useClerk() { return clerk; }
export function useAuth() { return { isLoaded: true, isSignedIn: Boolean(email), sessionId: session?.id }; }
export const useUser = useFixtureUser;
export const useReverification = useFixtureReverification;
export function useSignIn() { return { signIn: {} }; }
export function useSignUp() { return { signUp: {} }; }
