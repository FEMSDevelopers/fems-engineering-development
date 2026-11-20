import { describe, expect, it } from "vitest";
import {
  routeSides,
  setPortAt,
  buildLinks,
  hopElements,
  portAllocation,
  portAbbr,
  serviceColor,
  activeOnly,
  DEFAULT_NAME_RULE, DEFAULT_OPTIONS, applyRuleSet, buildAllConfigs, buildIpSchema, buildPointList,
  bumpMajor, bumpMinor, captureRuleSet, matchRuleSet, moveColumn, parseDelimited, renderRow, renderTable, resolveModbus,
  validateDevices, validateSource, validateVlans, verLabel, type ConditionState, type OutputContext,
  buildConnectionConfig, matchVlan, validateConnections, expandProtocols, DEFAULT_STYLE, type ProtocolDef, type Vlan,
  deviceVlan, inactiveReason, pathText, type Firewall, type Service,
} from "../src/index.js";

const SAMPLE = [
  ["tag", "description", "register", "data_type", "scale", "unit", "writable", "alarm.high", "alarm.low"],
  ["pcs1.p_cmd", "Active power setpoint", "40001", "int16", "0.1", "kW", "TRUE", "", ""],
  ["bms.soc", "State of charge", "30010", "uint16", "0.1", "%", "FALSE", "95", "5"],
  ["site.notes", 'Free text, "quotes", commas', "", "string", "", "", "1", "", ""],
];
const st = (over: Partial<ConditionState> = {}): ConditionState => ({
  grid: SAMPLE.map((r) => r.slice()),
  cond: [],
  nameRule: { ...DEFAULT_NAME_RULE },
  order: [],
  opts: { ...DEFAULT_OPTIONS },
  ...over,
});

describe("parsing", () => {
  it("parses Excel TSV with quoted cells", () => {
    const g = parseDelimited('a\tb\n"x\ty"\t"he said ""hi"""\n1\t2\n');
    expect(g).toEqual([["a", "b"], ["x\ty", 'he said "hi"'], ["1", "2"]]);
  });
});

describe("conditioning", () => {
  it("defaults quote text columns and leave numeric columns bare; output is valid JSON", () => {
    const r = renderTable(st());
    const parsed = JSON.parse(r.text);
    expect(parsed[1]).toMatchObject({ tag: "bms.soc", register: 30010, scale: 0.1, "alarm.high": 95 });
    expect(parsed[0]["alarm.high"]).toBeNull();
  });

  it("applies NA, b_10, b_r, if-empty and name rules", () => {
    const s = st();
    const cond: ConditionState["cond"] = [];
    cond[1] = { na: true, n: false, q: true, tf: false, t10: false, r: false, def: "" };
    cond[6] = { na: false, n: false, q: true, tf: false, t10: true, r: true, def: "" };
    cond[7] = { na: false, n: false, q: false, tf: false, t10: false, r: false, def: "0" };
    const out = renderRow({ ...s, cond, nameRule: { n: false, q: false } }, 0).text;
    expect(out).not.toContain("description");
    expect(out).toContain("writable: 0"); // TRUE → 1, inverted → 0
    expect(out).toContain("alarm.high: 0"); // if-empty value
    expect(out).toContain('tag: "pcs1.p_cmd"');
  });

  it("strips embedded quotes with # and recases literals", () => {
    const s = st({ opts: { ...DEFAULT_OPTIONS, boolFmt: "upper", nullFmt: "None" } });
    const cond: ConditionState["cond"] = [];
    cond[1] = { na: false, n: true, q: true, tf: false, t10: false, r: false, def: "" };
    cond[6] = { na: false, n: false, q: false, tf: true, t10: false, r: false, def: "" };
    const out = renderRow({ ...s, cond }, 2).text;
    expect(out).toContain('"description": "Free text, quotes, commas"');
    expect(out).toContain('"writable": TRUE'); // b_tf 1 → TRUE
    expect(out).toContain('"alarm.low": None');
  });

  it("renders keys in rearranged order", () => {
    const s = st();
    const order = moveColumn(s, 6, 0);
    const keys = renderRow({ ...s, order }, 0).lines.slice(1, 3).map((l) => l.text.trim().split(":")[0]);
    expect(keys).toEqual(['"writable"', '"tag"']);
    const tableKeys = renderRow({ ...s, order, opts: { ...s.opts, renderOrder: "table" } }, 0).lines[1].text.trim();
    expect(tableKeys.startsWith('"tag"')).toBe(true);
  });

  it("plain conversion infers types and supports keyed shape", () => {
    const r = renderTable(st({ opts: { ...DEFAULT_OPTIONS, applyCond: false, shape: "keyed" } }));
    const parsed = JSON.parse(r.text);
    expect(parsed["bms.soc"].register).toBe(30010);
    expect(parsed["pcs1.p_cmd"].writable).toBe(true);
  });
});

describe("versions", () => {
  it("bumps sub-version and version, skipping used numbers", () => {
    const used = [{ major: 1, minor: 1 }, { major: 1, minor: 2 }, { major: 233, minor: 1 }];
    expect(verLabel(bumpMinor({ major: 1, minor: 1 }, used))).toBe("1.003");
    expect(verLabel(bumpMajor({ major: 232, minor: 933 }, used))).toBe("234.001");
    expect(verLabel(bumpMajor({ major: 1, minor: 3 }, []))).toBe("2.001");
  });
});

describe("rule sets", () => {
  it("matches exact and suggested columns and applies rules + order", () => {
    const s = st();
    const cond: ConditionState["cond"] = [];
    cond[6] = { na: false, n: false, q: true, tf: false, t10: true, r: false, def: "" };
    const rs = captureRuleSet({ ...s, cond, order: moveColumn(s, 6, 0) });
    const target = st({ grid: [["Tag", "register", "Writable"], ["x1", "40001", "TRUE"]] });
    const m = matchRuleSet(rs, target);
    expect(m.find((x) => x.name === "writable")).toMatchObject({ kind: "suggested", target: 2 });
    expect(m.find((x) => x.name === "register")).toMatchObject({ kind: "exact", target: 1 });
    const applied = applyRuleSet(target, rs, m, { order: true, settings: true });
    expect(renderRow(applied, 0).text.split("\n")[1].trim()).toBe('"Writable": 1,');
  });
});

describe("protocol validation", () => {
  it("resolves Modicon addresses", () => {
    expect(resolveModbus("40001", "")).toEqual({ table: "HR", offset: 0, inferred: true });
    expect(resolveModbus("300010", "")).toEqual({ table: "IR", offset: 9, inferred: true });
    expect(resolveModbus("12", "input")).toEqual({ table: "IR", offset: 12, inferred: false });
  });
  it("flags duplicates and bad values", () => {
    const g = [["Tag", "Register", "Type"], ["a", "40001", ""], ["b", "40001", ""], ["", "x", ""]];
    const issues = validateSource("modbus", g, { tag: "Tag", address: "Register", regType: "Type" });
    expect(issues.some((i) => i.row === 2 && /already used/.test(i.msg))).toBe(true);
    expect(issues.some((i) => i.row === 3 && i.field === "tag")).toBe(true);
    expect(issues.some((i) => i.row === 3 && i.field === "address")).toBe(true);
  });
});

describe("services, firewalls + paths", () => {
  const services: Service[] = [
    { id: "s1", name: "Plant EMS", kind: "EMS", contractor: "Fractal", notes: "", enabled: true, sort: 0 },
    { id: "s2", name: "Substation", kind: "Substation", contractor: "SubCo", notes: "", enabled: false, sort: 1 },
  ];
  const firewalls: Firewall[] = [
    { id: "f1", name: "FW.01", serviceId: "s1", vendorModel: "", mgmtIp: "", serial: "", notes: "", enabled: true, sort: 0 },
    { id: "f2", name: "SUB.FW.01", serviceId: "s2", vendorModel: "", mgmtIp: "", serial: "", notes: "", enabled: true, sort: 0 },
  ];
  // Both services reuse 10.0.0.0/24 and VLAN 10.
  const vlans: Vlan[] = [
    { id: "v1", vlan: "10", name: "EMS LAN", subnet: "10.0.0.0/24", gateway: "", notes: "", firewallId: "f1", enabled: true },
    { id: "v2", vlan: "10", name: "SUB LAN", subnet: "10.0.0.0/24", gateway: "", notes: "", firewallId: "f2", enabled: true },
  ];
  it("scopes VLAN matching and duplicate checks to the service", () => {
    expect(validateVlans(vlans, firewalls)).toEqual({});
    expect(deviceVlan({ ip: "10.0.0.5", serviceId: "s2" }, vlans, firewalls)).toBe("v2");
    expect(deviceVlan({ ip: "10.0.0.5", serviceId: "s1" }, vlans, firewalls)).toBe("v1");
  });
  it("requires every level to be enabled", () => {
    const h = { services, firewalls, vlans, devices: [] };
    const d = (id: string, vlanId: string, enabled = true) => ({ id, name: id, type: "", serial: "", ip: "", vlanId, notes: "", enabled });
    expect(inactiveReason(d("a", "v1"), h)).toBe("");
    expect(inactiveReason(d("b", "v2"), h)).toBe("service Substation is inactive");
    expect(inactiveReason(d("c", "v1", false), h)).toBe("device is inactive");
  });
  it("leaves disabled branches out of outputs", () => {
    const d = (id: string, vlanId: string) => ({ id, name: id, type: "", serial: "", ip: "", vlanId, notes: "" });
    const conn = (id: string, fromId: string, toId: string) => ({ id, fromId, toId, protocolId: null, port: "", address: "", sourceId: null, topic: "", bidirectional: false, notes: "" });
    const ctx = activeOnly({
      services, firewalls, vlans, devices: [d("a", "v1"), d("b", "v2")],
      connections: [conn("ab", "a", "b"), conn("aa", "a", "a")], protocols: [], sources: {}, profiles: {},
    });
    expect(ctx.devices.map((x) => x.id)).toEqual(["a"]);
    expect(ctx.vlans.map((x) => x.id)).toEqual(["v1"]);
    expect(ctx.firewalls!.map((x) => x.id)).toEqual(["f1"]);
    expect(ctx.connections.map((x) => x.id)).toEqual(["aa"]);
  });
  it("describes and validates the client → server path", () => {
    const c = {
      id: "c", fromId: "rtac", toId: "rtac10", protocolId: "p", port: "", address: "", sourceId: null, topic: "", bidirectional: false, notes: "",
      clientPort: "eth1", serverPort: "eth0",
      path: [
        { kind: "device" as const, id: "ns1", inPort: "Gi1/3", outPort: "Gi1/24" },
        { kind: "firewall" as const, id: "f1", inPort: "", outPort: "" },
        { kind: "firewall" as const, id: "gone", inPort: "", outPort: "" },
      ],
    };
    const names: Record<string, string> = { rtac: "RTAC.01", rtac10: "RTAC.10E", ns1: "NS.01", f1: "FW.01" };
    expect(pathText(c, (_k, id) => names[id ?? ""] ?? "?")).toBe("RTAC.01:eth1 → NS.01 (Gi1/3 → Gi1/24) → FW.01 → ? → RTAC.10E:eth0");
    const single = { ...c, path: [{ kind: "firewall" as const, id: "f1", inPort: "port5", outPort: "ignored", single: true }] };
    expect(pathText(single, (_k, id) => names[id ?? ""] ?? "?")).toBe("RTAC.01:eth1 → FW.01 (port5) → RTAC.10E:eth0");
    const devs = ["rtac", "rtac10", "ns1"].map((id) => ({ id, name: id, type: "", serial: "", ip: "", vlanId: null, notes: "" }));
    const prot: ProtocolDef = { id: "p", name: "X", alias: "", dfAlias: "", parentId: null, defaultPort: "", pointListKind: "", style: DEFAULT_STYLE, sort: 0 };
    const v = validateConnections([c], devs, [prot], {}, ["f1"]);
    expect(v.c.map((i) => i.msg)).toEqual(["Hop 3 no longer exists"]);
  });
});

describe("network, data flow + outputs", () => {
  const MB: ProtocolDef = { id: "pm", name: "Modbus", alias: "Modbus", dfAlias: "MB", parentId: null, defaultPort: "502", pointListKind: "modbus", style: DEFAULT_STYLE, sort: 1 };
  const MBTCP: ProtocolDef = { ...MB, id: "pmt", name: "Modbus TCP", alias: "ModbusTCP", dfAlias: "MBTCP", parentId: "pm", pointListKind: "", sort: 2 };
  const MQTT: ProtocolDef = { ...MB, id: "pq", name: "MQTT", alias: "MQTT", dfAlias: "MQTT", defaultPort: "1883", pointListKind: "", sort: 3 };
  const vlans: Vlan[] = [
    { id: "v1", vlan: "20", name: "PCS", subnet: "10.10.20.0/24", gateway: "10.10.20.1", notes: "" },
    { id: "v2", vlan: "21", name: "PCS-A", subnet: "10.10.20.0/26", gateway: "", notes: "" },
  ];
  const ctx: OutputContext = {
    vlans,
    devices: [
      { id: "ems", name: "EMS", type: "Controller", serial: "E1", ip: "10.10.20.200", vlanId: "v1", notes: "" },
      { id: "d1", name: "PCS-01", type: "PCS", serial: "S1", ip: "10.10.20.11", vlanId: "v2", notes: "" },
      { id: "d2", name: "PCS-02", type: "PCS", serial: "S1", ip: "10.10.99.12", vlanId: null, notes: "" },
    ],
    protocols: [MB, MBTCP, MQTT],
    connections: [
      { id: "c1", fromId: "ems", toId: "d1", protocolId: "pmt", port: "", address: "1", sourceId: "s1", topic: "site/pcs01", bidirectional: false, notes: "" },
      { id: "c2", fromId: "ems", toId: "d2", protocolId: "pmt", port: "", address: "300", sourceId: "s1", topic: "site/pcs02", bidirectional: false, notes: "" },
      { id: "c3", fromId: "ems", toId: "ems", protocolId: "pq", port: "", address: "", sourceId: null, topic: "site/#", bidirectional: false, notes: "" },
    ],
    sources: {
      s1: {
        id: "s1", name: "PCS map", kind: "modbus", headers: SAMPLE[0], rows: SAMPLE.slice(1, 3),
        protocolMap: { tag: "tag", address: "register", description: "description", scale: "scale", units: "unit" },
      },
    },
    profiles: {},
  };
  it("assigns VLANs from subnets (most specific wins)", () => {
    expect(matchVlan("10.10.20.11", vlans)).toBe("v2");
    expect(matchVlan("10.10.20.200", vlans)).toBe("v1");
    expect(matchVlan("192.168.1.1", vlans)).toBeNull();
  });
  it("validates devices and connections", () => {
    const dv = validateDevices(ctx.devices, vlans);
    expect(dv.d2.map((i) => i.msg)).toEqual(expect.arrayContaining(["Serial number used by another device", "No VLAN subnet contains this IP"]));
    expect(dv.ems).toBeUndefined();
    const cv = validateConnections(ctx.connections, ctx.devices, ctx.protocols, { s1: "modbus" });
    expect(cv.c1).toBeUndefined(); // kind inherited from parent Modbus
    expect(cv.c2[0].msg).toMatch(/address must be 0–255/);
    expect(cv.c3.map((i) => i.msg)).toEqual(expect.arrayContaining(["From and To are the same device", "Publish topics cannot contain the wildcards # or +"]));
  });
  it("expands parent protocols when filtering", () => {
    expect([...expandProtocols(["pm"], ctx.protocols)].sort()).toEqual(["pm", "pmt"]);
  });
  it("builds the customer point list from connections", () => {
    const { grid } = buildPointList(ctx);
    expect(grid.length).toBe(1 + 4);
    expect(grid[1].slice(0, 9)).toEqual(["PCS-01", "PCS", "S1", "EMS", "Modbus TCP", "10.10.20.11", "502", "1", "21"]);
    expect(grid[1][17]).toBe("site/pcs01/pcs1.p_cmd");
  });
  it("builds Source → MQTT configs with and without a profile", () => {
    const plain = JSON.parse(buildConnectionConfig(ctx, ctx.connections[0]).text);
    expect(plain.device).toMatchObject({ name: "PCS-01", port: 502, unitId: 1, serial: "S1" });
    expect(plain.connection.client).toBe("EMS");
    expect(plain.network.mask).toBe("255.255.255.192");
    expect(plain.points[0].mqtt_topic).toBe("site/pcs01/pcs1.p_cmd");
    const withProfile: OutputContext = {
      ...ctx,
      profiles: {
        s1: {
          id: "p1", name: "PCS profile", sourceCols: ["tag", "register", "writable"],
          version: { major: 1, minor: 2, cond: [null, null, { na: false, n: false, q: false, tf: false, t10: true, r: false, def: "" }], nameRule: { n: false, q: true }, order: [], opts: {} },
        },
      },
    };
    const o = JSON.parse(buildConnectionConfig(withProfile, ctx.connections[0]).text);
    expect(o.points[0]).toEqual({ tag: "pcs1.p_cmd", register: 40001, writable: 1, mqtt_topic: "site/pcs01/pcs1.p_cmd" });
    expect(o.source.profile).toBe("PCS profile v1.002");
    expect(JSON.parse(buildAllConfigs(withProfile).text).connections).toHaveLength(2);
  });
  it("builds the IP schema with protocols per device", () => {
    const s = buildIpSchema(ctx);
    expect(s.sections.map((x) => x.vlan?.vlan ?? "none")).toEqual(["20", "21", "none"]);
    expect(s.grid.find((r) => r[8] === "EMS")).toEqual(["", "", "", "20", "PCS", "10.10.20.0/24", "255.255.255.0", "10.10.20.1", "EMS", "Controller", "E1", "10.10.20.200", "MBTCP, MQTT", ""]);
    expect(s.markdown).toContain("## Unassigned devices");
  });
});

describe("diagram helpers + per-end network", () => {
  it("abbreviates ports", () => {
    expect(["Port 1", "port-2", "Ethernet 1", "eth1", "GigabitEthernet1/0/3", "Gi1/24", "COM 2", "Serial 1", "", "LAN 3", "SFP+ 1"].map(portAbbr))
      .toEqual(["P1", "P2", "ETH1", "ETH1", "Gi1/0/3", "Gi1/24", "COM2", "S1", "", "LAN3", "SFP+ 1"]);
  });
  it("gives services an automatic colour until one is chosen", () => {
    const s = (id: string, sort: number, color = "") => ({ id, name: id, kind: "EMS", contractor: "", notes: "", enabled: true, sort, color });
    const list = [s("a", 0), s("b", 1, "#123456")];
    expect(serviceColor(list[0], list)).toBe("#2f7f8a");
    expect(serviceColor(list[1], list)).toBe("#123456");
  });
  it("describes custom trajectories and checks per-end VLAN / IP", () => {
    const vl: Vlan[] = [{ id: "v3", vlan: "3", name: "Ops", subnet: "192.168.20.0/24", gateway: "", notes: "" }];
    const devs = ["a", "b"].map((id) => ({ id, name: id.toUpperCase(), type: "", serial: "", ip: "", vlanId: null, notes: "" }));
    const prot: ProtocolDef = { id: "p", name: "X", alias: "", dfAlias: "", parentId: null, defaultPort: "", pointListKind: "", style: DEFAULT_STYLE, sort: 0 };
    const c = {
      id: "c", fromId: "a", toId: "b", protocolId: "p", port: "", address: "", sourceId: null, topic: "", bidirectional: false, notes: "",
      path: [{ kind: "custom" as const, id: "", label: "Utility MPLS", inPort: "", outPort: "" }, { kind: "custom" as const, id: "", label: "", inPort: "", outPort: "" }],
      endNet: true, clientIp: "192.168.20.21", clientVlanId: "v3", serverIp: "10.0.0.9", serverVlanId: "v3",
    };
    expect(pathText(c, (_k, id) => (id ?? "").toUpperCase())).toBe("A → ⟨Utility MPLS⟩ → ⟨custom trajectory⟩ → B");
    const msgs = (validateConnections([c], devs, [prot], {}, [], vl).c ?? []).map((i) => i.msg);
    expect(msgs).toContain("Hop 2 (custom trajectory) has no name");
    expect(msgs).toContain("Server IP is outside VLAN 3 (192.168.20.0/24)");
    expect(msgs.some((m) => m.startsWith("Client"))).toBe(false);
    expect(msgs.some((m) => m.includes("Hop 1"))).toBe(false);
  });
});

describe("network details (port allocation)", () => {
  const dev = (id: string, vlanId: string | null) => ({ id, name: id, type: "", serial: "", ip: "", vlanId, notes: "" });
  const devices = [dev("rtac1", "v3"), dev("rtac3", "v3"), dev("sub10", "v10"), dev("ns1", "v3"), dev("ns2", "v10")];
  const base = { protocolId: "p", port: "", address: "", sourceId: null, topic: "", bidirectional: false, notes: "" };
  const conns = [
    {
      ...base, id: "c1", fromId: "rtac1", toId: "sub10", clientPort: "eth3", serverPort: "eth0",
      path: [
        { kind: "device" as const, id: "ns1", inPort: "Gi1/3", outPort: "Gi1/24" },
        { kind: "firewall" as const, id: "fw1", inPort: "port5", outPort: "", single: true },
        { kind: "custom" as const, id: "", label: "Utility MPLS", inPort: "", outPort: "" },
        { kind: "device" as const, id: "ns2", inPort: "Gi1/1", outPort: "Gi1/7" },
      ],
    },
    { ...base, id: "c2", fromId: "rtac3", toId: "rtac1", clientPort: "P1", serverPort: "eth2", path: [{ kind: "device" as const, id: "ns1", inPort: "Gi1/4", outPort: "Gi1/2" }] },
  ];
  const links = buildLinks(conns, devices);
  it("turns paths into cables with VLANs", () => {
    expect(links).toHaveLength(7);
    expect(links[0]).toMatchObject({ a: { id: "rtac1" }, aPort: "eth3", aEnd: true, b: { id: "ns1" }, bPort: "Gi1/3", vlanIds: ["v3"] });
    // single-port firewall hop uses its one port both ways; trunk links carry both ends' VLANs
    expect(links[1]).toMatchObject({ a: { id: "ns1" }, aPort: "Gi1/24", b: { kind: "firewall" }, bPort: "port5", vlanIds: ["v3", "v10"] });
    expect(links[2]).toMatchObject({ a: { kind: "firewall" }, aPort: "port5", b: { kind: "custom", label: "Utility MPLS" } });
    expect(hopElements(conns).map((e) => e.kind + ":" + e.id)).toEqual(["device:ns1", "firewall:fw1", "custom:utility mpls", "device:ns2"]);
  });
  it("allocates each switch port to its peer", () => {
    const ns1 = portAllocation({ kind: "device", id: "ns1" }, links);
    expect(ns1.map((p) => [p.port, p.side, p.mode, p.peers.map((x) => x.elem.id + ":" + x.port).join(",")])).toEqual([
      ["Gi1/2", "access", "access", "rtac1:eth2"],
      ["Gi1/3", "access", "access", "rtac1:eth3"],
      ["Gi1/4", "access", "access", "rtac3:P1"],
      ["Gi1/24", "uplink", "trunk", "fw1:port5"],
    ]);
    const fw = portAllocation({ kind: "firewall", id: "fw1" }, links);
    expect(fw).toHaveLength(1);
    expect(fw[0].peers.map((x) => x.elem.id)).toEqual(["ns1", "utility mpls"]);
    expect(fw[0].warnings).toEqual([]);
    // Two elements on one port: one shared port with two peers (drawn as a bus), not an issue.
    const shared = buildLinks([{ ...conns[1], id: "c3", fromId: "ns2", clientPort: "Gi1/9", path: [{ kind: "device" as const, id: "ns1", inPort: "Gi1/4", outPort: "Gi1/2" }] }, conns[1]], devices);
    const g4 = portAllocation({ kind: "device", id: "ns1" }, shared).find((p) => p.port === "Gi1/4")!;
    expect(g4.peers.map((x) => x.elem.id).sort()).toEqual(["ns2", "rtac3"]);
    expect(g4.warnings).toEqual([]);
    expect(g4.peers.find((x) => x.elem.id === "ns2")!.vlanIds).toEqual(["v10"]);
  });
  it("describes each route side from a main element to the end device", () => {
    const ns1 = routeSides({ kind: "device", id: "ns1" }, conns, devices);
    // c1 passes through ns1 (both directions), c2 too.
    expect(ns1.map((r) => `${r.connId}:${r.dir}:${r.port}->${r.endId}:${r.endPort} [${r.hops.map((x) => x.id).join(",")}] ${r.mainVlan}/${r.endVlan}`)).toEqual([
      "c1:toClient:Gi1/3->rtac1:eth3 [] v3/v3",
      "c1:toServer:Gi1/24->sub10:eth0 [fw1,utility mpls,ns2] v10/v10",
      "c2:toClient:Gi1/4->rtac3:P1 [] v3/v3",
      "c2:toServer:Gi1/2->rtac1:eth2 [] v3/v3",
    ]);
    const r1 = routeSides({ kind: "device", id: "rtac1" }, conns, devices);
    expect(r1.map((r) => `${r.dir}:${r.mainAt}:${r.port}->${r.endId} ${r.mainVlan}/${r.endVlan}`)).toEqual([
      "toServer:client:eth3->sub10 v3/v10",
      "toClient:server:eth2->rtac3 v3/v3",
    ]);
  });
    it("writes edited ports back through refs", () => {
    const ns1 = portAllocation({ kind: "device", id: "ns1" }, links);
    const up = ns1.find((p) => p.port === "Gi1/24")!.peers[0];
    expect(up.selfRefs).toEqual([{ connId: "c1", at: "hop", hop: 0, dir: "out" }]);
    expect(up.peerRefs).toEqual([{ connId: "c1", at: "hop", hop: 1, dir: "in" }]);
    const c = setPortAt(setPortAt(conns[0], up.selfRefs[0], "Te1/1"), up.peerRefs[0], "port9");
    expect(c.path![0].outPort).toBe("Te1/1");
    expect(c.path![1].inPort).toBe("port9");
    const acc = ns1.find((p) => p.port === "Gi1/3")!.peers[0];
    expect(setPortAt(conns[0], acc.peerRefs[0], "eth9").clientPort).toBe("eth9");
  });
});
