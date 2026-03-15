# FlashShell Engine

## What This Is

Backend monolítico distribuido para el sector Dark Kitchen, construido con Bun + Elysia + TypeScript sobre Neon (PostgreSQL). Centraliza cuatro pilares operativos — pedidos de clientes (Flash-Consumer), gestión de cocina en tiempo real (Flash-KDS), logística de entrega con GPS (Flash-Logistics) y control financiero/inventario (Flash-Control) — bajo un único contrato de datos con sincronización por WebSocket.

## Core Value

Un pedido pasa de la app del cliente a la pantalla del chef en menos de 500ms, con el stock descontado y la ruta del repartidor asignada de forma automática y consistente.

## Requirements

### Validated

- ✓ Runtime Bun + framework Elysia en TypeScript configurado y corriendo en puerto 3000 — existente

### Active

**Flash-Consumer (Pedidos)**
- [ ] Cliente puede ver el menú con precios y disponibilidad en tiempo real
- [ ] Cliente puede crear un pedido con múltiples ítems
- [ ] Cliente puede pagar el pedido vía Stripe (Payment Intent + webhook)
- [ ] Cliente puede ver el estado del pedido y ubicación del repartidor en tiempo real

**Flash-KDS (Cocina)**
- [ ] Chef recibe notificación WebSocket al instante cuando llega un pedido nuevo
- [ ] Chef puede marcar ítems individuales como "en preparación" y "listo"
- [ ] Chef puede marcar un pedido como "listo para retirar"
- [ ] Chef puede cambiar la disponibilidad de un plato (activo/inactivo)

**Flash-Logistics (Entrega)**
- [ ] Repartidor puede ver pedidos listos para retirar
- [ ] App del repartidor envía coordenadas GPS al backend periódicamente
- [ ] Backend actualiza la posición del repartidor en tiempo real para el cliente
- [ ] Repartidor puede actualizar estado del pedido (en camino → entregado)

**Flash-Control (Admin)**
- [ ] Admin puede ver el flujo de caja (ventas vs. costos) por período
- [ ] Stock se descuenta automáticamente por cada venta confirmada
- [ ] Admin recibe alerta cuando un ingrediente supera umbral crítico de stock
- [ ] Admin puede ver todos los pedidos activos y su estado global

**Infraestructura transversal**
- [ ] Autenticación con Better Auth con roles: customer | chef | delivery | admin
- [ ] Sincronización en tiempo real vía Neon LISTEN/NOTIFY → WebSocket broadcast
- [ ] Estructura modular por pilar lista para evolucionar a multi-tenant

### Out of Scope

- Multi-tenancy (múltiples dark kitchens) — arquitectura preparada pero no implementada en v1
- Integraciones con Rappi / UberEats / Pedidos Ya — v2, después de tener la app propia funcionando
- Chat entre cliente y cocina — no es core al valor del producto
- Facturación / reportes tributarios — v2

## Context

El repo parte de un bootstrap Bun + Elysia (`src/index.ts` con un único `GET /` que responde "Hello Elysia"). No hay base de datos conectada, ni rutas de negocio, ni autenticación. Todo el dominio se construye desde cero sobre esta base.

Neon es la base de datos elegida (PostgreSQL serverless). La sincronización en tiempo real se implementará con `LISTEN/NOTIFY` de PostgreSQL + Elysia WebSocket — sin Redis como dependencia adicional. El procesador de pagos y el auth provider se definirán en la fase de investigación según compatibilidad con Bun/Elysia y el mercado LATAM.

El dominio "dark kitchen" implica operación de alta velocidad: múltiples pedidos concurrentes, tiempos de preparación ajustados, y consistencia financiera estricta (el stock debe reflejar cada venta sin lag).

## Constraints

- **Stack**: Bun + Elysia + TypeScript — ya decidido, no negociable
- **Base de datos**: Neon (PostgreSQL) — ya provisionado, sin Redis en v1
- **Single-tenant**: v1 opera para una sola dark kitchen. Multi-tenant es diseño futuro, no implementación presente
- **Real-time sin Redis**: La sincronización usa Neon LISTEN/NOTIFY + WebSocket nativo de Elysia
- **GPS**: Las coordenadas llegan desde la app móvil del repartidor (push), no se consultan a terceros
- **Elysia plugin pattern**: Cada pilar y módulo transversal se implementa como `new Elysia({ prefix })` registrado con `.use()`. Nunca código de dominio suelto en `index.ts`.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Monolito modular (no microservicios) | El equipo arranca solo; las fronteras de módulo permiten extraer servicios después sin reescribir | — Pending |
| Neon LISTEN/NOTIFY en lugar de Redis | Elimina una dependencia, reduce costos, suficiente para v1 single-tenant | — Pending |
| Better Auth para autenticación | Auth TypeScript-first, compatible con Bun, sin vendor lock-in pesado; roles custom directamente en el token | — Pending |
| Stripe para pagos | API robusta, SDK fetch-based compatible con Bun, webhook system maduro para idempotencia | — Pending |
| Single-tenant v1 | Simplifica el modelo de datos; el diseño mantiene `tenant_id` para migración futura sin romper esquema | — Pending |

---
*Last updated: 2026-03-15 after initialization*
