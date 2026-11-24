# Runbook: refund failures

1. Check the refunds dashboard for error code spikes.
2. Error `R-402` means the card network declined the refund. Retry once after 15 minutes.
3. Error `R-500` means our ledger write failed. Do NOT retry; page the ledger team.
4. Refunds older than 120 days cannot be processed automatically. Send them to finance-ops.
