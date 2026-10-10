/**
 * Runtime account selection for the gateway.
 *
 * The server resolves one credential snapshot per request, at entry, and
 * every later read in that request reuses it. A switch made while a request
 * runs never changes that request's account. A switch applies to requests
 * that start after the store update succeeds.
 *
 * Precedence per request: an explicit `Authorization` or `x-api-key` header,
 * then a static fallback (`DEVIN_API_KEY`), then the active profile's token.
 * The active token is read from its profile file for each request, so a
 * re-enrolled or removed token takes effect without a restart. If the active
 * profile has no usable token, the request fails closed. It is never sent to
 * another profile.
 *
 * A static fallback is an explicit operator override. While one is set, a
 * switch to a different profile is refused so the admin UI never reports a
 * switch that inference does not honor.
 *
 * Token values are only returned inside a snapshot. They are never placed in
 * logs, health output, admin responses, or error messages.
 */
import { AccountStore, validateAccountUpdate, type AccountSelection } from "./account-store.js";
import { readProfileCredential, type AccountProfileId } from "./profiles.js";

export type CredentialOrigin = "request" | "static" | "account" | "none";

export interface CredentialSnapshot {
  /** Token for this request. Empty when no credential is available. */
  token: string;
  origin: CredentialOrigin;
  /** Profile id when the account path was considered; undefined before initialization. */
  profileId?: AccountProfileId;
}

export class SwitchingDisabledError extends Error {
  readonly code = "switching_disabled";
  constructor() {
    super("A static Devin credential is configured for this gateway, so the active account cannot be changed here.");
  }
}

export class AccountRuntime {
  private profileId: AccountProfileId | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly store: AccountStore,
    private readonly configDirectory: string,
    private readonly staticFallback: string,
  ) {}

  /** Loads the store. Call once at startup, before serving requests. */
  initialize(): Promise<AccountSelection> {
    return this.exclusive(async () => {
      const selection = await this.store.initialize();
      this.profileId = selection.activeProfileId;
      return selection;
    });
  }

  /** Reads the saved selection under the same lock as updates, so the admin view matches inference. */
  read(): Promise<AccountSelection> {
    return this.exclusive(async () => {
      const selection = await this.store.read();
      this.profileId = selection.activeProfileId;
      return selection;
    });
  }

  /** Non-secret. Undefined only before `initialize()` completes. */
  activeProfileId(): AccountProfileId | undefined {
    return this.profileId;
  }

  /** True when a static fallback is set and therefore overrides account selection. */
  get hasStaticFallback(): boolean {
    return this.staticFallback !== "";
  }

  /** Whether the active profile currently has a usable token file. Never returns the token. */
  async activeTokenConfigured(): Promise<boolean> {
    if (this.profileId === undefined) return false;
    return (await readProfileCredential(this.configDirectory, this.profileId)) !== "";
  }

  /** Resolve the credential for one request. Callers keep the returned object for the whole request. */
  async snapshot(requestToken: string): Promise<CredentialSnapshot> {
    if (requestToken) return { token: requestToken, origin: "request" };
    if (this.staticFallback) return { token: this.staticFallback, origin: "static" };
    const profileId = this.profileId;
    if (profileId === undefined) return { token: "", origin: "none" };
    const token = await readProfileCredential(this.configDirectory, profileId);
    return token ? { token, origin: "account", profileId } : { token: "", origin: "none", profileId };
  }

  /**
   * Validate and save an account update. Store writes and the in-memory profile
   * change run under one lock so overlapping updates cannot disagree.
   */
  update(value: unknown, expectedETag: string): Promise<AccountSelection> {
    const proposed = validateAccountUpdate(value);
    return this.exclusive(async () => {
      if (this.staticFallback) {
        const current = await this.store.read();
        this.profileId = current.activeProfileId;
        if (proposed.activeProfileId !== current.activeProfileId) throw new SwitchingDisabledError();
      }
      const selection = await this.store.update(value, expectedETag);
      this.profileId = selection.activeProfileId;
      return selection;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}