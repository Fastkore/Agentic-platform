import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexClient, type CodexEvent, type CodexRequest, type RegisterSteering } from './codex.js';
import type { CliInfo, CodexLimits, ModelCatalog, ModelOption } from '../shared/types.js';
import { BridgeError } from './store.js';

// Z.ai GLM Coding Plan runs through Codex CLI with a custom model provider
// (docs.z.ai/devpack/tool/codex). The platform owns config.toml and models.json in
// the account home; the job sandbox cannot modify CODEX_HOME, so provider credentials
// never become editable by an agent. The API key is a Coding Plan subscription key,
// not a pay-per-use OpenAI key, and never leaves this home directory.
export const GLM_PROVIDER = 'ZAI';
export const GLM_DEFAULT_MODEL = 'glm-5.3';
const KEY_PATTERN = /^[A-Za-z0-9._-]{20,2048}$/;

function glmBaseUrl() {
  const url = process.env.BRIDGE_GLM_BASE_URL?.trim() || 'https://api.z.ai/api/v1';
  const remote = /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i;
  // Plain HTTP is only allowed for local test backends.
  const local = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s]*)?$/i;
  if (!remote.test(url) && !local.test(url)) throw new BridgeError('Некорректный адрес Z.ai в BRIDGE_GLM_BASE_URL.');
  return url.replace(/\/+$/, '');
}

export function readGlmKey(home: string): string | null {
  try {
    const text = readFileSync(path.join(home, 'config.toml'), 'utf8');
    const match = text.match(/^experimental_bearer_token = "([A-Za-z0-9._-]+)"$/m);
    return match ? match[1] : null;
  } catch { return null; }
}

type GlmCatalogEntry = { slug?: unknown; display_name?: unknown; description?: unknown };

export async function writeGlmConfig(home: string, key: string) {
  if (!KEY_PATTERN.test(key)) throw new BridgeError('Ключ GLM выглядит некорректно. Скопируйте ключ целиком из личного кабинета Z.ai.');
  const baseUrl = glmBaseUrl();
  // One request validates the key with Z.ai and returns the real model catalog
  // in the exact model_catalog_json format Codex expects.
  let catalog: { models?: GlmCatalogEntry[] };
  try {
    const response = await fetch(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 401 || response.status === 403) throw new BridgeError('Z.ai отклонил ключ GLM. Проверьте ключ Coding Plan в кабинете Z.ai.');
    if (!response.ok) throw new BridgeError('Z.ai ответил ошибкой при проверке ключа (HTTP ' + response.status + ').');
    catalog = await response.json() as { models?: GlmCatalogEntry[] };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('Не удалось связаться с Z.ai для проверки ключа. Попробуйте ещё раз.');
  }
  const models = (catalog.models ?? []).filter(model => typeof model.slug === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(model.slug));
  if (!models.length) throw new BridgeError('Z.ai не вернул список моделей для этого ключа.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const config = [
    `model_provider = "${GLM_PROVIDER}"`,
    `model = "${GLM_DEFAULT_MODEL}"`,
    `model_catalog_json = ${JSON.stringify(path.join(home, 'models.json'))}`,
    '',
    `[model_providers.${GLM_PROVIDER}]`,
    `name = "${GLM_PROVIDER}"`,
    `base_url = "${baseUrl}"`,
    `experimental_bearer_token = "${key}"`,
    'wire_api = "responses"',
    '',
  ].join('\n');
  await writeFile(path.join(home, 'config.toml'), config, { mode: 0o600 });
  await writeFile(path.join(home, 'models.json'), JSON.stringify({ models }, null, 2), { mode: 0o600 });
}

export function glmFailure(text: string) {
  if (/401|unauthorized|invalid.{0,24}(key|token)|incorrect/i.test(text)) return 'Z.ai отклонил ключ GLM. Проверьте ключ Coding Plan в настройках сервера.';
  if (/429|quota|rate.?limit|insufficient|payment|billing/i.test(text)) return 'Z.ai отклонил запрос: исчерпана квота или оплата GLM Coding Plan.';
  return 'GLM не выполнила запрос. Проверьте ключ, доступность Z.ai и лимиты плана.';
}

export class GlmClient extends CodexClient {
  constructor(private readonly glmHome: string, testPrefix: string[] = []) { super(testPrefix, 'worker', glmHome, GLM_PROVIDER); }
  async inspect(): Promise<CliInfo> {
    const signedIn = existsSync(path.join(this.glmHome, 'config.toml')) && readGlmKey(this.glmHome) !== null;
    return { path: '', version: 'Codex CLI · GLM (Z.ai)', authentication: signedIn ? 'glm' : 'signed-out',
      status: signedIn ? 'Ключ GLM Coding Plan сохранён.' : 'Сохраните ключ GLM Coding Plan.' };
  }
  async listModels(): Promise<ModelCatalog> {
    if (readGlmKey(this.glmHome) === null) throw new BridgeError('Сохраните ключ GLM, чтобы получить список моделей.', 503);
    const catalog = JSON.parse(await readFile(path.join(this.glmHome, 'models.json'), 'utf8').catch(() => '{\"models\":[]}')) as { models?: GlmCatalogEntry[] };
    const models: ModelOption[] = (catalog.models ?? [])
      .filter(model => typeof model.slug === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(model.slug))
      .map(model => ({ id: model.slug as string, name: typeof model.display_name === 'string' ? model.display_name : model.slug as string,
        description: typeof model.description === 'string' ? model.description : '', isDefault: false }));
    if (!models.length) throw new BridgeError('Каталог моделей GLM пуст. Сохраните ключ заново.', 502);
    return { models: [{ id: 'glm-auto', name: 'GLM (авто)', description: 'Модель по умолчанию из конфигурации GLM.', isDefault: true }, ...models],
      fetchedAt: new Date().toISOString(), source: 'glm' };
  }
  async readLimits(): Promise<CodexLimits> {
    return { provider: 'glm', buckets: [], resetsAvailable: null, unavailableReason: 'Z.ai не отдаёт остаток лимита по API. Проверьте кабинет Z.ai.' };
  }
  async run(request: CodexRequest, onEvent: (event: CodexEvent) => Promise<void>, signal: AbortSignal, registerSteering?: RegisterSteering) {
    // glm-auto keeps the provider default model; GLM accepts low/high/max rather than the
    // platform's medium/xhigh scale, so no reasoning effort override is forwarded.
    const model = request.model === 'glm-auto' ? undefined : request.model;
    try { return await super.run({ ...request, model, reasoningEffort: undefined }, onEvent, signal, registerSteering); }
    catch (error) {
      if (error instanceof BridgeError && error.statusCode === 502) throw new BridgeError(glmFailure(error.message), 503);
      throw error;
    }
  }
}
