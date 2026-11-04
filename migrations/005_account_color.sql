ALTER TABLE accounts ADD COLUMN color TEXT NOT NULL DEFAULT '#286a90';
UPDATE accounts SET color='#934866' WHERE platform='instagram';
