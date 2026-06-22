SELECT assigned_to_franchise, COUNT(*) as cnt FROM pin_packages WHERE status = 'used' GROUP BY assigned_to_franchise;
SELECT id, code, login_pin, used_by, assigned_to_franchise, status FROM pin_packages WHERE status = 'used' AND assigned_to_franchise != 3 ORDER BY id;
