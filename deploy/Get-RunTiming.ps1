param(
    [ValidatePattern('^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')][string]$RunId,
    [string]$Container = 'agentic-platformin-app-1'
)
$ErrorActionPreference = 'Stop'
$reader = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/state.sqlite', { readOnly: true });
try {
  const id = process.env.BRIDGE_TIMING_RUN_ID;
  const row = id ? db.prepare('SELECT payload FROM runs WHERE id = ?').get(id)
    : db.prepare(`SELECT payload FROM runs WHERE json_extract(payload, '$.chatId') IS NOT NULL
        ORDER BY json_extract(payload, '$.createdAt') DESC LIMIT 1`).get();
  if (!row) throw new Error('Задание не найдено');
  const run = JSON.parse(row.payload);
  const calls = db.prepare(`SELECT payload FROM detailed_audit WHERE json_extract(payload, '$.details.runId') = ?
    AND json_extract(payload, '$.action') IN ('erp.cli.read', 'erp.cli.command', 'erp.mcp.call') ORDER BY at`).all(run.id);
  const fields = ['scope','success','status','elapsedMs','trustMs','ticketMs','ticketStatus','cliRpcMs','cliProcessMs','exitCode','mcpTokenMs','mcpHttpMs'];
  console.log(JSON.stringify({ runId: run.id, model: run.model, status: run.status, createdAt: run.createdAt,
    elapsedMs: Math.max(0, (run.completedAt ? Date.parse(run.completedAt) : Date.now()) - Date.parse(run.createdAt)),
    timing: run.timing, erpCalls: calls.map(row => {
      const event = JSON.parse(row.payload);
      return { at: event.createdAt, operation: event.targetId, type: event.action,
        ...Object.fromEntries(fields.filter(key => event.details?.[key] !== undefined).map(key => [key, event.details[key]])) };
    }),
  }));
} finally { db.close(); }
'@
$json = $reader | docker exec -i -e "BRIDGE_TIMING_RUN_ID=$RunId" $Container node
if ($LASTEXITCODE -ne 0) { throw 'Не удалось прочитать тайминги из контейнера.' }
($json -join "`n") | ConvertFrom-Json
