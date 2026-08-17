function hashToUint32(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = ((hash * 31 + input.charCodeAt(i)) & 0xffffffff) >>> 0;
  return hash;
}

export function createNonce(account: string): string {
  const rand6 = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const base = `${Date.now()}${rand6}`;
  const sec = base.slice(0, -9);
  const input = `${sec}${account.toLowerCase()}`;
  const h = hashToUint32(input);
  return base.slice(0, -6) + String(h).slice(-6).padStart(6, '0');
}
