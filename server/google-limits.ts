import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodexLimits } from '../shared/types.js';

const unavailable = (message: string): CodexLimits => ({ provider: 'antigravity', buckets: [], resetsAvailable: null, unavailableReason: message });

// Accept the CLI's grouped /usage JSON and the documented quota-map representation.
// Only explicit remaining fractions are percentages; missing and absolute counts are never treated as zero.
export function parseGoogleLimits(payload: unknown): CodexLimits {
  const buckets: CodexLimits['buckets'] = [];
  function visit(value: unknown, name = '', modelIds: string[] = [], depth = 0) {
    if (depth > 6 || buckets.length > 100 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, name, modelIds, depth + 1); return; }
    const row = value as Record<string, unknown>;
    if (row.disabled === true) return;
    const ids = Array.isArray(row.model_ids) ? row.model_ids.filter((id): id is string => typeof id === 'string') : modelIds;
    const title = [name, row.name ?? row.label ?? row.id].filter(part => typeof part === 'string' && part).join(' · ');
    const fraction = row.remaining_fraction;
    if (typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && row.disabled !== true) {
      const reset = typeof row.reset_time === 'string' ? Date.parse(row.reset_time) / 1000 : NaN;
      const duration = /weekly|week/i.test(title) ? 10080 : /five.?hour|5.?hour|5h|five_hour/i.test(title) ? 300 : null;
      buckets.push({ name: title || 'Google', modelIds: ids.length ? ids : undefined,
        windows: [{ usedPercent: (1 - fraction) * 100, resetsAt: Number.isFinite(reset) ? reset : null, windowDurationMins: duration }] });
    }
    for (const field of ['data', 'structured_output', 'groups', 'buckets', 'quotas']) {
      const child = row[field];
      if (child && typeof child === 'object' && !Array.isArray(child) && ['buckets', 'quotas'].includes(field)) {
        for (const [key, item] of Object.entries(child)) visit(item, [title, key].filter(Boolean).join(' · '), ids, depth + 1);
      } else if (child) visit(child, title, ids, depth + 1);
    }
    if (row.quota && typeof row.quota === 'object') for (const [key, quota] of Object.entries(row.quota)) visit(quota, key, ids, depth + 1);
  }
  visit(payload);
  return buckets.length ? { provider: 'antigravity', buckets, resetsAvailable: null } : unavailable('Google не передал проценты доступной квоты.');
}

export function limitsForModel(limits: CodexLimits | null, model?: string): CodexLimits | null {
  if (!limits || limits.provider !== 'antigravity' || !model || model === 'antigravity-auto' || limits.unavailableReason) return limits;
  const matches = (name: string) => {
    const text = name.toLowerCase();
    const family = model.startsWith('gemini') ? 'gemini' : model.startsWith('claude') ? 'claude' : model.startsWith('gpt') ? 'gpt' : '';
    if (!family || !text.includes(family)) return false;
    for (const variant of ['flash', 'pro', 'argon', 'carbon', 'hydrogen', 'sonnet', 'opus']) {
      if (text.includes(variant) && !model.includes(variant)) return false;
    }
    return true;
  };
  const buckets = limits.buckets.filter(bucket => bucket.modelIds?.length ? bucket.modelIds.includes(model) : matches(bucket.name));
  return buckets.length ? { ...limits, buckets } : unavailable('Google не передал квоту выбранной модели.');
}

export async function readGoogleLimits(home: string, executable: string, prefix: string[]): Promise<CodexLimits> {
  try {
    const { stdout } = await promisify(execFile)(executable, [...prefix, '-p', '/usage', '--output-format', 'json'], {
      cwd: home, env: { ...process.env, HOME: home, GEMINI_CLI_HOME: home, NO_BROWSER: 'true' },
      timeout: 20000, maxBuffer: 1_000_000, windowsHide: true,
    });
    return parseGoogleLimits(JSON.parse(stdout));
  } catch (error) {
    const result = error as { stderr?: string; stdout?: string };
    const text = String(result.stderr ?? '') + String(result.stdout ?? '');
    if (/not (?:currently )?available in your location/i.test(text)) return unavailable('Google не выдаёт лимиты: Antigravity недоступен в текущем регионе.');
    if (/authentication required|invalid_grant|please sign in/i.test(text)) return unavailable('Для получения лимитов Google требуется вход в Antigravity.');
    return unavailable('Не удалось получить лимиты Google. Повторите обновление позже.');
  }
}
