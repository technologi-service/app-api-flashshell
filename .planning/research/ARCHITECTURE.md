# Architecture Patterns

**Domain:** Dark Kitchen Backend (monolito modular)
**Project:** FlashShell Engine
**Researched:** 2026-03-15
**Overall confidence:** HIGH (Elysia plugin API estable, PostgreSQL LISTEN/NOTIFY bien documentado, order lifecycle es patrón estándar de dominio)

---

## Recommended Architecture

### Visión general

Monolito modular con cuatro plugins de Elysia como fronteras de dominio, una capa de acceso a datos compartida (DAL), y un bus de eventos interno basado en Neon LISTEN/NOTIFY. Los módulos se comunican exclusivamente a través de eventos de base de datos y contratos de tipos TypeScript compartidos — nunca se llaman entre sí directamente.

```
┌─────────────────────────────────────────────────────────────┐
│  src/index.ts  —  Elysia root app                           │
│                                                             │
│  .use(authPlugin)      — JWT + role middleware global       │
│  .use(consumerPlugin)  — /consumer/*   (cliente)            │
│  .use(kdsPlugin)       — /kds/*        (cocina)             │
│  .use(logisticsPlugin) — /logistics/*  (repartidor)         │
│  .use(controlPlugin)   — /control/*    (admin)              │
│  .use(wsPlugin)        — /ws           (WebSocket hub)      │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │     DAL     │  src/db/
                    │  (queries)  │  — pool.ts
                    └──────┬──────┘  — schema.ts
                           │         — queries/*.ts
                    ┌──────▼──────┐
                    │    Neon     │
                    │ PostgreSQL  │
                    │             │
                    │ LISTEN/     │◄─── PG triggers
                    │ NOTIFY bus  │     emiten eventos
                    └─────────────┘
```

---

## Component Boundaries

| Componente | Responsabilidad | Expone | Consume |
|------------|----------------|--------|---------|
| `authPlugin` | Validar JWT, inyectar `ctx.user` con rol y userId | `ctx.user` via Elysia derive | Auth provider externo (JWT verify) |
| `consumerPlugin` | CRUD de pedidos desde perspectiva cliente: ver menú, crear pedido, consultar estado | `GET /consumer/menu`, `POST /consumer/orders`, `GET /consumer/orders/:id` | DAL → orders, menu, items |
| `kdsPlugin` | Gestión de cocina: recibir pedidos, actualizar estado de ítems, marcar pedido listo | `PATCH /kds/orders/:id/status`, `PATCH /kds/items/:id/status`, `PATCH /kds/menu/:id/availability` | DAL → orders, order_items, menu |
| `logisticsPlugin` | Gestión de repartidor: ver pedidos listos, push GPS, actualizar estado entrega | `GET /logistics/ready`, `POST /logistics/location`, `PATCH /logistics/orders/:id/status` | DAL → orders, delivery_locations |
| `controlPlugin` | Dashboard admin: stock, finanzas, alertas, pedidos globales | `GET /control/stock`, `GET /control/financials`, `GET /control/orders` | DAL → stock, orders, financials |
| `wsPlugin` | Hub WebSocket: gestionar conexiones por rol/orderId, recibir NOTIFY de PG, broadcast | `WS /ws?role=&orderId=` | Neon LISTEN via pg dedicated connection |
| `DAL` | Todas las queries SQL parametrizadas. Sin lógica de negocio. | Funciones TypeScript por entidad | Neon pool de conexiones |

### Regla de frontera crítica

Los plugins NO se importan entre sí. La comunicación cruzada ocurre únicamente a través de:
1. Cambios en la base de datos (un plugin escribe → PG trigger emite NOTIFY → wsPlugin difunde)
2. Tipos compartidos en `src/shared/types.ts`

Esto garantiza que cada módulo se pueda extraer a microservicio sin reescribir lógica.

---

## Data Flow

### Flujo principal: pedido nuevo (end-to-end)

```
[App cliente]
    │
    ├─ POST /consumer/orders
    │       │
    │  consumerPlugin
    │       │
    │  1. Validar stock disponible (SELECT ... FOR UPDATE en transaction)
    │  2. INSERT orders + order_items
    │  3. UPDATE stock (descuento atómico)
    │  4. PG trigger: NOTIFY 'order_events', payload JSON
    │       │
    │  Responde 201 { orderId, status: 'pending' }
    │
    └─ [Neon NOTIFY]
            │
       wsPlugin (dedicated LISTEN connection)
            │
       Parse payload → determinar canales destino
            │
       ┌────┴──────────────────────────┐
       │                               │
  Broadcast a                   Broadcast a
  canal 'kds'                   canal 'order:{id}'
       │                               │
  [Pantalla KDS]              [App cliente — estado]
```

### Flujo GPS del repartidor

```
[App repartidor] — POST /logistics/location { lat, lng, orderId }
    │
logisticsPlugin
    │
INSERT delivery_locations (lat, lng, driver_id, order_id, timestamp)
    │
PG trigger: NOTIFY 'location_events', { orderId, lat, lng }
    │
wsPlugin → broadcast canal 'order:{orderId}' → [App cliente — mapa]
```

### Flujo de stock con descuento atómico

```
POST /consumer/orders (dentro de una transaction SQL):

BEGIN;

-- 1. Verificar y bloquear stock para cada ingrediente del pedido
SELECT stock_id, quantity_available
FROM stock
WHERE ingredient_id = ANY($ingredientIds)
FOR UPDATE;  -- bloqueo pesimista

-- 2. Verificar suficiencia (en app layer, dentro de la misma tx)
-- Si falla: ROLLBACK → 409 Conflict

-- 3. Descontar
UPDATE stock
SET quantity_available = quantity_available - $amount,
    updated_at = NOW()
WHERE ingredient_id = $ingredientId;

-- 4. Insertar pedido e ítems
INSERT INTO orders ...
INSERT INTO order_items ...

COMMIT;
```

El `SELECT ... FOR UPDATE` dentro de la misma transaction garantiza que dos pedidos concurrentes no consuman el mismo stock. Neon soporta transacciones estándar PostgreSQL.

---

## Order Lifecycle

### Diagrama de estados

```
pending ──► confirmed ──► preparing ──► ready ──► picked_up ──► delivered
                │                                      │
                └── cancelled (antes de preparing)     └── failed (edge case)
```

### Transiciones y actores

| Transición | Actor | Evento emitido |
|------------|-------|---------------|
| `pending → confirmed` | Sistema (post-pago exitoso) | `order_confirmed` |
| `confirmed → preparing` | Chef (KDS) | `order_preparing` |
| `preparing → ready` | Chef (KDS) | `order_ready` |
| `ready → picked_up` | Repartidor (Logistics) | `order_picked_up` |
| `picked_up → delivered` | Repartidor (Logistics) | `order_delivered` |
| `* → cancelled` | Admin o sistema (pago fallido) | `order_cancelled` |

### Regla de transición

Solo el actor autorizado puede mover el estado. La lógica de validación vive en el plugin correspondiente, validada contra el rol en `ctx.user.role`.

---

## Database Schema (alto nivel)

### Entidades principales

```sql
-- Menú
menu_items (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  is_available BOOLEAN DEFAULT true,
  preparation_minutes INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

-- Ingredientes y stock
ingredients (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL  -- 'kg', 'unit', 'liter'
)

stock (
  id UUID PRIMARY KEY,
  ingredient_id UUID REFERENCES ingredients(id),
  quantity_available NUMERIC(10,3) NOT NULL,
  critical_threshold NUMERIC(10,3) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)

-- Relación ítem-ingrediente para descuento automático
menu_item_ingredients (
  menu_item_id UUID REFERENCES menu_items(id),
  ingredient_id UUID REFERENCES ingredients(id),
  quantity_required NUMERIC(10,3) NOT NULL,
  PRIMARY KEY (menu_item_id, ingredient_id)
)

-- Pedidos
orders (
  id UUID PRIMARY KEY,
  customer_id TEXT NOT NULL,           -- sub del JWT
  status order_status NOT NULL DEFAULT 'pending',
  total_amount NUMERIC(10,2) NOT NULL,
  payment_id TEXT,                     -- referencia al procesador de pagos
  driver_id TEXT,                      -- sub del JWT del repartidor asignado
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
)

-- Ítems del pedido
order_items (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id),
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL,   -- precio al momento del pedido
  status item_status NOT NULL DEFAULT 'pending',
  PRIMARY KEY (id)
)

-- Ubicaciones GPS del repartidor
delivery_locations (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  driver_id TEXT NOT NULL,
  lat NUMERIC(10,7) NOT NULL,
  lng NUMERIC(10,7) NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
)

-- Tipos ENUM
CREATE TYPE order_status AS ENUM (
  'pending', 'confirmed', 'preparing', 'ready',
  'picked_up', 'delivered', 'cancelled'
);

CREATE TYPE item_status AS ENUM (
  'pending', 'preparing', 'ready'
);
```

### Triggers para LISTEN/NOTIFY

```sql
-- Trigger en orders: emite evento en cada cambio de estado
CREATE OR REPLACE FUNCTION notify_order_change()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'order_events',
    json_build_object(
      'event', 'order_status_changed',
      'order_id', NEW.id,
      'old_status', OLD.status,
      'new_status', NEW.status,
      'customer_id', NEW.customer_id,
      'driver_id', NEW.driver_id,
      'updated_at', NEW.updated_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_status_changed
AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION notify_order_change();

-- Trigger en stock: alerta de umbral crítico
CREATE OR REPLACE FUNCTION notify_stock_critical()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quantity_available <= NEW.critical_threshold THEN
    PERFORM pg_notify(
      'stock_events',
      json_build_object(
        'event', 'stock_critical',
        'ingredient_id', NEW.ingredient_id,
        'quantity_available', NEW.quantity_available,
        'critical_threshold', NEW.critical_threshold
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_level_changed
AFTER UPDATE OF quantity_available ON stock
FOR EACH ROW EXECUTE FUNCTION notify_stock_critical();
```

### Índices críticos para performance

```sql
-- Pedidos activos por cliente (consulta frecuente en app)
CREATE INDEX idx_orders_customer_status ON orders (customer_id, status);

-- Pedidos listos para repartidor
CREATE INDEX idx_orders_status ON orders (status) WHERE status IN ('ready', 'picked_up');

-- Historial GPS de un pedido
CREATE INDEX idx_delivery_locations_order ON delivery_locations (order_id, recorded_at DESC);

-- Stock por ingrediente
CREATE UNIQUE INDEX idx_stock_ingredient ON stock (ingredient_id);
```

---

## Elysia Modular Structure

### Estructura de directorios

```
src/
├── index.ts                    # Root app — solo monta plugins
├── shared/
│   ├── types.ts               # OrderStatus, UserRole, DTOs compartidos
│   └── errors.ts              # Error classes con status codes
├── db/
│   ├── pool.ts                # Neon connection pool (singleton)
│   ├── schema.ts              # Tipos TypeScript de filas DB
│   └── queries/
│       ├── orders.ts
│       ├── menu.ts
│       ├── stock.ts
│       └── delivery.ts
├── plugins/
│   ├── auth.ts                # authPlugin: JWT decode, ctx.user inject
│   ├── consumer/
│   │   ├── index.ts          # consumerPlugin: monta rutas
│   │   ├── routes.ts
│   │   └── handlers.ts
│   ├── kds/
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── handlers.ts
│   ├── logistics/
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── handlers.ts
│   ├── control/
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── handlers.ts
│   └── ws/
│       ├── index.ts          # wsPlugin: WebSocket hub + LISTEN loop
│       └── channels.ts       # Lógica de routing de mensajes por canal
└── migrations/
    ├── 001_initial_schema.sql
    ├── 002_triggers.sql
    └── 003_indexes.sql
```

### Patrón de plugin Elysia

Cada módulo sigue este patrón (HIGH confidence — API estable desde Elysia 0.7):

```typescript
// src/plugins/consumer/index.ts
import { Elysia } from 'elysia'
import { authPlugin } from '../auth'

export const consumerPlugin = new Elysia({ prefix: '/consumer' })
  .use(authPlugin)
  .get('/menu', getMenuHandler)
  .post('/orders', createOrderHandler, {
    body: t.Object({ items: t.Array(...) })  // Elysia TypeBox validation
  })
  .get('/orders/:id', getOrderHandler)

// src/index.ts
const app = new Elysia()
  .use(consumerPlugin)
  .use(kdsPlugin)
  .use(logisticsPlugin)
  .use(controlPlugin)
  .use(wsPlugin)
  .listen(3000)
```

### WebSocket Hub con LISTEN/NOTIFY

El patrón clave: una sola conexión dedicada a PostgreSQL que hace LISTEN, separada del pool HTTP. Cuando llega un NOTIFY, itera sobre las conexiones WebSocket activas y hace broadcast selectivo por canal.

```typescript
// src/plugins/ws/index.ts — patrón conceptual
import { Elysia } from 'elysia'

// Mapa de conexiones: canal → Set de WebSocket handlers
const channels = new Map<string, Set<(data: string) => void>>()

// Conexión dedicada para LISTEN (no del pool HTTP)
// Se inicializa una vez al arrancar el servidor
async function startListenLoop(client: PgClient) {
  await client.query('LISTEN order_events')
  await client.query('LISTEN stock_events')
  await client.query('LISTEN location_events')

  client.on('notification', (msg) => {
    const payload = JSON.parse(msg.payload ?? '{}')
    const targetChannels = resolveChannels(msg.channel, payload)
    targetChannels.forEach(channel => {
      channels.get(channel)?.forEach(send => send(msg.payload!))
    })
  })
}

// Endpoint WebSocket
export const wsPlugin = new Elysia()
  .ws('/ws', {
    query: t.Object({
      role: t.String(),
      orderId: t.Optional(t.String())
    }),
    open(ws) {
      // Suscribir esta conexión a los canales apropiados según rol
      const channel = resolveSubscriptionChannel(ws.data.query)
      if (!channels.has(channel)) channels.set(channel, new Set())
      const send = (data: string) => ws.send(data)
      channels.get(channel)!.add(send)
      ws.data.cleanup = () => channels.get(channel)!.delete(send)
    },
    close(ws) {
      ws.data.cleanup?.()
    },
    message(ws, message) {
      // WebSocket es principalmente push del server; mensajes cliente son mínimos
    }
  })
```

**Nota sobre `pg_notify` payload:** PostgreSQL limita el payload de NOTIFY a 8000 bytes. Los payloads deben ser IDs y metadatos mínimos — los clientes hacen un fetch HTTP para datos completos si los necesitan.

### Resolución de canales por rol

| Rol | Canal WebSocket | Recibe |
|-----|-----------------|--------|
| `customer` + orderId | `order:{orderId}` | Cambios de estado de su pedido, ubicación GPS |
| `chef` | `kds` | Todos los pedidos nuevos confirmados |
| `delivery` | `logistics` | Pedidos en estado `ready` + `picked_up` |
| `admin` | `control` | Todos los eventos (stock crítico, pedidos, finanzas) |

---

## Patterns to Follow

### Pattern 1: Transacción atómica para descuento de stock

**What:** Todo pedido nuevo ejecuta INSERT orders + UPDATE stock en una sola transaction con `SELECT ... FOR UPDATE` para bloquear filas de stock.
**When:** Siempre que se cree o cancele un pedido (cancelación revierte el stock).
**Why:** Neon usa PostgreSQL estándar — las transactions ACID garantizan que bajo carga concurrente, dos pedidos del mismo ingrediente no generen stock negativo.

### Pattern 2: Plugin con prefijo, auth como dependencia interna

**What:** Cada plugin declara `new Elysia({ prefix: '/module' }).use(authPlugin)` internamente en lugar de montarlo globalmente solo en la raíz.
**When:** Siempre — módulos autónomos.
**Why:** Permite testear cada plugin de forma aislada inyectando un mock de auth, sin depender de que el root app monte auth primero.

### Pattern 3: NOTIFY payload mínimo, fetch para detalles

**What:** Los payloads de pg_notify contienen solo `{ event, order_id, new_status }`. Los clientes que necesitan datos completos hacen una llamada HTTP a la API REST.
**When:** Siempre — no poner modelos completos en NOTIFY.
**Why:** El límite de 8KB de pg_notify y la separación de concerns entre "notificación de cambio" y "lectura de datos".

### Pattern 4: DAL sin ORM — queries tipadas con pg

**What:** Funciones TypeScript en `src/db/queries/*.ts` que retornan tipos explícitos. Sin ORM.
**When:** Toda interacción con la base de datos.
**Why:** Neon funciona con el driver `pg` estándar. Un ORM agrega overhead de construcción de queries en hot paths (alta concurrencia). Las queries SQL explícitas son más debuggeables en producción.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Plugins que se llaman entre sí

**What:** `consumerPlugin` importa y llama funciones de `kdsPlugin`.
**Why bad:** Crea acoplamiento circular y rompe la posibilidad de extraer módulos a servicios independientes.
**Instead:** Toda comunicación cruzada vía cambios en DB + NOTIFY.

### Anti-Pattern 2: LISTEN en el pool HTTP

**What:** Usar la misma conexión del pool HTTP para hacer LISTEN.
**Why bad:** El pool recicla conexiones. Una conexión que hace LISTEN y luego vuelve al pool pierde su suscripción o bloquea al próximo consumer.
**Instead:** Una conexión dedicada (fuera del pool) exclusivamente para LISTEN, iniciada en el arranque del servidor.

### Anti-Pattern 3: Lógica de negocio en handlers

**What:** Poner validaciones de negocio (¿puede este chef cambiar este pedido?) directamente en el handler HTTP.
**Why bad:** Difícil de testear, se duplica si hay múltiples rutas que hacen la misma operación.
**Instead:** Handlers delegan a funciones de servicio en `handlers.ts`; los handlers de Elysia solo hacen parse/validate/response.

### Anti-Pattern 4: Conexión directa a Neon sin pooling

**What:** `new Client()` por cada request.
**Why bad:** Neon tiene límites de conexiones concurrentes. Un spike de tráfico puede agotar conexiones en segundos.
**Instead:** Pool de conexiones singleton (`src/db/pool.ts`) con `max: 10` para v1 single-tenant.

### Anti-Pattern 5: Guardar coordenadas GPS en orders

**What:** Columna `current_lat / current_lng` directamente en la tabla `orders`.
**Why bad:** Las coordenadas llegan cada pocos segundos. Un UPDATE frecuente en la tabla `orders` (que es la más consultada) genera contención.
**Instead:** Tabla separada `delivery_locations` con INSERT por punto; la app cliente obtiene la última via `ORDER BY recorded_at DESC LIMIT 1`.

---

## Build Order (orden de construcción sugerido)

El orden está determinado por dependencias técnicas: lo que todo lo demás necesita va primero.

```
Fase 1: Infraestructura base
  ├── Neon: schema + migrations (orders, stock, menu, delivery_locations)
  ├── PG triggers para NOTIFY
  ├── DAL: pool.ts + queries básicas
  └── authPlugin: JWT decode + ctx.user inject
  [BLOQUEANTE: todo lo demás depende de esto]

Fase 2: Core del dominio — Flash-Consumer + Flash-KDS
  ├── consumerPlugin: menú, crear pedido (con transacción atómica)
  ├── kdsPlugin: recibir pedido, actualizar estados
  └── wsPlugin: hub básico, LISTEN loop, broadcast a 'kds' y 'order:{id}'
  [BLOQUEANTE: el valor central del producto — pedido → cocina en <500ms]

Fase 3: Flash-Logistics
  ├── logisticsPlugin: ver pedidos ready, push GPS, cambiar estado
  └── Extender wsPlugin: canal 'logistics', broadcast de location_events
  [Depende de: Fase 2 (estados de pedido bien definidos)]

Fase 4: Flash-Control
  ├── controlPlugin: dashboard stock, alertas, finanzas
  └── Extender wsPlugin: canal 'control', broadcast de stock_events
  [Depende de: Fase 1 (stock schema), Fase 2 (orders data)]

Fase 5: Pagos + Auth completo
  ├── Integración procesador de pagos (TBD: MercadoPago/Stripe)
  ├── Transición pending → confirmed post-pago
  └── Roles completos con restricciones por pilar
  [Depende de: Fases 2-4 completas para saber qué proteger]
```

### Rationale del orden

- **Auth primero** porque todos los handlers necesitan `ctx.user.role` para validar permisos.
- **Consumer + KDS antes que Logistics** porque Logistics opera sobre pedidos en estado `ready`, que requiere que el ciclo completo consumer→kds funcione.
- **Control al final** porque es read-heavy sobre datos que las otras fases producen; no desbloquea nada operativo.
- **Pagos al final** porque el flujo funcional (pedido→cocina→repartidor) se puede testear end-to-end con `status = 'confirmed'` seteado manualmente; el procesador de pagos es la variable más incierta (LATAM, compatibilidad con Bun) y no debe bloquear el desarrollo del dominio.

---

## Scalability Considerations

| Concern | v1 (single-tenant, ~50 pedidos/día) | v2 (~500 pedidos/día) | v3 multi-tenant |
|---------|-------------------------------------|----------------------|-----------------|
| Conexiones DB | Pool max:10, LISTEN x1 | Pool max:20, monitorear | Pool por tenant, PgBouncer |
| WebSocket connections | En memoria (Map local) | En memoria suficiente | Redis Pub/Sub para multi-instancia |
| Stock contention | SELECT FOR UPDATE suficiente | Evaluar queue por ítem popular | Sharding por tenant |
| GPS updates | INSERT cada push, no throttle | TTL + rate limit por repartidor | Particionado por fecha |
| NOTIFY payload | Sin límite práctico a baja escala | Monitorear payload size | Canal por tenant |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Elysia plugin API | HIGH | API estable documentada; patrón `.use()` con prefijo es canónico desde Elysia 0.7 |
| Order lifecycle states | HIGH | Patrón estándar de dominio en food delivery; igual en Rappi/DoorDash/Uber Eats |
| PostgreSQL LISTEN/NOTIFY | HIGH | Feature core de PG desde v8; compatible con Neon (misma wire protocol) |
| Transacción atómica stock | HIGH | `SELECT FOR UPDATE` es patrón estándar ACID; funciona en Neon |
| WebSocket channel routing | MEDIUM | Implementación específica de Elysia WS — patrón correcto pero detalles de API pueden diferir de la versión más reciente |
| PG NOTIFY payload limit | HIGH | Documentado: 8000 bytes máximo |
| Neon connection limits | MEDIUM | Neon serverless tiene límites según plan; los números exactos dependen del tier contratado |

---

## Sources

- Elysia documentation: Plugin pattern con `.use()` y `prefix` — patrón canónico del framework
- PostgreSQL 16 docs: `pg_notify()`, `LISTEN/NOTIFY`, `SELECT FOR UPDATE`
- Neon docs: Compatible con PostgreSQL wire protocol; soporta LISTEN/NOTIFY en conexiones dedicadas (no en serverless HTTP driver)
- Food delivery domain modeling: Order lifecycle basado en patrones estándar de la industria (DoorDash, Rappi internal docs públicos)
- Confidence note: Web/search tools no disponibles durante esta investigación. Las afirmaciones técnicas sobre Elysia se basan en conocimiento de entrenamiento (cutoff agosto 2025). Se recomienda verificar la API exacta de `ws()` en Elysia contra la documentación oficial al implementar Fase 2.
