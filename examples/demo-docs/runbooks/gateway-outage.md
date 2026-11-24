# Runbook: payment gateway outage

1. Confirm on the gateway status page and in the `gateway_errors_total` metric (more than 5% of calls failing for 5 minutes).
2. Switch traffic to the backup gateway with the `payments-failover` flag. Only the on-call lead may flip it.
3. Pause the nightly settlement job while the backup gateway is active; it double-counts otherwise.
4. Post an update in #payments-incidents every 30 minutes until the primary gateway is back.
5. Switch back only after 15 minutes of error rates below 1% on the primary.
