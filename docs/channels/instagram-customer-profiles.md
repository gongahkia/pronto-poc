# Instagram customer profiles

Migration **064** adds a display-only JSON profile and refresh/lease fields to conversations. Routing continues to use the original channel and Instagram-scoped sender ID; neither `customer_handle` nor `external_thread_id` is rewritten. Names, usernames and profile details are not inserted into agent prompts by this feature.

A signed/account-matched/allowed-sender webhook schedules bounded profile work after durable ingestion and acknowledgement. It runs alongside the existing demo processing callback. An authorized business reader opening an older thread can also trigger the existing-conversation POST refresh endpoint; the browser cannot select another tenant, channel or sender. Query predicates and the final write bind the authenticated business, conversation, current account and encrypted credentials.

The Meta User Profile API is queried using the configured Graph version and the channel's existing login mode/token. Tokens are sent in the Authorization header. Only the requested name, username, photo, verification and follow fields are decoded; raw provider responses and credentials are not exposed. Photo URLs are limited to HTTPS Meta CDN hosts and images are loaded without a referrer; a failed image falls back to the channel icon.

A database lease coalesces concurrent requests. Successful data is cached for a day; failed reads retain the last known profile and back off for 15 minutes. Leases expire after 30 seconds, HTTP/body reading is bounded to three seconds and 32 KiB, and replacement leases reject late writes. The cache is not a claim that a customer's profile can never change during that day. Messaging still works with the numeric-ID fallback when profile access is unavailable.

The 21 November acceptance used the existing scoped token and real customer conversation: Meta returned Keith / @keibtang and the requested optional fields. The local preview and protected hosted database were hydrated, retaining all four original messages and the original routing IDs. Focused tests cover authenticated access, origin/tenant boundaries, sender mismatch, response bounds, CDN validation, concurrent refreshes, stale results, failure backoff and profile persistence across ingestion. Browser checks covered the list, thread, profile link and a 390px layout.

Reference: [Meta User Profile API](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/user-profile). Actual API field availability remains dependent on the channel's permissions and customer consent.
