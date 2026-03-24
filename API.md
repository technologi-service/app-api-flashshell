# FlashShell Engine — Guia de integracion Frontend

Base URL: `http://localhost:3001`
OpenAPI UI: `http://localhost:3001/openapi`

## Autenticacion

Todos los endpoints protegidos requieren el header `Authorization: Bearer <token>`.

### Sign Up (registro)

```
POST /api/auth/sign-up/email
Content-Type: application/json

{
  "email": "usuario@ejemplo.com",
  "password": "minimo8chars",
  "name": "Nombre del usuario"
}
```

Response `200`:
```json
{
  "token": "abc123...",
  "user": {
    "id": "string",
    "email": "usuario@ejemplo.com",
    "name": "Nombre del usuario",
    "role": "customer"
  }
}
```

El `role` siempre es `customer` al registrarse. No se puede elegir rol.

### Sign In (login)

```
POST /api/auth/sign-in/email
Content-Type: application/json

{
  "email": "usuario@ejemplo.com",
  "password": "minimo8chars"
}
```

Response `200`:
```json
{
  "token": "abc123...",
  "user": {
    "id": "string",
    "email": "usuario@ejemplo.com",
    "name": "Nombre del usuario",
    "role": "customer | chef | delivery | admin"
  }
}
```

**Guardar el `token`** — se usa en todas las peticiones posteriores.
**Guardar el `user.role`** — determina a que pantallas redirigir.

Error `401`: `{"message": "Invalid email or password", "code": "INVALID_EMAIL_OR_PASSWORD"}`

### Obtener sesion actual

```
GET /api/auth/get-session
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "session": { "id": "string", "expiresAt": "2026-03-26T..." },
  "user": { "id": "string", "email": "string", "name": "string", "role": "string" }
}
```

Response si no hay sesion: `null`

Usar este endpoint al cargar la app para verificar si el token guardado sigue siendo valido.

### Sign Out (logout)

```
POST /api/auth/sign-out
Authorization: Bearer <token>
```

Response `200`: `{ "success": true }`

Despues de sign-out, el token queda invalidado en el servidor. Borrar el token del almacenamiento local.

---

## Routing por rol

Despues del sign-in, redirigir segun `user.role`:

| Rol | Redirigir a | Descripcion |
|-----|------------|-------------|
| `customer` | Pantalla de menu/pedidos | Puede ver menu, crear pedidos, pagar, ver historial |
| `chef` | Pantalla KDS (cocina) | Ve ordenes confirmadas, cambia estado de items |
| `delivery` | Pantalla logistics | Ve ordenes listas, recoge y entrega |
| `admin` | Pantalla control/dashboard | Ve todas las ordenes activas, reportes |

Si un rol intenta acceder a una ruta que no le corresponde, el servidor responde:
```json
// HTTP 403
{
  "error": "FORBIDDEN",
  "message": "Requires role: chef",
  "required": ["chef"]
}
```

---

## Flujo del pedido (ciclo de vida de una orden)

```
customer crea orden          → status: "pending"
customer paga (Stripe)       → status: "confirmed"      → chef recibe notificacion
chef marca items preparing   → status: "preparing"
chef marca todos items ready → status: "ready_for_pickup" → delivery recibe notificacion
delivery recoge              → status: "picked_up"        → customer ve actualizacion
delivery entrega             → status: "delivered"         → customer ve actualizacion
```

---

## Pantalla Customer

### Ver menu

```
GET /consumer/menu
Authorization: Bearer <token>
```

Response `200`:
```json
[
  {
    "id": "uuid",
    "name": "Hamburguesa Clasica",
    "description": "Carne 200g con lechuga y tomate",
    "price": "8.50",
    "isAvailable": true
  }
]
```

Solo devuelve items con `isAvailable: true`.

### Crear pedido

```
POST /consumer/orders
Authorization: Bearer <token>
Content-Type: application/json

{
  "items": [
    { "menuItemId": "uuid-del-item", "quantity": 2 },
    { "menuItemId": "uuid-otro-item", "quantity": 1 }
  ],
  "deliveryAddress": "Calle Falsa 123, Piso 4"
}
```

Response `200`:
```json
{
  "id": "uuid-de-la-orden",
  "status": "pending",
  "totalAmount": "25.50",
  "deliveryAddress": "Calle Falsa 123, Piso 4",
  "expiresAt": "2026-03-24T10:30:00.000Z",
  "items": [
    { "itemId": "uuid", "name": "Hamburguesa Clasica", "quantity": 2, "unitPrice": "8.50" },
    { "itemId": "uuid", "name": "Papas Fritas", "quantity": 1, "unitPrice": "8.50" }
  ]
}
```

`expiresAt` marca el limite de 30 minutos para completar el pago. Pasado ese tiempo la orden se cancela automaticamente y el WebSocket envia `order_expired`. Mostrar un countdown en pantalla usando este valor.

Error `409` (sin stock o item no disponible):
```json
{
  "error": "CONFLICT",
  "message": "One or more items are unavailable or out of stock",
  "details": ["uuid-del-item-sin-stock"]
}
```

### Pagar pedido (Stripe)

```
POST /consumer/orders/:orderId/pay
Authorization: Bearer <token>
```

Response `200`:
```json
{ "clientSecret": "pi_xxx_secret_yyy" }
```

Errores HTTP:
| Status | `error` | Que mostrar |
|--------|---------|------------|
| `404` | `NOT_FOUND` | Pedido no encontrado |
| `409` | `ORDER_NOT_PENDING` | El pedido ya fue procesado |
| `409` | `INSUFFICIENT_STOCK` | Uno o mas productos ya no estan disponibles |
| `410` | `ORDER_EXPIRED` | El pedido expiro — redirigir a menu para hacer uno nuevo |

**Paso 1 — Conectar WebSocket ANTES de confirmar el pago:**
```js
const ws = new WebSocket(`ws://localhost:3001/ws/order:${orderId}`)
```

**Paso 2 — Confirmar pago con Stripe.js:**
```js
const stripe = Stripe('pk_test_...')
const { error } = await stripe.confirmCardPayment(clientSecret, {
  payment_method: {
    card: cardElement,
    billing_details: { name: 'Nombre del cliente' }
  }
})

if (error) {
  // Stripe rechazo localmente — mostrar error.message
  // El evento payment_failed llegara por WebSocket con el motivo detallado
} else {
  // Pago enviado — mostrar spinner y esperar confirmacion por WebSocket
  // NO asumir confirmado aqui: el stock se verifica en el servidor al recibir el webhook
}
```

**IMPORTANTE**: No confiar en la respuesta de `stripe.confirmCardPayment()` para mostrar "confirmado". El estado oficial siempre llega por WebSocket (`order_confirmed` o `order_cancelled`). Stripe puede reportar exito pero el stock podria haberse agotado en ese instante.

Si se llama `/pay` varias veces sobre la misma orden, el servidor cancela automaticamente el PaymentIntent anterior y crea uno nuevo. El `clientSecret` anterior queda invalido.

### Historial de pedidos

```
GET /consumer/orders
Authorization: Bearer <token>
```

Response `200`:
```json
[
  { "id": "uuid", "status": "delivered", "totalAmount": "25.50", "createdAt": "2026-03-19T..." },
  { "id": "uuid", "status": "pending", "totalAmount": "10.00", "createdAt": "2026-03-19T..." }
]
```

Ordenados por fecha descendente (mas reciente primero).

---

## Pantalla Chef (KDS)

### Ver ordenes activas

```
GET /kds/orders
Authorization: Bearer <token>
```

Response `200`:
```json
[
  {
    "id": "uuid-de-la-orden",
    "customerId": "string",
    "status": "confirmed",
    "totalAmount": "25.50",
    "deliveryAddress": "Calle Falsa 123",
    "createdAt": "2026-03-19T...",
    "items": [
      {
        "id": "uuid-del-item",
        "menuItemId": "uuid",
        "quantity": 2,
        "unitPrice": "8.50",
        "itemStatus": "pending",
        "name": "Hamburguesa Clasica"
      }
    ]
  }
]
```

Solo muestra ordenes con status `confirmed` o `preparing`.

Cada item tiene su propio `itemStatus`: `pending` → `preparing` → `ready`.

### Actualizar estado de un item

```
PATCH /kds/orders/:orderId/items/:itemId
Authorization: Bearer <token>
Content-Type: application/json

{ "status": "preparing" }   // o "ready"
```

Response `200`:
```json
{ "success": true, "advanced": false }
```

`advanced: true` significa que TODOS los items de la orden estan `ready` y la orden paso automaticamente a `ready_for_pickup`. Cuando esto pasa, mostrar feedback visual al chef (ej: "Orden lista para despacho").

### Cambiar disponibilidad de un item del menu

```
PATCH /kds/menu/:menuItemId/availability
Authorization: Bearer <token>
Content-Type: application/json

{ "isAvailable": false }
```

Response `200`: `{ "success": true, "isAvailable": false }`

---

## Pantalla Delivery

### Ver ordenes listas para recoger

```
GET /logistics/orders/ready
Authorization: Bearer <token>
```

Response `200`:
```json
[
  {
    "id": "uuid",
    "status": "ready_for_pickup",
    "totalAmount": "25.50",
    "deliveryAddress": "Calle Falsa 123",
    "createdAt": "2026-03-19T...",
    "items": [
      { "name": "Hamburguesa Clasica", "quantity": 2 }
    ]
  }
]
```

Muestra ordenes en `preparing` o `ready_for_pickup` sin courier asignado.

### Ver detalle de una orden

```
GET /logistics/orders/:orderId
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "id": "uuid",
  "status": "ready_for_pickup",
  "totalAmount": "25.50",
  "deliveryAddress": "Calle Falsa 123",
  "courierId": null,
  "createdAt": "2026-03-19T...",
  "items": [ { "name": "Hamburguesa Clasica", "quantity": 2 } ]
}
```

### Recoger orden (picked_up)

```
PATCH /logistics/orders/:orderId/status
Authorization: Bearer <token>
Content-Type: application/json

{ "status": "picked_up" }
```

Response `200`: `{ "success": true, "status": "picked_up" }`

Errores:
- `409 ALREADY_CLAIMED`: Otro courier ya tomo esta orden
- `409 COURIER_BUSY`: Ya tienes una entrega activa
- `409 INVALID_TRANSITION`: La orden no esta en `ready_for_pickup`

**Restriccion**: Un courier solo puede tener una entrega activa a la vez.

### Entregar orden (delivered)

```
PATCH /logistics/orders/:orderId/status
Authorization: Bearer <token>
Content-Type: application/json

{ "status": "delivered" }
```

Response `200`: `{ "success": true, "status": "delivered" }`

Solo el courier que recogio la orden puede marcarla como entregada.

### Enviar ubicacion GPS

```
POST /couriers/location
Authorization: Bearer <token>
Content-Type: application/json

{ "lat": -34.603722, "lng": -58.381592 }
```

Enviar periodicamente (cada 10-15 segundos) mientras el courier tenga una entrega activa.

---

## Pantalla Admin

### Ver ordenes activas

```
GET /control/orders/active
Authorization: Bearer <token>
```

Response `200`: Array de ordenes con status `confirmed` o `preparing`, incluyendo items.

### Reporte de cashflow

```
GET /control/reports/cashflow?from=2026-03-01&to=2026-03-19
Authorization: Bearer <token>
```

Parametros `from` y `to` requeridos (formato `YYYY-MM-DD`).

---

## WebSocket — Eventos en tiempo real

Conexion:
```js
const token = 'tu-bearer-token'
const ws = new WebSocket(`ws://localhost:3001/ws/${channel}`, {
  headers: { Authorization: `Bearer ${token}` }
})
```

**Desde browsers** el constructor `WebSocket` no soporta headers custom. Dos estrategias soportadas:

**Opcion 1 — Cookie (preferida, sin riesgo):**
Hacer el sign-in con `credentials: 'include'`. El browser envia la cookie automaticamente en la conexion WS.
```js
// Login con credentials: 'include'
await fetch('http://localhost:3001/api/auth/sign-in/email', {
  method: 'POST',
  credentials: 'include',  // el servidor setea Set-Cookie
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
})

// WS conecta sin token — la cookie viaja sola
const ws = new WebSocket('ws://localhost:3001/ws/kds')
```

**Opcion 2 — Query param `?token=` (fallback):**
Enviar el Bearer token como query param. Funciona pero el token queda en logs del servidor y en el historial del browser.
```js
const ws = new WebSocket(`ws://localhost:3001/ws/kds?token=${bearerToken}`)
```

> **Advertencia de seguridad**: el token en la URL es visible en logs de servidor, proxies y historial del browser. Usar solo si no es posible la autenticacion por cookie.

### Evento de conexion exitosa

Al conectarse, el servidor envia inmediatamente:
```json
{ "event": "connected", "channel": "kds", "message": "Subscribed to kds" }
```

### Keep-alive

Enviar `"ping"` periodicamente. El servidor responde `"pong"`.

### Canales por rol

| Canal | Rol | Cuando suscribirse |
|-------|-----|-------------------|
| `order:{orderId}` | customer | Despues de crear un pedido, para seguir su estado |
| `kds` | chef | Al entrar a la pantalla KDS, para recibir ordenes nuevas |
| `logistics` | delivery | Al entrar a la pantalla de delivery, para ordenes listas |
| `control` | admin | Al entrar al dashboard, para ver todo en tiempo real |

### Eventos que recibe cada canal

**Canal `order:{orderId}`** (customer):
```json
// Pago confirmado — cocina recibe la orden
{ "channel": "order:uuid", "event": "order_confirmed", "orderId": "uuid", "status": "confirmed" }

// Pago rechazado — informar motivo y permitir reintento (max 3 veces)
{ "channel": "order:uuid", "event": "payment_failed", "orderId": "uuid", "reason": "Fondos insuficientes", "attemptsRemaining": 2, "message": "El pago no se ha podido procesar. Te quedan 2 intentos." }

// Orden cancelada (3 fallos, stock agotado tras pagar, o pago cancelado)
{ "channel": "order:uuid", "event": "order_cancelled", "orderId": "uuid", "reason": "Descripcion del motivo" }

// Orden expirada (30 min sin pagar)
{ "channel": "order:uuid", "event": "order_expired", "orderId": "uuid", "reason": "Tu pedido ha expirado. No se completo el pago en los 30 minutos disponibles." }

// Seguimiento post-confirmacion
{ "channel": "order:uuid", "event": "item_status_changed", "orderId": "uuid", "itemId": "uuid", "status": "preparing" }
{ "channel": "order:uuid", "event": "order_status_changed", "orderId": "uuid", "status": "ready_for_pickup" }
{ "channel": "order:uuid", "event": "order_picked_up", "orderId": "uuid", "courierId": "string" }
{ "channel": "order:uuid", "event": "order_delivered", "orderId": "uuid" }
```

Logica recomendada para el canal `order:{orderId}`:
- `order_confirmed` → mostrar "Pedido confirmado, la cocina lo esta preparando" y pasar a pantalla de seguimiento
- `payment_failed` → mostrar `event.message` con motivo + boton "Intentar de nuevo" (volver a llamar `/pay`)
- `order_cancelled` → mostrar `event.reason` + boton "Volver al menu" (estado terminal)
- `order_expired` → mostrar `event.reason` + boton "Hacer nuevo pedido" (estado terminal)

**Canal `kds`** (chef):
```json
{ "channel": "kds", "event": "new_order", "orderId": "uuid" }
{ "channel": "kds", "event": "order_ready", "orderId": "uuid" }
```

Al recibir `new_order`, hacer `GET /kds/orders` para refrescar la lista.

**Canal `logistics`** (delivery):
```json
{ "channel": "logistics", "event": "order_ready_for_pickup", "orderId": "uuid" }
```

Al recibir `order_ready_for_pickup`, hacer `GET /logistics/orders/ready` para refrescar.

**Canal `control`** (admin):
```json
{ "channel": "control", "event": "order_picked_up", "orderId": "uuid", "courierId": "string" }
{ "channel": "control", "event": "order_delivered", "orderId": "uuid" }
```

---

## Manejo de errores

Todos los errores siguen este formato:
```json
{
  "error": "ERROR_CODE",
  "message": "Descripcion legible"
}
```

| HTTP | Codigo | Significado |
|------|--------|-------------|
| 401 | `UNAUTHORIZED` | Token ausente, invalido o sesion expirada → redirigir a login |
| 403 | `FORBIDDEN` | Rol incorrecto → no mostrar esa seccion |
| 404 | `NOT_FOUND` | Recurso no existe |
| 409 | `CONFLICT` | Estado invalido (sin stock, orden ya tomada, etc) |
| 410 | `ORDER_EXPIRED` | La ventana de 30 min para pagar ha expirado → redirigir a menu |
| 422 | `VALIDATION_ERROR` | Body mal formado (tiene campo `details` con array de errores) |

---

## Cuentas de prueba

Ejecutar `bun run db:seed:roles` en el backend para crear estos usuarios:

| Rol | Email | Password |
|-----|-------|----------|
| customer | (registrar via sign-up) | (el que elijas) |
| chef | chef@flashshell.test | test-chef-pass |
| delivery | delivery@flashshell.test | test-delivery-pass |
| admin | admin@flashshell.test | test-admin-pass |

---

## Flujo completo para validar pantallas

### 1. Customer: crear y pagar pedido
1. `POST /api/auth/sign-up/email` → registrar usuario
2. `GET /consumer/menu` → mostrar menu
3. `POST /consumer/orders` → crear pedido — guardar `id` y mostrar countdown con `expiresAt`
4. **Conectar WebSocket a `ws://localhost:3001/ws/order:{orderId}`** — antes de pagar
5. `POST /consumer/orders/:id/pay` → obtener `clientSecret`
6. Confirmar pago con `stripe.confirmCardPayment(clientSecret, ...)`
7. Mostrar spinner — esperar evento por WebSocket:
   - `order_confirmed` → ir a pantalla de seguimiento
   - `payment_failed` → mostrar motivo + boton reintentar (volver al paso 5)
   - `order_cancelled` → mostrar motivo, estado terminal
   - `order_expired` → pedido caducado, volver al menu

### 2. Chef: preparar pedido
1. `POST /api/auth/sign-in/email` → login como chef
2. Conectar WebSocket a `ws://localhost:3001/ws/kds`
3. `GET /kds/orders` → ver ordenes activas
4. `PATCH /kds/orders/:id/items/:itemId` → `{"status": "preparing"}`
5. `PATCH /kds/orders/:id/items/:itemId` → `{"status": "ready"}`
6. Si `advanced: true` → orden lista para despacho

### 3. Delivery: recoger y entregar
1. `POST /api/auth/sign-in/email` → login como delivery
2. Conectar WebSocket a `ws://localhost:3001/ws/logistics`
3. `GET /logistics/orders/ready` → ver ordenes listas
4. `PATCH /logistics/orders/:id/status` → `{"status": "picked_up"}`
5. `POST /couriers/location` → enviar GPS periodicamente
6. `PATCH /logistics/orders/:id/status` → `{"status": "delivered"}`

### 4. Admin: monitorear
1. `POST /api/auth/sign-in/email` → login como admin
2. Conectar WebSocket a `ws://localhost:3001/ws/control`
3. `GET /control/orders/active` → ver dashboard
4. `GET /control/reports/cashflow?from=2026-03-01&to=2026-03-31` → ver reporte
