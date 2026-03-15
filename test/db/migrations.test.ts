// test/db/migrations.test.ts
import { describe, it, expect } from 'bun:test'
import { menuItems, ingredients, menuItemIngredients } from '../../src/db/schema/menu'
import { orders, orderItems, orderStatusEnum } from '../../src/db/schema/orders'
import { courierLocations } from '../../src/db/schema/logistics'
import { paymentIntents } from '../../src/db/schema/payments'

describe('Drizzle schema exports', () => {
  it('menu schema exports are defined', () => {
    expect(menuItems).toBeDefined()
    expect(ingredients).toBeDefined()
    expect(menuItemIngredients).toBeDefined()
  })

  it('orders schema exports are defined', () => {
    expect(orders).toBeDefined()
    expect(orderItems).toBeDefined()
    expect(orderStatusEnum).toBeDefined()
  })

  it('logistics schema exports are defined', () => {
    expect(courierLocations).toBeDefined()
  })

  it('payments schema exports are defined', () => {
    expect(paymentIntents).toBeDefined()
  })

  it('order status enum has all 7 values', () => {
    const values = orderStatusEnum.enumValues
    expect(values).toContain('pending')
    expect(values).toContain('confirmed')
    expect(values).toContain('preparing')
    expect(values).toContain('ready_for_pickup')
    expect(values).toContain('picked_up')
    expect(values).toContain('delivered')
    expect(values).toContain('cancelled')
  })
})
