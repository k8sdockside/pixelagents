# pixelagents

A [K8s Dockside](https://github.com/k8sdockside/k8sdockside) plugin that draws
the cluster as a pixel-art office, after
[Pixel Agents](https://www.mdskills.ai/skills/pixel-agents), which does the
same for AI coding agents.

- **A person for every node.** Control planes sit in the glass room; workers on
  the open floor. A one-node cluster (a control plane that also runs pods) is a
  manager alone with a couple of empty desks. Three control planes and forty
  workers fill the floor. A managed cluster, where the provider hides the
  control plane, gets a cloud in the glass room instead.
- **As busy as their node.** CPU, memory and disk decide how hard each person
  works. Quiet nodes wander off for coffee and the couch. Busy ones type
  without looking up, their screens scrolling faster. One near its limits
  sweats. The server racks blink faster as the whole cluster gets busier.
- **Trouble shows on the floor, in stages.** Errors, warnings and security
  findings add up to a trouble level. A little trouble leaves litter and coffee
  stains around the desks that have it. More trouble brings cracks, and those
  desks' monitors start to smoke. Only past the lava line (70% by default) does
  the floor give way to lava, and even then it covers at most a set share of
  the floor (25% by default). People path around the lava, and run when they
  are standing in it.
- **A bigger cluster gets a bigger office.** Up to 6 nodes is a small office.
  Up to 24 gets wider aisles, a meeting table and a bigger lounge with a second
  couch. Past that is a large office. There is a server rack in the lounge for
  every four nodes.
- **Everything else.** A node that is down sleeps in front of a blue screen. A
  cordoned node's person is on a long break on the couch. Pods no node has
  taken pile up as boxes by the door. Security findings let hooded intruders in.
  Hover over a person to see their node's numbers, and click to open the node.

Under the office, everything that heats the floor is listed by category, and
each object in the list is a link.

## What counts

| | What it looks for | Weight |
| --- | --- | --- |
| **Errors** | node not ready, node under memory/disk/PID pressure, crash loops, image pull failures, container config errors, pods pending over 5 min, OOM kills | full |
| **Security** | privileged containers, host network/PID/IPC, dangerous capabilities, hostPath volumes, may run as root, `:latest` or untagged images | 0.7 |
| **Warnings** | running but not ready, failed pods left behind, frequent restarts, cordoned nodes, no memory limit, Warning events in the last hour | 0.5 |

Each finding's heat is its weight × hits^0.75, so 200 pods running as root
count for more than one, but for a lot less than 200 fires. The trouble level
is `1 − e^(−heat × sensitivity / 25)`, and the floor follows it:

| Trouble | The floor |
| --- | --- |
| under 3% | spotless |
| 3–30% | litter and coffee stains around the desks with problems |
| 30% to the lava line | cracks as well, and smoking monitors |
| past the lava line (70%) | lava, growing to the lava maximum (25% of the floor) at 100% | The security checks skip `kube-system`,
`kube-public` and `kube-node-lease` by default, because system pods are
privileged for good reason. You can change that list in the settings.

## Where the numbers come from

1. **node-exporter via Prometheus or VictoriaMetrics**: CPU, memory and the
   fullest real filesystem, measured. These are the manifest's three
   `overview` charts. Series are matched to nodes by `node_uname_info`'s
   `nodename`, then by the scrape address.
2. **metrics-server**: CPU and memory, measured, with no disk.
3. **Pod requests against allocatable**: an estimate, and the page says so.
   Disk is read from `DiskPressure` when it is set.

Each node takes each reading from the best source that has it, so a node
without node-exporter falls back on its own.

## Settings

Kept per cluster in the app's plugin storage, never in the cluster:

- **Office:** size (grows with the cluster by default, or Small, Medium or
  Large), people per node (from one per four nodes up to four per node), and a
  headcount cap. Past the cap, one person stands for several nodes.
- **Busyness:** a multiplier, plus how much CPU, memory and disk each count.
- **Trouble:** sensitivity (0 keeps the floor spotless), security checks and
  warning events on or off, and the namespaces the security checks skip.
- **Lava:** on or off, the trouble level where it starts, the most of the floor
  it can take, and whether it is lava, flood water or toxic slime.
- **Look:** floor style, day/night (follows the clock by default), zoom, speed,
  names, intruders, boxes, refresh interval.
- **Preview:** force busyness and trouble to any level, to see a busy or
  broken office without breaking a cluster. These overrides are not saved.

## Install it

**Settings → Plugins → From a repository**, and paste

```
https://github.com/k8sdockside/pixelagents
```

It needs K8s Dockside 0.1.1 or newer. It reads **nodes, pods and events**, and
optionally `nodes.metrics.k8s.io`. It never writes anything.

## Working on it

```sh
npm install
npm run watch     # rebuilds ui/ on every change under src/
npm test          # the model and the simulation
npm run check     # typecheck + tests + "is ui/ in step with src/"
```

Point the app at your checkout with **Settings → Plugins → Watch another
folder**. **Commit `ui/`**: installing clones the repository and builds nothing.

## Layout

```
plugin.json          the manifest: the overview page and three node-exporter charts
src/
  model/             no DOM, all the logic, all the tests
    nodes.ts         roles, readiness, what pods ask of each node
    load.ts          CPU/memory/disk per node from the best source, and busyness
    problems.ts      the checks, and how hot they make the floor
    staff.ts         people for nodes
    layout.ts        the floor plan, grown to fit the headcount
    lava.ts          litter, cracks and lava: where, the same way every time
    path.ts          walking around desks, and around lava
    office.ts        all of the above, put together
  ui/
    sprites.ts       the people, drawn from maps of letters and cached
    world.ts         the simulation: sitting, typing, coffee, panic
    render.ts        the floor, furniture, lava, screens, night
    hud.ts, panel.ts the meters, the tooltip, the findings, the settings
  pages/overview.*   the page
```

The pixel art is drawn in code, so the plugin ships no image assets apart from
its logo.

## License

Apache-2.0.
