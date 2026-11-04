CREATE TABLE orders (
 id TEXT PRIMARY KEY,
 date TEXT NOT NULL,
 phone TEXT NOT NULL,
 data TEXT NOT NULL,
 refused INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX orders_date ON orders(date);
CREATE INDEX orders_phone ON orders(phone);
