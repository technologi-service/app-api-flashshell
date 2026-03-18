-- 0004_stock_trigger.sql
-- CTRL-01: Automatic stock deduction when order status transitions to 'confirmed'
-- CTRL-02: Low-stock pg_notify alert when ingredient falls below critical_threshold

CREATE OR REPLACE FUNCTION deduct_stock_on_confirm()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only fire when transitioning INTO 'confirmed' (idempotent guard)
  IF NEW.status = 'confirmed' AND OLD.status != 'confirmed' THEN
    -- Deduct ingredient stock based on order items and recipe quantities
    UPDATE ingredients i
    SET stock_quantity = i.stock_quantity - (mii.quantity_used * oi.quantity),
        updated_at = NOW()
    FROM order_items oi
    JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
    WHERE oi.order_id = NEW.id
      AND mii.ingredient_id = i.id;

    -- Emit order_confirmed to control channel for admin dashboard (CTRL-03 real-time)
    PERFORM pg_notify(
      'flashshell_events',
      json_build_object(
        'channel', 'control',
        'event', 'order_confirmed',
        'orderId', NEW.id::text
      )::text
    );

    -- Emit low_stock_alert for any ingredient now below critical_threshold (CTRL-02)
    PERFORM pg_notify(
      'flashshell_events',
      json_build_object(
        'channel', 'control',
        'event', 'low_stock_alert',
        'ingredientId', i.id::text,
        'ingredientName', i.name,
        'currentStock', i.stock_quantity::float,
        'criticalThreshold', i.critical_threshold::float
      )::text
    )
    FROM ingredients i
    JOIN menu_item_ingredients mii ON mii.ingredient_id = i.id
    JOIN order_items oi ON oi.menu_item_id = mii.menu_item_id
    WHERE oi.order_id = NEW.id
      AND i.stock_quantity < i.critical_threshold;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deduct_stock_on_confirm ON orders;
CREATE TRIGGER trg_deduct_stock_on_confirm
  AFTER UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION deduct_stock_on_confirm();
