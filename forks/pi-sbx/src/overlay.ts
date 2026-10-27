export async function applyAfterPersist(
  persist: () => Promise<void>,
  apply: () => void,
): Promise<void> {
  await persist();
  apply();
}
