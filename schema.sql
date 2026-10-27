PRAGMA foreign_keys = ON;

CREATE TABLE licenses (
    id TEXT PRIMARY KEY NOT NULL,
    key_hash TEXT NOT NULL UNIQUE
        CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
    monthly_cap INTEGER NOT NULL CHECK (monthly_cap BETWEEN 0 AND 1000000000000),
    revoked_at TEXT
) STRICT;

-- All amounts are integer, fictional cost units, with no currency conversion.
-- Each UTC month keeps its own cap snapshot and outstanding reservations.
CREATE TABLE monthly_budgets (
    license_id TEXT NOT NULL REFERENCES licenses(id),
    month TEXT NOT NULL CHECK (
        month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
        AND substr(month, 6, 2) BETWEEN '01' AND '12'
    ),
    cap INTEGER NOT NULL CHECK (cap BETWEEN 0 AND 1000000000000),
    spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    PRIMARY KEY (license_id, month),
    CHECK (spent + reserved <= cap)
) STRICT;
