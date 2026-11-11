# HTTP API · v0.6

Базовый адрес: `http://<IP-сервера>:8787`. На том же адресе `/` открывает веб-чат.

Запросы автоматизации требуют `Authorization: Bearer <личный ключ Bridge>`. Веб-вход Fastkore использует отдельную cookie-сессию с CSRF; правила описаны ниже. Создайте ключ в разделе «API» после входа по своему логину и паролю. Ключ OpenAI не нужен. Секрет показывается один раз; API хранит только хеш. Права ключа — текущие права пользователя; отзыв ключа, отключение пользователя и смена пароля прекращают доступ. Старый общий ключ версии 0.3 отвергается.

Руководитель видит все проекты и чаты. Сотрудник — назначенные проекты, свои чаты и общие чаты проекта. Общие чаты других авторов доступны сотруднику только для чтения. Новые чаты личные; видимость меняет руководитель. Автор и руководители могут продолжать чат, менять модель и отменять его задания. Для недоступного проекта/чата/задания возвращается 404; административная операция сотрудника — 403. Проекты и количество чатов также отфильтрованы.

## Учётные записи и ключи

| Метод | Путь | Тело / назначение |
| --- | --- | --- |
| POST | /api/auth/login | {username, password}; без токена. Возвращает token (сеанс 12 часов) и user |
| GET | /api/auth/me | {user, setupRequired}; без хешей паролей |
| POST | /api/auth/logout | Отзывает текущий сеанс/ключ |
| POST | /api/auth/password | {currentPassword, password}; только сеанс браузера. Возвращает новый сеанс, отзывает остальные сеансы и все ключи пользователя |
| GET | /api/auth/keys | Личные ключи: [{id, name, createdAt}]; без секретов |
| POST | /api/auth/keys | {name}; только сеанс браузера. 201: {id, name, createdAt, token}; секрет один раз |
| DELETE | /api/auth/keys/{keyId} | Отозвать свой ключ |
| GET | /api/users | Только руководитель: публичные данные учётных записей |
| POST | /api/users | Только руководитель: {username, name, password, role: employee или admin} |
| PATCH | /api/users/{userId} | Только руководитель: {disabled? , password?}; отключение/пароль отзывают сеансы и ключи |
| GET | /api/projects/{projectId}/members | Только руководитель: {memberIds} |
| PATCH | /api/projects/{projectId}/members | Только руководитель: {memberIds: [userId, ...]} |
| PATCH | /api/projects/{projectId}/chats/{chatId}/visibility | Только руководитель: {visibility: private или project} |
| GET | /api/audit | Только руководитель: до 1000 изменений доступа без содержимого чатов |

Пароль: 12–200 символов. Логин: 3–48 латинских букв, цифр, точек, дефисов или подчёркиваний; регистр не учитывается. Максимум 10 ключей на пользователя. Первичная настройка через POST /api/local-login доступна только с loopback, localhost Host и X-Bridge-Local: 1 до задания первого пароля. Этот маршрут выдаёт временный сеанс, которому доступны только /api/auth/me, /api/auth/setup и /api/auth/logout. POST /api/auth/setup принимает {username, name, password}, возвращает новый сеанс и закрывает локальный вход без пароля. Для интеграций эти маршруты не нужны.

## Маршруты

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | /api/health | Доступность, имя и версия. Без ключа; без данных проектов |
| GET | /api/status | Настройки, CLI, активное задание, сетевые адреса |
| GET | /api/models | Каталог моделей Codex; кэш до 5 минут |
| POST | /api/models/refresh | Обновить каталог моделей |
| POST | /api/cli/check | Версия CLI и login status, без запроса к модели |
| POST | /api/subscription/check | Пробный запрос через ChatGPT; 202 с заданием |
| PATCH | /api/settings | cliPath, allowWrite, includePreviews, model |
| GET | /api/diagnostics | Краткий обезличенный журнал |
| GET | /api/projects | [{id, name, directory, chatCount}] |
| POST | /api/projects | Подключить папку сервера: {directory, name?} |
| GET | /api/projects/{projectId}/chats | [{id, title, updatedAt, messageCount}] |
| POST | /api/projects/{projectId}/chats | Создать чат: {} или {title, model?} |
| PATCH | /api/projects/{projectId}/chats/{chatId} | Выбрать модель чата: {model} |
| GET | /api/projects/{projectId}/chats/{chatId} | Чат, messages, sessionId |
| GET | /api/projects/{projectId}/chats/{chatId}/messages | Сообщения чата |
| POST | /api/projects/{projectId}/chats/{chatId}/messages | Отправить вопрос; 202 с заданием |
| POST | /api/projects/{projectId}/attachments | multipart/form-data, один файл в поле file; 201 |
| GET | /api/runs/{runId} | Задание, состояние, response/error/usage |
| POST | /api/runs/{runId}/cancel | Отменить выполняемое задание |
| POST | /api/migrations/desktop | Импорт старой истории сервера в пустое пространство |

POST без полей отправляйте с телом `{}` и Content-Type application/json, кроме multipart-загрузки. Настройки, диагностика, проверка CLI/подписки, импорт истории и подключение папок доступны только руководителю. Список чатов включает ownerId, ownerName и visibility. /api/status включает user, busy и activeRun: чужое личное задание не раскрывается, но busy сообщает общую занятость.

Создание проекта/чата не начинает диалог с моделью. Первый вопрос создаёт Codex Session ID. Последующие вопросы автоматически продолжают именно эту сессию.

## Отправка вопроса

```json
{
  "text": "Перечисли доступные Excel-файлы и кратко опиши их содержимое",
  "attachmentIds": [],
  "clientRequestId": "integration-question-001"
}
```

`text` обязателен, до 60 000 символов. `attachmentIds` — до 8 ID файлов, ранее загруженных **в этот проект**. Полные локальные пути вместо ID не принимаются. `clientRequestId` учитывается отдельно для каждого пользователя и необязателен, до 100 символов; используйте уникальное значение на каждый логический вопрос. Повтор идентичного запроса возвращает прежнее задание. Изменение текста, набора вложений, модели или чата при том же ключе даёт 409. Дедупликация сохраняется в SQLite без прежнего ограничения последними 500 заданиями.

Ответ: HTTP 202, Location: /api/runs/{id}.

```json
{
  "id": "<runId>",
  "projectId": "<projectId>",
  "chatId": "<chatId>",
  "status": "running",
  "progress": "Проверяем подключение Codex…",
  "createdAt": "2026-11-10T12:00:00.000Z"
}
```

Проверяйте GET /api/runs/{id}, например раз в секунду. Статусы: queued → running → complete, error, cancelled. Занятый сервер принимает новые вопросы в очередь; предел — 100 ожидающих заданий. После аварийного перезапуска прежние running получают interrupted, а queued сохраняются и ожидают запуска. При complete готовый текст находится в `response`, расход токенов — в `usage`, если CLI его сообщил. Ошибка — в `error`; неуспешное задание не публикует частичный response как готовый результат. При ошибке авторизации сообщения в чат не добавляются, но задание содержит причину. Соединение клиента может закрыться: уже принятое задание продолжится на сервере. /api/status возвращает только доступные пользователю queuedRuns; чужое личное задание не раскрывается.

Токены не показывают точный остаток или вид тарификации. API-ключ Codex всегда блокируется; поддерживается текущий вход ChatGPT серверного пользователя.

## Выбор модели

GET /api/models возвращает `{models: [{id, name, description, isDefault}], fetchedAt, source: "codex"}`. Идентификатор нужно брать из этого ответа. Каталог формирует Codex; присутствие в каталоге не гарантирует доступность для каждого аккаунта. Неизвестный ID при сохранении выбора даёт 400; ошибка реального доступа отображается в задании. Нет автоматического перехода на другую модель.

- PATCH /api/settings с `{ "model": "<id>" }` задаёт модель сервера; `{ "model": "" }` — автонастройку Codex.
- PATCH /api/projects/{projectId}/chats/{chatId} с `{ "model": "<id>" }` сохраняет модель чата; пустая строка включает наследование от сервера. Активный чат менять нельзя: 409. Session ID и история сохраняются.
- POST сообщения также принимает необязательное поле `model`. Если оно задано, выбор сохраняется для этого чата перед выполнением задания. Без поля сохраняется прежний выбор чата.
- Приоритет: фиксированная модель профиля → модель чата → модель сервера → настройки самого Codex. В заданиях и ответах помощника поле `model` содержит явно переданный идентификатор; при автонастройке CLI поле может отсутствовать.
- Изменения модели применяются к следующим вопросам. Выбор сохраняется в SQLite и переживает перезапуск; старые состояния JSON загружаются без потери данных. Пока у чата есть ожидающие/активные задания, менять его модель нельзя.

Сохраните cliPath отдельно, прежде чем менять модель: API не принимает в одном PATCH одновременную смену пути к CLI и непустой модели.

## Пример PowerShell

```powershell
$base = 'http://192.168.2.88:8787'
$key = Read-Host 'Личный ключ API Bridge'
$headers = @{ Authorization = 'Bearer ' + $key }
$projects = @(Invoke-RestMethod "$base/api/projects" -Headers $headers)
$projectId = $projects[0].id
$chats = @(Invoke-RestMethod "$base/api/projects/$projectId/chats" -Headers $headers)
# Если список пуст, создайте чат:
if ($chats.Count -eq 0) {
    $chat = Invoke-RestMethod "$base/api/projects/$projectId/chats" `
        -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
    $chatId = $chat.id
} else { $chatId = $chats[0].id }
$body = @{ text = 'Что находится в проекте?'; clientRequestId = [guid]::NewGuid().ToString() } | ConvertTo-Json
$run = Invoke-RestMethod "$base/api/projects/$projectId/chats/$chatId/messages" `
    -Method Post -Headers $headers -ContentType 'application/json' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body))
do {
    Start-Sleep -Seconds 1
    $result = Invoke-RestMethod "$base/api/runs/$($run.id)" -Headers $headers
} while ($result.status -in @('queued','running'))
$result | Select-Object status,response,error,usage
```

Если список проектов пуст, руководитель должен подключить папку и назначить пользователя участником проекта. Адрес выше — пример; используйте адрес, показанный вашим сервером.

## Пример JavaScript / TypeScript

```typescript
const base = 'http://192.168.2.88:8787';
const key = process.env.BRIDGE_ACCESS_KEY!;
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const response = await fetch(`${base}/api/projects/${projectId}/chats/${chatId}/messages`, {
  method: 'POST', headers,
  body: JSON.stringify({ text: 'Проанализируй таблицу', clientRequestId: crypto.randomUUID() })
});
if (!response.ok) throw new Error(await response.text());
const job = await response.json();
// Далее опрашивайте GET `${base}/api/runs/${job.id}` с тем же Authorization.
```

Это пример серверной интеграции. Браузерные запросы с других сайтов блокируются Origin-проверкой. Встроенный веб-чат работает на том же origin.

## Ошибки

Тело ошибки: `{ "error": "Описание" }`. Основные коды: 400 — неверные поля/путь, 401 — отсутствует/неверен ключ, 403 — недостаточно прав, чужой Origin или удалённый local-login, 404 — неизвестный/недоступный объект, 409 — конфликт идентификатора/ревизии/настроек или закрытый пока профиль, 413 — превышен размер файла, 429 — ограничение входов/очереди, 503 — остановка сервера или выключенное исполнение. Ошибки выполнения модели приходят в состоянии уже принятого задания; не рассчитывайте получить их в исходном HTTP-запросе.

Прототип предназначен для доверенной офисной команды. Очередь устойчивая, с одним исполнителем. Рабочий Windows-сервер пока использует HTTP; Linux/HTTPS и изолированное выполнение не прошли целевую проверку. Файлы обычных проектов общие независимо от видимости чатов. Для LAN используйте START-LAN.cmd. Ограничение входов: 10 на IP за 10 минут.

## Роли, профили и источники · 0.5

GET /api/agents возвращает разрешённые профили: id, name, description, model, available и необязательное unavailableReason. Внутренние инструкции и пути не включаются. Новый чат принимает необязательный agentProfileId (по умолчанию universal). Несуществующий или запрещённый профиль даёт 403; настроенный профиль с ещё неподтверждённой средой — 409 до запуска Codex.

Администратор получает/сохраняет настройки:

| Метод | Адрес | Поля записи |
| --- | --- | --- |
| GET | /api/admin/roles | Список рабочих ролей |
| PUT | /api/admin/roles/{id} | name, enabled, profileIds, operationIds, readDatasetIds, instructions |
| GET | /api/admin/profiles | Список профилей и причины недоступности |
| PUT | /api/admin/profiles/{id} | name, description, instructions, enabled, model, reasoningEffort, operationIds, datasetIds, skillIds, allowWrite, outputMode |
| GET | /api/admin/datasets | Список источников с серверными путями |
| PUT | /api/admin/datasets/{id} | name, directory, projectIds, classification |
| GET | /api/admin/operations | Поддерживаемые идентификаторы операций |

PUT передаёт все поля записи. Для обновления требуется revision из последнего GET; несовпадение даёт 409. Для создания revision отсутствует. ID — 2–64 символа: первая латинская буква, затем строчные буквы/цифры/подчёркивание/дефис. Обычные сотрудники не читают и не меняют эту конфигурацию.

reasoningEffort: low, medium, high, xhigh. outputMode: chat или restricted. classification: shared или restricted. Список operationIds: chat, estimate, technology, accounting. Сейчас запускается только обычная операция chat без дополнительных источников/Skills. Остальные настройки можно подготовить; они не означают, что бизнес-сценарий реализован.

POST /api/users дополнительно принимает roleId; PATCH /api/users/{id} принимает name, roleId, role (admin/employee), disabled и password. role — административный уровень, roleId — рабочая роль. Должен оставаться хотя бы один активный администратор. Смена рабочей роли немедленно применяется к дальнейшим операциям и проверяется во время выполнения.

После изменения правил профиля/роли следующая работа получает свежую внутреннюю сессию. Ранее созданные сообщения сохраняются. Профиль с активными/ожидающими заданиями не меняется до их завершения.

Регистрация любого restricted-источника закрывает ВСЕ запуски Codex в этой версии до проверки изоляции. Ограничение нельзя обойти выбором universal или проверкой подписки. Хранение записи источника само по себе не создаёт изоляцию файлов.

Маршруты /api/tasks ещё не реализованы. /auth/fastkore/exchange реализован как выключенный по умолчанию кандидат SSO; совместная приёмка с ERP остаётся открытой.

## Веб-вход Fastkore · пилот v1

Полная настройка и ограничения: [FASTKORE-SSO-PILOT.md](docs/FASTKORE-SSO-PILOT.md). Нужны HTTPS, конкретный доверенный proxy, BRIDGE_SSO_CONFIG и BRIDGE_EXECUTION=disabled. В обычном офисном режиме SSO выключен. Персональные API-ключи продолжают работать независимо от cookie транспорта.

| Метод | Путь | Назначение |
| --- | --- | --- |
| POST | /auth/fastkore/exchange | Только form-urlencoded `{installation_id,ticket}`, до 8 КБ. Проверяет билет на сервере ERP, устанавливает HttpOnly cookie, 303 на `/`. Другие поля и query string запрещены |
| GET | /api/auth/browser-session | Без cookie: `{authenticated:false,fastkoreEnabled}`. С действующей SSO-cookie: `{authenticated:true,user,setupRequired:false,csrfToken,source:"fastkore"}`. Authorization намеренно не выбирает личность этого маршрута |
| GET | /api/auth/me | Текущий пользователь, setupRequired и source (local/fastkore) |
| POST | /api/auth/logout | Отзывает текущий сеанс; при SSO также удаляет cookie |
| POST | /api/fastkore/context/validate | Только SSO-cookie: `{entityType,entityId,suggestedAgent?}` → `{context,suggestedAgent?,suggestionUnavailable}`. Установка берётся из сеанса, разрешения не выдаются |
| GET | /api/admin/fastkore/installations | Администратор: ID, имя, типы объектов, enabled и configuredEnabled. Без секретов, URL и серверных путей |
| PATCH | /api/admin/fastkore/installations/{id} | Администратор: `{enabled}`. Выключение отзывает все SSO-сеансы и выпущенные через них ключи установки. Включение не переопределяет выключенный серверный файл |
| GET | /api/admin/fastkore/identities | Администратор: связи `{installationId,externalUserId,userId}` |
| PUT | /api/admin/fastkore/identities | Администратор: те же три поля. Явная привязка к существующей активной учётной записи, отзыв старых SSO-сеансов и ключей этой внешней личности |

Для изменяющих запросов с cookie обязательны `Origin: <BRIDGE_PUBLIC_ORIGIN>` и `X-Bridge-CSRF: <csrfToken>`. Заголовок выдаётся авторизованной странице через browser-session, не заменяет cookie и не сохраняется в localStorage. Смешанные cookie и Authorization получают 409; SSO-сессионный токен через Bearer не принимается. Персональный API-ключ по-прежнему передаётся только как Bearer. Ключ, созданный в SSO-сеансе, дополнительно привязан к его установке и внешней личности.

Первый SSO-вход создаёт пользователя без пароля, проектов и рабочей роли. Объединения по имени/логину нет. Новая cookie имеет срок 30 минут; этот срок ещё нужно согласовать с ERP. Отзыв только в ERP не прекращает старую cookie немедленно без дополнительного канала.

Создание чата через `POST /api/projects/{projectId}/chats` дополнительно принимает `erpContext:{entityType,entityId}` в SSO-cookie-сеансе. installationId берётся из подтверждённой личности. Контекст сохраняется вместе с новым чатом; менять его PATCH-запросом нельзя. Новый объект означает явное создание отдельного диалога. Передача контекста сама по себе не читает ERP и не запускает Codex.
