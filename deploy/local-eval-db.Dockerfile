FROM pgvector/pgvector:0.8.0-pg16

# The simulator checks both ends of its database connection for loopback.
# Forward the published port to a loopback-only PostgreSQL listener inside
# this disposable container, preserving that check on Docker Desktop too.
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/*

CMD ["bash", "-c", "socat TCP-LISTEN:5433,reuseaddr,fork TCP:127.0.0.1:5432 & exec docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1"]
