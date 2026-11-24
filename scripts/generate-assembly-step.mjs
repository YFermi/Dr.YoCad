// Generates scripts/seed-models/gearbox-assembly.step: a small STEP AP214
// assembly with a nested sub-assembly and a part used twice, no colors.
//
//   GEARBOX (assembly)
//   ├── HOUSING          120 x 20 x 80 box at (0, 0, 0)
//   ├── SHAFT_ASSY       (sub-assembly) at (0, 40, 0)
//   │   ├── SHAFT        100 x 10 x 10 box at (0, 0, 0)
//   │   ├── GEAR         30 x 30 x 8 box at (20, 0, 0)
//   │   └── GEAR         same product, second instance at (-20, 0, 0)
//   └── COVER            120 x 4 x 80 box at (0, 25, 0)
//
// 5 leaf instances, 4 distinct part products, 2 assembly levels.
// usage: node scripts/generate-assembly-step.mjs [outFile]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out =
  process.argv[2] ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-models', 'gearbox-assembly.step');

const lines = [];
let n = 0;
const ent = (s) => {
  n += 1;
  lines.push(`#${n}=${s};`);
  return `#${n}`;
};
const f = (x) => (Number.isInteger(x) ? `${x}.` : String(x));
const dir = (v) => ent(`DIRECTION('',(${v.map(f).join(',')}))`);
const pt = (v) => ent(`CARTESIAN_POINT('',(${v.map(f).join(',')}))`);
const axis = (loc) => ent(`AXIS2_PLACEMENT_3D('',${pt(loc)},${dir([0, 0, 1])},${dir([1, 0, 0])})`);
const E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// --- shared context -------------------------------------------------------
const mm = ent(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
const rad = ent(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
const ster = ent(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
const unc = ent(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${mm},'distance_accuracy_value','')`);
const ctx = ent(
  `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${ster})) REPRESENTATION_CONTEXT('','') )`
);
const app = ent(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
ent(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${app})`);
const prodCtx = ent(`PRODUCT_CONTEXT('',${app},'mechanical')`);
const pdCtx = ent(`PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`);

// --- geometry: axis-aligned box centred at the local origin -----------------
function boxBrep(name, size) {
  const h = size.map((s) => s / 2);
  const coord = (i) => [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]];
  const verts = [];
  for (let i = 0; i < 8; i++) verts.push(ent(`VERTEX_POINT('',${pt(coord(i))})`));
  const edges = new Map();
  for (let i = 0; i < 8; i++) {
    for (let a = 0; a < 3; a++) {
      const j = i | (1 << a);
      if (j === i) continue;
      const line = ent(`LINE('',${pt(coord(i))},${ent(`VECTOR('',${dir(E[a])},${f(size[a])})`)})`);
      edges.set(`${i}-${j}`, ent(`EDGE_CURVE('',${verts[i]},${verts[j]},${line},.T.)`));
    }
  }
  const faces = [];
  for (let a = 0; a < 3; a++) {
    for (const s of [0, 1]) {
      const b = (a + 1) % 3;
      const c = (a + 2) % 3;
      const uv = s ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
      const idx = uv.map(([u, v]) => (s << a) | (u << b) | (v << c));
      const oes = idx.map((p, k) => {
        const q = idx[(k + 1) % 4];
        const fwd = q > p;
        return ent(`ORIENTED_EDGE('',*,*,${edges.get(fwd ? `${p}-${q}` : `${q}-${p}`)},${fwd ? '.T.' : '.F.'})`);
      });
      const loop = ent(`EDGE_LOOP('',(${oes.join(',')}))`);
      const normal = E[a].map((x) => (s ? x : -x));
      const plane = ent(`PLANE('',${ent(`AXIS2_PLACEMENT_3D('',${pt(coord(idx[0]))},${dir(normal)},${dir(E[b])})`)})`);
      faces.push(ent(`ADVANCED_FACE('',(${ent(`FACE_OUTER_BOUND('',${loop},.T.)`)}),${plane},.T.)`));
    }
  }
  return ent(`MANIFOLD_SOLID_BREP('${name}',${ent(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
}

// --- products ----------------------------------------------------------------
function product(name, category) {
  const prod = ent(`PRODUCT('${name}','${name}','',(${prodCtx}))`);
  ent(`PRODUCT_RELATED_PRODUCT_CATEGORY('${category}',$,(${prod}))`);
  const pdf = ent(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  return ent(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
}

/** A part: product + B-rep shape representation (origin axis is item 2). */
function part(name, size) {
  const pd = product(name, 'part');
  const origin = axis([0, 0, 0]);
  const rep = ent(`ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(${boxBrep(name, size)},${origin}),${ctx})`);
  ent(`SHAPE_DEFINITION_REPRESENTATION(${ent(`PRODUCT_DEFINITION_SHAPE('','',${pd})`)},${rep})`);
  return { pd, rep, origin };
}

/** An assembly: product + shape representation holding one placement per child. */
function assembly(name, children) {
  const pd = product(name, 'assembly');
  const origin = axis([0, 0, 0]);
  const placements = children.map((c) => ({ ...c, placement: axis(c.at) }));
  const rep = ent(
    `SHAPE_REPRESENTATION('${name}',(${[origin, ...placements.map((p) => p.placement)].join(',')}),${ctx})`
  );
  ent(`SHAPE_DEFINITION_REPRESENTATION(${ent(`PRODUCT_DEFINITION_SHAPE('','',${pd})`)},${rep})`);
  placements.forEach((p, i) => {
    const nauo = ent(
      `NEXT_ASSEMBLY_USAGE_OCCURRENCE('${name}-${i + 1}','${p.instance}','',${pd},${p.node.pd},$)`
    );
    const idt = ent(`ITEM_DEFINED_TRANSFORMATION('','',${p.node.origin},${p.placement})`);
    const rel = ent(
      `( REPRESENTATION_RELATIONSHIP('','',${p.node.rep},${rep}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${idt}) SHAPE_REPRESENTATION_RELATIONSHIP() )`
    );
    ent(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${rel},${ent(`PRODUCT_DEFINITION_SHAPE('','',${nauo})`)})`);
  });
  return { pd, rep, origin };
}

const housing = part('HOUSING', [120, 20, 80]);
const shaft = part('SHAFT', [100, 10, 10]);
const gear = part('GEAR', [30, 30, 8]);
const cover = part('COVER', [120, 4, 80]);
const shaftAssy = assembly('SHAFT_ASSY', [
  { node: shaft, at: [0, 0, 0], instance: 'SHAFT' },
  { node: gear, at: [20, 0, 0], instance: 'GEAR:1' },
  { node: gear, at: [-20, 0, 0], instance: 'GEAR:2' },
]);
assembly('GEARBOX', [
  { node: housing, at: [0, 0, 0], instance: 'HOUSING' },
  { node: shaftAssy, at: [0, 40, 0], instance: 'SHAFT_ASSY' },
  { node: cover, at: [0, 25, 0], instance: 'COVER' },
]);

const text = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('Dr.Yo CAD test fixture: gearbox assembly with a nested sub-assembly'),'2;1');",
  "FILE_NAME('gearbox-assembly.step','2026-11-24T00:00:00',(''),(''),'scripts/generate-assembly-step.mjs','','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
  'ENDSEC;',
  'DATA;',
  ...lines,
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');
fs.writeFileSync(out, text);
console.log(`wrote ${out} (${n} entities)`);
