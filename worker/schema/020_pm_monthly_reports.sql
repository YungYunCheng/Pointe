-- Property Managers prepare the monthly management report from locked ledger
-- figures and provide the PM half of the two-person review.  They still cannot
-- post journals, pay bills, reconcile bank accounts, edit the chart of accounts
-- or close a period.

INSERT INTO role_permissions (role_code, permission_code)
VALUES ('property_manager', 'accounting.reports')
ON CONFLICT DO NOTHING;
