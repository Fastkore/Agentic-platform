# FastkoreCLI: инструкция для внешнего агента

English machine-oriented contract: `FastkoreCLI-Agent-Contract.md`.

Начальная точка для агента: `AGENT-START.md`. Прочитать один раз; остальные разделы
выбирать по его таблице. Руководства не требуется загружать целиком для каждого действия.

## Сначала пример, затем читаемый макрос

Перед любым написанием макроса, включая простое чтение полей, изучить релевантные примеры
целевой конфигурации: похожую задачу, работу с нужным объектом, связью или API.
Проверить совместимость контекста и подтвердить свойства и связи по схеме.
Порядок работы и проверка семантики обязательны по разделу 6 платформенного руководства.
В исходнике предпочитать программные свойства и связи; `Id.*` использовать там, где API
требует идентификатор. Приоритет GUID для адресации команд CLI не означает приоритет GUID
в коде. Не создавать универсальные обёртки чтения вместо изучения Macro API.
Проверенные приёмы сохранять и искать по правилам [каталога рецептов](Fastkore-Macro-Recipes.md).
Подсказка не заменяет проверку актуальной схемы и не даёт разрешения выполнять макрос.

Для исправления ссылки ReportElement использовать `report binding update` со спецификацией
`reportGuid`/`dataName`, актуальной ревизией, подтверждением GUID, пометкой и предварительным
dry-run. Макрос и роли сохраняются. Для проверки рендера передавать выбранную привязку через
`report template test --element <binding-guid> --expected-binding-revision <revision>`.
Не делать вывод о выполнении конкретного DataMacro по успешному рендеру: поле
`dataMacrosExecuted` теперь null, `macroExecutionStatus=not-observed`. Подробности —
`REPORT-TEMPLATES.md` в документации CLI.

## Экономия контекста агента (обновлённый исходный код)

После `schema snapshot` использовать офлайн `schema find --file <snapshot> --contains <text>
--kind property --limit 10 --json`, затем `schema show --file <snapshot> --id <id из find>
--json`. Профиль не нужен. Не читать полный файл. При `truncated=true` уточнять поиск;
для дочерних объектов передавать `--parent <id>`. `show` выдаёт только скалярные поля и
число дочерних объектов. Составные id действуют внутри снимка; для сервера брать GUID.
Exit 5 означает частичный снимок; проверять warnings. Перед записью получать свежие guards.

Использовать `--json`: стандартный ответ теперь содержит компактный `agentContext`
со схемой compact-v3 для подтверждённых безопасных чтений и compact-v2 для остальных ответов. Полные общие инструкции доступны
через `--agent-full`, который также включает JSON. `--agent-compact` — явный синоним
компактного JSON; вместе с `--agent-full` он недопустим. Данные, ошибки и сведения
о побочных эффектах сохраняются полностью в обоих режимах.

У успешных безопасных чтений data query/get, object show и agent describe без предупреждений
не повторяются safety.instructions и recommendedNext; ошибки и опасные операции их сохраняют.
Эта ветка использует .NET 10. Для короткого поиска задавать `--detail brief --json`,
затем читать нужные поля через `data get --properties <guid,...> --detail brief --json`.
Без явных --properties в brief пользовательские свойства не загружаются. Явные поля и связи
не обрезаются. Полный режим: `--detail full --agent-full`. Стандарт JSON теперь brief;
прежний текстовый режим остаётся полным. Для прежних JSON-клиентов явно задавать full.

Для нескольких определений использовать `schema show --file <snapshot> --ids <id1,id2,id3>
--json` (максимум 10). При частичном успехе exit 5 проверить `lookupErrors`; suggestions
содержат до пяти кандидатов при опечатке и не являются автоматически выбранным объектом.
При возобновлении работы выполнить `schema check --profile <profile> --file <snapshot>
--json`. Статус changed/unknown требует обновить снимок. current-within-scope относится
только к сохранённым метаданным, не к правам, телам шаблонов или коду действий workflow;
это не атомарная ревизия и не замена guards. Не запускать check перед каждым find/show.

Для незнакомой команды получать адресную справку один раз на сборку:
`FastkoreCLI.exe agent describe "report template apply" --json`.
Она не подключается к серверу и не выполняет описываемую команду. Общие записи
семейств отмечены `contractScope`; они требуют уточнения параметров по документации
ресурса. Сохранять контракт с cliBuildId и использовать повторно; при замене EXE,
ошибке параметров или потере контекста перечитать. Полный agent capabilities нужен
только для поиска неизвестной команды, а не для обязательного первоначального чтения.

Для знакомства со структурой конкретного решения сначала создать один локальный индекс:

```powershell
FastkoreCLI.exe schema snapshot --profile dev --solution '<solution-guid>' `
  --out 'C:\Work\fastkore-schema.json' --agent-compact
```

Команда перечитывает доступную текущему профилю структуру с сервера и возвращает в stdout
только сводку. Не открывать JSON целиком в контексте модели: выполнять локальный поиск по
GUID, `MacroName`, `FieldName`, пути или имени и читать только нужный объект/раздел. Это
заменяет повторяющиеся `solution tree` и `schema entity-set show` для навигации, но не
заменяет свежее адресное чтение и revision/expected-hash перед записью. Перестраивать индекс
при смене сервера, пользователя/прав и перед изменением конфигурации. В файле нет бизнес-
объектов, исходников макросов и тел шаблонов отчётов; `complete=false` и warnings означают,
что отсутствующие разделы нельзя додумывать.

## Обязательные руководства по разработке

Перед написанием или изменением макроса агент обязан прочитать общие и тематические
разделы `Fastkore-Platform-Development-Guide.md`, перечисленные в AGENT-START.md.
Выбранные разделы читать полностью; контекст, транзакции и предусловия не пропускать.

Если целевая конфигурация или надстройка — Fastkore Business, дополнительно прочитать
разделы `Fastkore-Business-Development-Guide.md` по таблице AGENT-START.md. Business-дополнение содержит только предметные
правила этой конфигурации и не делает CLI зависимым от неё.

Критическое правило файловой подсистемы: папку связанных файлов нельзя создавать как обычный
объект через `CreateEntity`. Использовать `FileSet`, `FileService.GetDefaultLinkFolder` и
`FileService.CreateDefaultLinkFolder`, добавив `Fastkore.Platform.Model.Data.Files` и
`Fastkore.Platform.Presentation.Services` в `Usings`. Полный рабочий шаблон и причины приведены
в платформенном руководстве.

When an agent runs under an isolated Windows account, route normal commands through the local broker with
`--via-broker`. The saved-profile owner starts it using
`FastkoreCLI.exe broker start --broker-root C:\Projects\Fastkore --broker-allowed-sids <observed-agent-user-SID>`.
Default is owner-only. Compare exact TokenUser SID and Windows session, never account basenames.
Only the owner may stop/restart to change the list. Diagnose bracketed broker error codes without
broadening ACLs or disabling the sandbox. Owner-context success does not prove sandbox connectivity. Never request a password or
forward credential mutations. Automatic fallback is disabled unless
`FASTKORE_CLI_BROKER_FALLBACK=1` is explicitly set. A stopped broker is an error and must not
trigger an interactive password prompt. Full rules: `..\Source\FastkoreCLI\BROKER.md`.

The CLI also returns an English `agentContext` object in every `--json` response.
Use GUID, `MacroName`, and `FieldName` as stable identifiers. Treat localized names as
display/search values, except exact runtime string contracts such as report `DataName`
and Stimulsoft source or column names, which must be preserved without translation.
For Stimulsoft templates, nested `businessObjectPaths` and `businessObjectFieldPaths` are also
exact contracts. Use `report template export -> validate -> diff -> apply --dry-run -> apply`;
use `report template test` only after explicit authorization because it executes report code.
When the component schema changed, use `report template business-object sync` to produce a local
candidate through the standard Stimulsoft synchronization API, then review its exact path diff.

Ordinary business entities are deleted one at a time. Always run `data delete check`, copy
its exact `modified` value, obtain explicit authorization for the specific GUID, and then run
`data delete` with `--confirm-delete`, `--allow-side-effects`, and `--change-note`. Never infer
authorization to delete related objects and never retry after a conflict without re-reading.

`command invoke` returns the standard headless presentation without business-specific parsing:
`data.alerts`, `data.forms`, and `data.questions`. If a command exposes a machine-readable
read-only form control named `ResultJson`, use the exact string in the control `value`. Read
additional diagnostics through `event-log list/get`; do not invent a Business-specific CLI call.

Техническое задание на расширенное управление всей моделью конфигурации: `FastkoreCLI-Configuration-Management-TZ.md`.

Детальное ТЗ следующего этапа — роли, доступы, условия, плитки, отчёты и пакетный plan/apply: `FastkoreCLI-Phase2-TZ.md`.

Поэтапное ТЗ административного контура «Безопасность»: `FastkoreCLI-Security-TZ.md`.

Эта инструкция предназначена для Codex и других автоматизированных агентов, которые читают прикладные объекты и меняют макросы конфигурации Fastkore без запуска клиентского приложения.

## Назначение и границы

`FastkoreCLI.exe` подключается к серверу Fastkore через публичную модель конфигурации `Solution`. Текущая версия умеет:

- хранить профиль подключения в Windows Credential Manager текущего пользователя;
- перечислять конфигурации и макросы;
- читать исходный код зарегистрированного макроса;
- создавать макрос в существующем макро-слоте;
- проверять C#- и Python-макрос компиляцией без выполнения;
- сохранять макрос через `CheckOut`, `Save` и `CheckIn`;
- читать дерево элементов Solution и схему компонентов;
- читать прикладные объекты, их свойства и явно выбранные связи с соблюдением серверных прав;
- читать штатный журнал событий для поиска ошибок и проверки записей `[FastkoreCLI]`;
- проверять сервером эффективные права текущего профиля на компонент или конкретный объект;
- читать административные правила безопасности под профилем глобального администратора;
- создавать, изменять и удалять кнопки, обработчики событий, фильтры связей,
  ограничения доступа внутри Solution и подсветки по JSON-спецификации;
- создавать, изменять и удалять роли Solution и политики доступа с защитой от
  самоблокировки права «Разработчик конфигурации»;
- изменять встроенные плитки компонентов и управлять плитками компонентов, системными
  плитками, панелями аналитики и их элементами;
- создавать, изменять и удалять группы библиотек функций и сами библиотеки с
  компиляцией кода и проверкой подключённых библиотек;
- создавать, изменять и удалять задания планировщика Solution, управлять периодичностью,
  включением и Action без запуска макроса;
- создавать, изменять и удалять службы HTTP, безопасно управлять адресом, включением,
  признаком настройки Authorization и Action без запуска endpoint;
- хранить код таких элементов отдельными `.cs`/`.py`-файлами через `sourceFile`;
- проверять изменения этих элементов через обратимый режим `--dry-run` и полную ревизию элемента;
- записывать каждую фактическую правку в штатный «Журнал событий»: короткая операция с пометкой `[FastkoreCLI]` отображается в общей таблице, а `--change-note` и имя конфигурации — внутри записи;
- выгружать штатный каталог `Solution.ExportAll` для системы контроля версий;
- сохранять каждый макрос отдельным UTF-8-файлом `.cs` или `.py` для Git diff.
- строить неизменяемый пакетный plan по изменённым макросам VCS-workspace и применять
  его только после повторной проверки workspace, сервера, ревизий и явного подтверждения hash.

Текущая версия не является универсальным редактором всей конфигурации. Типизированная
запись реализована для `CommandElement`, `EventHandlerElement`, `LinkFilterElement`,
`EntityAccessElement`, `EntityHighlightingElement`, `RoleElement` и
`AccessPolicyElement`, `DashboardElement`, `FunctionLibraryGroupElement`,
`FunctionLibraryElement`, `SchedulerItemElement`, `HttpServiceElement`, а также для четырёх видов плиток; остальные типы пока изменяются
только через существующие макро-слоты.

## Что покрыто в кнопках и доступах

У кнопок `CommandElement` поддерживаются создание/изменение/удаление, исходники `Action` и `ValidationMacro`, текст, подсказка, иконка, цвет, жест, размещение, требования к выбору и признаки кнопки. Назначенные роли и статический фильтр проверки пока доступны только для чтения и сохраняются без изменения при частичном update.

У `EntityAccessElement` поддерживаются тип доступа, условие, Macro, роли, режим и список
свойств/связей, а также скрытие значения. У `EntityHighlightingElement` поддерживаются
цвета, стиль, приоритет, переключатель, статический фильтр, роли и Macro. Смена типа
доступа не очищает несовместимые настройки без явного `clearIncompatible: true`.

Не поддерживается редактирование:

- правил `EntitySetAccessRule` через `AccessManager`;
- списка `Solution.AccessRuleGuids`.

Правила `EntitySetAccessRule` доступны только для чтения командами `access-rule list/show`.
Это отдельный серверный контур, а не дочерние `EntityAccessElement` внутри Solution.

Полный VCS-экспорт может содержать эти данные, но наличие данных в экспорте не означает, что CLI умеет безопасно записывать их обратно.

## Поддерживаемые макро-слоты

CLI рекурсивно находит публичные записываемые свойства типа `MacroSource`. В текущей модели это включает, в частности:

- действия и проверки кнопок;
- действия плиток и планировщика;
- обработчики событий;
- библиотеки функций;
- HTTP-сервисы;
- фильтры связей;
- подготовку данных отчёта;
- загрузку задач календаря и доски задач;
- фильтры и проверки доступа, реализованные макросом;
- подсветку сущностей;
- макросы AI-ассистента.

Ориентироваться следует на результат `macro list`, а не на предположение о конкретном имени свойства.

## Безопасность

Агент обязан соблюдать следующие правила:

1. Не передавать пароль через аргументы командной строки, файл, stdin, JSON или Git.
2. Не читать и не экспортировать содержимое Windows Credential Manager.
3. Если профиль отсутствует, попросить пользователя лично выполнить интерактивную команду `auth add`.
4. Для отдельного макро-слота всегда использовать `--expected-hash`; для типизированного update/delete — `--expected-revision` из последнего `element show`.
5. Не использовать `--force`, если пользователь явно не разрешил перезаписать конфликтующую серверную или локальную версию.
6. До `macro apply` всегда выполнять `macro validate --warnings-as-errors`; до типизированной записи — ту же команду с `--dry-run --warnings-as-errors`.
7. Не запускать клиент Fastkore и не выполнять макрос для проверки.
8. Не делать Git commit, push или создание репозитория без отдельного указания пользователя.
9. Не менять несколько макросов как будто это одна атомарная операция: каждый `macro apply` имеет собственный `CheckIn`.
10. Для первого чтения компонента использовать `data query --limit 3`; не запрашивать связи, пока их GUID и назначение не проверены через `schema entity-set show`.
11. Не выгружать большие наборы объектов серией автоматических запросов без явного разрешения пользователя.
12. Использовать `data query --all` только после явного указания пользователя прочитать полный набор; обязательно ограничивать `--properties` необходимыми полями.
12.1. Большой `schema snapshot` хранить локально и выбирать из него только релевантные фрагменты; не отправлять весь файл модели.
13. Для каждой реальной команды `macro apply`, `create`, `update` или `delete` передавать `--change-note` с коротким понятным описанием результата. Не включать в него пароли, токены, персональные данные, значения защищённых полей и фрагменты конфиденциального кода. Для `--dry-run` и `macro validate` пометка не требуется.
14. Для проверки прав другого аккаунта использовать только заранее созданный пользователем Credential Manager-профиль и менять `--profile`; не запрашивать и не извлекать пароль.
15. Не считать базовую проверку компонента точной проверкой условного правила: для чтения, редактирования и удаления конкретного объекта передавать `--entity <guid>`.
16. Не пытаться менять `EntitySetAccessRule`: до серверного compare-and-save CLI поддерживает только `access-rule list/show` и `access check`.
17. Для нескольких изменений из Git использовать `vcs plan`, затем `vcs apply --dry-run`,
    и только после проверки передавать точный `--confirm-plan-hash` реальному apply.
18. Не редактировать `.fkps` с ожиданием импорта: текущий пакетный apply принимает только
    исходники, перечисленные в `.fastkore-macros.json`, и безопасно блокирует остальные файлы.
19. После успешного пакетного apply обязательно повторить `vcs export`, проверить Git diff
    и зафиксировать новые серверные ревизии. Journal не считать серверным rollback.

## Подготовка профиля пользователем

Стандартный путь после установки:

```powershell
& 'C:\Program Files (x86)\Fastkore\FastkoreCLI.exe' auth add `
  --profile dev `
  --server '<server>' `
  --login '<login>'
```

Пароль один раз вводится пользователем без отображения. Перед сохранением CLI проверяет подключение. Право и лицензия разработчика отдельно проверяются через `auth test`; для команд `data` они не требуются.

Проверка существующего профиля:

```powershell
& 'C:\Program Files (x86)\Fastkore\FastkoreCLI.exe' auth test --profile dev --json
```

Чтение внутренних прав, групп и ролей текущего пользователя:

```powershell
& 'C:\Program Files (x86)\Fastkore\FastkoreCLI.exe' auth info --profile dev --json
```

`auth info` является операцией только для чтения. Поле `isAdministrator` показывает
глобального администратора, `userAdmin` — право администрировать учётные записи,
`developer` — действие политики «Разработчик конфигурации». Наличие лицензии
Fastkore Developer проверяется отдельной командой `auth test`. Она во всех
конфигурациях сборки получает реальное состояние лицензии от сервера и возвращает
`developerPolicy`, `licenseState` и `canEditConfiguration`; Debug-сборка не обходит
проверку. Любая изменяющая команда повторяет эту проверку непосредственно перед
операциями с конфигурацией.

## Журнал событий для диагностики

Команды `event-log list` и `event-log get` являются операциями только чтения.
Они не исполняют макросы, не создают извлечение Solution и не пишут новую запись
в журнал. Агент использует их до изменения конфигурации для понимания ошибки и
после успешной записи для проверки аудита `[FastkoreCLI]`.

```powershell
& $cli event-log list --profile dev --level error,external --contains 'macro' --limit 20 --json
& $cli event-log list --profile dev --source FastkoreCLI --limit 20 --json
& $cli event-log get --profile dev --id '<log-entry-id>' --json
```

`list` возвращает ограниченный список, отсортированный от новых записей к старым.
По умолчанию возвращается не более 100 записей, максимум — 1000. Фильтры:
`--from`, `--to`, `--min-id`, `--max-id`, `--category`, `--level`, `--source`,
`--user`, `--contains`. Сначала агент выбирает одну запись через `list`, затем
получает её полное `Data` через `get`. Параметр `--include-data` допустим только
для небольшой, сознательно ограниченной выборки.

В стеке и данных журнала могут быть служебные и прикладные тексты. Не добавлять
их без проверки в `--change-note`, исходники Git, публичные отчёты или сообщения.

## Чтение прикладных объектов

Сначала агент получает список компонентов и схему выбранного компонента:

```powershell
& $cli schema entity-set list --profile dev --json
& $cli schema entity-set show --profile dev --entity-set '<entity-set-guid>' --json
```

Затем выполняет небольшую выборку без связей:

```powershell
& $cli data query --profile dev --entity-set '<entity-set-guid>' --limit 3 --json
```

Один найденный объект и выбранная связь читаются так:

```powershell
& $cli data get `
  --profile dev `
  --entity-set '<entity-set-guid>' `
  --entity '<entity-guid>' `
  --links '<link-guid>' `
  --link-limit 3 `
  --json
```

Команды `data query` и `data get` работают только на чтение и не требуют лицензии
разработчика. Сервер применяет права пользователя профиля. Связи не загружаются без
`--links`; бинарные и защищённые свойства не возвращаются. GUID являются основными
идентификаторами для автоматизации, имена предназначены только для человека.

Для полного чтения после ограниченной проверки разрешено использовать:

```powershell
& $cli data query --profile dev --entity-set '<entity-set-guid>' `
  --filter '<filter>' --all --properties '<property-guid>,<property-guid>' --json
```

Сервер передаёт такой результат внутренними страницами. `--all` нельзя совмещать со
связями; каждую необходимую связь агент читает последующим `data get`.

## Создание обычных записей

В `data create describe` проверять `writable`, `reason`, `readOnlyState` и `isComputed`
для выбранного типа. `ReadOnlyInList` запрещает только редактирование в списке и не
блокирует CLI create/update. `ReadOnlyInDialog`, полный `ReadOnly`, вычисляемые и
защищённые поля не записывать. `writable` — предварительная проверка CLI, не замена
серверных прав и бизнес-правил при сохранении. Не переносить значение поля в корень
JSON ради обхода отказа: контракт содержит только `properties` и `links`.

Создание записи — это бизнес-действие, а не изменение конфигурации. Агент не создаёт
объект без отдельного прямого поручения пользователя для конкретного компонента и типа.
Порядок работы строго такой: `data create describe`, подготовка минимальной JSON-
спецификации, `data create validate`, затем после разрешения пользователя `data create`.

`validate` не создаёт объект и не выполняет макросы или события создания. Реальная команда
обязана содержать точные `--confirm-create <type-guid>`, `--allow-side-effects` и
`--change-note`. Агент использует GUID и английские `fieldName`/`macroPropertyName`, а не
локализованные названия. Нельзя передавать значения защищённых полей. На первом этапе
допустимы только простые поля и связи к одному существующему объекту.

После успешного создания агент читает только созданный GUID через `data get` и проверяет
аудит `[FastkoreCLI]` в журнале событий. Нельзя создавать серию записей, табличные части
или множественные связи без отдельного подтверждения пользователя.

## Проверка и выполнение кнопок

Сначала агент читает объект через object show, затем получает кнопки через command list.
Перед выполнением обязательна отдельная command check. Реальный invoke разрешён только
когда пользователь явно поручил выполнить действие над конкретным объектом.

~~~powershell
& $cli command check --profile dev --entity-set '<entity-set-guid>' --entity '<entity-guid>' --command '<command-guid>' --json
& $cli command invoke --profile dev --entity-set '<entity-set-guid>' --entity '<entity-guid>' --command '<command-guid>' --expected-revision '<revision>' --expected-modified '<entityModified>' --confirm-command '<command-guid>' --allow-side-effects --change-note '<причина>' --json
~~~

Агент никогда не подставляет старые revision или entityModified: значения копируются
только из непосредственно предшествующего check. Флаг allow-side-effects не используется
для разведки. Если headlessExecutable=false, действие не обходится через прямой запуск
макроса или запись данных. Информационные формы только с read-only полями возвращаются
в forms. Редактируемая форма требует отдельный JSON-файл --input; ключи берутся из
Name/Label полей, а не угадываются агентом. Для одного известного вопроса агент передаёт
--question-answer yes или no только после явного выбора пользователя; фактический вопрос
и ответ проверяются в questions. Несколько вопросов и прочую неподдерживаемую
UI-зависимую кнопку выполняет пользователь в клиенте.

## Проверка и выполнение переходов бизнес-процесса

workflow list/check рассчитывают переход от имени аккаунта профиля штатным методом
CanChangeStage, включая текущую стадию, роли и обработчик доступности.

~~~powershell
& $cli workflow check --profile dev --entity-set '<entity-set-guid>' --entity '<entity-guid>' --transition '<transition-guid>' --json
& $cli workflow transition --profile dev --entity-set '<entity-set-guid>' --entity '<entity-guid>' --transition '<transition-guid>' --expected-stage '<currentStageToken>' --expected-modified '<entityModified>' --confirm-transition '<transition-guid>' --allow-side-effects --comment '<комментарий>' --change-note '<причина>' --json
~~~

Переход выполняется только после явного поручения пользователя. Токен стадии и версия
объекта берутся из свежего check. Для перехода с requiresCustomInputForm=true агент
сначала читает inputForm из check, создаёт JSON только с показанными полями и передаёт
его через input. Обычный обязательный комментарий передаётся через comment.
Код 5 означает, что действие уже выполнено, но отдельная запись [FastkoreCLI] не была
создана; повторять бизнес-действие автоматически в этом случае запрещено.

## Проверка эффективных прав аккаунта

Проверка не выполняет пробную запись и использует штатный серверный вычислитель доступа:

```powershell
& $cli access check --profile dev --entity-set '<entity-set-guid>' --json
& $cli access check --profile dev --entity-set '<entity-set-guid>' `
  --entity '<entity-guid>' --json
& $cli access scan --profile dev --entity-set '<entity-set-guid>' --json
& $cli access compare --profile dev --compare-profile limited-user `
  --entity-set '<entity-set-guid>' --entity '<entity-guid>' --json
```

Чтобы сравнить аккаунты, агент выполняет одинаковую команду с разными сохранёнными
профилями либо использует `access compare`; пароль второго профиля также не извлекается
и не выводится. Без `--entity` значения read/edit/delete
являются базовыми: условие, зависящее от полей объекта, ещё не вычислено. Создание всегда
проверяется на уровне компонента, как при реальной вставке на сервере.

Административная инвентаризация правил доступна только глобальному администратору:

```powershell
& $cli subject list --profile admin --kind role --json
& $cli subject show --profile admin --subject '<subject-guid>' --json
& $cli access-rule list --profile admin --json
& $cli access-rule show --profile admin --rule '<rule-guid>' --json
& $cli access-rule export --profile admin --out '.\access-rules'
& $cli access-rule validate --profile admin --spec '.\access-rule.json' --json
& $cli access-rule plan update --profile admin --rule '<rule-guid>' `
  --spec '.\access-rule.json' --out '.\update.plan.json' --json
```

Перед подготовкой правила агент разрешает пользователя, группу или роль через `subject
list/show` и сохраняет в спецификации GUID. Команды не возвращают SID, e-mail, телефоны,
пароли или токены. Отображаемое имя используется только для проверки человеком.

`null` в действии означает «не задано», а не запрет. Пустая область компонентов зависит
от режима: exclude + пустой список — все компоненты; include + пустой список — ни одного.
Агент не использует `snapshotHash` как CAS-токен и не записывает правило через модель.
Экспортированный `access-rule-v1` допустимо хранить в разрешённом репозитории. Перед
будущей записью агент всегда выполняет `validate`, затем создаёт plan и показывает diff.
Сейчас plan намеренно имеет `applicable: false`: отсутствие серверного CAS нельзя обходить
последовательностью read/compare/Save. Условие правила может содержать чувствительные
значения, поэтому файл не публикуется и не вставляется целиком в журналы или сообщения.

## Обязательный рабочий процесс агента

### 1. Выбрать конфигурацию

```powershell
& $cli solution list --profile dev --json
```

При совпадении имён всегда использовать GUID конфигурации.

### 2. Экспортировать рабочее состояние

```powershell
& $cli vcs export `
  --profile dev `
  --solution '<solution-guid>' `
  --out 'C:\Work\FastkoreConfig' `
  --json
```

В каталоге появятся:

- штатный полный экспорт конфигурации;
- `Macros\<element-guid>\<slot>.cs` или `.py`;
- `.fastkore-macros.json` с привязкой исходников к Solution;
- `.fastkore-vcs.json` со списком управляемых файлов и их SHA-256.

CLI не записывает в эти файлы пароль, логин или адрес сервера.

### 3. Выбрать макрос

Найти запись в `.fastkore-macros.json` по `elementPath`, `slot` или `file`. Зафиксировать:

- `solutionGuid`;
- `elementGuid`;
- `slot`;
- `language`;
- `revisionHash`;
- путь `file`.

Перед изменением при необходимости сверить актуальное состояние:

```powershell
& $cli macro get `
  --profile dev `
  --solution '<solution-guid>' `
  --element '<element-guid>' `
  --slot '<slot>' `
  --out 'C:\Work\macro.cs' `
  --json
```

Без `--force` существующий файл не перезаписывается.

### 4. Изменить файл

Редактировать исходник как обычный текстовый файл. Не передавать многострочный код аргументом командной строки. `--file -` разрешён только для осознанного stdin-сценария автоматизации.

Не менять сигнатуры и доступные переменные на основании догадки. Их следует определять по существующему коду, диагностике компилятора и контексту конкретного типа элемента.

Не добавлять C# `using` и ссылки на сборки «на всякий случай». Платформа уже
подключает стандартные пространства имён, включая `System`,
`System.Collections.Generic`, `System.Collections.ObjectModel`, `System.Linq`,
`System.Text`, `System.Threading.Tasks`, `System.Xml`, `System.IO`,
`System.Windows` и основные пространства Fastkore Macro API. Базовые сборки
.NET/WPF, `Fastkore.Platform.Model.dll` и
`Fastkore.Platform.Presentation.dll` также подключаются автоматически.
Полный актуальный перечень и правила Function Libraries приведены в разделе 12
`Fastkore-Platform-Development-Guide.md`. Дополнительные `Usings` и `References`
добавлять только после чтения metadata текущего макроса и подтверждения, что
нужный namespace или сборка не входят в автоматический набор.

### 5. Проверить без выполнения

```powershell
& $cli macro validate `
  --profile dev `
  --solution '<solution-guid>' `
  --element '<element-guid>' `
  --slot '<slot>' `
  --file 'C:\Work\macro.cs' `
  --language csharp `
  --expected-hash '<revisionHash>' `
  --change-note '<кратко что изменено>' `
  --warnings-as-errors `
  --json
```

Команда временно выполняет `CheckOut`, компилирует макрос и гарантированно вызывает `UndoCheckOut`. Она не выполняет код макроса.

### 6. Применить

Только после успешной проверки:

```powershell
& $cli macro apply `
  --profile dev `
  --solution '<solution-guid>' `
  --element '<element-guid>' `
  --slot '<slot>' `
  --file 'C:\Work\macro.cs' `
  --language csharp `
  --expected-hash '<revisionHash>' `
  --warnings-as-errors `
  --json
```

При несовпадении hash остановиться, заново прочитать серверную версию и согласовать объединение изменений. Не обходить конфликт флагом `--force` автоматически.

### 7. Зафиксировать результат в экспортируемом каталоге

Повторить `vcs export`. После успешного применения локальный исходник совпадёт с серверным и manifest получит новую ревизию. Если каталог уже находится в Git, можно показать пользователю diff. Commit и push требуют отдельного разрешения.

## Типизированные элементы конфигурации

Сначала получить дерево и схему, не угадывая GUID:

```powershell
& $cli solution tree --profile dev --solution '<solution-guid>' --json
& $cli schema entity-set show --profile dev --entity-set '<entity-set-guid>' --json
```

При создании любого элемента конфигурации сначала проверить его create-контракт или шаблон.
Если модель содержит `name`, `Name` или отображаемое поле «Название», оно обязательно
заполняется в спецификации создания непустым понятным названием, описывающим назначение элемента.
Нельзя оставлять название пустым с расчётом дописать его позднее в клиенте и нельзя использовать
бессодержательные значения вроде «Новый элемент». `text`, подпись кнопки, `MacroName` и имя
исходного файла не считаются заменой `Name`, если контракт содержит отдельное поле названия.

Название является локализованной подписью для человека; стабильным идентификатором остаётся GUID.
Для БП отдельно проверять название процесса, его `codeName`, название свойства стадии и
программное имя этого свойства: одно поле не заменяет другое. Существующие программные
имена не переводить и не «исправлять» по подписи. Соответствие полям CLI и смысл флага
«Обновление включено» (`locked`, не блокировка редактирования) описаны в разделе 2.1
`Fastkore-Platform-Development-Guide.md`, рабочие образцы Business — в разделах 6.1–6.2
`Fastkore-Business-Development-Guide.md`.

Редактирование существующего БП: `workflow definition update`, `workflow stage create/update/delete`,
`workflow edge create/update/delete`. Перед использованием прочитать `WORKFLOW-STRUCTURE.md`:
ревизия берётся для всего БП, каждый шаг требует точного подтверждения, а `edge` меняет
определение перехода, не выполняя его. Список настроек, ограничения удаления и правила
`updateEnabled` нельзя заменять предположениями из подписи редактора.

`workflow definition create` создаёт выключенный БП на существующем компоненте;
`workflow definition delete` удаляет только выключенное неиспользуемое определение после
явного удаления его переходов, дополнительных стадий и действий начальной стадии.
При создании заполнить все четыре поля: `name`, `codeName`, `propertyName`, `propertyCodeName`.
Удаление проверяет историю всех объектов компонента, включая удалённые записи и шаблоны.
По умолчанию лимит — 1000 объектов; `--history-scan-limit` явно увеличивает полный объём
проверки, но не разрешает пропускать историю. При превышении лимита удаление блокируется.

Перед реальной записью dry-run должен показать указанное название, а после создания агент повторно
читает элемент через `element show` и проверяет, что сервер сохранил его. Если CLI не позволяет
передать существующее в модели поле названия, это дефект CLI: элемент не создаётся частично, а
агент сообщает минимальный воспроизводимый сценарий в ветку разработки.

Для создания кнопки подготовить рядом `command.json` и `CommandAction.cs`. Минимальная привязка исходника:

```json
{
  "text": "Моя команда",
  "progressName": "Выполнение команды…",
  "placement": ["Toolbar", "ContextMenu"],
  "action": {
    "language": "csharp",
    "useEnglishApi": true,
    "sourceFile": "CommandAction.cs"
  }
}
```

Выполнить dry-run, затем ту же операцию без него:

```powershell
& $cli command create --profile dev --parent '<entity-set-element-guid>' --spec 'command.json' --dry-run --warnings-as-errors --json
& $cli command create --profile dev --parent '<entity-set-element-guid>' --spec 'command.json' --change-note 'добавлена кнопка <назначение>' --warnings-as-errors --json
```

При создании/изменении Action прочитать [прогресс и размещение команды](Fastkore-Command-Agent-Guide.md).
Для долгих действий progressName обязателен и должен быть непустым; tooltip не заменяет его.
После записи проверить progressName и placement через element show. Macro apply меняет
только код. HTTP/JSON-примеры .NET 10 — в [отдельной инструкции](Fastkore-NET10-Macro-Agent-Guide.md).
Для dashboard обязательно читать [инструкцию обновлённого движка](Fastkore-Dashboard-Agent-Guide.md).

Для изменения сначала прочитать элемент и взять `revision`:

```powershell
& $cli element show --profile dev --element '<command-guid>' --json
& $cli command update --profile dev --element '<command-guid>' --spec 'command.json' --expected-revision '<revision>' --dry-run --warnings-as-errors --json
& $cli command update --profile dev --element '<command-guid>' --spec 'command.json' --expected-revision '<revision>' --change-note '<кратко что изменено>' --warnings-as-errors --json
```

Отсутствующие поля JSON при update сохраняют прежнее значение; явный `null` очищает поддерживаемое nullable-поле или макро-слот. После dry-run серверная ревизия обычно остаётся прежней, но перед реальной записью агент должен повторить `element show`, если между командами мог работать другой пользователь.

Ресурсы `event`, `link-filter`, `entity-access`, `highlighting`,
`solution-role`, `access-policy`, `dashboard`, `function-library-group`,
`function-library`, `scheduler`, `http-service`, `calendar` и `task-board` имеют тот же цикл
`create/update/delete`. Удаление всегда требует `--confirm-delete <guid>` в дополнение к
актуальной ревизии. Каждая реальная изменяющая команда должна содержать безопасный
`--change-note`; успешный JSON-ответ возвращает `logEntryId` созданной записи «Журнала
событий». Готовые шаблоны находятся рядом с проектом в `DEV/Source/FastkoreCLI/Examples`,
а полный smoke-test — в `DEV/Source/FastkoreCLI/TESTING.md`.

Для `entity-access` агент использует GUID свойств/связей из `schema entity-set show` и
GUID `RoleElement` из `solution tree`. Режим `include-only` у fields означает, что
редактируемыми остаются только перечисленные поля; `exclude-listed` делает перечисленные
поля недоступными для редактирования. Для ролей пустой `include-only` запрещает элемент
всем, пустой `exclude-listed` разрешает всем — CLI возвращает предупреждение.

Статический `condition/filter` передаётся как `null`, объект `text` или объект
`serialized`. Нельзя переносить сериализованный фильтр между компонентами: CLI проверяет
GUID владельца. При смене `accessType` несовместимые настройки не очищаются неявно;
нужно явно передать `clearIncompatible: true` и проверить diff через `element show`.

`solution-role create` требует `--solution`, `--role` с GUID каталожной роли/группы и
спецификацию; если в ней есть `roleGuid`, значения обязаны совпасть. Плитки задаются
стабильными GUID, а тайм-аут бездействия — длительностью
ISO 8601. Непустой список при режиме `default` является допустимым legacy-состоянием
и не должен очищаться агентом. `access-policy` принимает только известные платформе типы. Для любой
операции с developer-политикой сначала выполнить `--dry-run` и затем проверить
все нужные профили через `auth test`. Флаг `--accept-lockout-risk` нельзя
добавлять автоматически: он допустим только после явного решения пользователя.
Удаление используемой роли Solution запрещено до удаления ссылок на неё.

Для плиток агент сначала читает владельца через `element show`. Встроенная плитка
не является отдельным элементом: команда `tile built-in update` блокирует и
сохраняет родительский `EntitySetElement`. Для самостоятельных ресурсов используются
`tile entity-set/system/dashboard create|update|delete`. Нельзя переносить GUID
типов, каталогов, свойств сортировки или сериализованный фильтр между компонентами.
Смена целевого компонента допустима только с явным `clearIncompatible: true`.
Перед реальной записью обязательны dry-run и повторное чтение ревизии.

Самой панелью аналитики управляет `dashboard create|update|delete`, а её внутренними
элементами — `tile dashboard create|update|delete`. Удаление панели выполняется только
после явного удаления всех внутренних элементов и ссылок на её GUID из настроек ролей.

Группа создаётся командой `function-library-group create --solution`, а функция —
`function-library create --parent <group-guid>`. Исходник Action всегда хранится в
отдельном `.cs` или `.py` через `sourceFile`. Для C# CLI устанавливает обязательный
признак `IsFunctionLibrary`. Подключённые функции задаются стабильными GUID в объекте
`libraries`. Нельзя удалять непустую группу или библиотеку, на которую ссылается любой
макрос; сначала ссылки удаляются явным update владельцев.

Задание планировщика управляется командой `scheduler`. `recurTime` передаётся в ISO 8601
и должен быть не меньше `PT1M`; Action компилируется, но никогда не выполняется CLI.
Штатная модель элемента фиксирована платформой: запуск при старте сервера, ежедневное
событие и повторяющееся действие. Включённое задание нельзя удалить напрямую — сначала
оно отключается отдельным update, затем повторно читаются состояние и ревизия.

Служба HTTP управляется командой `http-service`. Новая служба создаётся только
выключенной. Включённый элемент сначала отключается отдельным update; редактировать или
удалять его до подтверждения состояния нельзя. При включении проверяются Action и
относительный уникальный `baseAddress`; сложный непредсказуемый адрес может использоваться
как ключ доступа. Authorization задаёт пользователь в штатном интерфейсе: агент не читает,
не изменяет и не выводит его значение. `element show` сообщает только
`authorizationConfigured`. VCS-экспорт заменяет
Authorization на GUID-зависимый placeholder. CLI компилирует Action, но не запускает
службу и не вызывает её endpoints. Так как `baseAddress` остаётся в VCS-представлении,
агент экспортирует HTTP-конфигурацию только в закрытый репозиторий.

Календарь управляется командой `calendar`, канбан-доска — `task-board`. Перед созданием
или изменением агент получает GUID через `schema entity-set show`; отображаемые имена
полей нельзя подставлять вместо GUID. Для календаря выбирается не более одного способа
окончания, режима «весь день» и источника цвета. Для доски задаётся ровно один источник
состояния: бизнес-процесс, поле со списком значений или связь к одному объекту.
`excludedStates` берутся только из ранее прочитанной конфигурации или штатного интерфейса:
агент не угадывает внутренние ключи по подписям.

Фильтр календаря/доски относится к основному компоненту, а `groupFilter` календаря — к
компоненту связи ответственного. Макрос хранится отдельным файлом в
`taskLoadingMacro.sourceFile`, компилируется CLI и не выполняется. Смена `entitySet`
разрешена только с явным `clearIncompatible: true` после dry-run. Перед удалением агент
проверяет роли: календарь и доска являются плитками и могут быть обычными или
автоматически открываемыми. Постоянный цвет календаря в текущей модели имеет риск
повторной загрузки; при предупреждении агент оставляет dry-run и предлагает workflow
или поле цвета.

## Коды завершения

- `0` — успех;
- `1` — ошибка использования команды;
- `2` — ошибка подключения или операции;
- `3` — ошибка компиляции либо предупреждение при `--warnings-as-errors`;
- `4` — конфликт ревизии, блокировки или локального VCS-файла.

Агент должен проверять код завершения и JSON-результат каждой команды. Нельзя считать изменение применённым только по отсутствию текста в stderr.

## Что требуется для управления всей конфигурацией

Для дальнейшего безопасного расширения CLI нужны отдельные типизированные команды, а не универсальная запись свойств через reflection:

- типизированная запись статических условий остальных владельцев;
- команды правил доступа через `AccessManager`;
- dry-run, проверка ожидаемой ревизии и явный план изменений для каждой записывающей операции;
- пакетный режим с отчётом о частично выполненных операциях, так как серверное API не гарантирует одну транзакцию на все элементы.

До появления этих команд агент не должен редактировать `.fkps`, XML полного экспорта или внутренние данные сервера вручную с целью обратной загрузки.
