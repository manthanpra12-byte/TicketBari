-- TicketBari database schema (migration 001)

-- A movie that can be shown
CREATE TABLE movies (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(200) NOT NULL,
  duration_min  INT,
  language      VARCHAR(30)
);

-- One screening of a movie at a time and price
CREATE TABLE shows (
  id          SERIAL PRIMARY KEY,
  movie_id    INT NOT NULL REFERENCES movies(id),
  screen      VARCHAR(20),
  start_time  TIMESTAMPTZ NOT NULL,
  price       NUMERIC(8,2) NOT NULL
);

-- Every seat of a show (A1, A2, ...). A label can appear only once per show.
CREATE TABLE seats (
  id          SERIAL PRIMARY KEY,
  show_id     INT NOT NULL REFERENCES shows(id),
  seat_label  VARCHAR(5) NOT NULL,
  UNIQUE (show_id, seat_label)
);

-- One row per booking attempt. This is also our transaction log:
-- status moves PENDING -> CONFIRMED or FAILED.
CREATE TABLE bookings (
  id          UUID PRIMARY KEY,
  user_id     VARCHAR(50) NOT NULL,
  show_id     INT NOT NULL REFERENCES shows(id),
  status      VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  request_id  VARCHAR(64),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Which seats a confirmed booking owns.
-- UNIQUE (show_id, seat_id) is the final guard against double booking:
-- the database refuses a second booking of the same seat, even if two workers race.
CREATE TABLE booking_seats (
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  show_id     INT NOT NULL,
  seat_id     INT NOT NULL REFERENCES seats(id),
  UNIQUE (show_id, seat_id)
);
