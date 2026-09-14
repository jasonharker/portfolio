---
layout: ../../layouts/Essay.astro
title: A config line existing is not a config line working
kicker: Lessons
dek: The most expensive bugs in my homelab were settings that were present, correct-looking and doing nothing.
date: 2026-09-06
---

The worst failures I've had were not misconfigurations. They were configurations that looked right, passed review, and were silently inert.

## The allowlist that allowed everything

Some internal dashboards in my cluster sit behind an IP allowlist that admits only private addresses. It read correctly. It would also have admitted the entire internet under one innocuous default.

When a Kubernetes LoadBalancer Service uses `externalTrafficPolicy: Cluster`, a node may forward a request to a pod on another node — and to do that it rewrites the source address to one of its own. Every client, public or not, arrives looking like a private address. The allowlist evaluates the rewritten address and says yes.

Setting the policy to `Local` preserves the real client address, at the cost of only routing to nodes that run a replica. That line is load-bearing, not tuning, and it's documented as such.

## The relay that never relayed

On a switch, a DHCP helper address was configured on a VLAN interface for months. It was correct. It never forwarded a single packet, because a separate global setting had disabled the DHCP service the helper depends on. Nothing complained.

## What I do differently

- Verify the *effect*, not the setting: send the request, watch the packet, read the log line.
- Verify from where the traffic actually comes from. A test from inside the trusted network proves nothing about the untrusted one.
- Run a control. A probe that fails in both the broken and the fixed state isn't evidence of anything.

None of this is novel. It's just the kind of thing you only really believe after it has cost you an evening.
