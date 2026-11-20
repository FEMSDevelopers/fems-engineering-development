/**
 * Subcategory specifications: the common selection / sizing criteria of each device type, so parts of the same type from
 * different manufacturers can be compared and swapped (e.g. a 20 A → 25 A breaker of another make). Templates follow the
 * usual datasheet criteria and listing standards (UL / CSA / IEC / IEEE / NEMA). Also a description parser that suggests
 * values from catalog descriptions (always to be verified against the datasheet).
 */
import type { CustomFieldDef, Part } from "./bom.js";

/** Value of one specification: text, number, yes/no, several choices, or a min–max range. */
export type SpecValue = string | number | boolean | string[] | [number | null, number | null];

/** Listing / recognition mark (how the certification applies to the device). */
export const LISTING_MARKS = ["UL Listed", "cULus Listed", "UL Recognized (RU)", "cURus Recognized", "CSA certified", "ETL / cETLus", "CE only", "None"];

const num = (key: string, label: string, unit?: string, group?: string, help?: string): CustomFieldDef => ({ key, label, type: "number", unit, group, help });
const txt = (key: string, label: string, group?: string, help?: string): CustomFieldDef => ({ key, label, type: "text", group, help });
const yes = (key: string, label: string, group?: string, help?: string): CustomFieldDef => ({ key, label, type: "bool", group, help });
const sel = (key: string, label: string, options: string[], group?: string, help?: string, unit?: string): CustomFieldDef => ({ key, label, type: "select", options, group, help, unit });
const multi = (key: string, label: string, options: string[], group?: string, help?: string): CustomFieldDef => ({ key, label, type: "multi", options, group, help });
const range = (key: string, label: string, unit: string, group?: string, help?: string): CustomFieldDef => ({ key, label, type: "range", unit, group, help });
/** Certifications held (with a certificate PDF per standard) + the listing mark. */
const certs = (options: string[]): CustomFieldDef[] => [
  sel("listing", "Listing mark", LISTING_MARKS, "Certification", "UL Listed = stand-alone listed product; UL Recognized (RU / cURus) = component for use inside listed equipment"),
  { key: "certs", label: "Certifications", type: "certs", options, group: "Certification", help: "Tick each standard the part is certified to and attach its certificate (PDF)" },
];
const TEMP = range("tempOper", "Operating temperature", "°C", "Environment");
/** Storage (non-operating) temperature range. */
export const TEMP_STORE = range("tempStorage", "Storage temperature", "°C", "Environment", "Non-operating / storage temperature range (min – max)");
const AC_DC = ["AC", "DC", "AC/DC"];

const BREAKER_STD = ["UL 489", "UL 1077", "CSA C22.2 No. 5", "CSA C22.2 No. 235", "IEC 60898-1", "IEC 60947-2", "UL 508", "Class I Div 2"];
const breaker = (rcd: boolean): CustomFieldDef[] => [
  sel("protection", "Protection type", ["UL 489 branch-circuit breaker", "UL 1077 supplementary protector", "IEC 60898-1 MCB", "IEC 60947-2 circuit breaker", ...(rcd ? ["IEC 61009-1 RCBO", "UL 943 GFCI", "UL 1053 ground-fault"] : [])], "Protection",
    "Branch-circuit protection in North America requires UL 489 breakers; UL 1077 supplementary protectors need upstream branch protection"),
  sel("poles", "Poles", ["1", "1+N", "2", "3", "3+N", "4"], "Protection"),
  sel("tripCurve", "Trip curve", ["B", "C", "D", "K", "Z"], "Protection", "B 3–5×In, C 5–10×In, D 10–20×In (magnetic trip)"),
  num("ratedCurrent", "Rated current In", "A", "Ratings"),
  num("ratedVoltageAc", "Rated voltage AC", "VAC", "Ratings", "e.g. 120/240, 277, 480Y/277"),
  num("ratedVoltageDc", "Rated voltage DC", "VDC", "Ratings"),
  num("interrupting", "Interrupting rating (SCCR / Icu)", "kA", "Ratings", "UL interrupting rating or IEC Icu / Icn at the rated voltage"),
  num("icn", "Icn (IEC 60898)", "kA", "Ratings"),
  sel("frequency", "Frequency", ["50 Hz", "60 Hz", "50/60 Hz", "DC", "AC/DC"], "Ratings"),
  ...(rcd ? [sel("residual", "Rated residual current IΔn", ["6", "10", "30", "100", "300", "500"], "Residual current", undefined, "mA"), sel("rcdType", "RCD type", ["AC", "A", "F", "B", "B+"], "Residual current", "Type A: AC + pulsating DC; Type B: also smooth DC (VFDs, EV chargers)")] : []),
  yes("auxContact", "Auxiliary / signal contact", "Accessories"),
  txt("wireRange", "Wire range", "Connection", "e.g. 18–4 AWG / 1–25 mm²"),
  num("torque", "Terminal torque", "N·m", "Connection"),
  TEMP, TEMP_STORE,
  ...certs(rcd ? [...BREAKER_STD, "IEC 61009-1", "UL 943", "UL 1053"] : BREAKER_STD),
];

const PSU_STD = ["UL 61010-1", "UL 61010-2-201", "UL 62368-1", "UL 60950-1", "UL 508", "UL 1310 (Class 2)", "CSA C22.2 No. 107.1", "IEC 62368-1", "IEC 61010-2-201", "Class I Div 2", "ATEX", "IECEx", "SEMI F47", "DNV", "CE"];
const psu: CustomFieldDef[] = [
  sel("inputPhases", "Infeed", ["1-phase", "2-phase", "3-phase", "1/2-phase", "DC"], "Input", "Number of phases / conductors required by the input"),
  sel("inputType", "Input voltage type", AC_DC, "Input"),
  range("inputRangeAc", "Input voltage range AC", "VAC", "Input", "Rated (not wide) range, e.g. 100–240"),
  range("inputRangeDc", "Input voltage range DC", "VDC", "Input", "e.g. 110–250 for station batteries"),
  sel("frequency", "Input frequency", ["50/60 Hz", "45–65 Hz", "DC"], "Input"),
  num("inputCurrent", "Input current (at nominal)", "A", "Input"),
  num("inrush", "Inrush current", "A", "Input"),
  sel("outputType", "Output voltage type", ["DC", "AC"], "Output"),
  num("outputVoltage", "Output voltage (nominal)", "V", "Output"),
  range("outputRange", "Output voltage range (adjustable)", "V", "Output", "e.g. 24–28"),
  num("outputCurrent", "Output current (continuous)", "A", "Output"),
  num("outputPower", "Output power", "W", "Output"),
  num("boostCurrent", "Boost / peak current", "A", "Output", "Static boost (e.g. 125 % In) or dynamic peak for starting loads"),
  num("efficiency", "Efficiency", "%", "Output"),
  num("holdup", "Hold-up time", "ms", "Output"),
  yes("parallel", "Parallel / redundant operation", "Output"),
  yes("dcOk", "DC OK signal / relay", "Output"),
  yes("class2", "NEC Class 2 output", "Output", "Power-limited output (UL 1310 / UL 61010-2-201 annex)"),
  TEMP, TEMP_STORE,
  txt("derating", "Derating", "Environment", "e.g. 2.5 %/K above 60 °C"),
  ...certs(PSU_STD),
];

const TB_STD = ["UL 1059", "UL 486E", "CSA C22.2 No. 158", "IEC 60947-7-1", "IEC 60947-7-2", "IEC 60947-7-3", "Class I Div 2", "ATEX", "CE"];
const FUSE_CLASSES = ["CC", "J", "T", "RK1", "RK5", "G", "Midget (10×38)", "5×20 mm", "gG / gL (IEC)", "aM (IEC)", "gR / aR (semiconductor)", "gPV (solar)"];
const NET_STD = ["IEC 61850-3", "IEEE 1613", "IEEE 1613.1", "EN 50121-4", "NEMA TS2", "UL 62368-1", "UL 61010-1", "FCC Part 15 Class A", "Class I Div 2", "CE"];
const ENCL_STD = ["UL 50", "UL 50E", "UL 508A", "NEMA 250", "IEC 60529", "IEC 62208", "CSA C22.2 No. 94"];
const NEMA = ["1", "3R", "4", "4X", "12", "12K", "13"];
const IP = ["IP20", "IP40", "IP54", "IP55", "IP65", "IP66", "IP67", "IP68"];
const PROTOCOLS = ["DNP3", "Modbus TCP", "Modbus RTU", "IEC 61850 MMS", "IEC 61850 GOOSE", "IEC 60870-5-104", "IEC 60870-5-101", "SEL Fast Message", "OPC UA", "MQTT", "SNMP", "EtherNet/IP"];

/** Specification template per subcategory name (default subcategories of the Fractal catalog). */
export const SPEC_TEMPLATES: Record<string, CustomFieldDef[]> = {
  MCB: breaker(false),
  RCBO: breaker(true),
  "Surge Protection Device": [
    sel("spdType", "SPD type / class", ["UL 1449 Type 1", "UL 1449 Type 2", "UL 1449 Type 3", "UL 1449 Type 4", "IEC Class I (T1)", "IEC Class II (T2)", "IEC Class III (T3)", "IEC T1+T2"], "Protection"),
    txt("system", "System", "Protection", "e.g. 1Ø 2W+G 120 V, 3Ø 4W+G 277/480 V, 24 VDC"),
    num("nominalVoltage", "Nominal voltage", "V", "Ratings"),
    num("mcov", "MCOV / Uc", "V", "Ratings", "Maximum continuous operating voltage"),
    num("inKa", "Nominal discharge current In", "kA", "Ratings"),
    num("imaxKa", "Max discharge current Imax", "kA", "Ratings"),
    num("vpr", "VPR / Up (voltage protection level)", "kV", "Ratings"),
    num("sccr", "SCCR", "kA", "Ratings"),
    multi("modes", "Protection modes", ["L-N", "L-L", "L-PE", "N-PE", "+/-", "+/PE", "-/PE"], "Protection"),
    yes("remote", "Remote indication contact", "Accessories"),
    yes("pluggable", "Pluggable protection module", "Accessories"),
    TEMP, TEMP_STORE,
    ...certs(["UL 1449", "IEC 61643-11", "IEC 61643-21", "CSA C22.2 No. 269", "IEEE C62.41", "CE"]),
  ],
  Fuse: [
    sel("fuseClass", "Fuse class / size", FUSE_CLASSES, "Fuse"),
    sel("speed", "Characteristic", ["Fast-acting", "Time-delay", "Dual-element time-delay", "Very fast (semiconductor)"], "Fuse"),
    num("ratedCurrent", "Rated current", "A", "Ratings"),
    num("ratedVoltageAc", "Rated voltage AC", "VAC", "Ratings"),
    num("ratedVoltageDc", "Rated voltage DC", "VDC", "Ratings"),
    num("interrupting", "Interrupting rating", "kA", "Ratings"),
    yes("indicator", "Blown-fuse indicator", "Fuse"),
    ...certs(["UL 248-1", "UL 248-4 (Class CC)", "UL 248-8 (Class J)", "UL 248-14", "CSA C22.2 No. 248", "IEC 60269-1", "IEC 60269-2", "CE"]),
  ],
  "Fuse Holder": [
    sel("fuseClass", "Accepts fuse class", FUSE_CLASSES, "Fuse"),
    sel("poles", "Poles", ["1", "1+N", "2", "3", "4"], "Fuse"),
    num("ratedCurrent", "Max current", "A", "Ratings"),
    num("ratedVoltageAc", "Rated voltage AC", "VAC", "Ratings"),
    num("ratedVoltageDc", "Rated voltage DC", "VDC", "Ratings"),
    num("sccr", "SCCR", "kA", "Ratings"),
    yes("indicator", "Blown-fuse indicator", "Fuse"),
    yes("touchSafe", "Finger-safe (IP20)", "Fuse"),
    txt("wireRange", "Wire range", "Connection"),
    ...certs(["UL 4248-1", "UL 4248-4 (Class CC)", "UL 4248-8 (Class J)", "UL 512", "CSA C22.2 No. 4248", "IEC 60269-2", "CE"]),
  ],
  "24VDC Power Supply": psu,
  "24VDC Redundancy Module": [
    sel("technology", "Decoupling", ["Diode", "Active (MOSFET)"], "Function"),
    num("inputs", "Number of inputs", undefined, "Function"),
    range("inputRange", "Input voltage range", "VDC", "Ratings"),
    num("inputCurrent", "Current per input", "A", "Ratings"),
    num("outputCurrent", "Output current", "A", "Ratings"),
    num("voltageDrop", "Voltage drop", "V", "Ratings"),
    num("efficiency", "Efficiency", "%", "Ratings"),
    yes("loadBalancing", "Auto current balancing", "Function"),
    yes("monitoring", "Input / output monitoring contact", "Function"),
    TEMP, TEMP_STORE,
    ...certs(PSU_STD),
  ],
  UPS: [
    sel("topology", "Topology", ["Standby", "Line-interactive", "Online double-conversion", "DC UPS", "DC UPS with integrated battery"], "Function"),
    sel("inputPhases", "Infeed", ["1-phase", "3-phase", "DC"], "Input"),
    range("inputRange", "Input voltage range", "V", "Input"),
    sel("outputType", "Output type", ["AC pure sine", "AC stepped sine", "DC"], "Output"),
    num("outputVoltage", "Output voltage", "V", "Output"),
    num("capacityVa", "Capacity", "VA", "Output"),
    num("capacityW", "Real power", "W", "Output"),
    num("runtimeHalf", "Runtime at half load", "min", "Battery"),
    num("runtimeFull", "Runtime at full load", "min", "Battery"),
    sel("battery", "Battery chemistry", ["VRLA (lead-acid)", "Li-ion", "LiFePO4", "Supercapacitor", "External"], "Battery"),
    yes("extBattery", "Extended-runtime battery packs", "Battery"),
    yes("hotSwap", "Hot-swappable battery", "Battery"),
    txt("outlets", "Outlets", "Output", "e.g. 3× 5-15R, 3× 5-20R, 1× L5-30R / C13 / C19"),
    yes("nmc", "Network management card", "Monitoring"),
    TEMP, TEMP_STORE,
    ...certs(["UL 1778", "CSA C22.2 No. 107.3", "IEC 62040-1", "UL 61010-1", "UL 508", "FCC Part 15", "Energy Star", "CE"]),
  ],
  Inverter: [
    range("inputRange", "DC input range", "VDC", "Input"),
    num("outputVoltage", "Output voltage", "VAC", "Output"),
    sel("outputPhases", "Output phases", ["1-phase", "Split-phase", "3-phase"], "Output"),
    sel("waveform", "Waveform", ["Pure sine", "Modified sine"], "Output"),
    num("continuousVa", "Continuous rating", "VA", "Output"),
    num("continuousW", "Continuous power", "W", "Output"),
    num("surgeW", "Surge power", "W", "Output"),
    num("efficiency", "Efficiency", "%", "Output"),
    yes("transfer", "Static transfer switch / bypass", "Function"),
    yes("isolated", "Galvanically isolated", "Function"),
    TEMP, TEMP_STORE,
    ...certs(["UL 1741", "UL 458", "UL 1778", "IEEE 1613", "IEC 61850-3", "CSA C22.2 No. 107.1", "CE"]),
  ],
  PDU: [
    sel("pduType", "Type", ["Basic", "Metered", "Monitored", "Switched", "Metered-by-outlet"], "Function"),
    sel("mounting", "Mounting", ["Vertical (0U)", "Horizontal 1U", "Horizontal 2U"], "Function"),
    txt("inputPlug", "Input plug / inlet", "Input", "e.g. C20 inlet, NEMA 5-15P, L6-30P"),
    num("inputVoltage", "Input voltage", "V", "Input"),
    num("inputCurrent", "Input current", "A", "Input"),
    sel("inputPhases", "Infeed", ["1-phase", "3-phase"], "Input"),
    txt("outlets", "Outlets", "Output", "e.g. 20× C13, 4× C19"),
    yes("breaker", "Built-in breaker", "Function"),
    ...certs(["UL 60950-1", "UL 62368-1", "UL 1363", "CSA C22.2 No. 62368-1", "CE"]),
  ],
  "Terminal Block": [
    sel("connection", "Connection", ["Screw", "Push-in", "Spring-cage", "Insulation displacement", "Bolt"], "Function"),
    sel("function", "Function", ["Feed-through", "Ground (PE)", "Fuse", "Disconnect / knife", "Multi-level", "Sensor / actuator", "Distribution block", "Test"], "Function"),
    num("levels", "Levels", undefined, "Function"),
    num("positions", "Connection points", undefined, "Function"),
    num("ratedVoltage", "Rated voltage (IEC)", "V", "Ratings"),
    num("ratedCurrent", "Rated current (IEC)", "A", "Ratings"),
    num("ulVoltage", "UL voltage", "V", "Ratings"),
    num("ulCurrent", "UL current", "A", "Ratings"),
    txt("wireRange", "Wire range", "Connection", "e.g. 26–10 AWG / 0.14–6 mm²"),
    num("crossSection", "Nominal cross-section", "mm²", "Connection"),
    sel("color", "Color", ["Gray", "Green/yellow (PE)", "Blue", "Red", "Black", "Orange", "White"], "Function"),
    yes("bridgeShaft", "Bridge shaft (plug-in jumpers)", "Function"),
    ...certs(TB_STD),
  ],
  "Terminal Accessory": [
    sel("accessory", "Accessory", ["End cover", "Partition plate", "End clamp / end stop", "Marker", "Group marker carrier", "Test plug"], "Function"),
    txt("fitsSeries", "Fits series", "Function", "e.g. UT 4, PT 4-QUATTRO, XTV 10"),
    sel("color", "Color", ["Gray", "Green/yellow", "Blue", "Red", "Black", "Orange"], "Function"),
  ],
  "Plug-in Bridge": [
    num("positions", "Positions", undefined, "Function"),
    num("pitch", "Pitch", "mm", "Function"),
    num("ratedCurrent", "Rated current", "A", "Ratings"),
    txt("fitsSeries", "Fits series", "Function"),
    sel("color", "Color", ["Red", "Blue", "Gray"], "Function"),
    ...certs(TB_STD),
  ],
  "Power Cable": [
    txt("endA", "End A", "Cable", "e.g. NEMA 5-15P, C14, open wire"),
    txt("endB", "End B", "Cable", "e.g. C13, C19, open wire"),
    num("length", "Length", "m", "Cable"),
    txt("gauge", "Conductor size", "Cable", "e.g. 14 AWG / 1.5 mm²"),
    num("ratedVoltage", "Rated voltage", "V", "Ratings"),
    num("ratedCurrent", "Rated current", "A", "Ratings"),
    sel("jacket", "Jacket", ["SJT", "SJTW", "SJOOW", "H05VV-F", "H07RN-F", "LSZH"], "Cable"),
    ...certs(["UL 817", "UL 62", "CSA C22.2 No. 21", "IEC 60320", "CE"]),
  ],
  Outlet: [
    sel("config", "Configuration", ["NEMA 5-15R", "NEMA 5-20R", "NEMA L5-30R", "NEMA 6-20R", "IEC C13", "IEC C19", "Schuko", "DIN-rail socket"], "Function"),
    num("ratedCurrent", "Rated current", "A", "Ratings"),
    num("ratedVoltage", "Rated voltage", "V", "Ratings"),
    yes("gfci", "GFCI", "Function"),
    ...certs(["UL 498", "UL 943", "CSA C22.2 No. 42", "CE"]),
  ],
  Transformer: [
    sel("trType", "Type", ["Control", "Isolation", "Auto", "Step-down", "Step-up"], "Function"),
    num("kva", "Rating", "kVA", "Ratings"),
    txt("primary", "Primary voltage(s)", "Ratings", "e.g. 480 / 240 V"),
    txt("secondary", "Secondary voltage(s)", "Ratings", "e.g. 120 V"),
    sel("phases", "Phases", ["1-phase", "3-phase"], "Ratings"),
    sel("frequency", "Frequency", ["50 Hz", "60 Hz", "50/60 Hz"], "Ratings"),
    num("impedance", "Impedance", "%", "Ratings"),
    ...certs(["UL 5085", "UL 1561", "CSA C22.2 No. 66", "DOE 2016", "CE"]),
  ],
  "Server Rack Enclosure": [
    num("rackUnits", "Rack units", "U", "Rack"),
    sel("rails", "Rail standard", ['19" EIA-310', '23"', "ETSI"], "Rack"),
    num("staticLoad", "Static load rating", "kg", "Rack"),
    num("dynamicLoad", "Rolling load rating", "kg", "Rack"),
    sel("ip", "IP rating", IP, "Protection"),
    sel("nema", "NEMA type", NEMA, "Protection"),
    sel("doors", "Doors", ["Perforated", "Glass", "Solid", "Split rear", "Lockable"], "Rack"),
    yes("fans", "Fans / ventilation", "Thermal"),
    yes("seismic", "Seismic (Zone 4) rated", "Rack"),
    ...certs(["EIA-310-E", "UL 2416", "UL 60950-1", "UL 50", "IEC 60529", "Telcordia GR-63 Zone 4", "CE"]),
  ],
  "Wall Mounted RTAC Enclosure": [
    sel("nema", "NEMA type", NEMA, "Protection"),
    sel("ip", "IP rating", IP, "Protection"),
    sel("material", "Material", ["Carbon steel", "Stainless 304", "Stainless 316", "Aluminum", "Polycarbonate", "Fiberglass"], "Enclosure"),
    sel("door", "Door", ["Single", "Double", "Window kit"], "Enclosure"),
    txt("panel", "Back panel part", "Enclosure"),
    ...certs(ENCL_STD),
  ],
  "Field Enclosure": [
    sel("nema", "NEMA type", NEMA, "Protection"),
    sel("ip", "IP rating", IP, "Protection"),
    sel("material", "Material", ["Carbon steel", "Stainless 304", "Stainless 316", "Aluminum", "Polycarbonate", "Fiberglass"], "Enclosure"),
    txt("color", "Color / finish", "Enclosure", "e.g. RAL 7035 gray"),
    sel("door", "Doors", ["Single", "Double"], "Enclosure"),
    sel("lock", "Lock", ["Quarter-turn", "Key", "Padlock handle", "3-point"], "Enclosure"),
    txt("panel", "Back panel part", "Enclosure", "Panel part number (its size is the mounting area)"),
    yes("hvacCutout", "HVAC cut-out / provision", "Thermal"),
    ...certs(ENCL_STD),
  ],
  "Back Panel": [
    sel("material", "Material", ["Mild steel", "Galvanized steel", "Stainless steel", "Aluminum", "Non-metallic"], "Panel"),
    sel("finish", "Finish", ["White powder coat", "Galvanized", "Unfinished", "Orange"], "Panel"),
    txt("fits", "Fits enclosure", "Panel"),
  ],
  "Rack Shelf": [
    sel("shelfType", "Type", ["Fixed", "Sliding", "Cantilever", "Keyboard / laptop drawer"], "Function"),
    num("load", "Load rating", "kg", "Function"),
    yes("vented", "Vented", "Function"),
  ],
  "DIN Rail": [
    sel("profile", "Profile", ["TS35 × 7.5", "TS35 × 15", "TS32 (G)", "TS15"], "Rail"),
    num("length", "Length", "m", "Rail"),
    sel("material", "Material", ["Steel, zinc-plated", "Aluminum", "Copper"], "Rail"),
    yes("perforated", "Perforated", "Rail"),
    ...certs(["IEC 60715", "EN 60715"]),
  ],
  "Wire Duct": [
    sel("ductType", "Type", ["Narrow slot", "Wide slot", "Solid wall", "Round hole"], "Duct"),
    num("length", "Length", "m", "Duct"),
    sel("material", "Material", ["PVC", "Halogen-free (LSZH)", "Polypropylene"], "Duct"),
    sel("color", "Color", ["Light gray", "White", "Black", "Blue"], "Duct"),
    ...certs(["UL 94 V-0", "UL 94 V-2", "UL 1565", "CSA C22.2"]),
  ],
  "Mounting Hardware": [txt("hwType", "Type", "Function"), txt("fits", "Fits", "Function"), sel("material", "Material", ["Steel", "Stainless 304", "Stainless 316", "Aluminum", "Plastic"], "Function")],
  Fan: [
    num("voltage", "Voltage", "V", "Ratings"),
    sel("voltageType", "Voltage type", ["AC", "DC"], "Ratings"),
    num("airflow", "Airflow", "CFM", "Ratings"),
    num("noise", "Noise", "dBA", "Ratings"),
    num("power", "Power", "W", "Ratings"),
    txt("size", "Frame size", "Function", "e.g. 120 × 120 × 38 mm"),
    sel("bearing", "Bearing", ["Ball", "Sleeve", "Fluid"], "Function"),
    yes("filter", "Filter", "Function"),
    yes("thermostat", "Thermostat controlled", "Function"),
    ...certs(["UL 507", "CSA C22.2 No. 113", "CE"]),
  ],
  HVAC: [
    sel("hvacType", "Type", ["Air conditioner", "Heater", "Heat exchanger", "Thermoelectric cooler", "Filter fan"], "Function"),
    num("cooling", "Cooling capacity", "BTU/h", "Ratings"),
    num("heating", "Heating capacity", "W", "Ratings"),
    num("voltage", "Voltage", "VAC", "Ratings"),
    sel("phases", "Phases", ["1-phase", "3-phase"], "Ratings"),
    num("current", "Current", "A", "Ratings"),
    sel("mounting", "Mounting", ["Side", "Door", "Top", "Panel / DIN"], "Function"),
    sel("nema", "NEMA type kept", NEMA, "Protection"),
    txt("refrigerant", "Refrigerant", "Function"),
    range("setpoint", "Thermostat range", "°C", "Function"),
    TEMP, TEMP_STORE,
    ...certs(["UL 484", "UL 1995", "UL 50E", "UL 499", "CSA C22.2 No. 236", "CE"]),
  ],
  Firewall: [
    sel("formFactor", "Form factor", ["Desktop", "1U rack", "2U rack", "Rugged DIN", "Virtual"], "Platform"),
    num("fwThroughput", "Firewall throughput", "Gbps", "Performance"),
    num("tpThroughput", "Threat-protection throughput", "Gbps", "Performance"),
    num("ipsec", "IPsec VPN throughput", "Gbps", "Performance"),
    num("sessions", "Concurrent sessions", "M", "Performance"),
    yes("redundantPsu", "Redundant power supplies", "Platform"),
    yes("ha", "High-availability pair support", "Platform"),
    txt("license", "License / support bundle", "Platform"),
    TEMP, TEMP_STORE,
    ...certs(["IEC 61850-3", "IEEE 1613", "UL 62368-1", "FCC Part 15 Class A", "FIPS 140-2", "FIPS 140-3", "Common Criteria", "ICSA Labs", "Class I Div 2", "CE"]),
  ],
  "Network Switch": [
    sel("layer", "Layer", ["L2", "L2+", "L3"], "Function"),
    yes("managed", "Managed", "Function"),
    sel("formFactor", "Form factor", ["1U rack", "Rugged rack", "DIN rail", "Desktop"], "Function"),
    num("switching", "Switching capacity", "Gbps", "Performance"),
    sel("poe", "PoE", ["None", "802.3af (PoE)", "802.3at (PoE+)", "802.3bt (PoE++)", "UPOE 60 W"], "PoE"),
    num("poeBudget", "PoE budget", "W", "PoE"),
    yes("redundantPsu", "Redundant power inputs", "Function"),
    multi("protocols", "Redundancy / timing", ["RSTP", "MSTP", "ERPS", "PRP", "HSR", "MRP", "LACP", "PTP IEEE 1588", "VLAN 802.1Q", "802.1X"], "Function"),
    TEMP, TEMP_STORE,
    ...certs(NET_STD),
  ],
  "SFP Transceiver": [
    sel("formFactor", "Form factor", ["SFP", "SFP+", "SFP28", "QSFP+", "QSFP28"], "Optics"),
    sel("rate", "Data rate", ["100 Mbps", "1 Gbps", "10 Gbps", "25 Gbps", "40 Gbps", "100 Gbps"], "Optics"),
    sel("standard", "Standard", ["100BASE-FX", "100BASE-LX10", "1000BASE-SX", "1000BASE-LX", "1000BASE-LX10", "1000BASE-ZX", "1000BASE-BX", "1000BASE-T", "10GBASE-SR", "10GBASE-LR", "10GBASE-ER"], "Optics"),
    sel("fiber", "Fiber", ["Single-mode (SMF)", "Multimode (MMF)", "Copper"], "Optics"),
    num("wavelength", "Wavelength", "nm", "Optics"),
    num("reach", "Reach", "km", "Optics"),
    sel("connector", "Connector", ["LC duplex", "LC simplex (BiDi)", "SC", "RJ45"], "Optics"),
    yes("ddm", "DDM / DOM", "Optics"),
    TEMP, TEMP_STORE,
    txt("compat", "Coded for", "Optics", "Switch / firewall vendor coding"),
    ...certs(["SFF-8472", "SFP MSA", "IEC 60825-1 Class 1", "FDA 21 CFR 1040.10", "UL 60950-1", "CE"]),
  ],
  "Fiber Patch Panel": [
    sel("mounting", "Mounting", ["19\" rack", "DIN rail", "Wall"], "Panel"),
    num("slots", "Adapter slots", undefined, "Panel"),
    num("fibers", "Fiber capacity", undefined, "Panel"),
    sel("connector", "Connector", ["LC", "SC", "ST", "MPO"], "Panel"),
    yes("splice", "Splice trays", "Panel"),
  ],
  "Fiber Adapter": [
    sel("connector", "Connector", ["LC duplex", "LC quad", "SC simplex", "SC duplex", "ST"], "Adapter"),
    num("fibers", "Fibers", undefined, "Adapter"),
    sel("mode", "Fiber mode", ["SM OS1/OS2", "MM OM1", "MM OM2", "MM OM3", "MM OM4", "MM OM5"], "Adapter"),
    sel("polish", "Polish", ["UPC", "APC"], "Adapter"),
  ],
  "Patch Cable": [
    sel("medium", "Medium", ["Copper Cat5e", "Copper Cat6", "Copper Cat6A", "Fiber SM OS2", "Fiber MM OM1", "Fiber MM OM2", "Fiber MM OM3", "Fiber MM OM4", "Coax"], "Cable"),
    txt("endA", "Connector A", "Cable", "e.g. RJ45, LC UPC, SMA male"),
    txt("endB", "Connector B", "Cable"),
    num("length", "Length", "m", "Cable"),
    sel("shield", "Shielding", ["UTP", "F/UTP", "S/FTP"], "Cable"),
    sel("jacket", "Jacket", ["PVC", "LSZH", "Plenum (CMP/OFNP)", "Riser (CMR/OFNR)", "Outdoor / armored"], "Cable"),
    txt("color", "Color", "Cable"),
    ...certs(["TIA-568.2-D", "TIA-568.3-D", "ISO/IEC 11801", "UL 444", "UL 1651", "ITU-T G.652.D", "ITU-T G.657.A1"]),
  ],
  "Cellular Router": [
    sel("cellCat", "Cellular", ["LTE Cat 4", "LTE Cat 6", "LTE Cat 12", "LTE Cat 18", "LTE Cat 20", "5G NR"], "Cellular"),
    txt("bands", "Bands", "Cellular"),
    num("sims", "SIM slots", undefined, "Cellular"),
    multi("carriers", "Carrier certified", ["AT&T", "Verizon", "T-Mobile", "FirstNet", "PTCRB"], "Cellular"),
    txt("antennas", "Antenna connectors", "Cellular", "e.g. 4× SMA"),
    TEMP, TEMP_STORE,
    ...certs(["PTCRB", "FCC Part 15", "FCC Part 22/24/27", "UL 62368-1", "Class I Div 2", "IEC 61850-3", "CE"]),
  ],
  "Satellite Clock": [
    multi("gnss", "GNSS", ["GPS", "GLONASS", "Galileo", "BeiDou"], "Timing"),
    multi("outputs", "Time outputs", ["IRIG-B demodulated", "IRIG-B modulated", "PTP IEEE 1588", "PTP C37.238", "NTP", "SNTP", "PPS", "Serial"], "Timing"),
    num("accuracy", "Accuracy", "ns", "Timing"),
    sel("oscillator", "Holdover oscillator", ["TCXO", "OCXO", "Rubidium"], "Timing"),
    yes("conformal", "Conformal coating", "Platform"),
    TEMP, TEMP_STORE,
    ...certs(["IEEE 1613", "IEC 61850-3", "IEC 60255-26", "UL 62368-1", "CE"]),
  ],
  RTAC: [
    txt("platform", "Platform / model", "Platform", "e.g. SEL-3530-4"),
    multi("protocols", "Protocols", PROTOCOLS, "Communications"),
    txt("ethernet", "Ethernet ports", "Communications", "e.g. 2× 10/100BASE-T, 1× 100BASE-LX10"),
    num("serialPorts", "Serial ports", undefined, "Communications"),
    txt("io", "I/O", "Platform"),
    yes("conformal", "Conformal coating", "Platform"),
    TEMP, TEMP_STORE,
    ...certs(["IEEE 1613", "IEC 61850-3", "IEC 60255-26", "IEC 60255-27", "UL 61010-1", "CE"]),
  ],
  "Site Controller": [
    txt("platform", "Platform", "Platform", "e.g. sbRIO-9609"),
    yes("redundant", "Redundant controller", "Platform"),
    yes("gpic", "GPIC I/O breakout", "Platform"),
    multi("protocols", "Protocols", PROTOCOLS, "Communications"),
    TEMP, TEMP_STORE,
    ...certs(["UL 61010-1", "IEC 61010-1", "FCC Part 15", "CE"]),
  ],
  Controller: [
    txt("platform", "Platform", "Platform", "e.g. sbRIO-9603 / OnLogic K410"),
    sel("role", "Role", ["Unit controller", "Power plant controller", "Voltage controller", "Other"], "Platform"),
    sel("mounting", "Mounting", ["DIN rail", "Rack 2U", "Panel"], "Platform"),
    multi("protocols", "Protocols", PROTOCOLS, "Communications"),
    TEMP, TEMP_STORE,
    ...certs(["UL 61010-1", "IEC 61010-1", "FCC Part 15", "CE"]),
  ],
  "Industrial PC": [
    txt("cpu", "CPU", "Platform"),
    num("ram", "RAM", "GB", "Platform"),
    num("storage", "Storage", "GB", "Platform"),
    txt("os", "Operating system", "Platform"),
    yes("fanless", "Fanless", "Platform"),
    sel("mounting", "Mounting", ["DIN rail", "Wall", "VESA", "Rack"], "Platform"),
    range("powerRange", "Power input range", "VDC", "Power"),
    TEMP, TEMP_STORE,
    ...certs(["UL 62368-1", "IEC 61850-3", "IEEE 1613", "Class I Div 2", "FCC Part 15", "CE"]),
  ],
  Server: [
    txt("cpu", "CPU", "Platform"),
    num("sockets", "Sockets", undefined, "Platform"),
    num("ram", "RAM", "GB", "Platform"),
    txt("storage", "Storage", "Platform", "e.g. 2× 960 GB SSD RAID 1"),
    num("psuW", "PSU rating (each)", "W", "Power"),
    yes("redundantPsu", "Redundant PSUs", "Power"),
    yes("bmc", "Remote management (iDRAC / iLO / IPMI)", "Platform"),
    txt("os", "Operating system", "Platform"),
    ...certs(["UL 62368-1", "UL 60950-1", "FCC Part 15 Class A", "Energy Star", "NEBS", "CE"]),
  ],
  "I/O Module": [
    num("di", "Digital inputs", undefined, "I/O"),
    num("do", "Digital outputs", undefined, "I/O"),
    num("ai", "Analog inputs", undefined, "I/O"),
    num("ao", "Analog outputs", undefined, "I/O"),
    multi("aiType", "Analog types", ["4–20 mA", "0–10 V", "±10 V", "RTD", "Thermocouple"], "I/O"),
    multi("protocols", "Protocols", ["Modbus TCP", "Modbus RTU", "EtherNet/IP", "DNP3", "SNMP", "MQTT", "RESTful"], "Communications"),
    num("isolation", "Isolation", "V", "Ratings"),
    range("powerRange", "Power input range", "VDC", "Power"),
    TEMP, TEMP_STORE,
    ...certs(["UL 61010-2-201", "UL 508", "Class I Div 2", "ATEX", "CE"]),
  ],
  Sensor: [
    multi("measurand", "Measures", ["Temperature", "Humidity", "Pressure", "Door / contact", "Smoke", "Water / leak", "Current", "Voltage"], "Sensor"),
    multi("output", "Output", ["Modbus RTU", "Modbus TCP", "SNMP", "4–20 mA", "0–10 V", "Dry contact"], "Sensor"),
    txt("accuracy", "Accuracy", "Sensor", "e.g. ±0.3 °C, ±2 % RH"),
    range("powerRange", "Power input range", "V", "Power"),
    yes("display", "Display", "Sensor"),
    TEMP, TEMP_STORE,
    ...certs(["UL 61010-1", "FCC Part 15", "CE"]),
  ],
  Camera: [
    num("resolution", "Resolution", "MP", "Camera"),
    txt("lens", "Lens / field of view", "Camera"),
    num("irRange", "IR range", "m", "Camera"),
    sel("poeClass", "PoE class", ["802.3af Class 3", "802.3at Class 4", "802.3bt", "12 VDC"], "Power"),
    sel("ip", "IP rating", IP, "Protection"),
    sel("ik", "IK rating", ["IK08", "IK09", "IK10"], "Protection"),
    yes("onvif", "ONVIF", "Camera"),
    TEMP, TEMP_STORE,
    ...certs(["UL 62368-1", "NDAA compliant", "FCC Part 15", "IEC 60529", "CE"]),
  ],
  Battery: [
    sel("chemistry", "Chemistry", ["VRLA AGM", "VRLA gel", "Li-ion", "LiFePO4", "NiCd"], "Battery"),
    num("nominalVoltage", "Nominal voltage", "V", "Ratings"),
    num("capacityAh", "Capacity", "Ah", "Ratings"),
    num("energyWh", "Energy", "Wh", "Ratings"),
    num("life", "Design life", "years", "Battery"),
    txt("compatible", "For UPS / charger", "Battery"),
    TEMP, TEMP_STORE,
    ...certs(["UL 1989", "UL 1973", "UL 2054", "UN 38.3", "IEC 62133", "CE"]),
  ],
  Antenna: [
    sel("antType", "Type", ["Omni", "Directional / Yagi", "Panel", "Dome / puck", "GNSS"], "Antenna"),
    txt("bands", "Frequency bands", "Antenna", "e.g. 617–960, 1700–2700, 3300–5000 MHz"),
    num("gain", "Peak gain", "dBi", "Antenna"),
    num("ports", "Ports (MIMO)", undefined, "Antenna"),
    txt("connector", "Connectors", "Antenna", "e.g. 2× N female"),
    sel("ip", "IP rating", IP, "Protection"),
  ],
};

/** Subcategories that the specification templates add when missing (category, name, tag prefix). */
export const EXTRA_SUBCATEGORIES: [string, string, string][] = [["Electrical", "Battery", "BAT."], ["Network", "Antenna", "ANT."]];

/** Template fields merged into existing ones (existing keys keep their definition; new keys are appended). */
export function mergeSpecFields(existing: CustomFieldDef[], template: CustomFieldDef[]): CustomFieldDef[] {
  const have = new Set(existing.map((f) => f.key));
  return [...existing, ...template.filter((f) => !have.has(f.key))];
}

// ───────────────────────── values ─────────────────────────

export function specText(f: CustomFieldDef, v: SpecValue | undefined): string {
  if (v == null || v === "") return "";
  if (f.type === "bool") return v ? "Yes" : "No";
  if (f.type === "range" && Array.isArray(v)) {
    const [a, b] = v as [number | null, number | null];
    if (a == null && b == null) return "";
    return `${a ?? "?"}–${b ?? "?"}${f.unit ? ` ${f.unit}` : ""}`;
  }
  if (Array.isArray(v)) return v.join(", ");
  return `${v}${f.unit && typeof v === "number" ? ` ${f.unit}` : ""}`;
}
export const isEmptySpec = (v: SpecValue | undefined) => v == null || v === "" || (Array.isArray(v) && (v.length === 0 || v.every((x) => x == null)));

/** Short summary of the most selective specifications (first n filled fields). */
export function specSummary(p: Pick<Part, "custom">, fields: CustomFieldDef[], n = 4): string {
  return fields
    .filter((f) => f.type !== "certs" && f.key !== "listing" && !isEmptySpec(p.custom?.[f.key] as SpecValue))
    .slice(0, n)
    .map((f) => specText(f, p.custom[f.key] as SpecValue))
    .join(" · ");
}

// ───────────────────────── suggestions from descriptions ─────────────────────────

const n = (s: string | undefined) => (s == null ? null : Number(s.replace(",", ".")));
const first = (t: string, re: RegExp) => t.match(re) ?? undefined;

/**
 * Specification values suggested from a catalog description (and part number), for the subcategory's template keys.
 * Only patterns that are explicit in the text are used; results are suggestions to verify against the datasheet.
 */
export function suggestSpecs(fields: CustomFieldDef[], description: string, partNumber = ""): Record<string, SpecValue> {
  const T = ` ${description.toUpperCase().replace(/\s+/g, " ")} `;
  const keys = new Set(fields.map((f) => f.key));
  const out: Record<string, SpecValue> = {};
  const put = (k: string, v: SpecValue | null | undefined) => {
    if (v == null || v === "" || !keys.has(k) || (typeof v === "number" && !isFinite(v))) return;
    const f = fields.find((x) => x.key === k)!;
    if (f.type === "select" && typeof v === "string") {
      const opt = f.options?.find((o) => o.toUpperCase() === v.toUpperCase()) ?? f.options?.find((o) => o.toUpperCase().startsWith(v.toUpperCase()));
      if (!opt) return;
      out[k] = opt;
      return;
    }
    out[k] = v;
  };
  // poles
  const pol = first(T, /\b(\d)\s*-?\s*POLES?\b|\b(\d)P\b/);
  if (/\b1P\s*\+\s*N\b/.test(T)) put("poles", "1+N");
  else if (pol) put("poles", pol[1] ?? pol[2]);
  // trip curve
  const cur = first(T, /\b([BCDKZ])\s*-?\s*(?:CURVE|CHAR(?:ACTERISTIC)?)\b/);
  if (cur) put("tripCurve", cur[1]);
  // rated current: "IN: 16 A", "16A", "FUSE 5A"
  const amps = first(T, /\bIN:?\s*(\d+(?:[.,]\d+)?)\s*A\b/) ?? first(T, /(?<![\d.])(\d+(?:[.,]\d+)?)\s*A\b(?!H)/);
  if (amps) put("ratedCurrent", n(amps[1]));
  // voltages: "120(277)VAC" → 277; "230V AC/DC"; "600 VAC, 600VDC"
  const vac = first(T, /(\d{2,4})\s*(?:\((\d{2,4})\))?\s*V\s*AC\b|(\d{2,4})\s*VAC\b|UN AC:\s*(\d{2,4})\s*V/);
  if (vac) (put("ratedVoltageAc", n(vac[2] ?? vac[1] ?? vac[3] ?? vac[4])), put("nominalVoltage", n(vac[2] ?? vac[1] ?? vac[3] ?? vac[4])));
  const vdc = first(T, /(\d{2,4})\s*V\s*DC\b|(\d{2,4})\s*VDC\b/);
  if (vdc && keys.has("ratedVoltageDc")) put("ratedVoltageDc", n(vdc[1] ?? vdc[2]));
  const ka = first(T, /(\d+(?:[.,]\d+)?)\s*KA\b/);
  if (ka) (put("interrupting", n(ka[1])), put("sccr", n(ka[1])));
  // residual current device
  const ma = first(T, /(\d+)\s*MA\b/);
  if (ma) put("residual", ma[1]);
  const rcd = first(T, /TYPE\s+(AC|A|F|B)\b,/);
  if (rcd) put("rcdType", rcd[1]);
  if (/RCBO|RESIDUAL CURRENT BREAKER/.test(T)) put("protection", "IEC 61009-1 RCBO");
  const modes = ["L-N", "L-L", "L-PE", "N-PE"].filter((m) => T.includes(` ${m}`) || T.includes(`${m},`));
  if (modes.length) put("modes", modes);
  if (/SINGLE PHASE|1-PHASE|1 PHASE/.test(T)) put("inputPhases", "1-phase");
  if (/THREE PHASE|3-PHASE|3 PHASE/.test(T)) put("inputPhases", "3-phase");
  // fuses
  const fc = first(T, /CLASS\s+(CC|J|T|RK1|RK5|G)\b/);
  if (fc) put("fuseClass", fc[1]);
  if (/FAST ACTING|FAST-ACTING/.test(T)) put("speed", "Fast-acting");
  if (/TIME DELAY|TIME-DELAY|SLOW BLOW/.test(T)) put("speed", "Time-delay");
  if (/WITH INDICATOR|INDICATING/.test(T)) put("indicator", true);
  // surge protection
  const spd = first(T, /TYPE\s*([1-4])\s+SURGE|SURGE PROTECTION DEVICE[^,]*TYPE\s*([1-4])|\bT([1-3])\b/);
  if (spd) put("spdType", `IEC Class ${["", "I (T1)", "II (T2)", "III (T3)"][Number(spd[1] ?? spd[2] ?? spd[3])] ?? ""}`.trim());
  if (/TYPE 3 SURGE/.test(T)) put("spdType", "UL 1449 Type 3");
  // power supplies, UPS, inverters
  const inRange = first(T, /(\d{2,3})\s*-\s*(\d{2,3})\s*V\s*AC|(\d{2,3})-(\d{2,3})VAC/);
  if (inRange) {
    put("inputRangeAc", [n(inRange[1] ?? inRange[3]), n(inRange[2] ?? inRange[4])]);
    put("inputRange", [n(inRange[1] ?? inRange[3]), n(inRange[2] ?? inRange[4])]);
    put("inputType", "AC");
  }
  const inDc = first(T, /(\d{2,3})\s*-\s*(\d{2,3})\s*VDC\s*INPUT|(\d{2,3})-(\d{2,3})VACDC/);
  if (inDc) (put("inputRangeDc", [n(inDc[1] ?? inDc[3]), n(inDc[2] ?? inDc[4])]), put("inputRange", [n(inDc[1] ?? inDc[3]), n(inDc[2] ?? inDc[4])]));
  if (/\d+\s*-\s*\d+\s*VACDC|VAC\/DC|AC\/DC/.test(T) && keys.has("inputType")) put("inputType", "AC/DC");
  const outR = first(T, /OUTPUT\s*(\d{1,3})\s*-\s*(\d{1,3})\s*VDC/);
  if (outR) (put("outputRange", [n(outR[1]), n(outR[2])]), put("outputVoltage", n(outR[1])), put("outputType", "DC"));
  const out24 = first(T, /(\d{2})\s*VDC\s*OUT|OUT(?:PUT)?\s*(\d{2})\s*VDC|(\d{2})VDC OUTPUT|(\d{2})\s*VDC\s+(?:20A|\d+A)\s+OUTPUT/);
  if (out24 && !outR) (put("outputVoltage", n(out24[1] ?? out24[2] ?? out24[3] ?? out24[4])), put("outputType", "DC"));
  const watts = first(T, /(\d{2,5})\s*W\b(?!H)/);
  if (watts) (put("outputPower", n(watts[1])), put("continuousW", n(watts[1])));
  const outA = first(T, /(\d+(?:\.\d+)?)\s*A\b/);
  if (outA && keys.has("outputCurrent")) put("outputCurrent", n(outA[1]));
  const kva = first(T, /(\d+(?:\.\d+)?)\s*KVA\b/);
  if (kva) (put("capacityVa", (n(kva[1]) ?? 0) * 1000), put("continuousVa", (n(kva[1]) ?? 0) * 1000), put("kva", n(kva[1])));
  if (/LINE INTERACTIVE|LINE-INTERACTIVE/.test(T)) put("topology", "Line-interactive");
  if (/ONLINE|DOUBLE CONVERSION/.test(T)) put("topology", "Online double-conversion");
  if (/UPS/.test(T) && /24VDC OUT|24 ?VDC/.test(T) && keys.has("topology")) put("topology", "DC UPS");
  if (/SINE/.test(T)) put("waveform", "Pure sine");
  const outV = first(T, /(\d{3})\s*VAC OUTPUT/);
  if (outV) put("outputVoltage", n(outV[1]));
  if (/REDUNDANCY MODULE/.test(T)) (put("technology", /ACTIVE/.test(T) ? "Active (MOSFET)" : "Diode"), put("loadBalancing", /BALANCING/.test(T)));
  const rmIn = first(T, /(\d)X\s*(\d+)A IN/);
  if (rmIn) (put("inputs", n(rmIn[1])), put("inputCurrent", n(rmIn[2])));
  const rmOut = first(T, /(\d)X\s*(\d+)A OUT/);
  if (rmOut) put("outputCurrent", (n(rmOut[1]) ?? 1) * (n(rmOut[2]) ?? 0));
  if (/EXTENDED RUNTIME/.test(T)) put("extBattery", true);
  if (/NETWORK MANAGEMENT|SMARTSLOT/.test(T)) put("nmc", true);
  // terminal blocks
  if (/TERMINAL BLOCK/.test(T)) {
    put("connection", /PUSH-?IN|PT \d/.test(T) ? "Push-in" : /SPRING/.test(T) ? "Spring-cage" : "Screw");
    put("function", /-PE\b|PE,|GROUND/.test(T) ? "Ground (PE)" : /FUSE/.test(T) ? "Fuse" : /DISCONNECT|KNIFE/.test(T) ? "Disconnect / knife" : "Feed-through");
    const tv = first(T, /(\d+(?:[.,]\d+)?)\s*(KV|V)\s+(\d+)\s*A\b/);
    if (tv) (put("ratedVoltage", tv[2] === "KV" ? (n(tv[1]) ?? 0) * 1000 : n(tv[1])), put("ratedCurrent", n(tv[3])));
    put("color", /GREEN/.test(T) ? "Green/yellow (PE)" : /BLUE/.test(T) ? "Blue" : /GRAY|GREY/.test(T) ? "Gray" : "");
    if (/QUATTRO/.test(T)) put("positions", 4);
  }
  if (/PARTITION PLATE/.test(T)) put("accessory", "Partition plate");
  else if (/END CLAMP/.test(T)) put("accessory", "End clamp / end stop");
  else if (/END COVER/.test(T)) put("accessory", "End cover");
  const bridge = first(T, /BRIDGE,?\s*(\d+)\s*POS/);
  if (bridge) (put("positions", n(bridge[1])), put("color", /RED/.test(T) ? "Red" : /BLUE/.test(T) ? "Blue" : ""));
  const fits = first(T, /(?:PLATE|COVER),\s*D-([A-Z]+ ?[\d,]+(?:-QUATTRO)?)/);
  if (fits) put("fitsSeries", fits[1]);
  // network
  if (/LAYER 2\/3|L2\/3/.test(T)) put("layer", "L3");
  else if (/LAYER 2\b/.test(T)) put("layer", "L2");
  if (/UPOE/.test(T)) put("poe", "UPOE 60 W");
  else if (/802\.3BT/.test(T)) put("poe", "802.3bt (PoE++)");
  else if (/POE\+|802\.3AT/.test(T)) put("poe", "802.3at (PoE+)");
  else if (/802\.3AF/.test(T)) put("poe", "802.3af (PoE)");
  const budget = first(T, /MAXIMUM\s*(\d+)W LIMIT|POE BUDGET\s*(\d+)/);
  if (budget) put("poeBudget", n(budget[1] ?? budget[2]));
  if (/RUGGED/.test(T) && keys.has("formFactor")) put("formFactor", /RACK|424F|216F/.test(T + partNumber.toUpperCase()) ? "Rugged rack" : "DIN rail");
  if (/\bSFP\b/.test(T) && keys.has("standard")) {
    const rate = /10GE|10G\b|SFP\+/.test(T) ? "10 Gbps" : /1GE|1G\b|GIGABIT/.test(T) ? "1 Gbps" : "";
    put("rate", rate);
    const kind = first(T, /\b(SX|LX10|LX|ZX|BX)\b/);
    if (kind && rate === "1 Gbps") put("standard", `1000BASE-${kind[1]}`);
    if (kind && rate === "10 Gbps") put("standard", `10GBASE-${kind[1] === "SX" ? "SR" : "LR"}`);
    put("formFactor", /SFP\+/.test(T) ? "SFP+" : "SFP");
  }
  if (/\bSMF\b|SINGLE ?MODE|\bOS[12]\b/.test(T)) (put("fiber", "Single-mode (SMF)"), put("mode", "SM OS1/OS2"));
  else if (/\bMMF\b|MULTI ?MODE|\bOM[1-5]\b/.test(T)) put("fiber", "Multimode (MMF)");
  const reach = first(T, /(\d+)\s*KM\b/);
  if (reach) put("reach", n(reach[1]));
  if (/DUPLEX LC|LC DUPLEX/.test(T)) put("connector", /SFP/.test(T) ? "LC duplex" : "LC duplex");
  const tr = first(T, /-(\d+)C TO (\d+)C/);
  if (tr) put("tempOper", [-(n(tr[1]) ?? 0), n(tr[2])]);
  const trf = first(T, /(-?\d+)F?˚?\s*-\s*(\d+)F˚/);
  if (trf && !tr) put("tempOper", [Math.round((((n(trf[1]) ?? 32) - 32) * 5) / 9), Math.round((((n(trf[2]) ?? 32) - 32) * 5) / 9)]);
  // patch cables
  const cat = first(T, /\bCAT\s?(5E|6A|6)\b/);
  if (cat) (put("medium", `Copper Cat${cat[1].toLowerCase().replace("e", "e").replace("a", "A")}`), put("endA", "RJ45"), put("endB", "RJ45"));
  const om = first(T, /\b(OS2|OM[1-5])\b/);
  if (om && keys.has("medium")) put("medium", om[1] === "OS2" ? "Fiber SM OS2" : `Fiber MM ${om[1]}`);
  const lenFt = first(T, /(\d+(?:\.\d+)?)\s*(?:FT|FEET|')\b/);
  const lenM = first(T, /(?<![A-Z\d.])(\d+(?:\.\d+)?)\s*M\b(?![M/])/) ?? first(T, /(\d+(?:\.\d+)?)-METERS/);
  if (keys.has("length")) {
    if (lenFt) put("length", Math.round((n(lenFt[1]) ?? 0) * 0.3048 * 100) / 100);
    else if (lenM) put("length", n(lenM[1]));
  }
  if (/\bUTP\b/.test(T)) put("shield", "UTP");
  const conn = first(T, /\b(LC|SC|ST)\s*(UPC|APC)?\s*TO\s*(LC|SC|ST)\s*(UPC|APC)?/);
  if (conn) (put("endA", `${conn[1]}${conn[2] ? ` ${conn[2]}` : ""}`), put("endB", `${conn[3]}${conn[4] ? ` ${conn[4]}` : ""}`));
  const plugs = first(T, /([\d-]+[RP]|C1[349]|C2[01])\s*TO\s*([\d-]+[RP]|C1[349]|C2[01]|OPEN WIRE)/);
  if (plugs) (put("endA", plugs[1]), put("endB", plugs[2]));
  const awg = first(T, /(\d+)\s*AWG/);
  if (awg) put("gauge", `${awg[1]} AWG`);
  const mm2 = first(T, /(\d+(?:\.\d+)?)\s*MM2/);
  if (mm2) put("crossSection", n(mm2[1]));
  // enclosures and mechanical
  const ipr = first(T, /\bIP(\d{2})\b/);
  if (ipr) put("ip", `IP${ipr[1]}`);
  const nema = first(T, /NEMA\s*(4X|3R|12|4|1)\b/);
  if (nema) put("nema", nema[1]);
  if (/\bSS-?316\b|STAINLESS 316/.test(T)) put("material", "Stainless 316");
  else if (/\bSS-?304\b|STAINLESS/.test(T)) put("material", "Stainless 304");
  else if (/MILD STEEL/.test(T)) put("material", "Mild steel");
  else if (/\bSTEEL\b/.test(T)) put("material", "Carbon steel");
  if (/SINGLE-DOOR|SINGLE DOOR/.test(T)) put("door", "Single");
  const u = first(T, /\b(\d{1,2})U\b/);
  if (u) put("rackUnits", n(u[1]));
  if (/SLOTTED/.test(T)) put("ductType", /NARROW/.test(T) ? "Narrow slot" : "Wide slot");
  if (/\bPVC\b/.test(T)) put("material", "PVC");
  const cfm = first(T, /(\d+(?:\.\d+)?)(?:\/[\d.]+)?\s*CFM/);
  if (cfm) put("airflow", n(cfm[1]));
  const btu = first(T, /(\d+)\s*BTU/);
  if (btu) (put("cooling", n(btu[1])), put("hvacType", "Air conditioner"));
  const heat = first(T, /(\d+)\s*W HEATING/);
  if (heat) put("heating", n(heat[1]));
  if (/^ ?(HEATER|ENCLOSURE HEATER)/.test(T)) put("hvacType", "Heater");
  const ah = first(T, /(\d+(?:\.\d+)?)\s*AH\b/);
  if (ah) put("capacityAh", n(ah[1]));
  if (/CONFORMAL/.test(T)) put("conformal", true);
  if (/TCXO/.test(T)) put("oscillator", "TCXO");
  if (/OCXO/.test(T)) put("oscillator", "OCXO");
  if (/SATELLITE|GPS/.test(T) && keys.has("gnss")) put("gnss", ["GPS"]);
  if (/REDUNDANT|REDUNDTANT/.test(T) && keys.has("redundant")) put("redundant", true);
  if (/GPIC/.test(T)) put("gpic", true);
  const sb = first(T, /SBRIO-?(\d{4})/);
  if (sb) put("platform", `sbRIO-${sb[1]}`);
  if (/DIN-?MOUNT|DIN RAIL/.test(T) && keys.has("mounting") && fields.find((f) => f.key === "mounting")?.options?.includes("DIN rail")) put("mounting", "DIN rail");
  if (/FANLESS/.test(T)) put("fanless", true);
  const ram = first(T, /(\d+)\s*GB\s*(?:RAM|DDR)/);
  if (ram) put("ram", n(ram[1]));
  if (/DUAL REDUNDANT POWER SUPPLY|REDUNDANT POWER/.test(T)) put("redundantPsu", true);
  const psuW = first(T, /POWER SUPPLY,\s*(\d+)W/);
  if (psuW) put("psuW", n(psuW[1]));
  const lte = first(T, /LTE\s*CAT(?:EGORY)?\s*(\d+)/);
  if (lte) put("cellCat", `LTE Cat ${lte[1]}`);
  if (/\b5G\b/.test(T) && keys.has("cellCat") && !lte) put("cellCat", "5G NR");
  const dbi = first(T, /(\d+(?:\.\d+)?)\s*DBI/);
  if (dbi) put("gain", n(dbi[1]));
  if (/DIRECTIONAL/.test(T)) put("antType", "Directional / Yagi");
  if (/MIMO/.test(T) && keys.has("ports")) put("ports", 2);
  if (/\bN-CONNECTOR|N FEMALE|N-FEMALE/.test(T)) put("connector", "N female");
  return out;
}

/** Fill only the empty specification values of a part from its description (returns the merged custom map and what changed). */
export function fillSpecs(p: Pick<Part, "custom" | "description" | "partNumber">, fields: CustomFieldDef[]): { custom: Part["custom"]; filled: string[] } {
  const s = suggestSpecs(fields, p.description, p.partNumber);
  const custom = { ...(p.custom ?? {}) } as Record<string, SpecValue>;
  const filled: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (!isEmptySpec(custom[k])) continue;
    custom[k] = v;
    filled.push(k);
  }
  return { custom: custom as Part["custom"], filled };
}
