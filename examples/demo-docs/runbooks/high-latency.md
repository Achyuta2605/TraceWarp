# Runbook: high checkout latency

- If p95 checkout latency is above 800 ms for 10 minutes, scale the checkout-api deployment to 12 pods.
- If the database CPU is above 85%, enable read replicas for the catalog queries.
- Escalate to the platform team after 30 minutes without improvement.
