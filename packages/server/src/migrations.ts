import { DEFAULT_SUBCATEGORIES, EXTRA_SUBCATEGORIES, SPEC_TEMPLATES } from "@fpl/core";

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Ordered schema migrations. Each runs once, inside a transaction, and is recorded in schema_migrations. */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_initial",
    sql: `
CREATE TABLE sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'generic',
  headers       jsonb NOT NULL DEFAULT '[]',
  rows          jsonb NOT NULL DEFAULT '[]',
  row_count     integer NOT NULL DEFAULT 0,
  protocol_map  jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Conditioning profiles: the Excel -> JSON editor's saved tables (rules + data snapshot), optionally bound to a source.
CREATE TABLE profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  source_id    uuid REFERENCES sources(id) ON DELETE SET NULL,
  source_name  text,
  source_cols  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_source_idx ON profiles(source_id);

CREATE TABLE profile_versions (
  profile_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (profile_id, major, minor)
);

-- Rule sets: reusable column names + rules, applied to future tables column by column.
CREATE TABLE rule_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rule_set_versions (
  rule_set_id   uuid NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (rule_set_id, major, minor)
);

CREATE TABLE vlans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vlan        text NOT NULL DEFAULT '',
  name        text NOT NULL DEFAULT '',
  subnet      text NOT NULL DEFAULT '',
  gateway     text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT '',
  type        text NOT NULL DEFAULT '',
  protocol    text NOT NULL DEFAULT 'Modbus TCP',
  ip          text NOT NULL DEFAULT '',
  port        text NOT NULL DEFAULT '',
  address     text NOT NULL DEFAULT '',
  vlan_id     uuid REFERENCES vlans(id) ON DELETE SET NULL,
  source_id   uuid REFERENCES sources(id) ON DELETE SET NULL,
  mqtt_topic  text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
`,
  },
  {
    id: "002_dataflow",
    sql: `
-- Devices: serial number; protocol/point list now live on connections (old columns kept, unused).
ALTER TABLE devices ADD COLUMN serial text NOT NULL DEFAULT '';

CREATE TABLE protocols (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  alias            text NOT NULL DEFAULT '',
  df_alias         text NOT NULL DEFAULT '',
  parent_id        uuid REFERENCES protocols(id) ON DELETE SET NULL,
  default_port     text NOT NULL DEFAULT '',
  point_list_kind  text NOT NULL DEFAULT '',
  style            jsonb NOT NULL DEFAULT '{}',
  sort             integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

WITH mb AS (
  INSERT INTO protocols(name, alias, df_alias, default_port, point_list_kind, style, sort)
  VALUES ('Modbus', 'Modbus', 'MB', '502', 'modbus', '{"color":"#0b6e69","width":2,"dash":"solid","startHead":"none","endHead":"arrow","scale":1,"opacity":1}'::jsonb, 10) RETURNING id
)
INSERT INTO protocols(name, alias, df_alias, parent_id, default_port, point_list_kind, style, sort)
SELECT 'Modbus TCP', 'ModbusTCP', 'MBTCP', id, '502', '', '{"color":"#0b6e69","width":2,"dash":"solid","startHead":"none","endHead":"arrow","scale":1,"opacity":1}'::jsonb, 11 FROM mb
UNION ALL
SELECT 'Modbus Serial', 'ModbusSerial', 'MBRTU', id, '', '', '{"color":"#0b6e69","width":2,"dash":"dashed","startHead":"none","endHead":"arrow","scale":1,"opacity":1}'::jsonb, 12 FROM mb;

INSERT INTO protocols(name, alias, df_alias, default_port, point_list_kind, style, sort) VALUES
  ('MQTT', 'MQTT', 'MQTT', '1883', '', '{"color":"#7a3e9d","width":2,"dash":"dashed","startHead":"dot","endHead":"arrow","scale":1,"opacity":1}'::jsonb, 20),
  ('DNP3', 'DNP3', 'DNP3', '20000', 'dnp3', '{"color":"#b0490f","width":2,"dash":"solid","startHead":"dot","endHead":"arrow","scale":1,"opacity":1}'::jsonb, 30),
  ('IEC 60870-5-104', 'IEC104', '104', '2404', 'iec104', '{"color":"#1d5fa8","width":2,"dash":"solid","startHead":"none","endHead":"arrow","scale":1,"opacity":1}'::jsonb, 40);

-- Directional communication: from (client / master / publisher) -> to (server / outstation / broker).
CREATE TABLE connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_device_id   uuid REFERENCES devices(id) ON DELETE CASCADE,
  to_device_id     uuid REFERENCES devices(id) ON DELETE CASCADE,
  protocol_id      uuid REFERENCES protocols(id) ON DELETE RESTRICT,
  port             text NOT NULL DEFAULT '',
  address          text NOT NULL DEFAULT '',
  source_id        uuid REFERENCES sources(id) ON DELETE SET NULL,
  topic            text NOT NULL DEFAULT '',
  bidirectional    boolean NOT NULL DEFAULT false,
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX connections_from_idx ON connections(from_device_id);
CREATE INDEX connections_to_idx ON connections(to_device_id);

-- Data flow diagram layouts, saved as major.minor versions.
CREATE TABLE diagrams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE diagram_versions (
  diagram_id    uuid NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (diagram_id, major, minor)
);
`,
  },
  {
    id: "003_services_paths",
    sql: `
-- Distinct services/solutions in a project (Substation, EMS, QSE, ISO, SCADA, DAS, PLC ...), each with its contractor.
CREATE TABLE services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT '',
  contractor  text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  enabled     boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE firewalls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL DEFAULT '',
  service_id    uuid REFERENCES services(id) ON DELETE SET NULL,
  vendor_model  text NOT NULL DEFAULT '',
  mgmt_ip       text NOT NULL DEFAULT '',
  serial        text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  enabled       boolean NOT NULL DEFAULT true,
  sort          integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE vlans
  ADD COLUMN firewall_id uuid REFERENCES firewalls(id) ON DELETE SET NULL,
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN sort integer NOT NULL DEFAULT 0;

ALTER TABLE devices
  ADD COLUMN service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN sort integer NOT NULL DEFAULT 0;

-- Client/server ports and the hop-by-hop path between them.
ALTER TABLE connections
  ADD COLUMN client_port text NOT NULL DEFAULT '',
  ADD COLUMN server_port text NOT NULL DEFAULT '',
  ADD COLUMN path jsonb NOT NULL DEFAULT '[]';

-- Saved UI states (e.g. Data flow column layouts), shared so anyone can load a named workflow.
CREATE TABLE ui_presets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL,
  name        text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, name)
);
`,
  },
  {
    id: "004_device_categories",
    sql: `
-- Editable device categories, used as filters in Network and Data flow.
CREATE TABLE device_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT '',
  color       text NOT NULL DEFAULT '#6b7782',
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO device_categories(name, color, sort) VALUES
  ('Network', '#2f7f8a', 0),
  ('Operational', '#c46a1f', 1),
  ('Workstations', '#5b4fc4', 2),
  ('Sensors', '#3d8b3d', 3),
  ('Others', '#6b7782', 4);

ALTER TABLE devices ADD COLUMN category_id uuid REFERENCES device_categories(id) ON DELETE SET NULL;

-- Best-effort starting point from the free-text device type; anything unrecognised stays blank.
UPDATE devices SET category_id = (SELECT id FROM device_categories WHERE name = 'Network')
 WHERE type ~* '(switch|router|gateway|firewall|\\mns\\M|radio|modem)';
UPDATE devices SET category_id = (SELECT id FROM device_categories WHERE name = 'Workstations')
 WHERE category_id IS NULL AND type ~* '(hmi|workstation|laptop|\\mpc\\M|server|historian)';
UPDATE devices SET category_id = (SELECT id FROM device_categories WHERE name = 'Sensors')
 WHERE category_id IS NULL AND type ~* '(meter|sensor|met station|weather|irradiance|\\mct\\M|\\mpt\\M)';
`,
  },
  {
    id: "005_diagram_colors_endnet",
    sql: `
-- Service colour for the Data flow diagram ('' = automatic palette).
ALTER TABLE services ADD COLUMN color text NOT NULL DEFAULT '';

-- Optional per-connection VLAN / IP at each end (a device may use different ports on different segments).
ALTER TABLE connections
  ADD COLUMN end_net boolean NOT NULL DEFAULT false,
  ADD COLUMN client_ip text NOT NULL DEFAULT '',
  ADD COLUMN client_vlan_id uuid REFERENCES vlans(id) ON DELETE SET NULL,
  ADD COLUMN server_ip text NOT NULL DEFAULT '',
  ADD COLUMN server_vlan_id uuid REFERENCES vlans(id) ON DELETE SET NULL;
`,
  },
  {
    id: "006_device_model",
    sql: `
-- Device make / model, optionally shown in the Data flow diagram.
ALTER TABLE devices ADD COLUMN model text NOT NULL DEFAULT '';
`,
  },
  {
    id: "007_snapshots",
    sql: `
-- Versioned snapshots (major.minor) of the whole connection list and of the whole network (services, firewalls, VLANs, devices, categories).
CREATE TABLE dataflow_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dataflow_snapshot_versions (
  snapshot_id          uuid NOT NULL REFERENCES dataflow_snapshots(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, major, minor)
);
CREATE TABLE network_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE network_snapshot_versions (
  snapshot_id          uuid NOT NULL REFERENCES network_snapshots(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, major, minor)
);
`,
  },
  {
    id: "008_pointlist_builder",
    sql: `
-- Point list builder: pasted input tables and build templates (rules), each saved as major.minor versions.
CREATE TABLE pl_inputs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pl_input_versions (
  input_id      uuid NOT NULL REFERENCES pl_inputs(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (input_id, major, minor)
);
CREATE TABLE pl_builds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pl_build_versions (
  build_id      uuid NOT NULL REFERENCES pl_builds(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (build_id, major, minor)
);
`,
  },
  {
    id: "009_unit_sets",
    sql: `
-- Unit conditioning sets for the point list builder (variable -> accepted units -> desired unit), saved as major.minor versions.
CREATE TABLE unit_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE unit_set_versions (
  set_id        uuid NOT NULL REFERENCES unit_sets(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (set_id, major, minor)
);
`,
  },
  {
    id: "010_datatype_sets",
    sql: `
-- Standard data type sets for the point list builder (protocol independent), saved as major.minor versions.
CREATE TABLE datatype_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE datatype_set_versions (
  set_id        uuid NOT NULL REFERENCES datatype_sets(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (set_id, major, minor)
);
`,
  },
  {
    id: "011_json_editor",
    sql: `
-- JSON editor: raw sources (JSON documents, lookup tables), array selections and conditioning rules, each versioned independently.
CREATE TABLE json_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE json_source_versions (
  source_id        uuid NOT NULL REFERENCES json_sources(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (source_id, major, minor)
);
CREATE TABLE json_selections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE json_selection_versions (
  selection_id        uuid NOT NULL REFERENCES json_selections(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (selection_id, major, minor)
);
CREATE TABLE json_conds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE json_cond_versions (
  cond_id        uuid NOT NULL REFERENCES json_conds(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (cond_id, major, minor)
);
`,
  },
  {
    id: "012_py_libs",
    sql: `
-- Python function libraries (def's used by Expression / Python code rules), saved as major.minor versions.
CREATE TABLE py_libs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE py_lib_versions (
  lib_id        uuid NOT NULL REFERENCES py_libs(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (lib_id, major, minor)
);
`,
  },
  {
    id: "013_departments_instances",
    sql: `
-- Departments (top-level, parent_id NULL) and folders nested under them; shared by the whole app.
CREATE TABLE app_folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES app_folders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort        integer NOT NULL DEFAULT 0,
  options     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_folders_parent ON app_folders(parent_id);
INSERT INTO app_folders(name, sort, options) VALUES
  ('Engineering', 0, '{"color": "#0b6e69"}'),
  ('Labview', 1, '{"color": "#9a5800"}'),
  ('WebUI', 2, '{"color": "#3b5bdb"}');

-- JSON editor instances: one source document with several outputs (conditionings), versioned as a whole.
CREATE TABLE json_instances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  folder_id   uuid REFERENCES app_folders(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX json_instances_folder ON json_instances(folder_id);
CREATE TABLE json_instance_versions (
  instance_id   uuid NOT NULL REFERENCES json_instances(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (instance_id, major, minor)
);
`,
  },
  {
    id: "014_conds_instance",
    sql: `
-- A saved conditioning set may belong to a JSON editor instance (its output is computed on the instance document).
-- Deleting the instance keeps its conditionings as library templates.
ALTER TABLE json_conds ADD COLUMN instance_id uuid REFERENCES json_instances(id) ON DELETE SET NULL;
CREATE INDEX json_conds_instance ON json_conds(instance_id);
`,
  },
  {
    id: "015_bom",
    sql: `
-- Parts & BOM module: subcategory catalog (with per-subcategory custom fields and port types), master parts,
-- part documents (uploaded files or links), assembly templates and project BOMs (both saved as major.minor versions).
CREATE TABLE part_subcats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    text NOT NULL DEFAULT '',
  name        text NOT NULL DEFAULT '',
  tag_prefix  text NOT NULL DEFAULT '',
  fields      jsonb NOT NULL DEFAULT '[]',
  port_types  jsonb NOT NULL DEFAULT '[]',
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO part_subcats(category, name, tag_prefix, sort) VALUES
${DEFAULT_SUBCATEGORIES.map(([c, n, t], i) => `  (${q(c)}, ${q(n)}, ${q(t)}, ${i})`).join(",\n")};

CREATE TABLE parts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category        text NOT NULL DEFAULT '',
  subcategory_id  uuid REFERENCES part_subcats(id) ON DELETE SET NULL,
  manufacturer    text NOT NULL DEFAULT '',
  series          text NOT NULL DEFAULT '',
  part_number     text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  vendor          text NOT NULL DEFAULT '',
  vendor_contact  text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  tag_prefix      text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'active',
  stock           numeric,
  on_order        numeric,
  price           numeric,
  mech            jsonb NOT NULL DEFAULT '{}',
  power_in        jsonb,
  power_out       jsonb,
  ports           jsonb NOT NULL DEFAULT '[]',
  custom          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parts_pn ON parts (upper(part_number));
CREATE INDEX parts_subcat ON parts (subcategory_id);

CREATE TABLE part_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id     uuid NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'Datasheet',
  title       text NOT NULL DEFAULT '',
  url         text NOT NULL DEFAULT '',
  file_name   text NOT NULL DEFAULT '',
  mime        text NOT NULL DEFAULT '',
  size        integer NOT NULL DEFAULT 0,
  data        bytea,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX part_docs_part ON part_docs (part_id);

CREATE TABLE bom_assemblies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'OTHER',
  code        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bom_assembly_versions (
  assembly_id  uuid NOT NULL REFERENCES bom_assemblies(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (assembly_id, major, minor)
);

CREATE TABLE bom_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bom_project_versions (
  project_id  uuid NOT NULL REFERENCES bom_projects(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (project_id, major, minor)
);
`,
  },
  {
    id: "016_part_views",
    sql: `
-- 2D views of a part (front, back, top, bottom, left, right): SVG markup or an image data URL, with the drawing's extents in mm.
CREATE TABLE part_views (
  part_id     uuid NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  view        text NOT NULL CHECK (view IN ('front', 'back', 'top', 'bottom', 'left', 'right')),
  kind        text NOT NULL DEFAULT 'svg' CHECK (kind IN ('svg', 'image')),
  content     text NOT NULL,
  w_mm        numeric,
  h_mm        numeric,
  source      text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (part_id, view)
);
`,
  },
  {
    id: "017_specs",
    sql: `
-- Subcategory specifications: standard selection / sizing criteria per device type (filled only where a subcategory has
-- no fields yet), two more subcategories, and documents tied to what they back (e.g. "cert:UL 489" certificates).
ALTER TABLE part_docs ADD COLUMN ref text NOT NULL DEFAULT '';
INSERT INTO part_subcats(category, name, tag_prefix, sort)
SELECT v.category, v.name, v.tag_prefix, (SELECT COALESCE(MAX(sort), 0) FROM part_subcats) + v.n
  FROM (VALUES ${EXTRA_SUBCATEGORIES.map(([c, n, t], i) => `(${q(c)}, ${q(n)}, ${q(t)}, ${i + 1})`).join(", ")}) AS v(category, name, tag_prefix, n)
 WHERE NOT EXISTS (SELECT 1 FROM part_subcats s WHERE lower(s.name) = lower(v.name));
${Object.entries(SPEC_TEMPLATES).map(([name, f]) => `UPDATE part_subcats SET fields = ${q(JSON.stringify(f))}::jsonb WHERE lower(name) = lower(${q(name)}) AND fields = '[]'::jsonb;`).join("\n")}
`,
  },
  {
    id: "018_naming_layouts",
    sql: `
-- Custom prefix per part document; SKU and configuration codes per part; document naming standards; project part-number
-- formats; rack and FNE layouts (own versions, BOM as overlay).
ALTER TABLE part_docs ADD COLUMN prefix text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN sku text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN config_code1 text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN config_code2 text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN config_code3 text NOT NULL DEFAULT '';
CREATE TABLE pn_formats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pn_format_versions (
  format_id     uuid NOT NULL REFERENCES pn_formats(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (format_id, major, minor)
);
CREATE TABLE doc_namings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE doc_naming_versions (
  naming_id  uuid NOT NULL REFERENCES doc_namings(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (naming_id, major, minor)
);
CREATE TABLE mech_racks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mech_rack_versions (
  layout_id  uuid NOT NULL REFERENCES mech_racks(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (layout_id, major, minor)
);
CREATE TABLE mech_fnes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mech_fne_versions (
  layout_id  uuid NOT NULL REFERENCES mech_fnes(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (layout_id, major, minor)
);
`,
  },
  {
    id: "019_desc_suffix",
    sql: `
-- Custom suffix per part document ({suffix} in naming standards); assembly-description formats (left / right text of
-- devices in cabinet layouts).
ALTER TABLE part_docs ADD COLUMN suffix text NOT NULL DEFAULT '';
CREATE TABLE asm_desc_formats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE asm_desc_format_versions (
  format_id     uuid NOT NULL REFERENCES asm_desc_formats(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (format_id, major, minor)
);
`,
  },
  {
    id: "020_oem_desc",
    sql: `
-- Long OEM description (catalog / flyer / datasheet text) kept apart from the BOM description.
ALTER TABLE parts ADD COLUMN oem_desc text NOT NULL DEFAULT '';
`,
  },
  {
    id: "021_sort_formats",
    sql: `
-- Output sort orders (Python sort key) for the part list of Parts & BOM outputs.
CREATE TABLE sort_formats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sort_format_versions (
  format_id     uuid NOT NULL REFERENCES sort_formats(id) ON DELETE CASCADE,
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 1),
  stamp         text NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  notes         text NOT NULL DEFAULT '',
  update_notes  text NOT NULL DEFAULT '',
  meta          jsonb NOT NULL DEFAULT '{}',
  data          jsonb NOT NULL,
  PRIMARY KEY (format_id, major, minor)
);
`,
  },
  {
    id: "022_asm_folders",
    sql: `
-- Template library directory: folder path of each assembly template, plus empty folders.
ALTER TABLE bom_assemblies ADD COLUMN IF NOT EXISTS folder text NOT NULL DEFAULT '';
CREATE TABLE asm_folders (
  path        text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "023_storage_temp",
    sql: `
-- Storage temperature (min / max, °C) right after the operating temperature of every subcategory that has one.
UPDATE part_subcats s SET fields = (
  SELECT jsonb_agg(x.e ORDER BY x.o) FROM (
    SELECT t.e, t.o * 2 AS o FROM jsonb_array_elements(s.fields) WITH ORDINALITY t(e, o)
    UNION ALL
    SELECT '{"key":"tempStorage","label":"Storage temperature","type":"range","unit":"°C","group":"Environment","help":"Non-operating / storage temperature range (min – max)"}'::jsonb,
           (SELECT u.o * 2 + 1 FROM jsonb_array_elements(s.fields) WITH ORDINALITY u(e, o) WHERE u.e->>'key' = 'tempOper' LIMIT 1)
  ) x
)
WHERE s.fields @> '[{"key":"tempOper"}]'::jsonb AND NOT s.fields @> '[{"key":"tempStorage"}]'::jsonb;
`,
  },
  {
    id: "024_doc_active_year",
    sql: `
-- Part documents: active flag (inactive documents are kept but left out of outputs) and year published.
ALTER TABLE part_docs ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE part_docs ADD COLUMN year integer CHECK (year IS NULL OR (year BETWEEN 1900 AND 2200));
`,
  },
  {
    id: "025_part_cad",
    sql: `
-- Last STEP model imported per part and its orientation (model axis up / out of the front), so the six 2D views can be
-- re-drawn when the part is rotated (Edit part -> Dimensions & 2D views).
CREATE TABLE part_cad (
  part_id    uuid PRIMARY KEY REFERENCES parts(id) ON DELETE CASCADE,
  file_name  text NOT NULL,
  data       bytea NOT NULL,
  up         text NOT NULL DEFAULT '+Z' CHECK (up IN ('+X','-X','+Y','-Y','+Z','-Z')),
  front      text NOT NULL DEFAULT '-Y' CHECK (front IN ('+X','-X','+Y','-Y','+Z','-Z')),
  -- File uploaded to generate the views (a .stp, or a .zip holding the .stp and its .txt), and that .txt.
  source_name text NOT NULL DEFAULT '',
  txt_name   text,
  txt        text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "026_projects",
    sql: `
-- Projects. Every project uses all the tools, but its content is its own: the tables below are per project.
-- Shared by every project: master parts (parts, part_subcats, part_docs, part_views, part_cad), naming standards,
-- project PN / assembly-description / sort formats, assembly templates (bom_assemblies, asm_folders), table formatting
-- (ui_presets), unit sets, data-type sets, rule sets, device categories, protocols, Python function libraries, JSON
-- editor departments / folders and library templates (json_sources, json_selections, json_conds not attached to an
-- instance).
--
-- How: each per-project table <t> is renamed <t>_all and gets app_project_id; a view <t> shows the current project's
-- rows only (WITH CHECK OPTION; inserts get the current project by default), so the queries of the routes are unchanged.
-- The current project is the session setting fpl.project, set on every pooled connection from the request (db.ts).
-- Version tables of per-project items are filtered through their parent view.
--
-- FOR FUTURE MIGRATIONS: alter the <t>_all tables (never the views), then run SELECT fpl_project_views(); to rebuild
-- every view with the new columns. Data changes done in migrations must target <t>_all (the views show nothing there).
CREATE TABLE app_projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  alias        text NOT NULL DEFAULT '',
  country      text NOT NULL DEFAULT '',
  state        text NOT NULL DEFAULT '',
  contractor   text NOT NULL DEFAULT '',
  end_user     text NOT NULL DEFAULT '',
  iso          text NOT NULL DEFAULT '',
  dispatcher   text NOT NULL DEFAULT '',
  qse          text NOT NULL DEFAULT '',
  kw           numeric,
  kwh          numeric,
  pcs_oem      text NOT NULL DEFAULT '',
  bess_oem     text NOT NULL DEFAULT '',
  stage        text NOT NULL DEFAULT '',
  active_state text NOT NULL DEFAULT 'Active',
  notes        text NOT NULL DEFAULT '',
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Everything created so far goes into a first project (named after the most recent project BOM).
INSERT INTO app_projects(name, last_used_at)
VALUES (COALESCE((SELECT NULLIF(trim(name), '') FROM bom_projects ORDER BY updated_at DESC LIMIT 1), 'Project 1'), now());

CREATE FUNCTION fpl_project() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('fpl.project', true), '')::uuid $$;

ALTER TABLE sources RENAME TO sources_all;
ALTER TABLE profiles RENAME TO profiles_all;
ALTER TABLE pl_inputs RENAME TO pl_inputs_all;
ALTER TABLE pl_builds RENAME TO pl_builds_all;
ALTER TABLE services RENAME TO services_all;
ALTER TABLE firewalls RENAME TO firewalls_all;
ALTER TABLE vlans RENAME TO vlans_all;
ALTER TABLE devices RENAME TO devices_all;
ALTER TABLE connections RENAME TO connections_all;
ALTER TABLE diagrams RENAME TO diagrams_all;
ALTER TABLE dataflow_snapshots RENAME TO dataflow_snapshots_all;
ALTER TABLE network_snapshots RENAME TO network_snapshots_all;
ALTER TABLE bom_projects RENAME TO bom_projects_all;
ALTER TABLE mech_racks RENAME TO mech_racks_all;
ALTER TABLE mech_fnes RENAME TO mech_fnes_all;
ALTER TABLE json_instances RENAME TO json_instances_all;
ALTER TABLE profile_versions RENAME TO profile_versions_all;
ALTER TABLE diagram_versions RENAME TO diagram_versions_all;
ALTER TABLE dataflow_snapshot_versions RENAME TO dataflow_snapshot_versions_all;
ALTER TABLE network_snapshot_versions RENAME TO network_snapshot_versions_all;
ALTER TABLE pl_input_versions RENAME TO pl_input_versions_all;
ALTER TABLE pl_build_versions RENAME TO pl_build_versions_all;
ALTER TABLE json_instance_versions RENAME TO json_instance_versions_all;
ALTER TABLE bom_project_versions RENAME TO bom_project_versions_all;
ALTER TABLE mech_rack_versions RENAME TO mech_rack_versions_all;
ALTER TABLE mech_fne_versions RENAME TO mech_fne_versions_all;
ALTER TABLE json_conds RENAME TO json_conds_all;
ALTER TABLE json_cond_versions RENAME TO json_cond_versions_all;

ALTER TABLE sources_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE sources_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE sources_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX sources_all_project_idx ON sources_all(app_project_id);
ALTER TABLE profiles_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE profiles_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE profiles_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX profiles_all_project_idx ON profiles_all(app_project_id);
ALTER TABLE pl_inputs_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE pl_inputs_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE pl_inputs_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX pl_inputs_all_project_idx ON pl_inputs_all(app_project_id);
ALTER TABLE pl_builds_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE pl_builds_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE pl_builds_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX pl_builds_all_project_idx ON pl_builds_all(app_project_id);
ALTER TABLE services_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE services_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE services_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX services_all_project_idx ON services_all(app_project_id);
ALTER TABLE firewalls_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE firewalls_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE firewalls_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX firewalls_all_project_idx ON firewalls_all(app_project_id);
ALTER TABLE vlans_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE vlans_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE vlans_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX vlans_all_project_idx ON vlans_all(app_project_id);
ALTER TABLE devices_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE devices_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE devices_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX devices_all_project_idx ON devices_all(app_project_id);
ALTER TABLE connections_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE connections_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE connections_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX connections_all_project_idx ON connections_all(app_project_id);
ALTER TABLE diagrams_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE diagrams_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE diagrams_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX diagrams_all_project_idx ON diagrams_all(app_project_id);
ALTER TABLE dataflow_snapshots_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE dataflow_snapshots_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE dataflow_snapshots_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX dataflow_snapshots_all_project_idx ON dataflow_snapshots_all(app_project_id);
ALTER TABLE network_snapshots_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE network_snapshots_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE network_snapshots_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX network_snapshots_all_project_idx ON network_snapshots_all(app_project_id);
ALTER TABLE bom_projects_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE bom_projects_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE bom_projects_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX bom_projects_all_project_idx ON bom_projects_all(app_project_id);
ALTER TABLE mech_racks_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE mech_racks_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE mech_racks_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX mech_racks_all_project_idx ON mech_racks_all(app_project_id);
ALTER TABLE mech_fnes_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE mech_fnes_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE mech_fnes_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX mech_fnes_all_project_idx ON mech_fnes_all(app_project_id);
ALTER TABLE json_instances_all ADD COLUMN app_project_id uuid REFERENCES app_projects(id) ON DELETE CASCADE;
UPDATE json_instances_all SET app_project_id = (SELECT id FROM app_projects ORDER BY created_at LIMIT 1);
ALTER TABLE json_instances_all ALTER COLUMN app_project_id SET NOT NULL, ALTER COLUMN app_project_id SET DEFAULT fpl_project();
CREATE INDEX json_instances_all_project_idx ON json_instances_all(app_project_id);

CREATE TABLE fpl_scoped (name text PRIMARY KEY, kind text NOT NULL, parent text, fk text, cond text, ord int NOT NULL);
INSERT INTO fpl_scoped(name, kind, parent, fk, cond, ord) VALUES
('sources', 'project', NULL, NULL, NULL, 1),\n('profiles', 'project', NULL, NULL, NULL, 2),\n('pl_inputs', 'project', NULL, NULL, NULL, 3),\n('pl_builds', 'project', NULL, NULL, NULL, 4),\n('services', 'project', NULL, NULL, NULL, 5),\n('firewalls', 'project', NULL, NULL, NULL, 6),\n('vlans', 'project', NULL, NULL, NULL, 7),\n('devices', 'project', NULL, NULL, NULL, 8),\n('connections', 'project', NULL, NULL, NULL, 9),\n('diagrams', 'project', NULL, NULL, NULL, 10),\n('dataflow_snapshots', 'project', NULL, NULL, NULL, 11),\n('network_snapshots', 'project', NULL, NULL, NULL, 12),\n('bom_projects', 'project', NULL, NULL, NULL, 13),\n('mech_racks', 'project', NULL, NULL, NULL, 14),\n('mech_fnes', 'project', NULL, NULL, NULL, 15),\n('json_instances', 'project', NULL, NULL, NULL, 16),\n('profile_versions', 'child', 'profiles', 'profile_id', NULL, 116),\n('diagram_versions', 'child', 'diagrams', 'diagram_id', NULL, 117),\n('dataflow_snapshot_versions', 'child', 'dataflow_snapshots', 'snapshot_id', NULL, 118),\n('network_snapshot_versions', 'child', 'network_snapshots', 'snapshot_id', NULL, 119),\n('pl_input_versions', 'child', 'pl_inputs', 'input_id', NULL, 120),\n('pl_build_versions', 'child', 'pl_builds', 'build_id', NULL, 121),\n('json_instance_versions', 'child', 'json_instances', 'instance_id', NULL, 122),\n('bom_project_versions', 'child', 'bom_projects', 'project_id', NULL, 123),\n('mech_rack_versions', 'child', 'mech_racks', 'layout_id', NULL, 124),\n('mech_fne_versions', 'child', 'mech_fnes', 'layout_id', NULL, 125),\n('json_conds', 'filter', NULL, NULL, 'instance_id IS NULL OR instance_id IN (SELECT id FROM json_instances)', 200),\n('json_cond_versions', 'child', 'json_conds', 'cond_id', NULL, 201);

-- (Re)create every per-project view from fpl_scoped (run after altering a <t>_all table).
CREATE FUNCTION fpl_project_views() RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM fpl_scoped ORDER BY ord DESC LOOP
    EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', r.name);
  END LOOP;
  FOR r IN SELECT * FROM fpl_scoped ORDER BY ord LOOP
    IF r.kind = 'project' THEN
      EXECUTE format('CREATE VIEW %I AS SELECT * FROM %I WHERE app_project_id = fpl_project() WITH CASCADED CHECK OPTION', r.name, r.name || '_all');
      EXECUTE format('ALTER VIEW %I ALTER COLUMN app_project_id SET DEFAULT fpl_project()', r.name);
    ELSIF r.kind = 'child' THEN
      EXECUTE format('CREATE VIEW %I AS SELECT * FROM %I v WHERE v.%I IN (SELECT id FROM %I) WITH CASCADED CHECK OPTION', r.name, r.name || '_all', r.fk, r.parent);
    ELSE
      EXECUTE format('CREATE VIEW %I AS SELECT * FROM %I WHERE %s WITH CASCADED CHECK OPTION', r.name, r.name || '_all', r.cond);
    END IF;
  END LOOP;
END $$;
SELECT fpl_project_views();
`,
  },
  {
    id: "027_effective_pn",
    sql: `
-- Effective part number (Edit part -> Configuration & standards -> Configuration): a Python expression over the part's
-- fields (empty = the part number) and its result, computed by the server whenever the part is saved. Shared (master parts).
ALTER TABLE parts ADD COLUMN eff_pn_expr text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN eff_pn text NOT NULL DEFAULT '';
UPDATE parts SET eff_pn = part_number;
`,
  },
  {
    id: "028_effective_desc",
    sql: `
-- Effective description (Python, empty = the description) and its result; price of the custom configuration; the
-- "Apply custom PN / DESC" switch; saved custom PN / DESC versions of the part (JSON) and the one loaded.
ALTER TABLE parts ADD COLUMN eff_desc_expr text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN eff_desc text NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN eff_price numeric;
ALTER TABLE parts ADD COLUMN eff_apply boolean NOT NULL DEFAULT false;
ALTER TABLE parts ADD COLUMN eff_versions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE parts ADD COLUMN eff_version_id text;
UPDATE parts SET eff_desc = description, eff_apply = (eff_pn_expr <> '');
`,
  },
  {
    id: "029_series_docs",
    sql: `
-- Product-series documents: a document belongs to one part (part_id) or to a manufacturer + product series (series_key);
-- every part of that manufacturer and series lists it and puts it in its outputs. A product series is unique to its
-- manufacturer: the key is the manufacturer and the series, letters and digits only, case-insensitive.
CREATE FUNCTION fpl_series_key(mfr text, series text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN coalesce(trim(series), '') = '' THEN NULL
    ELSE lower(regexp_replace(coalesce(mfr, ''), '[^A-Za-z0-9]+', '', 'g')) || '|' || lower(regexp_replace(series, '[^A-Za-z0-9]+', '', 'g')) END $$;
ALTER TABLE part_docs ALTER COLUMN part_id DROP NOT NULL;
ALTER TABLE part_docs ADD COLUMN series_key text;
ALTER TABLE part_docs ADD COLUMN series_mfr text NOT NULL DEFAULT '';
ALTER TABLE part_docs ADD COLUMN series_name text NOT NULL DEFAULT '';
ALTER TABLE part_docs ADD CONSTRAINT part_docs_owner CHECK ((part_id IS NULL) <> (series_key IS NULL));
CREATE INDEX part_docs_series_idx ON part_docs(series_key);
`,
  },
  {
    id: "030_doc_approval_id",
    sql: `
-- Approval ID of a certificate (e.g. UL file / CSA master contract / certificate number): Edit part → Certification.
ALTER TABLE part_docs ADD COLUMN approval_id text NOT NULL DEFAULT '';
`,
  },
  {
    id: "031_doc_cert_name",
    sql: `
-- Certificate name (e.g. "Environmental Confirmation", "UL Listing"), left of the title in Edit part → Certification.
ALTER TABLE part_docs ADD COLUMN cert_name text NOT NULL DEFAULT '';
`,
  },
];
