---
title: I condemned network cards that my own commands had wedged
dek: Each board that went dark had just taken a forced ethtool setting, and each one came back when autonegotiation was restored. At least one went back to the seller as defective before I worked that out.
label: Hardware
order: 4
focus: [Proxmox, Ceph, r8169, ethtool]
---

My Proxmox nodes are OptiPlex 7070 Micros. Ceph wants its own network for replication, and the only internal expansion slot on these machines is an M.2 A+E slot, the kind meant for a Wi-Fi card. I spent June and July trying to put a wired NIC in it.

## Two kinds of board

The first boards used Intel's I226-V on the `igc` driver. The Linux driver only autonegotiates, and asking it for a fixed speed returns `Force mode currently not supported`. All four units I bought failed the same way, which pointed at the driver on this hardware. I stopped buying them.

Next came a Realtek RTL8111F board on `r8169`, a different chip and a different driver. It linked. Across both kinds, boards kept going dark while I chased gigabit: carrier 0, no link, and no recovery on reboot. I had a count of five defective boards, and at least one went back to the seller.

## What the logs showed

In July I went back through the transcripts of every NIC session and lined up each dark board with the commands before it. An `ethtool -s` forcing speed or master/slave role, or an `ethtool -r`, came right before each one. Each board came back, at 100 Mb/s, once autonegotiation was restored. Clearing the wedge took a cold power-off, since a warm reboot doesn't reset the PHY on these boards. My own commands had inflated the count.

## The fault that was real

The RTL8111F had one genuine problem. On a clean autonegotiation with nothing forced, it negotiated gigabit and then dropped:

```
Downshift occurred from negotiated speed 1Gbps to actual speed 100Mbps, check cabling!
```

My laptop ran gigabit on the same cable, so I ruled that out, along with the switch, ASPM, the BIOS power settings, the driver and the master/slave role. A downshift to 100 usually means gigabit training failed on the four pairs and the link fell back to two. Two tests would have told board from slot: a PHY cold from power-off, and the same board in a different machine. I never ran either. I closed the M.2 path and put the Ceph network on USB gigabit adapters, where Ceph now writes at 114 MB/s, the ceiling for gigabit.

## What I got wrong

Each time a board went dark I blamed the board without checking which command had run just before it. Those commands forced a physical re-initialization, and the only recovery was me at the machine pulling the power.

## What changed

Physical hardware is read-only by default. Reads like `ethtool <if>`, `dmesg` and `/sys` are fine. Anything that re-initializes a device, such as `ethtool -s`, `ethtool -r`, a driver unbind or a module reload, gets a deliberate decision first, along with what recovery would cost. Before I call a device dead, I read my own shell history for the minutes before it failed.
