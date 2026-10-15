# Feature: Sincronizar leverage del bot con Extended (y venues activos)

## Contexto

- El cambio de leverage por Telegram (`/config` → ⚡️ Leverage → `handleSettingValueInput`)
  solo muta `config.leverage` (sizing: notional = margin × leverage). **Nunca lo escribe al venue.**
- RISEx sí escribe: `validateExecutionPreflight` llama `updateLeverage` (SDK).
- Extended NO escribe: su preflight solo valida `leverage <= maxLeverage` localmente.
- Extended tiene endpoint oficial: `PATCH /api/v1/user/leverage` (body
  `{"market": "BTC-USD", "leverage": "10"}`, ambos strings; auth `X-Api-Key`,
  sin firma Stark) y `GET /api/v1/user/leverage?market={market}`.
  Fuente: https://api.docs.extended.exchange/ (secciones "Get current leverage" /
  "Update leverage"). Falla si posición+órdenes trigger exceden el máx del leverage
  o si el available balance no cubre el margen adicional.
- El preflight de arranque en `main.ts` ya itera los exchanges activos con
  `capabilities.orderPlacement` + `execution` y llama `validateExecutionPreflight`
  con `config.leverage` (después de restaurar overrides de DB). Si Extended escribe
  el leverage dentro de su preflight, el arranque queda cubierto sin tocar main.ts
  salvo el comentario.

## Tareas

1. [x] **Extended HTTP client + adapter**: agregar `patch()` al `ExtendedHttpClient`
   y a la interfaz `ExtendedHttpApi`; en `validateExecutionPreflight`, tras los
   checks existentes, resolver el market y hacer
   `PATCH /api/v1/user/leverage` `{market: getMarketName(market), leverage: String(input.leverage)}`
   con `{private: true}`.
2. [x] **Telegram leverage change**: en `handleSettingValueInput`, para
   `kind === "leverage"`, preparar los venues ANTES de aplicar (mismo patrón que
   el flujo de Pairs): validación local (exportar `MAX_LEVERAGE` de
   runtime-settings), luego `validateExecutionPreflight({symbol, leverage: value})`
   en cada exchange activo con `capabilities.orderPlacement && execution`;
   si falla alguno, no aplicar y mostrar `❌` con los errores; si ok, `applyLeverage`
   + persist + mensaje de confirmación.
3. [x] **main.ts**: actualizar el comentario del preflight de arranque (RISEx write
   → RISEx + Extended write). El loop ya cubre los exchanges activos.
4. [x] **Docs**: `docs/exchanges/extended-execution.md` — agregar los endpoints
   leverage a "Implemented endpoints" y nota en "Current support".

## Restricciones

- NO agregar tests (pausados por instrucción del usuario).
- No axios; `fetch` nativo ya encapsulado en el HTTP client.
- Verificación: `yarn typecheck` debe pasar.

## Evidencia

- `yarn typecheck` exit 0 (observado en esta sesión).
- Commits: pendiente (los work-unit commits quedan en manos del usuario).
