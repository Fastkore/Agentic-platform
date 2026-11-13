const bounded = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 16 ? parsed : fallback;
};
export const executorCapacity = () => bounded(process.env.BRIDGE_EXECUTOR_CONCURRENCY, 4);
export const providerCapacity = (provider: string) => provider === 'glm' ? bounded(process.env.BRIDGE_GLM_CONCURRENCY, 2) : 1;
