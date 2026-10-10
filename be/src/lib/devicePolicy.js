// Effective device cap — THE single policy point (enroll, approve, the app's
// device list, the admin panel and /api/me all read this):
//
//   admin override  (maxDevicesOverride — set from the admin panel; beats all)
//   premium         (deviceLimitPremium, default 5)
//   identity-verified (deviceLimitVerified, default 2)
//   unverified      (deviceLimitUnverified, default 1)
//
// A staff TIMEOUT (lib/moderation.js) makes the account read as UNVERIFIED
// here — an admin-flagged account falls back to the unverified tier.
//
// The legacy stored doc.maxDevices is NO LONGER consulted: caps follow the
// flags dynamically, so flipping verification/premium takes effect without
// touching device rows.

import { timeoutActive } from './moderation.js';

export function effectiveMaxDevices(doc, config) {
  if (Number.isInteger(doc.maxDevicesOverride) && doc.maxDevicesOverride >= 1) {
    return doc.maxDevicesOverride;
  }
  if (doc.premium === true) return config.deviceLimitPremium;
  return (doc.verified === true && !timeoutActive(doc))
    ? config.deviceLimitVerified : config.deviceLimitUnverified;
}
