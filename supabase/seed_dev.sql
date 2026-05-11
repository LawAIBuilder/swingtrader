-- Optional local dev seed. Do not run in production unless you want mock rows.
INSERT INTO wash_sale_lockout (ticker, lockout_until, reason)
VALUES ('CRWV', CURRENT_DATE + INTERVAL '30 days', 'manual dev example')
ON CONFLICT DO NOTHING;
