---
layout: ../../layouts/Essay.astro
title: How this page got here
kicker: Delivery
dek: A static site doesn't need a blue/green deployment. I built one anyway, because the pipeline is the portfolio.
date: 2026-09-13
---

The site you're reading is a folder of HTML. It could be served from anywhere. Instead, every change goes through the same path I'd want for a service that matters, because building that path is the point.

## From commit to image

A push to the repository triggers Jenkins. Kaniko builds the container image inside the cluster without a Docker daemon, and Trivy scans it; any critical CVE fails the build before the image is used anywhere. The image is Astro's output copied into unprivileged nginx — no shell tooling, no build dependencies, nothing running as root.

## Staging first

Jenkins doesn't deploy to production. It commits the new image tag to a staging namespace in the GitOps repository, and Flux applies it.

In staging, Flagger takes over. It runs the new version alongside the current one, sends it test traffic and checks the responses. Only if those checks pass does it switch the staging Service to the new version. If they fail, the old version never stopped serving.

## Promotion is a pull request

Production runs the same image, but only after someone copies the tag that passed staging into the production manifest and merges it. That merge is the gate: a person looking at a version that has already proven itself.

For a personal site this is overkill. For a sportsbook on a Saturday it's the minimum — and I'd rather have made my mistakes with it here.
