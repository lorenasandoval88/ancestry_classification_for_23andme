// Expose the PCA coordinates of the published ONNX model as a graph output.
//
//   node scripts/expose-pcs-output.mjs [--model model/model.onnx] [--metadata model/metadata.json] [--dry-run]
//
// The cloud Step 6 export (cloud/source/<run>/export_onnx.py) computes the 10 principal components
// as an intermediate tensor named `pcs` but only lists `probabilities` and `class_index` as graph
// outputs, so the browser cannot place an uploaded file on the PCA plot. This script appends `pcs`
// to graph.output — no node, weight or shape is changed, so probabilities stay bit-identical — and
// updates metadata.json: new model_sha256, pc_scores_output = "pcs", n_components, and a
// `derived_from` record pointing at the original export's checksum. Safe to rerun (no-op when
// `pcs` is already an output). Needs the onnx-proto dev dependency (npm install).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as onnxProto from "onnx-proto";
import { parseArgs } from "./lib/run-dir.mjs";

const onnx = onnxProto.onnx ?? onnxProto.default?.onnx ?? onnxProto.default ?? onnxProto;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const modelPath = resolve(root, args.model || "model/model.onnx");
const metaPath = resolve(root, args.metadata || "model/metadata.json");
const rel = (p) => relative(root, p).replace(/\\/g, "/");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const before = readFileSync(modelPath);
const beforeSha = sha256(before);
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
if (meta.model_sha256 && meta.model_sha256 !== beforeSha) {
  throw new Error(`${rel(modelPath)} sha256 ${beforeSha.slice(0, 12)}… does not match ${rel(metaPath)} (${meta.model_sha256.slice(0, 12)}…); refusing to patch an unverified model`);
}

const model = onnx.ModelProto.decode(before);
const g = model.graph;
const producer = g.node.find((n) => n.output.includes("pcs"));
if (!producer) throw new Error("graph has no tensor named pcs — this is not the Step 6 export layout");
if (producer.opType !== "MatMul" || producer.input[1] !== "pca_weights") {
  throw new Error(`pcs is produced by ${producer.opType}(${producer.input.join(", ")}), expected MatMul(pca_centered, pca_weights)`);
}
const weights = g.initializer.find((t) => t.name === "pca_weights");
if (!weights || weights.dims.length !== 2) throw new Error("pca_weights initializer missing or not 2-D");
const k = Number(weights.dims[1]);

if (g.output.some((o) => o.name === "pcs")) {
  console.log(`${rel(modelPath)} already exposes pcs[N, ${k}] — nothing to do`);
  process.exit(0);
}

// Same batch dimension encoding as the existing outputs (unnamed, unsized first dim).
const probabilities = g.output.find((o) => o.name === "probabilities");
if (!probabilities) throw new Error("graph has no probabilities output");
const batchDim = onnx.TensorShapeProto.Dimension.fromObject(onnx.TensorShapeProto.Dimension.toObject(probabilities.type.tensorType.shape.dim[0]));
const pcsOut = onnx.ValueInfoProto.fromObject({
  name: "pcs",
  type: { tensorType: { elemType: onnx.TensorProto.DataType.FLOAT, shape: { dim: [batchDim, { dimValue: k }] } } },
});
g.output.push(pcsOut);

const after = Buffer.from(onnx.ModelProto.encode(model).finish());
const afterSha = sha256(after);

// Round-trip check: nodes, initializers and the original outputs must be untouched.
const check = onnx.ModelProto.decode(after);
const summary = (m) => JSON.stringify({
  ir: String(m.irVersion), opset: m.opsetImport.map((o) => `${o.domain}:${o.version}`),
  nodes: m.graph.node.map((n) => [n.opType, n.input, n.output, n.attribute.map((a) => a.name)]),
  inits: m.graph.initializer.map((t) => [t.name, t.dims.map(String), t.dataType, sha256(t.rawData)]),
  inputs: m.graph.input.map((v) => v.name),
});
if (summary(check) !== summary(model)) throw new Error("re-encoded graph differs from the original beyond the added output");
if (check.graph.output.map((o) => o.name).join(",") !== "probabilities,class_index,pcs") throw new Error("unexpected output list after patch");

const newMeta = {
  ...meta,
  model_sha256: afterSha,
  pc_scores_output: "pcs",
  n_components: k,
  derived_from: {
    model_sha256: beforeSha,
    source: "cloud Step 6 browser export (6_test_model/results/<run_id>/browser/model.onnx)",
    change: "graph output `pcs` (PCA coordinates, [N, n_components]) exposed; nodes, weights and the probabilities / class_index outputs are unchanged",
    script: "scripts/expose-pcs-output.mjs",
  },
};
const metaText = JSON.stringify(Object.fromEntries(Object.entries(newMeta).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n";

console.log(`${rel(modelPath)}: ${before.length} → ${after.length} bytes`);
console.log(`  outputs: probabilities[N,${probabilities.type.tensorType.shape.dim[1].dimValue}], class_index[N], pcs[N,${k}]`);
console.log(`  sha256:  ${beforeSha.slice(0, 16)}… → ${afterSha.slice(0, 16)}…`);
if (args["dry-run"]) { console.log("dry run — nothing written"); process.exit(0); }
writeFileSync(modelPath, after);
writeFileSync(metaPath, metaText);
console.log(`wrote ${rel(modelPath)} and ${rel(metaPath)}`);
