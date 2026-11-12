-- Sample data (migration 002)

INSERT INTO movies (title, duration_min, language) VALUES
  ('Inception',    148, 'English'),
  ('3 Idiots',     170, 'Hindi'),
  ('Interstellar', 169, 'English');

-- 2 shows per movie, starting tomorrow at 18:00 and 21:00
INSERT INTO shows (movie_id, screen, start_time, price)
SELECT m.id, s.screen, (now()::date + 1) + s.start_at, s.price
FROM movies m
CROSS JOIN (VALUES
  ('Screen 1', INTERVAL '18 hours', 250),
  ('Screen 2', INTERVAL '21 hours', 300)
) AS s(screen, start_at, price);

-- 24 seats per show: rows A, B, C with seats 1 to 8
INSERT INTO seats (show_id, seat_label)
SELECT sh.id, r.letter || n.num
FROM shows sh
CROSS JOIN (VALUES ('A'), ('B'), ('C')) AS r(letter)
CROSS JOIN generate_series(1, 8) AS n(num)
ORDER BY sh.id, r.letter, n.num;  -- A1..A8, then B1..B8, then C1..C8
