export function collectorCredentialRejected(status) {
  return status === 401 || status === 403;
}

export async function clearRejectedCollectorCredential(storage, keys) {
  await storage.remove([keys.token, keys.policy, keys.pairing]);
}
