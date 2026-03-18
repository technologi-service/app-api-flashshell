# FlashShell Engine — API Reference

> Interactive docs (dev only): `http://localhost:3000/openapi`

---

## Setup

### Variables de entorno en el frontend

```env
VITE_API_URL=http://localhost:3000
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

### Todas las peticiones deben incluir credenciales

```js
// fetch nativo
fetch(`${import.meta.env.VITE_API_URL}/consumer/orders`, {
  credentials: 'include',   // OBLIGATORIO — envía la cookie de sesión
  headers: { 'Content-Type': 'application/json' }
})
```

```js
// axios
axios.defaults.baseURL = import.meta.env.VITE_API_URL
axios.defaults.withCredentials = true  // OBLIGATORIO
```

Sin `credentials: 'include'` / `withCredentials: true` la sesión no se envía y todas las rutas protegidas devuelven 401.

---

## Autenticación

### `POST /api/auth/sign-up/email`

```json
{ "email": "user@example.com", "password": "password123", "name": "Jane Doe" }
```

**200:**
```json
{
  "token": "<session-token>",
  "user": { "id": "uuid", "email": "user@example.com", "name": "Jane Doe", "role": "customer" }
}
```

La cookie de sesión se setea automáticamente. Guarda el `user.role` para mostrar las vistas correctas.

---

### `POST /api/auth/sign-in/email`

```json
{ "email": "user@example.com", "password": "password123" }
```

**200:** misma forma que sign-up. **401:** credenciales inválidas.

---

### `POST /api/auth/sign-out`

Sin body. Invalida la sesión y borra la cookie.

---

### `GET /api/auth/get-session`

Devuelve la sesión actual. Úsalo al cargar la app para saber si el usuario ya está logueado.

**200:**
```json
{
  "session": { "id": "uuid", "expiresAt": "2026-04-18T00:00:00Z" },
  "user": { "id": "uuid", "email": "...", "name": "...", "role": "customer" }
}
```

**401:** no hay sesión activa.

---

## Roles y acceso

| Rol | Rutas |
|-----|-------|
| `customer` | `/consumer/*` |
| `chef` | `/kds/*` |
| `delivery` | `/logistics/*`, `/couriers/*` |
| `admin` | `/control/*` |

Los roles se asignan en el servidor. El signup siempre crea `customer`. Para crear cuentas `chef`, `delivery` o `admin` usa el script de seed o hazlo directamente en la DB.

---

## Endpoints

### `GET /health`
Sin auth. Verifica que el servidor y la DB estén operativos.

**200:** `{ "status": "ok", "db": "ok", "uptime": 123.4 }`

---

### Consumer (rol: `customer`)

#### `GET /consumer/menu`
Lista de items disponibles.

**200:**
```json
[
  { "id": "uuid", "name": "Tacos de Birria", "description": "...", "price": "12.50", "isAvailable": true }
]
```

---

#### `POST /consumer/orders`
Crea una orden. Queda en estado `pending` hasta que se complete el pago.

```json
{
  "items": [
    { "menuItemId": "uuid", "quantity": 2 }
  ],
  "deliveryAddress": "Calle Falsa 123"
}
```

**200:**
```json
{
  "id": "uuid",
  "status": "pending",
  "totalAmount": "25.00",
  "items": [
    { "itemId": "uuid", "name": "Tacos de Birria", "quantity": 2, "unitPrice": "12.50" }
  ]
}
```

**409:** uno o más items sin stock — `{ "error": "CONFLICT", "details": ["<menuItemId>"] }`

---

#### `POST /consumer/orders/:id/pay`
Inicia el pago de una orden. Devuelve el `clientSecret` de Stripe para que el frontend complete el checkout.

**200:**
```json
{ "clientSecret": "pi_xxx_secret_xxx" }
```

**Con Stripe.js:**
```js
import { loadStripe } from '@stripe/stripe-js'

const stripe = await loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)

const { error } = await stripe.confirmCardPayment(clientSecret, {
  payment_method: {
    card: cardElement,  // elemento de Stripe
    billing_details: { name: 'Jane Doe' }
  }
})

if (!error) {
  // pago completado — escuchar el WebSocket para la confirmación del servidor
}
```

Cuando Stripe confirma el pago, el servidor cambia la orden de `pending` a `confirmed` automáticamente vía webhook.

---

#### `GET /consumer/orders`
Historial de órdenes del usuario autenticado.

**200:**
```json
[
  { "id": "uuid", "status": "confirmed", "totalAmount": "25.00", "createdAt": "2026-03-18T10:00:00Z" }
]
```

**Estados posibles:** `pending` → `confirmed` → `preparing` → `ready` → `delivered`

---

### KDS — Cocina (rol: `chef`)

#### `GET /kds/orders`
Todas las órdenes activas con sus items.

**200:**
```json
[
  {
    "id": "uuid",
    "status": "confirmed",
    "createdAt": "2026-03-18T10:00:00Z",
    "items": [
      { "id": "uuid", "name": "Tacos de Birria", "quantity": 2, "itemStatus": "pending" }
    ]
  }
]
```

---

#### `PATCH /kds/orders/:orderId/items/:itemId`
Avanza el estado de un item.

```json
{ "status": "preparing" }
```

`status`: `"preparing"` | `"ready"`

**200:** `{ "success": true, "advanced": true }`
`advanced: true` significa que todos los items llegaron a `ready` y la orden pasó a `ready` automáticamente.

---

#### `PATCH /kds/menu/:itemId/availability`
Activa o desactiva un item del menú.

```json
{ "isAvailable": false }
```

**200:** `{ "success": true, "isAvailable": false }`

---

### Logistics — Repartidores (rol: `delivery`)

#### `GET /logistics/pickup`
Lista de órdenes listas para recoger (`ready` y sin courier asignado).

**200:**
```json
[
  { "id": "uuid", "status": "ready", "deliveryAddress": "Calle Falsa 123", "items": [...] }
]
```

---

#### `GET /logistics/orders/:id`
Detalle de una orden específica.

---

#### `PATCH /logistics/orders/:id/picked_up`
Marca la orden como recogida. Asigna el courier autenticado.

**200:** `{ "success": true }` **409:** ya tiene courier asignado.

---

#### `PATCH /logistics/orders/:id/delivered`
Marca la orden como entregada.

**200:** `{ "success": true }` **409:** no está en estado `picked_up`.

---

### Couriers — GPS (rol: `delivery`)

#### `POST /couriers/location`
Actualiza la posición del repartidor. Throttle de 30 segundos.

```json
{ "latitude": 19.4326, "longitude": -99.1332 }
```

**200:** `{ "updated": true }` **429:** throttle activo, espera 30s.

---

### Control — Admin (rol: `admin`)

#### `GET /control/orders/active`
Todas las órdenes que no están en `delivered` ni `cancelled`.

**200:**
```json
[
  {
    "id": "uuid",
    "status": "preparing",
    "totalAmount": "25.00",
    "createdAt": "2026-03-18T10:00:00Z",
    "items": [...]
  }
]
```

---

#### `GET /control/reports/cashflow?from=YYYY-MM-DD&to=YYYY-MM-DD`
Reporte financiero del período.

**200:**
```json
{
  "from": "2026-03-01",
  "to": "2026-03-18",
  "totalRevenue": "1250.00",
  "totalStockCost": "430.00",
  "margin": "820.00"
}
```

---

## WebSocket — Tiempo real

```js
const ws = new WebSocket(`ws://localhost:3000/ws/${channel}`, [], {
  // la cookie de sesión se envía automáticamente por el browser
})

ws.onmessage = (e) => {
  const event = JSON.parse(e.data)
  console.log(event.event, event)
}
```

### Canales

| Canal | Quién escucha | Eventos |
|-------|--------------|---------|
| `kds` | Chef | `new_order`, `item_status_updated` |
| `order:<orderId>` | Customer | `order_confirmed`, `order_status_updated` |
| `logistics` | Courier | `order_ready_for_pickup` |
| `control` | Admin | `order_confirmed`, `low_stock_alert` |

### Ejemplo — escuchar confirmación de pago (customer)

```js
// Después de llamar a stripe.confirmCardPayment()
const ws = new WebSocket(`ws://localhost:3000/ws/order:${orderId}`)

ws.onmessage = (e) => {
  const { event } = JSON.parse(e.data)
  if (event === 'order_confirmed') {
    // mostrar confirmación al usuario
    ws.close()
  }
}
```

---

## Flujo de pago completo

```
1. POST /consumer/orders          → { id, status: "pending" }
2. POST /consumer/orders/:id/pay  → { clientSecret }
3. stripe.confirmCardPayment(clientSecret, { card })
4. Stripe → POST /webhooks/stripe (automático, no llamar desde frontend)
5. WS order:<id> recibe { event: "order_confirmed" }
6. Mostrar confirmación al usuario
```

---

## Errores

```json
{ "error": "ERROR_CODE", "message": "descripción" }
```

| HTTP | Código | Cuándo |
|------|--------|--------|
| 401 | `UNAUTHORIZED` | Sin sesión o sesión expirada |
| 403 | `FORBIDDEN` | Rol incorrecto para esa ruta |
| 404 | `NOT_FOUND` | Recurso no existe |
| 409 | `CONFLICT` | Stock insuficiente / estado inválido |
| 422 | `VALIDATION_ERROR` | Body inválido — incluye `details[]` |
| 500 | `INTERNAL_ERROR` | Error del servidor |

---

## Notas

- `price`, `totalAmount`, `unitPrice` son **strings** (ej. `"12.50"`), no números. Usa `parseFloat()` si necesitas operar con ellos.
- `createdAt` y fechas son **ISO 8601 UTC**.
- Todos los IDs son **UUID v4**.
- El endpoint `/webhooks/stripe` es solo para Stripe — no llamarlo desde el frontend.
