# Retry policy

Client calls to the payment gateway retry at most 3 times, with exponential backoff starting at 200 ms
(200 ms, 400 ms, 800 ms). Never retry a call that returned HTTP 409 (duplicate payment).
