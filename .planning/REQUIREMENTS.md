# Requirements: FlashShell Engine

**Defined:** 2026-03-15
**Core Value:** Un pedido pasa de la app del cliente a la pantalla del chef en menos de 500ms, con el stock descontado y la ruta del repartidor asignada de forma automática y consistente.

## v1 Requirements

### Infrastructure

- [ ] **INFRA-01**: El sistema provee un esquema de base de datos completo con migraciones versionadas (Drizzle ORM + Neon)
- [ ] **INFRA-02**: Todos los endpoints validan el cuerpo de la petición contra schemas TypeBox y retornan errores descriptivos
- [ ] **INFRA-03**: El sistema autentica usuarios con Better Auth y expone roles: `customer | chef | delivery | admin`
- [ ] **INFRA-04**: Un middleware central rechaza peticiones sin token válido o con rol insuficiente en todos los endpoints protegidos
- [ ] **INFRA-05**: El servidor mantiene una conexión WebSocket hub usando Neon `DATABASE_DIRECT_URL` con LISTEN/NOTIFY y reconexión supervisada automática ante caídas

### Flash-Consumer (Pedidos)

- [ ] **CONS-01**: Usuario puede obtener el menú completo con precio, descripción y disponibilidad en tiempo real (activo/inactivo)
- [ ] **CONS-02**: Usuario puede crear un pedido con uno o más ítems validando stock disponible en el momento del request
- [ ] **CONS-03**: La creación de pedido usa `SELECT FOR UPDATE` para evitar race conditions de stock en pedidos concurrentes
- [ ] **CONS-04**: Usuario puede iniciar el pago de un pedido con Stripe (Payment Intent) y el sistema confirma el pedido al recibir el webhook de Stripe
- [ ] **CONS-05**: El webhook de Stripe es idempotente — reintentos de Stripe no crean pedidos duplicados
- [ ] **CONS-06**: Usuario puede suscribirse por WebSocket al estado de su pedido y recibir actualizaciones en tiempo real (confirmed → preparing → ready → delivered)
- [ ] **CONS-07**: Usuario autenticado puede ver el historial de sus pedidos anteriores

### Flash-KDS (Cocina)

- [ ] **KDS-01**: Chef autenticado recibe una notificación WebSocket en tiempo real (<500ms) cuando llega un pedido nuevo
- [ ] **KDS-02**: Chef puede marcar un ítem individual como "en preparación" (PATCH /orders/:id/items/:itemId → `preparing`)
- [ ] **KDS-03**: Chef puede marcar un ítem individual como "listo" (PATCH /orders/:id/items/:itemId → `ready`)
- [ ] **KDS-04**: Chef puede marcar un pedido completo como "listo para retiro" (PATCH /orders/:id → `ready`), lo que notifica a Logistics
- [ ] **KDS-05**: Chef puede activar o desactivar un plato del menú; el cambio se refleja en tiempo real para los clientes activos

### Flash-Logistics (Entrega)

- [ ] **LOGI-01**: Repartidor autenticado puede ver la lista de pedidos con estado `ready` disponibles para retirar
- [ ] **LOGI-02**: App del repartidor puede enviar coordenadas GPS al backend (POST /couriers/location, upsert en `courier_location`, máximo cada 30s para prevenir bloat en DB)
- [ ] **LOGI-03**: Las coordenadas GPS del repartidor se retransmiten en tiempo real por WebSocket al cliente que tiene el pedido activo
- [ ] **LOGI-04**: Repartidor puede actualizar el estado de entrega: `picked_up` → `delivered`; cada cambio notifica al cliente y al admin

### Flash-Control (Admin)

- [ ] **CTRL-01**: El stock de ingredientes se descuenta automáticamente cuando un pedido pasa a estado `confirmed` (trigger en DB, no lógica de aplicación)
- [ ] **CTRL-02**: El sistema envía una notificación WebSocket al admin cuando el stock de cualquier ingrediente cae por debajo de su umbral crítico configurado
- [ ] **CTRL-03**: Admin autenticado puede ver todos los pedidos activos con su estado actual en tiempo real vía WebSocket
- [ ] **CTRL-04**: Admin puede consultar el flujo de caja del período actual: suma de ventas confirmadas vs. suma de costos de stock consumido

## v2 Requirements

### Flash-Consumer

- **CONS-V2-01**: Usuario puede aplicar códigos de descuento o promociones en el carrito
- **CONS-V2-02**: Usuario puede ver el historial de pedidos paginado con filtros por fecha

### Flash-Control

- **CTRL-V2-01**: Admin puede ver reportes históricos de ventas por período (día/semana/mes)
- **CTRL-V2-02**: Admin puede gestionar el catálogo de ingredientes y sus costos unitarios
- **CTRL-V2-03**: Sistema calcula costo de receta por plato para reportes de margen

### Infraestructura

- **INFRA-V2-01**: Multi-tenancy — aislamiento de datos por `tenant_id` para múltiples dark kitchens
- **INFRA-V2-02**: ETA dinámico basado en distancia GPS (PostGIS en Neon)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Integraciones con Rappi / UberEats / PedidosYa | Marketplace integrations requieren contratos comerciales; v2 después de validar la app propia |
| Chat entre cliente y cocina | No es core al valor; complejidad alta; los estados del pedido cumplen la misma función |
| Facturación electrónica / compliance tributario | Regulatoriamente opcional en v1; v2 cuando el negocio lo requiera |
| App móvil nativa (iOS/Android) | Este repo es el backend; las apps son proyectos separados |
| Notificaciones push (FCM/APNs) | WebSocket cubre los casos de uso de v1; push en v2 para usuarios con app cerrada |
| Sistema de reseñas / calificaciones | No es operacional; v2 cuando haya usuarios activos para validar |
| Redis | Neon LISTEN/NOTIFY + un solo servidor cubre los casos de v1 sin Redis |

## Traceability

_Populated during roadmap creation._

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | — | Pending |
| INFRA-02 | — | Pending |
| INFRA-03 | — | Pending |
| INFRA-04 | — | Pending |
| INFRA-05 | — | Pending |
| CONS-01 | — | Pending |
| CONS-02 | — | Pending |
| CONS-03 | — | Pending |
| CONS-04 | — | Pending |
| CONS-05 | — | Pending |
| CONS-06 | — | Pending |
| CONS-07 | — | Pending |
| KDS-01 | — | Pending |
| KDS-02 | — | Pending |
| KDS-03 | — | Pending |
| KDS-04 | — | Pending |
| KDS-05 | — | Pending |
| LOGI-01 | — | Pending |
| LOGI-02 | — | Pending |
| LOGI-03 | — | Pending |
| LOGI-04 | — | Pending |
| CTRL-01 | — | Pending |
| CTRL-02 | — | Pending |
| CTRL-03 | — | Pending |
| CTRL-04 | — | Pending |

**Coverage:**
- v1 requirements: 25 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 25 ⚠

---
*Requirements defined: 2026-03-15*
*Last updated: 2026-03-15 after initial definition*
