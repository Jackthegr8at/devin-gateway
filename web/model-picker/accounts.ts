/**
 * Browser client for the Devin account profile contract.
 * Responses are read through an allowlist: names and credential state only, never token or credential fields.
 */
export const ACCOUNT_PROFILE_IDS = ["personal", "team"] as const;
export type AccountProfileId = (typeof ACCOUNT_PROFILE_IDS)[number];
export type AccountCredentialState = "configured" | "unconfigured" | "invalid";
const CREDENTIAL_STATES = ["configured", "unconfigured", "invalid"] as const;

export interface AccountProfile { readonly id: AccountProfileId; readonly name: string; readonly credentialState: AccountCredentialState }
export interface AccountsSnapshot { readonly revision: number; readonly etag: string; readonly activeProfileId: AccountProfileId; readonly staticOverride: boolean; readonly profiles: readonly AccountProfile[] }
export interface AccountsUpdate { readonly activeProfileId: AccountProfileId; readonly profiles: readonly { readonly id: AccountProfileId; readonly name: string }[] }
export interface AccountsApi { load(): Promise<AccountsSnapshot>; save(update: AccountsUpdate, etag: string): Promise<AccountsSnapshot> }

/** User-facing copy. Server text is shown only for the 400 invalid_accounts and 409 account_unconfigured codes. */
export const ACCOUNTS_MESSAGES = {
  network: "The management gateway could not be reached. Check your HTTPS connection or local management access, then retry.",
  invalidData: "The gateway returned invalid account data. Reload after checking the gateway.",
  load: "Accounts could not be loaded. Retry, or reload the picker.",
  update: "Accounts could not be saved. Reload to check the saved state before trying again.",
  unavailable: "Accounts are unavailable right now. Try again shortly.",
  conflict: "Accounts changed somewhere else. The latest settings are loaded. Review them before you try again.",
  conflictReloadFailed: "Accounts changed somewhere else, and the latest settings could not be loaded. Retry loading accounts.",
  invalidNames: "The account names could not be saved. Check the names and try again.",
  unconfigured: "That account is not signed in. Sign in from the server terminal first. The active account did not change.",
  emptyName: "Each account needs a name before you save.",
} as const;

const ETAG = /^"accounts-v1-(0|[1-9]\d*)"$/;
const ACCOUNTS_PATH = "/admin/api/accounts";
const MAX_SERVER_TEXT = 200;

export class AccountsApiError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message); this.name = "AccountsApiError"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProfileId(value: unknown): value is AccountProfileId {
  return ACCOUNT_PROFILE_IDS.includes(value as AccountProfileId);
}
function isCredentialState(value: unknown): value is AccountCredentialState {
  return CREDENTIAL_STATES.includes(value as AccountCredentialState);
}
function invalidData() { return new AccountsApiError(0, null, ACCOUNTS_MESSAGES.invalidData); }

/** Copies only the known fields. The ETag must match the revision exactly. */
function parseAccounts(value: unknown, etag: string): AccountsSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) throw invalidData();
  const { revision, activeProfileId, profiles, staticOverride } = value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || etag !== `"accounts-v1-${revision}"`) throw invalidData();
  if (!isProfileId(activeProfileId) || typeof staticOverride !== "boolean" || !Array.isArray(profiles) || profiles.length !== ACCOUNT_PROFILE_IDS.length) throw invalidData();
  const parsed = profiles.map((profile, index): AccountProfile => {
    const id = ACCOUNT_PROFILE_IDS[index];
    if (!isRecord(profile) || profile.id !== id || typeof profile.name !== "string" || profile.name.trim() === ""
      || !isCredentialState(profile.credentialState)) throw invalidData();
    return { id, name: profile.name, credentialState: profile.credentialState };
  });
  return { revision, etag, activeProfileId, staticOverride, profiles: parsed };
}

async function snapshotFrom(response: Response): Promise<AccountsSnapshot> {
  let body: unknown;
  try { body = await response.json(); } catch { throw invalidData(); }
  return parseAccounts(body, response.headers.get("etag") ?? "");
}

function serverText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_SERVER_TEXT ? value.trim() : null;
}

async function errorDetails(response: Response): Promise<{ code: string | null; message: unknown }> {
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    return { code: typeof error?.code === "string" ? error.code : null, message: error?.message };
  } catch { return { code: null, message: undefined }; }
}

/** Maps a non-OK response to fixed copy. 412 is reported as a conflict so the caller can reload. */
async function rejection(response: Response, context: "load" | "save"): Promise<AccountsApiError> {
  const { code, message } = await errorDetails(response);
  const generic = context === "load" ? ACCOUNTS_MESSAGES.load : ACCOUNTS_MESSAGES.update;
  if (response.status === 412) return new AccountsApiError(412, code, ACCOUNTS_MESSAGES.conflict);
  if (response.status === 503) return new AccountsApiError(503, code, ACCOUNTS_MESSAGES.unavailable);
  if (response.status === 400 && context === "save" && code === "invalid_accounts") {
    return new AccountsApiError(400, code, serverText(message) ?? ACCOUNTS_MESSAGES.invalidNames);
  }
  if (response.status === 409 && context === "save" && (code === "account_unconfigured" || code === "switching_disabled")) {
    return new AccountsApiError(409, code, serverText(message) ?? ACCOUNTS_MESSAGES.unconfigured);
  }
  return new AccountsApiError(response.status, code, generic);
}

/** Validates the outgoing body before any request is sent. Names are trimmed. */
function updateBody(update: AccountsUpdate) {
  if (!isProfileId(update.activeProfileId)) throw new AccountsApiError(0, null, ACCOUNTS_MESSAGES.invalidNames);
  return {
    activeProfileId: update.activeProfileId,
    profiles: ACCOUNT_PROFILE_IDS.map((id) => {
      const name = update.profiles.find((profile) => profile.id === id)?.name.trim() ?? "";
      if (name === "") throw new AccountsApiError(0, null, ACCOUNTS_MESSAGES.emptyName);
      return { id, name };
    }),
  };
}

export function createAccountsApi(send: typeof fetch = fetch): AccountsApi {
  async function request(init: RequestInit = {}): Promise<Response> {
    try {
      return await send(ACCOUNTS_PATH, { ...init, mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    } catch { throw new AccountsApiError(0, null, ACCOUNTS_MESSAGES.network); }
  }
  return {
    async load() {
      const response = await request();
      if (!response.ok) throw await rejection(response, "load");
      return snapshotFrom(response);
    },
    async save(update, etag) {
      if (!ETAG.test(etag)) throw new AccountsApiError(0, null, ACCOUNTS_MESSAGES.update);
      const body = updateBody(update);
      const response = await request({
        method: "PUT",
        headers: { "content-type": "application/json", "x-devin-management": "1", "if-match": etag },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await rejection(response, "save");
      return snapshotFrom(response);
    },
  };
}