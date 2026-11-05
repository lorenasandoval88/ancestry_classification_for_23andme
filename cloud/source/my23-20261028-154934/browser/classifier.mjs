// Numerical inference stays in ONNX; parsing mirrors raw_parser.py.
export function markerIndex(sites) {
  const all = new Map();
  sites.forEach(([c,p,r,a],i) => {
    const key=`${c}:${p}`;
    if(!all.has(key)) all.set(key,[]);
    all.get(key).push([i,r,a]);
  });
  const unique=new Map([...all].filter(([,v])=>v.length===1).map(([k,v])=>[k,v[0]]));
  return {unique, count:sites.length, ambiguous:sites.length-unique.size};
}

export function parseText(text,index) {
  const values=new Float32Array(index.count).fill(NaN), seen=new Map(), builds=new Set();
  const qc={rows:0,matched_coordinates:0,no_calls:0,incompatible_alleles:0,possible_opposite_strand:0,
    duplicate_rows:0,conflicting_duplicates:0,malformed_rows:0};
  const complement={A:'T',T:'A',C:'G',G:'C'};
  for(const source of text.split(/\r?\n/)) {
    const line=source.trim();
    if(!line) continue;
    if(line.startsWith('#')) {
      for(const m of line.matchAll(/(?:\bbuild\s*[:=]?\s*|\bgrch\s*)(3[678])\b/gi)) builds.add(m[1]);
      continue;
    }
    const c=line.split(/\s+/);
    if(c.length>=4 && c[0].toLowerCase()==='rsid') continue;
    qc.rows++;
    if(c.length!==4) {qc.malformed_rows++;continue;}
    const chrom=c[1].replace(/^chr/,'');
    if(!/^\d+$/.test(chrom)||!/^\d+$/.test(c[2])) continue;
    const key=`${Number(chrom)}:${Number(c[2])}`;
    if(!index.unique.has(key)) continue;
    const genotype=c[3].toUpperCase();
    if(seen.has(key)) {
      qc.duplicate_rows++;
      if(genotype!==seen.get(key)&&seen.get(key)!=='CONFLICT') {
        qc.conflicting_duplicates++;seen.set(key,'CONFLICT');
      }
      continue;
    }
    seen.set(key,genotype);
  }
  qc.matched_coordinates=seen.size;
  for(const [key,g] of seen) {
    const [i,r,a]=index.unique.get(key), allowed=new Set([r,a]);
    if(['--','NN','00','CONFLICT'].includes(g)) qc.no_calls++;
    else if(g.length===2&&[...g].every(b=>allowed.has(b))) values[i]=[...g].filter(b=>b===r).length;
    else {
      if(g.length===2&&[...g].every(b=>complement[b]&&allowed.has(complement[b]))) qc.possible_opposite_strand++;
      qc.incompatible_alleles++;
    }
  }
  qc.called_model_markers=values.reduce((n,v)=>n+Number(Number.isFinite(v)),0);
  qc.called_fraction=qc.called_model_markers/index.count;
  qc.incompatible_fraction_of_matched_coordinates=seen.size?qc.incompatible_alleles/seen.size:0;
  return {values,builds:[...builds].sort(),qc};
}

async function verifiedBytes(url,hash) {
  const response=await fetch(url);
  if(!response.ok) throw new Error(`Cannot load model asset: ${response.status}`);
  const bytes=await response.arrayBuffer();
  if(hash) {
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const actual=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(actual!==hash) throw new Error('Model asset checksum mismatch');
  }
  return bytes;
}

export async function createClassifier(baseURL,ort) {
  const base=new URL(baseURL,globalThis.location?.href);
  const metadata=JSON.parse(new TextDecoder().decode(await verifiedBytes(new URL('metadata.json',base))));
  const markers=JSON.parse(new TextDecoder().decode(await verifiedBytes(new URL('markers.json',base),metadata.markers_sha256)));
  const index=markerIndex(markers.sites);
  if(index.count!==metadata.feature_count||markers.genome_build!=='37') throw new Error('Marker metadata mismatch');
  ort.env.wasm.wasmPaths=new URL('vendor/',base).href;
  ort.env.wasm.numThreads=1;
  const model=await verifiedBytes(new URL('model.onnx',base),metadata.model_sha256);
  const session=await ort.InferenceSession.create(new Uint8Array(model),{executionProviders:['wasm']});
  return {metadata, async classify(file) {
    const parsed=parseText(await file.text(),index), reasons=[];
    if(parsed.builds.length!==1||parsed.builds[0]!=='37') reasons.push('header_build_not_verified_as_37');
    if(parsed.qc.malformed_rows) reasons.push('malformed_genotype_rows');
    if(parsed.qc.called_fraction<metadata.minimum_called_fraction) reasons.push('insufficient_model_marker_coverage');
    if(parsed.qc.incompatible_fraction_of_matched_coordinates>metadata.maximum_incompatible_fraction) reasons.push('excess_incompatible_alleles');
    const report={file_name:file.name,status:reasons.length?'skipped':'classified',reasons,qc:parsed.qc,
      predicted_group:null,reference_group_probabilities:null,run_id:metadata.run_id};
    if(reasons.length) return report;
    const tensor=new ort.Tensor('float32',parsed.values,[1,index.count]);
    let outputs;
    try {
      outputs=await session.run({[metadata.input_name]:tensor});
      const probabilities=Array.from(outputs[metadata.probabilities_output].data);
      if(probabilities.length!==metadata.classes.length||!probabilities.every(Number.isFinite)) throw new Error('Invalid model probabilities');
      const best=probabilities.indexOf(Math.max(...probabilities));
      report.predicted_group=metadata.classes[best];
      report.reference_group_probabilities=Object.fromEntries(metadata.classes.map((c,i)=>[c,probabilities[i]]));
    } finally {
      tensor.dispose();
      if(outputs) for(const value of Object.values(outputs)) value.dispose?.();
    }
    return report;
  }};
}
