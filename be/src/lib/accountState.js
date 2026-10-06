// Server-side account teardown, shared by the admin routes and the
// self-service device detach (removing the LAST device deletes the account).

// L9 fix: removing an account should also sweep its Redis state (login
// nonces, pending/approved enrollments, per-account rate-limit counters)
// instead of leaving it to TTL expiry.
export async function cleanupAccountState(redis, ul) {
  await redis.del(`rl:verify:${ul}`, `rl:dapprove:${ul}`, `rl:dpending:${ul}`);

  for await (const batch of redis.scanIterator({ MATCH: `denroll:c:${ul}:*`, COUNT: 100 })) {
    for (const key of batch) {
      const raw = await redis.getDel(key);
      try {
        const { enrollId } = JSON.parse(raw);
        await redis.del(`denroll:p:${enrollId}`, `denroll:ok:${enrollId}`);
      } catch {
        // Not a enrollment record — ignore.
      }
    }
  }

  // Login nonces are keyed by the nonce itself; inspect the bound account.
  for await (const batch of redis.scanIterator({ MATCH: 'auth:nonce:*', COUNT: 100 })) {
    for (const key of batch) {
      try {
        const bound = JSON.parse(await redis.get(key));
        if (bound?.ul === ul) await redis.del(key);
      } catch {
        // ignore
      }
    }
  }
}
