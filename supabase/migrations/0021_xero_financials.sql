-- ============================================================================
-- 0021_xero_financials.sql
-- Financial control data layer: Xero sync tables + agent outputs.
--
-- What's added:
--
--   raw.xero_api_log         — timestamped landing zone for every raw Xero
--                              API response (JSONB). Re-parse without re-fetching.
--
--   brain.xero_accounts      — chart of accounts; one row per account code.
--   brain.xero_bank_txns     — bank transactions with reconciliation status.
--   brain.xero_invoices      — sales invoices (ACCREC) and purchase bills (ACCPAY).
--                              Bills flagged as inventory-cost are marked
--                              is_capitalised = true (IAS 2 treatment).
--   brain.xero_tax_rates     — VAT code definitions.
--
--   brain.cashflow_forecast  — rolling 52-week forecast. One row per week.
--                              Actuals overwrite forecast as weeks close.
--
--   ops.pnl_monthly          — monthly P&L snapshots written by the pnl-balance
--                              agent after each Xero P&L pull.
--   ops.balance_sheet_monthly — monthly balance sheet snapshots.
--   ops.financial_audit_log  — findings written by the xero-audit agent.
--                              Append-only. Each run adds new rows; old rows
--                              are never deleted (audit trail).
--
-- Capitalisation rules (IAS 2 / FRS 102):
--   Inbound freight, import duties, and FBA shipping are part of the cost of
--   bringing inventory to its present location and condition. They sit on the
--   Balance Sheet (inventory asset) until the corresponding stock is sold, at
--   which point they release to COGS. The is_capitalised flag on xero_invoices
--   implements this classification; the releasing logic lives in the
--   pnl-balance agent skill.
--
-- Schema placement rationale:
--   raw.*    — untouched API payloads. Never query for reporting; re-parse only.
--   brain.*  — parsed canonical reference data. One row per source entity.
--   ops.*    — agent-computed outputs and rollups (not raw source data).
--   meta.*   — wiring/connection metadata (not used in this migration).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- raw.xero_api_log
-- Landing zone. The xero-operator-stack writes here on every sync.
-- The endpoint column allows re-parsing a specific API response type.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.xero_api_log (
    id              BIGSERIAL    PRIMARY KEY,
    fetched_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    endpoint        TEXT         NOT NULL,  -- e.g. 'Accounts', 'BankTransactions'
    tenant_id       TEXT         NOT NULL,
    response_json   JSONB        NOT NULL,
    record_count    INT          NOT NULL DEFAULT 0,
    CONSTRAINT xero_api_log_endpoint_check
        CHECK (endpoint IN (
            'Accounts', 'BankTransactions', 'Invoices',
            'TaxRates', 'Journals', 'ProfitAndLoss',
            'BalanceSheet', 'TrialBalance'
        ))
);

CREATE INDEX IF NOT EXISTS xero_api_log_endpoint_fetched
    ON raw.xero_api_log (endpoint, fetched_at DESC);

COMMENT ON TABLE raw.xero_api_log IS
    'Timestamped landing zone for raw Xero API responses. Never query for reporting. '
    'Re-parse into brain.* without re-fetching.';

-- ----------------------------------------------------------------------------
-- brain.xero_accounts
-- Chart of accounts. Synced on demand; full replace per sync.
-- statement_type derived from Xero account type at parse time.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.xero_accounts (
    account_id      TEXT         PRIMARY KEY,  -- Xero AccountID (UUID)
    code            TEXT,                       -- nominal code, e.g. '200', '630'
    name            TEXT         NOT NULL,
    type            TEXT         NOT NULL,      -- Xero account type (EXPENSE, BANK, etc.)
    statement_type  TEXT         NOT NULL,      -- 'ProfitAndLoss' | 'BalanceSheet'
    tax_type        TEXT,                       -- default VAT code for this account
    status          TEXT         NOT NULL DEFAULT 'ACTIVE',
    is_capitalised  BOOLEAN      NOT NULL DEFAULT false,
    -- true if this account code appears in XERO_CAPITALISE_ACCOUNTS (.env)
    -- set at sync time by the xero-operator-stack
    synced_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT xero_accounts_statement_type_check
        CHECK (statement_type IN ('ProfitAndLoss', 'BalanceSheet')),
    CONSTRAINT xero_accounts_status_check
        CHECK (status IN ('ACTIVE', 'ARCHIVED'))
);

CREATE INDEX IF NOT EXISTS xero_accounts_code ON brain.xero_accounts (code);
CREATE INDEX IF NOT EXISTS xero_accounts_type  ON brain.xero_accounts (type);

COMMENT ON TABLE brain.xero_accounts IS
    'Chart of accounts from Xero. Full replace on each sync. '
    'is_capitalised=true means bills to this account are inventory costs (BS).';

-- ----------------------------------------------------------------------------
-- brain.xero_bank_txns
-- Bank transactions. Idempotent on xero_transaction_id.
-- is_reconciled is the critical flag for the audit agent.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.xero_bank_txns (
    xero_transaction_id  TEXT         PRIMARY KEY,  -- Xero BankTransactionID
    date                 DATE         NOT NULL,
    type                 TEXT         NOT NULL,      -- RECEIVE, SPEND, etc.
    status               TEXT         NOT NULL,
    account_id           TEXT,
    account_code         TEXT,
    contact_name         TEXT,
    reference            TEXT,
    amount               NUMERIC(12,2) NOT NULL,
    currency_code        TEXT         NOT NULL DEFAULT 'GBP',
    is_reconciled        BOOLEAN      NOT NULL DEFAULT false,
    line_items           JSONB,
    synced_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS xero_bank_txns_date         ON brain.xero_bank_txns (date DESC);
CREATE INDEX IF NOT EXISTS xero_bank_txns_unreconciled ON brain.xero_bank_txns (is_reconciled)
    WHERE is_reconciled = false;

COMMENT ON TABLE brain.xero_bank_txns IS
    'Bank transactions from Xero. Unreconciled rows older than 30 days are audit findings.';

-- ----------------------------------------------------------------------------
-- brain.xero_invoices
-- Sales invoices (ACCREC) and purchase bills (ACCPAY).
-- is_capitalised flags bills whose line items include inventory-cost accounts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.xero_invoices (
    xero_invoice_id    TEXT          PRIMARY KEY,  -- Xero InvoiceID
    type               TEXT          NOT NULL,     -- 'ACCREC' | 'ACCPAY'
    invoice_number     TEXT,
    date               DATE,
    due_date           DATE,
    status             TEXT          NOT NULL,
    contact_name       TEXT,
    sub_total          NUMERIC(12,2),
    total_tax          NUMERIC(12,2),
    total              NUMERIC(12,2),
    amount_due         NUMERIC(12,2),
    currency_code      TEXT          NOT NULL DEFAULT 'GBP',
    is_capitalised     BOOLEAN       NOT NULL DEFAULT false,
    -- true if any line item is coded to a capitalised account (freight/duties/FBA)
    capitalised_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    -- sum of line amounts coded to capitalised accounts
    line_items         JSONB,
    synced_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT xero_invoices_type_check
        CHECK (type IN ('ACCREC', 'ACCPAY')),
    CONSTRAINT xero_invoices_status_check
        CHECK (status IN ('DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED'))
);

CREATE INDEX IF NOT EXISTS xero_invoices_type_date  ON brain.xero_invoices (type, date DESC);
CREATE INDEX IF NOT EXISTS xero_invoices_due_date   ON brain.xero_invoices (due_date)
    WHERE status = 'AUTHORISED';
CREATE INDEX IF NOT EXISTS xero_invoices_capitalised ON brain.xero_invoices (is_capitalised)
    WHERE is_capitalised = true;

COMMENT ON TABLE brain.xero_invoices IS
    'Invoices and bills from Xero. ACCREC = sales, ACCPAY = purchases. '
    'is_capitalised=true means this bill contains inventory costs (BS, not P&L). '
    'capitalised_amount is the sum of those line items.';

-- ----------------------------------------------------------------------------
-- brain.xero_tax_rates
-- VAT code definitions. Used by audit agent to validate line-item tax types.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.xero_tax_rates (
    tax_type        TEXT  PRIMARY KEY,   -- e.g. 'OUTPUT', 'INPUT', 'ZERORATEDINPUT'
    name            TEXT  NOT NULL,
    effective_rate  NUMERIC(5,2),        -- e.g. 20.00 for standard rate
    status          TEXT  NOT NULL DEFAULT 'ACTIVE',
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE brain.xero_tax_rates IS
    'VAT / tax rate definitions from Xero. Used by audit agent to validate coding.';

-- ----------------------------------------------------------------------------
-- brain.cashflow_forecast
-- Rolling 52-week forecast. One row per week per forecast_type.
-- Actuals overwrite the forecast column when the week closes.
--
-- forecast_type values:
--   'cash_in'  — expected receipts (Amazon payouts + direct sales)
--   'cash_out' — expected payments (supplier bills, opex, duties, FBA)
--   'net'      — cash_in minus cash_out (computed; stored for reporting)
--
-- Sources for each column:
--   forecast_amount   — set by cashflow agent from sales forecast + historical costs
--   actual_amount     — set by cashflow agent from Xero bank transactions (closed weeks)
--   variance          — actual_amount - forecast_amount (negative = overspend / shortfall)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain.cashflow_forecast (
    id              BIGSERIAL    PRIMARY KEY,
    week_start      DATE         NOT NULL,  -- Monday of the week
    week_end        DATE         NOT NULL,  -- Sunday of the week
    forecast_type   TEXT         NOT NULL,
    forecast_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    actual_amount   NUMERIC(12,2),          -- null until week closes
    variance        NUMERIC(12,2),          -- null until week closes
    notes           TEXT,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT cashflow_forecast_type_check
        CHECK (forecast_type IN ('cash_in', 'cash_out', 'net')),
    CONSTRAINT cashflow_forecast_week_unique
        UNIQUE (week_start, forecast_type)
);

CREATE INDEX IF NOT EXISTS cashflow_forecast_week ON brain.cashflow_forecast (week_start);

COMMENT ON TABLE brain.cashflow_forecast IS
    'Rolling 52-week cashflow forecast. Maintained by the cashflow agent. '
    'actual_amount is populated when the week closes from Xero bank transactions. '
    'Forecast is rebuilt weekly from Supabase sales forecast + Xero historical costs.';

-- ----------------------------------------------------------------------------
-- ops.pnl_monthly
-- Monthly P&L snapshots. Written by the pnl-balance agent after each Xero pull.
-- One row per month per account. Idempotent on (period_month, account_code).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.pnl_monthly (
    id              BIGSERIAL    PRIMARY KEY,
    period_month    DATE         NOT NULL,  -- first day of month, e.g. '2026-05-01'
    account_code    TEXT         NOT NULL,
    account_name    TEXT         NOT NULL,
    account_type    TEXT         NOT NULL,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    -- positive = income/credit, negative = expense/debit (sign follows Xero convention)
    currency_code   TEXT         NOT NULL DEFAULT 'GBP',
    snapped_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pnl_monthly_unique
        UNIQUE (period_month, account_code)
);

CREATE INDEX IF NOT EXISTS pnl_monthly_period ON ops.pnl_monthly (period_month DESC);

COMMENT ON TABLE ops.pnl_monthly IS
    'Monthly P&L snapshots from Xero. Written by the pnl-balance agent. '
    'One row per account per month. Re-running the agent re-upserts these rows.';

-- ----------------------------------------------------------------------------
-- ops.balance_sheet_monthly
-- Monthly balance sheet snapshots. One row per account per month.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.balance_sheet_monthly (
    id              BIGSERIAL    PRIMARY KEY,
    period_month    DATE         NOT NULL,
    account_code    TEXT         NOT NULL,
    account_name    TEXT         NOT NULL,
    account_type    TEXT         NOT NULL,
    balance         NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency_code   TEXT         NOT NULL DEFAULT 'GBP',
    snapped_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT balance_sheet_monthly_unique
        UNIQUE (period_month, account_code)
);

CREATE INDEX IF NOT EXISTS bs_monthly_period ON ops.balance_sheet_monthly (period_month DESC);

COMMENT ON TABLE ops.balance_sheet_monthly IS
    'Monthly balance sheet snapshots from Xero. Written by the pnl-balance agent. '
    'Includes inventory (capitalised stock + freight + duties + FBA) until sold.';

-- ----------------------------------------------------------------------------
-- ops.financial_audit_log
-- Audit findings from the xero-audit agent. Append-only — rows are never
-- deleted. The agent writes a new batch each run; each finding is tagged
-- with the run_id so runs can be compared.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.financial_audit_log (
    id              BIGSERIAL    PRIMARY KEY,
    run_id          TEXT         NOT NULL,   -- UUID generated per agent run
    run_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    severity        TEXT         NOT NULL,
    category        TEXT         NOT NULL,
    entity_type     TEXT,                    -- 'invoice', 'bank_txn', 'account', etc.
    entity_id       TEXT,                    -- Xero ID of the relevant entity
    description     TEXT         NOT NULL,
    recommended_action TEXT,
    resolved        BOOLEAN      NOT NULL DEFAULT false,
    resolved_at     TIMESTAMPTZ,
    CONSTRAINT audit_log_severity_check
        CHECK (severity IN ('info', 'warning', 'error')),
    CONSTRAINT audit_log_category_check
        CHECK (category IN (
            'vat_code',         -- wrong VAT code on a transaction
            'account_code',     -- wrong nominal code
            'unreconciled',     -- unreconciled bank transaction
            'overdue',          -- overdue invoice or bill
            'manual_journal',   -- unexplained manual journal entry
            'capitalisation',   -- cost incorrectly coded to P&L vs BS
            'other'
        ))
);

CREATE INDEX IF NOT EXISTS audit_log_run    ON ops.financial_audit_log (run_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_open   ON ops.financial_audit_log (resolved, severity)
    WHERE resolved = false;

COMMENT ON TABLE ops.financial_audit_log IS
    'Audit findings from the xero-audit agent. Append-only — never delete rows. '
    'Each agent run creates a batch tagged with run_id. resolved=false rows '
    'are the active action list for the operator.';

-- ----------------------------------------------------------------------------
-- Expose new schemas to PostgREST (if not already exposed)
-- ops and brain should already be in the exposed list from earlier migrations.
-- raw is intentionally NOT exposed (internal only).
-- ----------------------------------------------------------------------------
-- Note: run `supabase db push` then add 'ops' and 'brain' to
-- Supabase Settings > API > Exposed schemas if they're not there already.
-- ----------------------------------------------------------------------------

COMMIT;
