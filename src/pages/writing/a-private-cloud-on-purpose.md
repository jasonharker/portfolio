---
layout: ../../layouts/Essay.astro
title: A private cloud, on purpose
kicker: THALES
dek: Why a cloud engineer runs a seven-node Kubernetes cluster in his apartment, and what "cloud" has to mean for that to be worth it.
date: 2026-09-13
---

Most homelabs are a pile of services. THALES started as one too. What turned it into something worth writing about was deciding what it was *for*: every technology I meet at work should already have been built, broken and understood at home.

That goal needs a definition to measure against, so I borrowed the dullest one available. NIST SP 800-145 says a cloud has five essential characteristics — on-demand self-service, broad network access, resource pooling, rapid elasticity and measured service. If THALES can't honestly claim all five, it's a server closet with ambitions.

## The shape of it

Three Proxmox hosts share a Ceph cluster, so a VM's disk isn't tied to the machine it happens to be running on. On top of them sits a Talos Linux Kubernetes cluster: three control planes and four workers. Talos has no shell and no SSH — every change goes through an API — which removes a whole category of 2 a.m. improvisation.

Nothing in the cluster is installed by hand. Flux reconciles it from a git repository: raw manifests where I can, pinned Helm releases where I must. Secrets are moving from SOPS-encrypted files to HashiCorp Vault, one application at a time. Cilium handles networking and encrypts pod traffic between nodes with WireGuard.

## What the five characteristics forced

**Measured service** was the one I'd have skipped. Cost allocation on a cluster that costs nothing per hour feels like theatre — but it turns "the cluster is full" into a number per namespace, which is the conversation you have at work anyway.

**Rapid elasticity** is still the honest gap. The cluster can't grow itself; that waits on hardware, and I'd rather write that down than pretend.

The naming — every host after a Classical Greek thinker — is the one thing in THALES that exists purely because I like it.
