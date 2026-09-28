---
title: A database restore brought back a password I had rotated away
dek: Guacamole's logins and its nightly backups failed with the same authentication error. Two containers read the database password from two places, and a restore picked the stale one.
label: Secrets
order: 2
focus: [Guacamole, PostgreSQL, Vault, External Secrets]
---

Guacamole is the browser-based remote desktop gateway I use to reach machines in the lab. On September 2 every login failed, and its logs showed `password authentication failed` on each request. The nightly `pg_dump` CronJob had failed the same way for the two nights before. The backup never got past connecting, so I lost no data.

## Two readers, one password

Two containers need the database password. The Guacamole web app and the backup job read it from `postgres-secret`, a Secret that External Secrets Operator syncs from Vault every hour. The Postgres container had it as a literal in its Deployment manifest, left over from when I first put the app into Git.

In July I moved the web app and the backup job onto the Secret and rotated the password, since the old value had landed in Git history. I realigned the database with `ALTER USER`. The Postgres manifest kept the old literal. Postgres reads `POSTGRES_PASSWORD` only when it initializes an empty data directory, so for seven weeks the literal did nothing.

On August 30 a DiskPressure eviction corrupted that Postgres's write-ahead log, and I restored the database from that day's dump into a fresh data directory. Initialization read the literal, and the database came back up with the old password. Vault still held the new one, so from then on the web app and the backup job both failed to log in.

## The fix

```yaml
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: postgres-secret
      key: POSTGRES_PASSWORD
```

Postgres now reads the same Secret as the app, so the next initialization takes its password from Vault. To restore service I set the value in Vault to match the database and deleted the Secret, which made the operator rebuild it without waiting out the hourly refresh.

The change doesn't sync a running database. Postgres keeps the password it stored at initialization, whatever the Secret says later, so a rotation still runs `ALTER USER` first, then updates Vault, then restarts the app.

## What I got wrong

The July change covered the two containers that read the password on every start and skipped the one that reads it once. Postgres ignores that literal on a normal start, so it looked harmless. It mattered only on a fresh data directory, and a restore produces one.

## What changed

For any credential shared between containers, I check that every consumer reads the same Secret, including the ones that read it only at initialization. The rotation runbook lists `ALTER USER` before the Vault update for each database password.
