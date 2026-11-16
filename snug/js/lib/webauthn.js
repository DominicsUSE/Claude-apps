// Passkeys in the browser (v0.12): the native WebAuthn API with JSON in and out.
// Browsers that have PublicKeyCredential.parse*OptionsFromJSON and toJSON() use
// them; older ones get the same shapes from the small base64url code below.
// No library: the server (server/passkeys.js) speaks the standard JSON forms.

const fromB64u = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const toB64u = (buf) => {
  if (buf == null) return null;
  let s = '';
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const PKC = () => globalThis.PublicKeyCredential;

/** Can this browser make or use a passkey here? (The server separately says whether it allows them.) */
export const passkeysHere = () => !!PKC() && !!globalThis.isSecureContext && !!navigator.credentials;

export async function conditionalAvailable() {
  try { return !!(await PKC()?.isConditionalMediationAvailable?.()); } catch { return false; }
}

function creationOptions(o) {
  if (PKC().parseCreationOptionsFromJSON) return PKC().parseCreationOptionsFromJSON(o);
  return {
    ...o,
    challenge: fromB64u(o.challenge),
    user: { ...o.user, id: fromB64u(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
  };
}
function requestOptions(o) {
  if (PKC().parseRequestOptionsFromJSON) return PKC().parseRequestOptionsFromJSON(o);
  return { ...o, challenge: fromB64u(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })) };
}
function toJSON(cred) {
  try { if (typeof cred.toJSON === 'function') return cred.toJSON(); } catch { /* the fallback below */ }
  const r = cred.response;
  const out = { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment ?? null, clientExtensionResults: cred.getClientExtensionResults?.() || {}, response: { clientDataJSON: toB64u(r.clientDataJSON) } };
  if (r.attestationObject) Object.assign(out.response, { attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() || [] });
  else Object.assign(out.response, { authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: toB64u(r.userHandle) });
  return out;
}

/** Make a passkey from the server's creation options; resolves with the JSON to send back. */
export async function createPasskey(options) {
  return toJSON(await navigator.credentials.create({ publicKey: creationOptions(options) }));
}

/** Use a passkey. `conditional`: offered in the username field's autofill, waits until picked (or `signal` aborts). */
export async function getPasskey(options, { conditional = false, signal } = {}) {
  const cred = await navigator.credentials.get({ publicKey: requestOptions(options), ...(conditional ? { mediation: 'conditional' } : {}), ...(signal ? { signal } : {}) });
  return cred ? toJSON(cred) : null;
}

/** Words for the browser's own refusals (the server's come with their own message). */
export function passkeyProblem(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return 'The passkey wasn’t used. Try again when you’re ready.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (e?.name === 'SecurityError') return 'Passkeys need this server to use HTTPS with a domain name.';
  return e?.message || 'That passkey didn’t work. Try again.';
}

export const _test = { fromB64u, toB64u };
