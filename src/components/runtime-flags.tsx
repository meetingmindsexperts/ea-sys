"use client";

/**
 * RUNTIME DEPLOYMENT FLAGS, handed down from the server layout.
 *
 * WHY NOT `NEXT_PUBLIC_*`. A `NEXT_PUBLIC_` variable is INLINED AT BUILD TIME.
 * Master and the platform instance are built from ONE image and differ only in
 * their environment, so a build-time constant would carry whichever value the CI
 * runner happened to have and would be identical on both. Every per-deployment
 * flag therefore has to be read on the server at request time and passed to the
 * client, which is what this provider is for.
 *
 * WHY NOT `process.env` IN THE CLIENT COMPONENT DIRECTLY. Next does not expose
 * non-public env vars to the browser bundle, so the read silently yields
 * `undefined` rather than failing. That is the worst shape of bug available
 * here: the flag reads false, the feature is invisible, and nothing anywhere
 * says why.
 *
 * WHY NOT AN API CALL. The server layout already runs on every dashboard
 * request and already knows the answer, so fetching it again would be a request
 * per session to learn something we were holding.
 */

import { createContext, useContext } from "react";

export interface RuntimeFlags {
  /** Is the HR module switched on for this deployment? Master silo only. */
  hrEnabled: boolean;
}

const DEFAULTS: RuntimeFlags = { hrEnabled: false };

const RuntimeFlagsContext = createContext<RuntimeFlags>(DEFAULTS);

export function RuntimeFlagsProvider({
  flags,
  children,
}: {
  flags: RuntimeFlags;
  children: React.ReactNode;
}) {
  return (
    <RuntimeFlagsContext.Provider value={flags}>
      {children}
    </RuntimeFlagsContext.Provider>
  );
}

/**
 * Reads the flags. Defaults to everything OFF outside a provider, so a component
 * rendered somewhere unexpected hides a gated feature rather than showing one
 * that is not there.
 */
export function useRuntimeFlags(): RuntimeFlags {
  return useContext(RuntimeFlagsContext);
}
