---
title: A Cilium upgrade the agents never saw, and an MTU I never set
dek: I enabled WireGuard between pods and Helm reported success, but the agents kept running unencrypted. Chasing that, I found the cluster running an MTU I had never chosen.
label: Networking
order: 1
focus: [Cilium, WireGuard, Helm, Tailscale]
---

I wanted pod traffic between nodes encrypted. Cilium runs WireGuard inside its existing datapath, so the change took a few lines of Helm values and an upgrade. The upgrade succeeded and `rollout status` came back clean, but all seven agents went on reporting `Encryption: Disabled`.

## Two faults

The first fault was the upgrade. My values-only `helm upgrade` rewrote `cilium-config` with `enable-wireguard: "true"`, and the chart does not restart the agents when that ConfigMap changes, so the agents kept the config they had started with. `rollout status` reported success because no pod had rolled.

The second fault had nothing to do with the upgrade. With no MTU set, Cilium takes the smallest MTU among the devices it detects. Each node runs `tailscale0` at 1280, so the pods ran at 1280 too, on a 1500 network. Subtract VXLAN's 50 bytes and WireGuard's 95, and routes between nodes came out at 1135. No alert fired, since nothing had failed. You would have had to read `ip link` on an agent to see it.

## The fix

```yaml
encryption:
  enabled: true
  type: wireguard

MTU: 1500
```

Pinning `MTU` sets Cilium's own interfaces and leaves `tailscale0` attached. Pinning `devices` would have excluded it, and taken NodePort traffic that arrives over Tailscale down with it. Then I restarted the agents, the step the upgrade had skipped:

```sh
kubectl -n kube-system rollout restart ds/cilium
kubectl -n kube-system exec ds/cilium -- cilium-dbg status | grep -E 'Encryption|MTU'
```

Afterwards each agent had six WireGuard peers. `cilium_wg0` sat at 1405 and the route between nodes at 1355. I captured packets on one worker and saw pod traffic between nodes as WireGuard on UDP 51871 and nothing else.

## What I got wrong

I assumed running pods would keep the old MTU until they restarted, so I rolled every Deployment and StatefulSet in the cluster. I didn't need to: restarting the agents rewrites the MTU of existing pods' `eth0` in place. A pod I had started ten days earlier and never restarted read 1500 afterwards, and so did all 91 pod endpoints.

## What changed

After any Cilium values change I restart the agents and check the feature itself in `cilium-dbg status`. `rollout status` reports pod health, and pod health said nothing about whether WireGuard was on.
