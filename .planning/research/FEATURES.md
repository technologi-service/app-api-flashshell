# Feature Landscape: FlashShell Engine (Dark Kitchen Backend)

**Domain:** Dark Kitchen — Operaciones backend de cocina fantasma con cuatro pilares operativos
**Researched:** 2026-03-15
**Confidence note:** Basado en conocimiento de dominio profundo de sistemas dark kitchen, KDS industriales (Toast, Square KDS, Lightspeed), plataformas de delivery (Rappi, UberEats, iFood), y los requisitos explícitos del PROJECT.md. Sin acceso a herramientas de búsqueda externas en esta sesión — marcar como MEDIUM confidence donde aplique verificación externa.

---

## Contexto: Por Qué Dark Kitchen Difiere de Food Delivery Genérico

Una dark kitchen opera sin salón ni caja física. Esto implica:

1. **Cero tolerancia a inconsistencias de stock** — no hay mesero que "avise que se acabó"; el sistema debe bloquear el item antes de que el cliente lo ordene.
2. **Latencia cocina < 500ms es un SLA operativo** — el chef no puede esperar; cada segundo de delay alarga la cola de preparación.
3. **El repartidor es el único punto de contacto post-compra** — el tracking GPS no es un lujo, es la única visibilidad del cliente.
4. **La caja es cierre del día, no accesorio** — sin sala, el único control financiero es digital.

Estas cuatro realidades determinan qué es table stakes y qué es diferenciador.

---

## Pilar 1: Flash-Consumer (Pedidos del Cliente)

### Table Stakes

Features sin los cuales el sistema no puede procesar un solo pedido.

| Feature | Por Qué Es Obligatorio | Complejidad | Notas |
|---------|----------------------|-------------|-------|
| Listado de menú con precio y disponibilidad | Sin esto no hay compra posible | Baja | `GET /menu` — debe reflejar stock real-time |
| Agrupación de menú en categorías | Orientación del cliente; sin esto el menú es ilegible | Baja | Categorías: entradas, principales, bebidas, postres |
| Indicador de item disponible/agotado | Sin esto el cliente ordena items imposibles de preparar | Media | Ligado al estado de stock de Flash-Control |
| Carrito de compra con múltiples ítems | Pedido mínimo viable; sin esto solo se puede comprar 1 item | Media | Estado en backend, no solo frontend |
| Customización básica de item (notas / sin ingrediente) | Clientes con restricciones dietarias; sin esto el abandono es alto | Media | Campo `notes: string` por item — sin variantes complejas en v1 |
| Creación de pedido confirmado | El acto central del sistema | Baja | Transición `cart → order` con validación atómica |
| Validación de stock al confirmar pedido | Evita condiciones de carrera: dos clientes comprando el último item | Alta | Requiere `SELECT FOR UPDATE` o serializable transaction |
| Pago pre-entrega (online) | Dark kitchen = cobro antes de cocinar; sin esto hay fraude/abandono | Alta | Integración MercadoPago (LATAM) — ver decisión pendiente |
| Estado del pedido en tiempo real | El cliente necesita saber: recibido → en preparación → listo → en camino → entregado | Media | WebSocket broadcast desde backend |
| Tracking de ubicación del repartidor | Sin esto el cliente no sabe cuándo llega; llamadas al soporte se disparan | Alta | Feed de coordenadas GPS desde Flash-Logistics |
| Confirmación de pedido recibido (push/notif) | El cliente necesita confirmación inmediata o asume que falló | Media | WebSocket event + email/push opcional |

### Diferenciadores

Features que elevan la experiencia pero no bloquean el MVP.

| Feature | Valor Competitivo | Complejidad | Notas |
|---------|------------------|-------------|-------|
| Tiempo estimado de entrega dinámico | Reduce ansiedad; diferencia de apps genéricas que dan ventanas de 45min | Alta | Basado en cola de cocina actual + distancia GPS |
| Historial de pedidos del cliente | Re-order con un tap; aumenta retención | Media | `GET /orders/history` por customer_id |
| Recomendaciones basadas en historial | Aumenta ticket promedio | Alta | Defer a v2 — requiere ML/heurística |
| Notificación cuando el repartidor está a X metros | "Tu repartidor está a 2 minutos" | Media | Geo-fence calculado en backend |
| Calificación del pedido post-entrega | Feedback loop para la cocina | Baja | Simple 1-5 stars + comentario opcional |

### Anti-Features (NO construir en v1)

| Anti-Feature | Por Qué Evitar | Alternativa |
|--------------|---------------|-------------|
| Guest checkout sin cuenta | Requiere reconciliar datos de pago sin identidad; fraude alto | Registro obligatorio con auth provider |
| Múltiples métodos de pago simultáneos (split payment) | Complejidad de reconciliación 10x; no es core | Soportar 1 método por pedido |
| Cupones / descuentos complejos (combinables, por categoría) | Sistema de reglas complejo; distrae del core | Máximo 1 descuento simple por pedido en v1 |
| Wallet / saldo interno del cliente | Regulación financiera compleja en LATAM | Usar procesador externo siempre |
| Suscripciones / membresías | Modelo de negocio diferente; infraestructura de billing recurrente | Fuera de alcance v1 |
| Chat cliente-cocina | Carga operativa; no reduce tiempo de entrega | Campo `notes` en el pedido |

---

## Pilar 2: Flash-KDS (Kitchen Display System)

### Table Stakes

| Feature | Por Qué Es Obligatorio | Complejidad | Notas |
|---------|----------------------|-------------|-------|
| Queue de pedidos en tiempo real | El chef necesita ver todos los pedidos pendientes ordenados por llegada | Media | WebSocket push; no polling |
| Detalle expandido de pedido (items + notas) | El chef necesita saber exactamente qué preparar | Baja | Incluir `notes` del cliente por item |
| Marcado de item como "en preparación" | Control fino de progreso; permite coordinar estaciones de cocina | Media | Estado por item, no solo por pedido |
| Marcado de item como "listo" | Cierre de la unidad de trabajo del chef | Baja | Trigger para actualizar estado del pedido |
| Marcado de pedido completo como "listo para retirar" | Trigger que notifica al sistema de logística | Baja | Cambia estado pedido a `ready_for_pickup` |
| Priorización por tiempo de espera | Evita que pedidos viejos queden atascados en cola | Media | Ordenación por `created_at`; resaltado visual de pedidos con >X min |
| Toggle de disponibilidad de plato (activo/inactivo) | Gestión de "se acabó el día" sin ir a admin | Baja | `PATCH /menu/items/:id/availability` — rol chef |
| Alerta de pedido urgente / retrasado | Pedidos que superan el tiempo estimado deben resaltarse | Media | Computed en backend: `now() - order.created_at > threshold` |

### Diferenciadores

| Feature | Valor Competitivo | Complejidad | Notas |
|---------|------------------|-------------|-------|
| Tiempo de preparación promedio por plato | Le dice al admin cuánto demora realmente cada item | Media | Running average calculado en cierre de item |
| Vista por estación de cocina | Diferentes pantallas para parrilla vs frío vs postres | Alta | Requiere asignar items a estaciones — v2 |
| Bump bar / botones físicos de confirmación | Chef puede marcar listo sin tocar pantalla | Alta | Integración hardware; v2 |
| Estadísticas de throughput en tiempo real | Pedidos/hora, items/hora — para ajustar staffing | Media | Agregaciones simples en queries |

### Anti-Features

| Anti-Feature | Por Qué Evitar | Alternativa |
|--------------|---------------|-------------|
| Recetas completas en el KDS | El chef las sabe; pantalla llena de texto ralentiza lectura | Solo nombre de item + notas del pedido |
| Fotos de platos en KDS | Bandwidth, latencia de imagen, pantalla de cocina tiene vapor | Solo texto |
| Chat con el cliente desde KDS | Distrae al chef; cocina no es soporte | Chef solo marca estados |
| Sistema de tickets impreso integrado | Complejidad de driver de impresora; WiFi en cocina es poco confiable | Display digital primario; impresora opcional v2 |

---

## Pilar 3: Flash-Logistics (Entrega y GPS)

### Table Stakes

| Feature | Por Qué Es Obligatorio | Complejidad | Notas |
|---------|----------------------|-------------|-------|
| Lista de pedidos listos para retirar | El repartidor necesita saber qué retirar y en qué orden | Baja | `GET /orders?status=ready_for_pickup` filtrado por repartidor asignado |
| Asignación de repartidor a pedido | Sin esto dos repartidores van por el mismo pedido | Media | Manual en v1 (admin asigna); automático en v2 |
| Detalle del pedido con dirección de entrega | Repartidor necesita destino exacto | Baja | Dirección + coordenadas del cliente |
| Push de coordenadas GPS desde app del repartidor | El corazón del tracking — el repartidor manda su posición | Media | `POST /deliveries/:id/location` con lat/lng; rate: cada 5-10 seg |
| Broadcast de posición GPS al cliente | El cliente ve la ubicación del repartidor en su app | Media | WebSocket event `delivery.location_updated` |
| Actualización de estado de entrega | `picked_up → in_transit → delivered` | Baja | `PATCH /deliveries/:id/status` — rol delivery |
| Confirmación de entrega (acción del repartidor) | Cierre del ciclo operativo y financiero | Baja | Trigger para actualizar pedido a `delivered` |

### Diferenciadores

| Feature | Valor Competitivo | Complejidad | Notas |
|---------|------------------|-------------|-------|
| Radio de entrega configurable | Controla zona de cobertura sin geo-fencing costoso | Baja | Simple validación de distancia en confirmación de pedido |
| ETA dinámico basado en GPS | "Llega en 8 minutos" calculado con distancia real | Media | Requiere cálculo de ruta (Google Maps API o Haversine simple) |
| Historial de entregas del repartidor | Para métricas de performance y pago por entrega | Media | Agregación simple de `deliveries` completadas |
| Asignación automática de repartidor más cercano | Optimización operativa; reduce tiempo de recolección | Alta | Requiere indexación geoespacial y algoritmo — v2 |
| Prueba de entrega (foto) | Protege contra fraude "no me llegó" | Media | Upload de imagen — v2, requiere object storage |

### Anti-Features

| Anti-Feature | Por Qué Evitar | Alternativa |
|--------------|---------------|-------------|
| Optimización multi-pedido (batching) | Un repartidor toma N pedidos en un viaje; complejidad de routing exponencial | Solo 1 pedido por repartidor en v1 |
| Tracking de flota con mapa en admin | Mapa en tiempo real de todos los repartidores simultáneos requiere tile server | Lista tabular de estados en v1 |
| Integración con Rappi/UberEats Logistics | Diferentes APIs, webhooks, y modelos de comisión | Repartidores propios en v1 |
| Cálculo de costo de envío por distancia | Requiere geocoding + routing API + modelo de precios | Tarifa plana de envío en v1 |

---

## Pilar 4: Flash-Control (Admin, Stock y Finanzas)

### Table Stakes

| Feature | Por Qué Es Obligatorio | Complejidad | Notas |
|---------|----------------------|-------------|-------|
| Vista de todos los pedidos activos con estado global | Sin esto el admin opera a ciegas | Baja | `GET /orders?status=active` con joins de estado |
| Descuento automático de stock por venta confirmada | Consistencia financiera core; sin esto el inventario es ficticio | Alta | Trigger post-pago: `ingredients -= recipe_quantities` |
| Vista de stock actual por ingrediente | Para tomar decisiones de compra | Baja | `GET /inventory` |
| Ingreso manual de stock (reposición) | Admin carga mercadería comprada | Baja | `PATCH /inventory/:ingredient_id/quantity` |
| Alerta de stock bajo | Sin esto el admin descubre el faltante cuando el chef lo reporta | Media | Threshold configurable por ingrediente; WebSocket o email |
| Flujo de caja del período (ingresos vs costos) | KPI financiero básico de la operación | Media | Suma de `orders.total` por período vs `inventory_costs` |
| Reporte de ventas por período | Cuántos pedidos, cuánto se vendió, top items | Media | Agregaciones SQL por `created_at` |
| Gestión de usuarios y roles (customer/chef/delivery/admin) | Sin esto no hay control de acceso operativo | Media | Delegado al auth provider + tabla `user_roles` local |
| Activar/desactivar items del menú | Gestión de carta sin tocar código | Baja | `PATCH /menu/items/:id` — rol admin |
| Gestión de precios del menú | Sin esto no se puede actualizar precios | Baja | `PATCH /menu/items/:id` — rol admin |

### Diferenciadores

| Feature | Valor Competitivo | Complejidad | Notas |
|---------|------------------|-------------|-------|
| Costo de receta calculado automáticamente | `recipe_cost = sum(ingredient_unit_cost * quantity)` — margen real por plato | Media | Requiere tabla `recipes` con ingredientes y cantidades |
| Margen por plato en tiempo real | Alerta si el margen cae por variación de costo de ingredientes | Alta | Derived metric: `(price - recipe_cost) / price` |
| Dashboard de eficiencia de cocina | Tiempo promedio de preparación, pedidos/hora, items más vendidos | Media | Queries de agregación sobre `order_items` con timestamps |
| Exportación de reporte a CSV | Para contabilidad externa | Baja | `GET /reports/sales?format=csv` |
| Gestión de proveedores y costos | Quién suministra qué, a qué precio | Media | Tabla `suppliers` + `ingredient_supplier_prices` — v2 |

### Anti-Features

| Anti-Feature | Por Qué Evitar | Alternativa |
|--------------|---------------|-------------|
| Facturación electrónica (AFIP/SAT/SUNAT) | Regulación por país, alto costo de integración, fuera del core | Exportar datos; facturación externa |
| Contabilidad doble entrada (debe/haber) | Sistema contable completo es un producto separado | Flujo de caja simple (ingresos - costos) |
| Gestión de nómina de empleados | RRHH es dominio diferente | Métricas de performance sí, nómina no |
| Multi-kitchen analytics cruzados | Requiere multi-tenancy primero | Single-tenant v1 |
| Predicción de demanda con ML | Útil pero requiere historial de datos significativo | Con 3 meses de datos reales, reconsiderar |

---

## Infraestructura Transversal (Cross-Cutting)

### Table Stakes

| Feature | Por Qué Es Obligatorio | Complejidad | Notas |
|---------|----------------------|-------------|-------|
| Autenticación con roles (customer/chef/delivery/admin) | Sin roles, cualquiera puede acceder a cualquier endpoint | Alta | Auth provider externo + `user_roles` local |
| Autorización por endpoint (RBAC) | Chef no puede modificar precios; customer no puede ver caja | Media | Middleware de Elysia con verificación de rol |
| WebSocket con autenticación | Canal real-time no puede ser público | Media | Verificar JWT en handshake WS |
| Validación de schema en todos los endpoints | Previene inyección y crashes por datos malformados | Media | `@elysiajs/eden` + TypeBox schemas |
| Health check endpoint | Para balanceadores de carga y monitoring | Baja | `GET /health` — siempre |
| Variables de entorno para configuración | Sin esto el deploy es imposible | Baja | `DATABASE_URL`, `JWT_SECRET`, `PAYMENT_KEY` |
| Manejo de errores estructurado | Sin esto debugging en producción es ciego | Media | Error handler global de Elysia con códigos HTTP correctos |
| Transacciones atómicas para operaciones críticas | Pago + descuento de stock deben ser atómicos | Alta | PostgreSQL transactions; Neon soporta ACID completo |

### Diferenciadores

| Feature | Valor Competitivo | Complejidad | Notas |
|---------|------------------|-------------|-------|
| Rate limiting por IP/usuario | Previene abuso de la API | Media | Middleware Elysia — importante para endpoint de pedidos |
| Logging estructurado con request ID | Trazabilidad en producción | Baja | `pino` o similar — impacto alto en operabilidad |
| API versioning (`/v1/`) | Evolucionar API sin romper clientes | Baja | Prefijo desde el inicio, costo zero ahora vs alto después |
| Idempotency keys en pagos | Previene cargos duplicados si el cliente reintenta | Alta | Header `Idempotency-Key` + tabla de keys procesadas |

---

## Dependencias Entre Features

```
Ingredientes/Recetas → Menú con disponibilidad real
Menú → Carrito
Carrito → Creación de pedido
Creación de pedido → Validación de stock (atómica)
Validación de stock → Pago
Pago → Descuento de stock automático (Flash-Control)
Pago → Notificación al KDS (Flash-KDS)
Notificación al KDS → Queue de pedidos en pantalla
Queue KDS → Marcado de estado de preparación
Marcado "listo para retirar" → Lista de pickup en Flash-Logistics
Lista de pickup → Asignación de repartidor
Asignación de repartidor → Push de GPS
Push de GPS → Broadcast de posición al cliente
Estado "entregado" → Cierre de caja (Flash-Control)

Auth/Roles ─────────────────────────────────→ Todo
WebSocket ──────────────────────────────────→ KDS, Logistics, Consumer tracking
Transacciones atómicas ──────────────────────→ Pago + Stock descuento
```

---

## MVP Recommendation

### Priorizar en v1 (en este orden)

**Bloque 1 — Fundamentos (todo lo demás depende de esto):**
1. Auth con roles + RBAC en endpoints
2. Esquema de base de datos: menú, pedidos, stock, usuarios, entregas
3. WebSocket con autenticación

**Bloque 2 — Flujo mínimo de venta:**
4. Menú con disponibilidad real-time (ligado a stock)
5. Creación de pedido con validación atómica de stock
6. Integración de pagos (MercadoPago — decisión pendiente)
7. Descuento automático de stock post-pago

**Bloque 3 — Operaciones de cocina:**
8. KDS: queue de pedidos en tiempo real vía WebSocket
9. KDS: marcado de estados de preparación y pedido completo
10. Toggle de disponibilidad de plato desde KDS

**Bloque 4 — Logística:**
11. Lista de pedidos listos para pickup
12. Push de GPS del repartidor + broadcast al cliente
13. Actualización de estado de entrega

**Bloque 5 — Control admin:**
14. Vista de pedidos activos
15. Alerta de stock bajo
16. Reporte de ventas por período (flujo de caja básico)

### Diferir para v2

| Feature | Razón de Diferimiento |
|---------|----------------------|
| Asignación automática de repartidor | Requiere indexación geoespacial; v1 con asignación manual |
| ETA dinámico con routing real | API externa (Google Maps) + complejidad; Haversine como aproximación |
| Costo de receta automático | Requiere tabla de recetas completa; útil pero no bloquea operación |
| Exportación CSV de reportes | Nice-to-have; no bloquea operación financiera básica |
| Calificación post-entrega | Feedback loop valioso pero no operativo |
| Prueba de entrega (foto) | Requiere object storage; diferir |
| Integración con plataformas (Rappi/UberEats) | App propia primero |

---

## Mapa de Complejidad Total

| Área | Features Table Stakes | Features Diferenciadores | Complejidad Dominante |
|------|----------------------|--------------------------|----------------------|
| Flash-Consumer | 11 | 5 | Transacción atómica pago+stock, GPS tracking |
| Flash-KDS | 8 | 4 | WebSocket broadcast sub-500ms |
| Flash-Logistics | 7 | 5 | GPS push + broadcast, asignación |
| Flash-Control | 10 | 5 | Descuento automático de stock, reporting |
| Transversal | 8 | 4 | Auth/RBAC, transacciones, WebSocket auth |
| **Total v1** | **44** | **23** | — |

El 80% del valor viene del 40% de los features. El flujo `pedido → cocina → entrega → caja` con consistencia atómica en stock y tiempo real vía WebSocket es el core irreducible.

---

## Sources

- PROJECT.md de FlashShell Engine (fuente primaria de requisitos, 2026-03-15)
- Domain knowledge: Toast KDS, Square KDS, Lightspeed Restaurant — patrones de sistemas KDS industriales (MEDIUM confidence — training data, no verificado externamente)
- Domain knowledge: Rappi, iFood, UberEats backend patterns — order lifecycle, delivery tracking (MEDIUM confidence — training data)
- Domain knowledge: MercadoPago LATAM integration patterns — payment flows (MEDIUM confidence — training data)
- Domain knowledge: PostgreSQL transactional patterns para food delivery — stock atomicity, race conditions (HIGH confidence — well-established pattern)
