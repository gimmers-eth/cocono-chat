// Browser-side account teardown — the counterpart to the server's
// deleteAccountFully. When an account is GONE (its last device detached, or
// an admin removed the account), NOTHING about it may survive in this
// browser, or a future re-registration of the same username would inherit a
// stranger's cached transcript (the app DB is keyed by username, not device).
//
// Two stores make up a device's copy of an account:
//   * the APP db  (cocono-app:<ul>)  — transcripts, friends/pins/peers
//     mirrors, read marks — dropped by deleteAccountData(ul).
//   * the SDK identity (cocono-client-sdk, identity:<ul>) — the device's key
//     pair + session — dropped by client.forget().
// Together they are the full local wipe; call order is irrelevant (they are
// independent stores).
//
// A leaf module (imports only store.js, takes `client` as an argument) so
// both main.js and the home component can use it with no import cycle.
import { deleteAccountData } from './store.js';

export async function purgeLocalAccount(client, username) {
  const ul = String(username ?? '').toLowerCase();
  if (ul) await deleteAccountData(ul).catch(() => { /* already gone */ });
  await client.forget?.().catch(() => { /* no identity to drop */ });
}
