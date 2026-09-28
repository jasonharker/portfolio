---
title: An IDS that flooded the logs, then one that watched nothing
dek: Suricata's first deployment wrote 7.2 GB of alerts in 19 minutes and took syslog down for 33 hours. Its redeployment ran clean, with zero dropped packets and zero rules.
label: Security
order: 3
focus: [Suricata, pfSense, rsyslog, logrotate]
---

Suricata runs on the pfSense firewall as an alert-only intrusion detection system. In August I needed several days of firewall logs to write the rules between my new VLANs, and went to the syslog host to start collecting. It had collected nothing since the day before. The disk was full and syslog had been down for 33 hours.

## The flood

One Suricata rule, `STREAM ESTABLISHED invalid ack`, had fired on NFS traffic and written about 7.2 GB in 19 minutes. The log rotation did have a 100 MB limit, but `logrotate` ran once a day, so the limit got checked once a day. rsyslog had no rate limit on its UDP input either.

Suricata was also bound to the VLAN trunk's parent interface, where it saw tagged frames it couldn't decode. It logged them as `VLAN unknown type` events and misfired.

I truncated the log with `: >` rather than deleting it, because rsyslog holds the file open, then restarted rsyslog. Two changes bound the disk from then on. rsyslog's UDP input got `RateLimit.Interval="5"` and `RateLimit.Burst="5000"`, and `logrotate` moved from the daily run to one every 15 minutes. I sized the rate limit against the firewall logs I meant to keep, since a tenth of that burst would have dropped part of the audit.

Then I turned Suricata off. It shared the syslog pipe with the firewall audit I needed, and one more burst would have left holes in the data I was writing policy from. It only alerted, so turning it off cost no blocking.

## The redeploy

In September, with the VLAN work finished, I brought Suricata back with an instance on each VLAN interface that carries traffic. Alerts stay on the firewall, the log directory is capped at 5 GB, and a suppress list covers the NFS stream rule and SSDP noise.

I built one instance by editing pfSense's configuration through PHP instead of the web UI. It started, captured traffic, and reported zero dropped packets. Its own log held the problem:

```
detect: No signatures supplied.
```

pfSense stages the rule files only when a global, `$rebuild_rules`, is true. The web UI sets it. My direct edit didn't, so Suricata loaded no signatures and matched nothing. Setting the flag before the sync and restarting the instance loaded 37,694 rules.

## What I got wrong

I took a running process with no drops as proof the IDS was working. Those numbers say Suricata keeps up with the traffic. They say nothing about whether it has any rules to check the traffic against.

## What changed

After any Suricata change I look for `rules successfully loaded` in the instance's log before calling it done. For log rotation, I check the interval as well as the threshold. A 100 MB limit read once a day can't stop a process that writes 6 MB a second.
