// SDK boundary fixture for custom account controls. This models the installed
// Clerk resource interfaces; it does not prove live provider delivery or policy.
import { useSyncExternalStore } from 'react';
import { ClerkRuntimeError } from '@clerk/react/errors';
import type { EmailAddressResource, SessionWithActivitiesResource, UserResource, SessionVerificationResource } from '@clerk/react/types';

const email = localStorage.getItem('e2e-email');
type State = { firstName: string; lastName: string; passwordEnabled: boolean; primaryId: string;
  addresses: { id: string; email: string; verified: boolean }[]; sessions: string[] };
const initial: State = {
  firstName: 'Isolated', lastName: 'browser tester', passwordEnabled: true, primaryId: 'email_primary',
  addresses: [{ id: 'email_primary', email: email ?? '', verified: true }], sessions: ['isolated-browser-session', 'other-device'],
};
const state: State = JSON.parse(sessionStorage.getItem('e2e-account-state') ?? 'null') ?? initial;
const listeners = new Set<() => void>();
function record(method: string, data?: unknown) {
  const events = JSON.parse(sessionStorage.getItem('e2e-account-events') ?? '[]');
  events.push({ method, data }); sessionStorage.setItem('e2e-account-events', JSON.stringify(events));
}
function failure(method: string) {
  if (localStorage.getItem('e2e-account-fail') === method) {
    localStorage.removeItem('e2e-account-fail'); throw new Error('Temporary account service failure. Please try again.');
  }
}
function publish() {
  sessionStorage.setItem('e2e-account-state', JSON.stringify(state));
  currentUser = makeUser(); listeners.forEach(listener => listener());
}
function addressResource(item: State['addresses'][number]): EmailAddressResource {
  return {
    id: item.id, emailAddress: item.email, verification: { status: item.verified ? 'verified' : 'unverified' },
    prepareVerification: async () => { record('email.prepare'); failure('email.prepare'); return addressResource(item); },
    attemptVerification: async ({ code }: { code: string }) => {
      record('email.verify');
      if (code !== '123456') throw new Error('That verification code is incorrect.');
      item.verified = true; publish(); return addressResource(item);
    },
    destroy: async () => { record('email.remove', item.id); failure('email.remove');
      if (item.id === state.primaryId) throw new Error('Cannot remove primary email.');
      state.addresses = state.addresses.filter(address => address.id !== item.id); publish(); },
  } as unknown as EmailAddressResource;
}
function deviceResource(id: string): SessionWithActivitiesResource {
  return {
    id, status: 'active', lastActiveAt: new Date('2026-11-11T08:00:00Z'),
    latestActivity: { browserName: id === 'other-device' ? 'Safari' : 'Chrome', deviceType: id === 'other-device' ? 'iPhone' : 'Mac', isMobile: id === 'other-device', city: 'London', country: 'United Kingdom' },
    revoke: async () => { record('session.revoke', id); failure('session.revoke');
      state.sessions = state.sessions.filter(item => item !== id); publish(); return deviceResource(id); },
  } as SessionWithActivitiesResource;
}
function makeUser(): UserResource {
  return {
    id: 'isolated-user', firstName: state.firstName, lastName: state.lastName,
    fullName: `${state.firstName} ${state.lastName}`, passwordEnabled: state.passwordEnabled,
    primaryEmailAddressId: state.primaryId,
    primaryEmailAddress: addressResource(state.addresses.find(item => item.id === state.primaryId)!),
    emailAddresses: state.addresses.map(addressResource),
    update: async (params: { firstName?: string; lastName?: string; primaryEmailAddressId?: string }) => {
      record('user.update', params); failure('user.update');
      if (params.primaryEmailAddressId) {
        if (!state.addresses.find(item => item.id === params.primaryEmailAddressId)?.verified) throw new Error('Email is not verified.');
        state.primaryId = params.primaryEmailAddressId;
      }
      if (params.firstName !== undefined) state.firstName = params.firstName;
      if (params.lastName !== undefined) state.lastName = params.lastName;
      publish(); return currentUser;
    },
    createEmailAddress: async ({ email: value }: { email: string }) => {
      record('email.create', value); failure('email.create');
      const item = { id: `email_${state.addresses.length}`, email: value, verified: false };
      state.addresses.push(item); publish(); return addressResource(item);
    },
    updatePassword: async ({ currentPassword, newPassword, signOutOfOtherSessions }: { currentPassword?: string; newPassword: string; signOutOfOtherSessions?: boolean }) => {
      record('password.update', { signOutOfOtherSessions }); failure('password.update');
      if (state.passwordEnabled && currentPassword !== 'Test-only password 47!') throw new Error('Current password is incorrect.');
      if (newPassword.length < 8) throw new Error('Password is too short.');
      state.passwordEnabled = true;
      if (signOutOfOtherSessions) state.sessions = state.sessions.filter(id => id === 'isolated-browser-session');
      publish(); return currentUser;
    },
    getSessions: async () => { record('sessions.list'); failure('sessions.list'); return state.sessions.map(deviceResource); },
  } as UserResource;
}
let currentUser = makeUser();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useFixtureUser() {
  const user = useSyncExternalStore(subscribe, () => currentUser);
  return { isLoaded: true, isSignedIn: Boolean(email), user: email ? user : null };
}
function verification(status: SessionVerificationResource['status']): SessionVerificationResource {
  return { status, supportedFirstFactors: [{ strategy: 'password' }, { strategy: 'email_code', emailAddressId: 'email_primary', safeIdentifier: 'a***@example.test' }],
    supportedSecondFactors: [{ strategy: 'totp' }, { strategy: 'backup_code' }] } as SessionVerificationResource;
}
export const fixtureSession = email ? {
  id: 'isolated-browser-session', getToken: async () => null,
  startVerification: async ({ level }: { level: string }) => {
    record('verification.start', { level }); failure('verification.start');
    return verification(localStorage.getItem('e2e-reverification') === 'strongest' && level === 'second_factor' ? 'needs_second_factor' : 'needs_first_factor');
  },
  prepareFirstFactorVerification: async () => { record('verification.send'); return verification('needs_first_factor'); },
  attemptFirstFactorVerification: async (params: { strategy: string; password?: string; code?: string }) => {
    record('verification.first');
    if (params.strategy === 'password' ? params.password !== 'Test-only password 47!' : params.code !== '123456') throw new Error('Verification failed. Please try again.');
    return verification(localStorage.getItem('e2e-reverification') === 'mfa' ? 'needs_second_factor' : 'complete');
  },
  attemptSecondFactorVerification: async ({ code }: { code: string }) => {
    record('verification.second'); if (code !== '654321') throw new Error('Invalid authenticator code.'); return verification('complete');
  },
} : null;

export function useFixtureReverification<T extends (...args: any[]) => Promise<unknown>>(action: T, options?: {
  onNeedsReverification?: (request: { level: 'multi_factor' | 'first_factor' | undefined; complete: () => void; cancel: () => void }) => void;
}) {
  return async (...args: Parameters<T>) => {
    if (localStorage.getItem('e2e-reverification')) {
      if (!options?.onNeedsReverification) throw new Error('Fixture requires custom verification UI.');
      await new Promise<void>((resolve, reject) => options.onNeedsReverification!({
        level: localStorage.getItem('e2e-reverification') === 'mfa' ? 'multi_factor' : localStorage.getItem('e2e-reverification') === 'strongest' ? undefined : 'first_factor',
        complete: () => { localStorage.removeItem('e2e-reverification'); resolve(); },
        cancel: () => reject(new ClerkRuntimeError('Cancelled', { code: 'reverification_cancelled' })),
      }));
    }
    return action(...args);
  };
}
