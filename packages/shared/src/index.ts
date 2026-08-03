export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
